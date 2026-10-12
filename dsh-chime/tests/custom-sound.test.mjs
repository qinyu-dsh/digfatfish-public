/**
 * 自定义铃声的真实 HTTP 测试：上传 → 列表 → 取回 → 删除，全程打真 socket。
 *
 * 为什么不上假 req/res：上传这条路要处理 JSON body 分块、base64、文件头嗅探、
 * 落盘、以及「请求里的名字绝不能拿来拼路径」这几件事——每一条都是假对象测不出来的。
 *
 * 用真实的 wav/mp3 魔数构造样本，避免测试依赖磁盘上真实音频文件。
 *
 * 用法：node --test tests/custom-sound.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 造一个最小的合法 WAV（44 字节头 + 少量静音采样）。 */
function makeWav(samples = 64) {
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(22050, 24)
  header.writeUInt32LE(22050 * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 造一个裸 MP3（无 ID3，直接 frame sync）。 */
function makeMp3() {
  const frame = Buffer.alloc(256, 0)
  frame[0] = 0xff
  frame[1] = 0xfb
  frame[2] = 0x90
  frame[3] = 0x00
  return frame
}

/**
 * 起服务器。appliedDir 不再显式传：插件按 DSH_HOME 惰性解析自定义目录，
 * 而 DSH_HOME 由 harness() 在「整个测试期间」指向临时目录——不是只在 apply() 那一下。
 */
function mountPlugin() {
  const routes = []
  const cleanups = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    on() { return () => {} },
    get(name) {
      if (name !== 'webServer') return undefined
      return { register(spec) { routes.push(spec); return () => {} } }
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
    Promise.resolve(hit.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  return { cleanups, api, server }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/**
 * 建一个隔离环境：临时 DSH_HOME → 插件把自定义铃声写在那儿。
 *
 * 这个文件要改 process.env.DSH_HOME，而测试之间不保证串行，所以不去赌时序：
 * 每次请求前都用 pin() 重新钉一次（插件那头是惰性解析 DSH_HOME 的）。
 * 绝不能出现「测试往用户真实 ~/.dsh 里写文件」这种事。
 */
async function harness(t) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-chime-home-'))
  process.env.DSH_HOME = home

  const { cleanups, api, server } = mountPlugin()
  const base = await listen(server)

  t.after(() => {
    for (const c of cleanups) { try { c() } catch (error) {} }
    server.close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  /** 请求前后都把自己的 DSH_HOME 钉住，避免并发测试互相抢。 */
  const pin = async (request) => {
    process.env.DSH_HOME = home
    try {
      return await request()
    } finally {
      process.env.DSH_HOME = home
    }
  }
  return { home, api, base, pin, dir: join(home, 'dsh-chime', 'sounds') }
}

const upload = (h, body) => h.pin(() => globalThis.fetch(`${h.base}/dsh-chime/sounds/custom`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}))
const listCustom = async (h) => (await h.pin(() => globalThis.fetch(`${h.base}/dsh-chime/sounds/custom`))).json()
const removeCustom = (h, name) => h.pin(() => globalThis.fetch(
  `${h.base}/dsh-chime/sounds/custom?name=${encodeURIComponent(name)}`,
  { method: 'DELETE' },
))
const fetchSound = (h, name) => h.pin(() => globalThis.fetch(`${h.base}/dsh-chime/sounds/${encodeURIComponent(name)}`))
const status = async (h) => (await h.pin(() => globalThis.fetch(`${h.base}/dsh-chime/status`))).json()

test('上传 wav：落盘、列表可见、能按同名取回字节', async (t) => {
  const h = await harness(t)
  const wav = makeWav(128)

  const res = await upload(h, { name: '我的收工铃.wav', dataBase64: wav.toString('base64') })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.bytes, wav.length)
  assert.equal(body.name, '我的收工铃')
  assert.equal(body.file, '我的收工铃.wav')
  assert.ok(existsSync(join(h.dir, '我的收工铃.wav')), '文件应当落在 DSH_HOME 下的自定义目录')

  const list = await listCustom(h)
  assert.equal(list.ok, true)
  assert.equal(list.sounds.length, 1)
  assert.equal(list.sounds[0].name, '我的收工铃')
  assert.equal(list.sounds[0].custom, true)
  assert.equal(list.sounds[0].gain, 1, '自定义音色默认满音量')
  assert.match(list.dir, /dsh-chime[\\/]sounds$/)

  const fetched = await fetchSound(h, '我的收工铃.wav')
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers.get('content-type'), 'audio/wav')
  const bytes = Buffer.from(await fetched.arrayBuffer())
  assert.deepEqual(bytes, wav, '取回的字节必须与上传的完全一致')
})

test('上传 mp3：靠文件头认格式（文件名没有后缀也能收）', async (t) => {
  const h = await harness(t)
  const mp3 = makeMp3()
  const res = await upload(h, { name: 'no-extension', dataBase64: mp3.toString('base64') })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.file, 'no-extension.mp3', '按 ID3/frame-sync 嗅探出 .mp3')
  const fetched = await fetchSound(h, 'no-extension.mp3')
  assert.equal(fetched.headers.get('content-type'), 'audio/mpeg')
})

test('拒绝：认不出格式的内容、空内容、超大体、畸形 JSON', async (t) => {
  const h = await harness(t)

  const junk = await upload(h, { name: 'a.txt', dataBase64: Buffer.from('this is not audio at all').toString('base64') })
  assert.equal(junk.status, 415, '既无后缀魔数也不对 → 415')

  const empty = await upload(h, { name: 'a.wav', dataBase64: '' })
  assert.equal(empty.status, 400)

  const badJson = await h.pin(() => fetch(`${h.base}/dsh-chime/sounds/custom`, { method: 'POST', body: '{oops' }))
  assert.equal(badJson.status, 400)

  const oversize = await upload(h, {
    name: 'big.wav',
    dataBase64: 'A'.repeat(Math.ceil(9 * 1024 * 1024 * 4 / 3)),
  })
  assert.equal(oversize.status, 413)

  assert.equal((await listCustom(h)).sounds.length, 0, '被拒绝的上传不该留下任何文件')
})

test('文件名收敛：路径穿越与奇怪字符都落不到目录外面', async (t) => {
  const h = await harness(t)
  const wav = makeWav()
  const res = await upload(h, {
    name: '../../../evil.wav',
    label: '../..\\..\\evil',
    dataBase64: wav.toString('base64'),
  })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(!body.file.includes('/') && !body.file.includes('\\'), `文件名不该含路径分隔符：${body.file}`)
  assert.ok(!body.file.includes('..'), `文件名不该含 ..：${body.file}`)
  assert.ok(existsSync(join(h.dir, body.file)), '文件必须落在自定义目录里')
  assert.ok(!existsSync(join(h.dir, '..', 'evil.wav')), '绝不能写到目录外面')

  // URL 段里带穿越也取不到东西
  const escape = await fetchSound(h, '../../package.json')
  assert.equal(escape.status, 404)
})

test('删除：删掉后列表与取回都消失，删不存在的报 404', async (t) => {
  const h = await harness(t)
  const wav = makeWav()
  await upload(h, { name: 'temp.wav', dataBase64: wav.toString('base64') })
  assert.equal((await listCustom(h)).sounds.length, 1)

  const gone = await removeCustom(h, 'temp')
  assert.equal(gone.status, 200)
  assert.equal((await gone.json()).ok, true)
  assert.equal((await listCustom(h)).sounds.length, 0)
  assert.equal((await fetchSound(h, 'temp.wav')).status, 404, '删掉的文件不该还能取回')

  const again = await removeCustom(h, 'temp')
  assert.equal(again.status, 404)
})

test('内置音色不受影响，自定义与内置能共存', async (t) => {
  const h = await harness(t)
  await upload(h, { name: 'mine.wav', dataBase64: makeWav().toString('base64') })

  const builtin = await fetchSound(h, 'complete.wav')
  assert.equal(builtin.status, 200, '内置铃声仍然取得到')
  assert.ok((await builtin.arrayBuffer()).byteLength > 8000)

  const diag = await status(h)
  assert.equal(diag.customSounds, 1, '诊断口报出自定义铃声数量')

  // 未知名字仍然 404（白名单逻辑没有被自定义那支破坏）
  assert.equal((await fetchSound(h, 'nope.wav')).status, 404)
})
