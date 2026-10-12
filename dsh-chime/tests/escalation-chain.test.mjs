/**
 * 升级链「调度与取消」回归测试（TASK-escalation-tests.md）。
 *
 * 为什么单独有这个文件：计划纯函数（节奏/倍数/上限）由 tests/escalation.test.mjs 钉住；
 * 这里钉的是真正容易坏、坏了又不报错的部分——定时器调度、取消、清理。
 * 这类故障的共同点是「代码不报错、测试不红、只有用户的耳朵遭殃」。
 *
 * 手法与 batch.test.mjs 相同：从 lib/client.js 源码里抽出 createEscalation 与
 * buildEscalationPlan 直接执行（测的就是线上那份逻辑），然后注入假时钟、假定时器、
 * 假设置与假响铃，把 16 条用例在无浏览器环境下跑完。
 *
 * 用法：node --test tests/escalation-chain.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 从 client 源码里按大括号配平抽出一个函数并求值成真函数。 */
function extractFn(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `lib/client.js 里找不到 ${name} —— 改名了就把这个测试一起改`)
  let i = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let j = i; j < source.length; j += 1) {
    const ch = source[j]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = j + 1; break }
    }
  }
  assert.ok(end > i, `${name} 的大括号没配平`)
  // eslint-disable-next-line no-new-func
  return new Function(`${source.slice(start, end)}; return ${name}`)()
}

const createEscalation = extractFn('createEscalation')
const buildEscalationPlan = extractFn('buildEscalationPlan')

const T0 = 1_000_000

/**
 * 假环境：时间手动推进，定时器用 Map 模拟（浏览器语义：触发后即失效；
 * clearTimeout 的每次调用都记下来——「重排前清旧定时器」就靠这个断言）。
 */
function makeChain() {
  let now = T0
  let nextId = 1
  const timers = new Map() // id -> { fireAt, fn }
  const cleared = []
  const state = {
    settings: { enabled: true, escalateEnabled: true, escalateDelaySec: 30 },
    quiet: false,
  }
  const calls = { ring: [], record: [] }
  const chain = createEscalation({
    now: () => now,
    setTimeout: (fn, wait) => {
      const id = nextId
      nextId += 1
      timers.set(id, { fireAt: now + Math.max(0, wait), fn })
      return id
    },
    clearTimeout: (id) => { cleared.push(id); timers.delete(id) },
    getSettings: () => state.settings,
    inQuietHours: () => state.quiet,
    buildPlan: buildEscalationPlan,
    ring: async (kind, detail, gainScale, round) => {
      calls.ring.push({ kind, detail, gainScale, round, at: now })
      return true
    },
    record: (entry) => calls.record.push({ ...entry, at: now }),
  })
  const pending = () => [...timers.entries()].map(([id, t]) => ({ id, fireAt: t.fireAt }))
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  /** 推进假时钟：按触发顺序跑到点的定时器，并让过 fire() 的 await 点。 */
  async function advance(ms) {
    const target = now + ms
    for (;;) {
      let hit = null
      for (const [id, t] of timers) {
        if (t.fireAt <= target && (!hit || t.fireAt < hit.t.fireAt)) hit = { id, t }
      }
      if (!hit) break
      timers.delete(hit.id) // 浏览器语义：定时器触发后即失效
      now = hit.t.fireAt
      hit.t.fn()
      await flush()
      await flush()
    }
    now = target
  }
  return { chain, state, calls, pending, cleared, advance, now: () => now }
}

// ── 调度（用例 1–5）────────────────────────────────────────────────────

test('1 首响后按首次延迟武装一次重响（默认 30 s），且不立刻响', () => {
  const h = makeChain()
  assert.equal(h.chain.arm('assist', '问个问题'), true)
  const p = h.pending()
  assert.equal(p.length, 1, '武装后必须恰好一个 pending 定时器')
  assert.equal(p[0].fireAt, T0 + 30000, '第一轮相对首响 30 s')
  assert.equal(h.calls.ring.length, 0, '武装本身不响')
})

test('2 到点触发第一轮：增益是计划第一档 ×1.3，记为第 1 轮', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  await h.advance(30000)
  assert.equal(h.calls.ring.length, 1)
  assert.deepEqual(
    [h.calls.ring[0].gainScale, h.calls.ring[0].round, h.calls.ring[0].detail],
    [1.3, 1, '问个问题'],
  )
})

test('3 一轮结束后继续排下一轮：相对首响 75 s（+45 s 节奏）', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  await h.advance(30000)
  const p = h.pending()
  assert.equal(p.length, 1, '第一轮响完必须立刻有下一轮在排')
  assert.equal(p[0].fireAt, T0 + 75000)
  await h.advance(45000)
  assert.equal(h.calls.ring.length, 2)
  assert.deepEqual([h.calls.ring[1].gainScale, h.calls.ring[1].round], [1.6, 2])
})

test('4 追满 3 轮后自行结束：不再排下一轮，链置空', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  await h.advance(30000 + 45000 + 45000)
  assert.deepEqual(h.calls.ring.map((r) => r.gainScale), [1.3, 1.6, 1.9])
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 3, '结束后绝不补响')
})

test('5 定时器不累积：重排前清旧定时器，全程最多一个 pending', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  const firstId = h.pending()[0].id
  await h.advance(30000)
  assert.ok(h.cleared.includes(firstId), '重排前必须 clearTimeout 掉旧定时器（删掉这行本测试必须红）')
  assert.equal(h.pending().length, 1)
  const secondId = h.pending()[0].id
  await h.advance(45000)
  assert.ok(h.cleared.includes(secondId), '每一轮重排都要清旧定时器')
  assert.equal(h.pending().length, 1)
})

// ── 取消（用例 6–12，本文件的重点）────────────────────────────────────

test('6 页面变可见（visibilitychange 且 hidden=false）→ 取消并记「已注意到」', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.chain.onVisibilityChange(true)
  assert.equal(h.chain.active(), true, '页面变隐藏不算关注，不该取消')
  h.chain.onVisibilityChange(false)
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
  const note = h.calls.record.find((r) => r.kind === 'escalation')
  assert.ok(note && note.text.includes('已注意到'), '必须留一条「已注意到，升级提醒停止」的痕迹')
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('7 pointerdown（用户点了一下）→ 取消；客户端必须把 pointerdown 绑到升级链', async () => {
  assert.ok(
    source.includes("window.addEventListener('pointerdown', attended"),
    'client.js 里 pointerdown 的绑定丢了——用户点页面将不再取消升级链',
  )
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.chain.attend()
  assert.equal(h.chain.active(), false)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('8 keydown（用户敲了键盘）→ 取消；客户端必须把 keydown 绑到升级链', async () => {
  assert.ok(
    source.includes("window.addEventListener('keydown', attended"),
    'client.js 里 keydown 的绑定丢了——用户敲键盘将不再取消升级链',
  )
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.chain.attend()
  assert.equal(h.chain.active(), false)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('9 总开关（enabled）关掉 → 对账即取消，等不到触发瞬间', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.state.settings.enabled = false
  h.chain.reconcile()
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('10 升级开关（escalateEnabled）关掉 → 对账即取消', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.state.settings.escalateEnabled = false
  h.chain.reconcile()
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('11 新通知到来时作废旧链：旧定时器被清、新链从头开始、旧链绝不响', async () => {
  const h = makeChain()
  h.chain.arm('assist', '旧问题')
  const oldId = h.pending()[0].id
  await h.advance(10000) // 旧链已等 10 s
  h.chain.arm('assist', '新问题')
  assert.ok(h.cleared.includes(oldId), '武装新链前必须清掉旧链的定时器')
  const p = h.pending()
  assert.equal(p.length, 1, '两条链并存 = 一条通知响两轮，绝不允许')
  assert.equal(p[0].fireAt, T0 + 10000 + 30000, '新链从它自己的首响时刻重新计时')
  await h.advance(30000)
  assert.equal(h.calls.ring.length, 1, '旧链的那一轮绝不能响出来')
  assert.equal(h.calls.ring[0].detail, '新问题')
})

test('12 取消后不再有任何重响：假时钟推到远超计划时长，零次播放', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.chain.cancel()
  assert.equal(h.chain.active(), false)
  await h.advance(3600000)
  assert.equal(h.calls.ring.length, 0)
})

// ── 清理 / 边界（用例 13–16）──────────────────────────────────────────

test('13 卸载清理：dispose 清定时器、链置空；客户端必须移除三个事件监听', () => {
  for (const snippet of [
    "document.removeEventListener('visibilitychange'",
    "window.removeEventListener('pointerdown'",
    "window.removeEventListener('keydown'",
  ]) {
    assert.ok(source.includes(snippet), `client.js 的 ctx.effect 清理器里少了 ${snippet}——热更新后会幽灵响铃`)
  }
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  const timerId = h.pending()[0].id
  h.chain.dispose()
  assert.ok(h.cleared.includes(timerId), 'dispose 必须清掉 pending 定时器')
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
})

test('14 触发瞬间已进入静音时段 → 不响、记「升级提醒就此打住」、链终止', async () => {
  const h = makeChain()
  h.chain.arm('assist', '问个问题')
  h.state.quiet = true
  await h.advance(30000)
  assert.equal(h.calls.ring.length, 0, '静音时段被追着响是最伤信任的事故')
  assert.ok(h.calls.record.some((r) => r.text.includes('进入静音时段，升级提醒就此打住')))
  assert.equal(h.chain.active(), false)
  assert.equal(h.pending().length, 0)
  await h.advance(600000)
  assert.equal(h.calls.ring.length, 0)
})

test('15 触发瞬间总开关/升级开关已关 → 不响、链终止（第二道防线）', async () => {
  for (const flip of ['enabled', 'escalateEnabled']) {
    const h = makeChain()
    h.chain.arm('assist', '问个问题')
    h.state.settings[flip] = false // 不经过 reconcile，直接考触发瞬间的重查
    await h.advance(30000)
    assert.equal(h.calls.ring.length, 0, `${flip} 已关还响 = 关掉开关后还响一次`)
    assert.equal(h.chain.active(), false)
    assert.equal(h.pending().length, 0)
  }
})

test('16 计划为空（完成音 / 开关关）→ 不武装链、不排定时器', () => {
  const h1 = makeChain()
  assert.equal(h1.chain.arm('complete', '干完了'), false, '完成音不追着人跑')
  assert.equal(h1.pending().length, 0)

  const h2 = makeChain()
  h2.state.settings.escalateEnabled = false
  assert.equal(h2.chain.arm('assist', '问个问题'), false, '升级开关关着不武装')
  assert.equal(h2.pending().length, 0)

  const h3 = makeChain()
  h3.state.settings.enabled = false
  assert.equal(h3.chain.arm('assist', '问个问题'), false, '总开关关着不武装')
  assert.equal(h3.pending().length, 0)
})
