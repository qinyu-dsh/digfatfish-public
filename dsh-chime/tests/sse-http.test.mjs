/**
 * SSE 的真实 HTTP 端到端测试。
 *
 * 为什么不用假 req/res 就完事：SSE 是一套协议细节（响应头、分帧、长连接不被结束、
 * 断开清理）。用假对象很容易「测试通过但实际不通」——这次开发里就真的踩到过一次
 * （把客户端 id 当对象用，写帧时 `id.socket` 是 undefined，假对象的 write 却"成功"了）。
 *
 * 这里把插件的真实 handler 挂到真实 http 服务器上，用真实 fetch 读流，
 * 量的是「宿主入队到浏览器读到帧」的延迟。
 *
 * 用法：node --test tests/sse-http.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

/** 起一个真实 http 服务器，把插件注册的路由按「精确 > 最长前缀」分派上去。 */
function mountPlugin() {
  const routes = []
  const cleanups = []
  const listeners = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    on(name, fn) { listeners.push({ name, fn }); return () => {} },
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(spec) { routes.push(spec); return () => {} },
      }
    },
  }
  const api = apply(ctx, {})
  const server = createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0]
    const exact = routes.find((r) => r.kind === 'exact' && r.path === pathname)
    const hit = exact || routes
      .filter((r) => r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(r.path + '/')))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!hit) { res.writeHead(404); res.end('no route'); return }
    try { hit.handler(req, res) } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  return { ctx, routes, cleanups, listeners, api, server }
}

/** 起服务器并返回 base url。 */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/** 读 SSE 流：每收到一个 data: 帧就回调，返回一个 close()。 */
async function readStream(url, onFrame) {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              onFrame(JSON.parse(line.slice(6)))
            }
          }
        }
      }
    } catch (error) { /* 关闭时正常抛 */ }
  })()
  return { res, close: () => controller.abort(), pump }
}

const waitFor = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

test('SSE 真实 HTTP：连上就收到 hello，随后每条通知都是推着到的（毫秒级）', async (t) => {
  const { server, api, cleanups } = mountPlugin()
  const base = await listen(server)
  t.after(() => { for (const c of cleanups) { try { c() } catch (e) {} } server.close() })

  const frames = []
  const conn = await readStream(`${base}/dsh-chime/stream`, (frame) => frames.push({ frame, at: Date.now() }))
  t.after(() => conn.close())

  // Content-Type 必须是 event-stream，否则 EventSource 会当场报错
  assert.match(conn.res.headers.get('content-type'), /text\/event-stream/)
  assert.equal(conn.res.headers.get('cache-control'), 'no-store, no-transform')

  assert.ok(await waitFor(() => frames.length >= 1), '没等到 hello 帧')
  assert.equal(frames[0].frame.hello, true)
  assert.equal(frames[0].frame.clients, 1, '宿主应当看到 1 个在线页面')

  // 宿主入队 → 立刻计延迟
  const startedAt = Date.now()
  api.push('complete', { title: '活干完了', detail: '第 9 轮结束', sound: 'complete' })
  assert.ok(await waitFor(() => frames.length >= 2), '推送帧没到')
  const latency = frames[1].at - startedAt
  assert.equal(frames[1].frame.item.kind, 'complete')
  assert.equal(frames[1].frame.item.seq, 1)
  assert.ok(latency < 500, `推送延迟应当远低于轮询：实测 ${latency}ms`)
  console.log(`     实测推送延迟：${latency}ms（轮询兜底是 20000ms 一轮）`)

  // 再推两条，验证是「每条都推」而不是「推到第一条就停」
  api.push('assist', { title: '有事情问你', sound: 'assist' })
  api.push('assist', { title: '卡住了，等你发话', sound: 'assist' })
  assert.ok(await waitFor(() => frames.length >= 4))
  assert.deepEqual(frames.slice(1).map((f) => f.frame.item.seq), [1, 2, 3])
})

test('SSE 真实 HTTP：页面断开后宿主不再持有它（长连接不泄漏）', async (t) => {
  const { server, api, cleanups } = mountPlugin()
  const base = await listen(server)
  t.after(() => { for (const c of cleanups) { try { c() } catch (e) {} } server.close() })

  const connection = await readStream(`${base}/dsh-chime/stream`, () => {})
  assert.ok(await waitFor(() => api.streamClients === 1), '连接没被记录')

  connection.close()
  assert.ok(await waitFor(() => api.streamClients === 0), '断开后连接没被清掉')
})

test('SSE 真实 HTTP：轮询接口同时可用（断线补拉的兜底）', async (t) => {
  const { server, api, cleanups } = mountPlugin()
  const base = await listen(server)
  t.after(() => { for (const c of cleanups) { try { c() } catch (e) {} } server.close() })

  api.push('complete', { title: '活干完了', sound: 'complete' })
  const res = await fetch(`${base}/dsh-chime/poll?since=0`)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 1)
  assert.equal(body.lastSeq, 1)
  // since 之后没有新的，就是空批
  const second = await (await fetch(`${base}/dsh-chime/poll?since=1`)).json()
  assert.equal(second.items.length, 0)
})
