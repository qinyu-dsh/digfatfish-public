/**
 * dsh-chime 宿主半边端到端测试（假的 ctx + 假的路由处理器，不启动 DSH）。
 *
 * 覆盖的是「装上去以后才会暴露」的那类问题：路由注册形状、轮询增量语义、
 * 铃声文件白名单（路径穿越）、以及同一轮去重。全是本地可离线复现的。
 *
 * 用法：node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

/** 所有已建立的插件实例：测试结束时统一卸载（否则 SSE 心跳定时器会把进程挂住）。 */
const boots = []

/** 最小的 ctx 替身：记下 effect 清理器、event 监听器与注册过的路由。 */
function fakeCtx() {
  const routes = []
  const listeners = []
  const cleanups = []
  const instance = {
    routes,
    listeners,
    cleanups,
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return disposer
    },
    on(name, fn) {
      listeners.push({ name, fn })
      return () => {}
    },
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(spec) {
          routes.push(spec)
          return () => {}
        },
      }
    },
  }
  return instance
}

/** fake ctx 上的 SSE 响应：记录 write() 出去的每一帧，close 时就地触发监听器。 */
function streamRes() {
  const res = {
    status: 0,
    headers: null,
    chunks: [],
    ended: false,
    handlers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end() { this.ended = true; this.emit('close') },
    on(name, fn) { (this.handlers[name] ||= []).push(fn) },
    off(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter((f) => f !== fn) },
    emit(name) { for (const fn of [...(this.handlers[name] || [])]) fn() },
  }
  return res
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

const req = (url, method = 'GET') => ({ url, method })

/** 建立一次插件实例并返回 { ctx, route(path) }。 */
function boot(config) {
  const ctx = fakeCtx()
  apply(ctx, config)
  boots.push(ctx)
  /**
   * 按真实 WebServer 的规则找路由：先精确表，再最长前缀（比的是 `${prefix}/`）。
   * 这里刻意复刻那段匹配语义——「prefix 带尾斜杠会永远匹配不上」这个坑就是靠它抓出来的。
   */
  const match = (pathname) => {
    const urlPath = String(pathname).split('?')[0]
    const exact = ctx.routes.find((r) => r.kind === 'exact' && r.path === urlPath)
    if (exact) return exact
    const candidates = ctx.routes
      .filter((r) => r.kind === 'prefix' && (urlPath === r.path || urlPath.startsWith(r.path + '/')))
      .sort((a, b) => b.path.length - a.path.length)
    return candidates[0]
  }
  const route = (path) => {
    const hit = match(path)
    assert.ok(hit, `路由未注册或匹配不到: ${path}（已注册: ${ctx.routes.map((r) => `${r.kind} ${r.path}`).join(', ')}）`)
    return { spec: hit, async call(url, method = 'GET') { const res = fakeRes(); await hit.handler(req(url, method), res); return res } }
  }
  return { ctx, route }
}

/** 卸载所有实例：跑每个 effect 注册的清理器（含 SSE 心跳与长连接收尾）。 */
function teardownAll() {
  while (boots.length > 0) {
    const ctx = boots.pop()
    for (const cleanup of ctx.cleanups.splice(0)) {
      try { cleanup() } catch (error) { /* 清理失败不该让测试报错 */ }
    }
  }
}

test.after(() => teardownAll())

/** 造一个会话替身：只有 header 被规则读取。 */
const session = (id, header = {}) => ({ id, header })

const turnEnd = (kind, turn = 1) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const toolCall = (name) => ({ type: 'tool/call', data: { name, callId: 'c-' + name, arguments: '{}' } })

const fire = (ctx, session_, event) => {
  for (const l of ctx.listeners) if (l.name === 'session/event') l.fn(session_, event)
}
const parse = (res) => JSON.parse(res.body)

test('四条路由全部注册，且互不重叠', () => {
  const { ctx } = boot()
  assert.deepEqual(ctx.routes.map((r) => [r.kind, r.path]), [
    ['exact', '/dsh-chime/poll'],
    ['exact', '/dsh-chime/test'],
    ['exact', '/dsh-chime/stream'],
    // 前缀路由不能带尾斜杠：Web 服务器比的是 `${prefix}/`，带尾斜杠会永远匹配不上
    ['prefix', '/dsh-chime'],
  ])
  assert.ok(!ctx.routes.some((r) => r.path.endsWith('/')), '任何路由都不该以斜杠结尾')
})

test('SSE：订阅后立刻收到 hello（带当前水位），随后每条通知实时推下去', async () => {
  const { ctx, route } = boot()
  const stream = route('/dsh-chime/stream').spec
  const res = streamRes()
  await stream.handler(req('/dsh-chime/stream'), res)

  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /text\/event-stream/)
  assert.equal(res.chunks[0], ': dsh-chime stream open\nretry: 2000\n\n', '先发注释行与重连间隔')

  const hello = JSON.parse(res.chunks[1].replace(/^data: /, '').trim())
  assert.equal(hello.hello, true)
  assert.equal(hello.lastSeq, 0, '空队列时水位是 0')
  assert.equal(hello.clients, 1)

  // 真实事件 → 不经过任何轮询就应该写到这条连接上（这就是「真·实时」）
  fire(ctx, session('s1'), turnEnd('completed', 1))
  assert.equal(res.chunks.length, 3, '推送必须立即发生，不等下一次轮询')
  const pushed = JSON.parse(res.chunks[2].replace(/^data: /, '').trim())
  assert.equal(pushed.item.kind, 'complete')
  assert.equal(pushed.item.seq, 1)
  assert.match(pushed.item.title, /活干完了/)

  fire(ctx, session('s1'), toolCall('ask_user_question'))
  const second = JSON.parse(res.chunks[3].replace(/^data: /, '').trim())
  assert.equal(second.item.kind, 'assist')

  // 轮询路由依然可用（它是断线补拉的兜底）
  const poll = parse(await route('/dsh-chime/poll').call('/dsh-chime/poll?since=0'))
  assert.equal(poll.items.length, 2)
})

test('SSE：客户端断开后不再收到推送，计数也回落（长连接不能泄漏）', async () => {
  const { ctx, route } = boot()
  const stream = route('/dsh-chime/stream').spec
  const res = streamRes()
  await stream.handler(req('/dsh-chime/stream'), res)

  const status = async () => parse(await route('/dsh-chime/status').call('/dsh-chime/status'))
  assert.equal((await status()).streamClients, 1)

  res.emit('close') // 浏览器关页面 / 网络断
  assert.equal((await status()).streamClients, 0)

  const before = res.chunks.length
  fire(ctx, session('s1'), turnEnd('completed', 1))
  assert.equal(res.chunks.length, before, '关掉的连接不该再被写')
})

test('SSE：插件卸载时把长连接收干净（热重载不留下没人写的连接）', async () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  boots.push(ctx)
  const stream = ctx.routes.find((r) => r.path === '/dsh-chime/stream')
  const res = streamRes()
  await stream.handler(req('/dsh-chime/stream'), res)
  assert.equal(res.ended, false)

  // 模拟 Loader 卸载：跑所有清理器
  for (const cleanup of ctx.cleanups.splice(0)) cleanup()
  assert.equal(res.ended, true, '卸载时连接必须被 end()')
})

test('轮询是增量的：since 之后的才下发', async () => {
  const { ctx, route } = boot()
  const poll = route('/dsh-chime/poll')
  fire(ctx, session('s1'), turnEnd('completed', 1))
  fire(ctx, session('s1'), turnEnd('completed', 2))

  const first = parse(await poll.call('/dsh-chime/poll?since=0'))
  assert.equal(first.items.length, 2)
  assert.deepEqual(first.items.map((i) => i.seq), [1, 2])
  assert.equal(first.lastSeq, 2)

  const second = parse(await poll.call('/dsh-chime/poll?since=2'))
  assert.equal(second.items.length, 0)
  assert.equal(second.lastSeq, 2, '没有新通知时 lastSeq 不能倒退')

  fire(ctx, session('s1'), turnEnd('completed', 3))
  const third = parse(await poll.call('/dsh-chime/poll?since=2'))
  assert.deepEqual(third.items.map((i) => i.seq), [3])
})

test('通知带着会话身份与铃声档位', async () => {
  const { ctx, route } = boot()
  const poll = route('/dsh-chime/poll')
  fire(ctx, session('sess-42', { agentPreset: 'cordis' }), turnEnd('completed', 7))
  const { items } = parse(await poll.call('/dsh-chime/poll?since=0'))
  assert.equal(items[0].kind, 'complete')
  assert.equal(items[0].sound, 'complete')
  assert.equal(items[0].sessionId, 'sess-42')
  assert.equal(items[0].agentPreset, 'cordis')
  assert.ok(items[0].time > 0)
})

test('子会话默认不响铃，开了 notifySubagentSessions 才响', async () => {
  const only = boot()
  const pollOnly = only.route('/dsh-chime/poll')
  fire(only.ctx, session('child', { parentSession: 'root' }), turnEnd('completed'))
  fire(only.ctx, session('child2', { origin: 'subagent' }), turnEnd('completed'))
  assert.equal(parse(await pollOnly.call('/dsh-chime/poll?since=0')).items.length, 0)

  const all = boot({ notifySubagentSessions: true })
  const pollAll = all.route('/dsh-chime/poll')
  fire(all.ctx, session('child', { parentSession: 'root' }), turnEnd('completed'))
  const items = parse(await pollAll.call('/dsh-chime/poll?since=0')).items
  assert.equal(items.length, 1)
  assert.match(items[0].title, /子任务收工/)
})

test('同一轮里问过就不再补一次急促铃', async () => {
  const { ctx, route } = boot()
  const poll = route('/dsh-chime/poll')
  fire(ctx, session('s1'), toolCall('ask_user_question'))
  fire(ctx, session('s1'), turnEnd('blocked')) // 同一轮收尾：不该再响
  const items = parse(await poll.call('/dsh-chime/poll?since=0')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '有事情问你')

  // 下一轮真的卡住了（没问过），仍然要响
  fire(ctx, session('s1'), turnEnd('blocked', 2))
  assert.equal(parse(await poll.call('/dsh-chime/poll?since=0')).items.length, 2)
})

test('一轮完成不受上一轮提问影响', async () => {
  const { ctx, route } = boot()
  const poll = route('/dsh-chime/poll')
  fire(ctx, session('s1'), toolCall('ask_user_question'))
  fire(ctx, session('s1'), turnEnd('completed'))
  const items = parse(await poll.call('/dsh-chime/poll?since=0')).items
  assert.deepEqual(items.map((i) => i.kind), ['assist', 'complete'])
})

test('总开关关掉后什么都不入队', async () => {
  const { ctx, route } = boot({ enabled: false })
  const poll = route('/dsh-chime/poll')
  fire(ctx, session('s1'), turnEnd('completed'))
  fire(ctx, session('s1'), toolCall('exit_plan_mode'))
  assert.equal(parse(await poll.call('/dsh-chime/poll?since=0')).items.length, 0)
})

test('测试路由能自己塞一条通知（走完整链路验证用）', async () => {
  const { ctx, route } = boot()
  const poll = route('/dsh-chime/poll')
  const res = parse(await route('/dsh-chime/test').call('/dsh-chime/test?kind=assist'))
  assert.equal(res.ok, true)
  assert.equal(res.sound, 'assist')
  const items = parse(await poll.call('/dsh-chime/poll?since=0')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'test')
  assert.equal(items[0].sound, 'assist', '试听 assist 必须真的放 assist 音')

  // 未知 kind 回落 blip，不报错也不放奇怪的东西
  const fallback = parse(await route('/dsh-chime/test').call('/dsh-chime/test?kind=../etc/passwd'))
  assert.equal(fallback.sound, 'blip')
})

test('铃声文件：白名单放行四个，其余 404', async () => {
  const { route } = boot()
  for (const name of ['complete.wav', 'assist.wav', 'alert.wav', 'blip.wav']) {
    const sounds = route('/dsh-chime/sounds/' + name)
    const res = await sounds.call('/dsh-chime/sounds/' + name)
    assert.equal(res.status, 200, name + ' 应可读取')
    assert.equal(res.headers['Content-Type'], 'audio/wav')
    assert.ok(res.body.length > 8000, name + ' 音频内容太短，可能读错了文件')
    assert.equal(Number(res.headers['Content-Length']), res.body.length)
  }
  for (const bad of ['nope.wav', 'complete.mp3', '', '../lib/rules.js', '..%2f..%2fpackage.json', '%2e%2e%2fsounds%2fcomplete.wav']) {
    const res = await route('/dsh-chime/sounds/' + bad).call('/dsh-chime/sounds/' + bad)
    assert.ok(res.status === 404 || res.status === 400, `${bad} 不该放行（得到 ${res.status}）`)
  }
  // 前缀路由接管了整个 /dsh-chime 段，未知子路径必须自己 404（不能落到 SPA fallback 上）
  const stray = await route('/dsh-chime/whatever').call('/dsh-chime/whatever')
  assert.equal(stray.status, 404)
})

test('诊断口：/status 说清「活着吗、监听到什么、为什么没响」', async () => {
  const { ctx, route } = boot()
  const status = async () => parse(await route('/dsh-chime/status').call('/dsh-chime/status'))

  const before = await status()
  assert.equal(before.ok, true)
  assert.equal(before.enabled, true)
  assert.equal(before.lastSeq, 0)
  assert.deepEqual(before.stats.classified, {})

  fire(ctx, session('s1'), turnEnd('completed', 2))
  fire(ctx, session('s1'), toolCall('ask_user_question'))
  fire(ctx, session('s1'), turnEnd('blocked', 3)) // 被同轮去重挡掉
  fire(ctx, session('child', { parentSession: 's1' }), turnEnd('completed'))

  const after = await status()
  assert.equal(after.lastSeq, 2, '去了重的那条不该入队')
  assert.equal(after.stats.pushed, 2, 'pushed 只算真正入队的')
  assert.equal(after.stats.suppressed, 1)
  assert.equal(after.stats.classified['turn/end:completed'], 2)
  assert.equal(after.stats.classified['turn/end:blocked'], 1)
  assert.equal(after.stats.classified['tool/call:ask_user_question'], 1)
  assert.equal(after.pendingSessions, 0, '去重表不该泄漏')
  assert.deepEqual(after.sounds.sort(), ['alert.wav', 'assist.wav', 'blip.wav', 'complete.wav'])
})

test('清理器全部登记（插件卸载时路由与会话监听都要撤掉）', () => {
  const { ctx } = boot()
  // 3 条路由各一个 + session/event 一个
  assert.ok(ctx.cleanups.length >= 4, `期望至少 4 个清理器，实际 ${ctx.cleanups.length}`)
})

test('没有 webServer 时不抛异常（只是没有铃声通道）', () => {
  const ctx = { effect: () => {}, on: () => () => {}, get: () => undefined }
  assert.doesNotThrow(() => apply(ctx, {}))
})
