/**
 * 「标签页标题闪烁」与「桌面通知」回归测试（TASK-notify-complete.md）。
 *
 * 这两个渠道曾经只做了「发出去」：人盯着页面标题也在闪、切回来不立刻安静、
 * 图标可能永久写进标题；桌面通知点击无行为、权限被拒静默失效、同件事堆一排。
 * 这里的 16 条用例把「发出去之后」的行为全部钉住。
 *
 * 手法与 escalation-chain.test.mjs 相同：从 lib/client.js 源码里抽出
 * createTitleFlash / createDesktopNotifier 直接执行，document / Notification
 * 全部用假实现注入——不依赖真实浏览器（profile 里也没有 react 独立包）。
 *
 * 用法：node --test tests/notify.test.mjs
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

const createTitleFlash = extractFn('createTitleFlash')
const createDesktopNotifier = extractFn('createDesktopNotifier')

// ── 标题闪烁的假环境 ────────────────────────────────────────────────────

function makeTitle(initialTitle = '工作台', initialHidden = true) {
  const state = { title: initialTitle, hidden: initialHidden }
  let nextId = 1
  const timers = new Map()
  const cleared = []
  const setCalls = []
  const flash = createTitleFlash({
    getTitle: () => state.title,
    setTitle: (value) => { state.title = value; setCalls.push(value) },
    isHidden: () => state.hidden,
    setTimeout: (fn, wait) => { const id = nextId; nextId += 1; timers.set(id, { fn, wait }); return id },
    clearTimeout: (id) => { cleared.push(id); timers.delete(id) },
  })
  /** 触发所有到点定时器（本测试里不细分时间，只分「到点/没到点」）。 */
  function fireTimers() {
    for (const [, t] of [...timers]) t.fn()
    timers.clear()
  }
  return { state, tf: flash, timers, cleared, setCalls, fireTimers }
}

// ── 桌面通知的假环境 ────────────────────────────────────────────────────

function makeNotifier(overrides = {}) {
  const state = {
    enabled: true,
    permission: 'granted',
    requested: 0,
    requestResult: 'granted',
    ...overrides.state,
  }
  const calls = { made: [], record: [], focus: 0, permission: [] }
  class FakeNotification {
    constructor(title, options) {
      this.title = title
      this.options = options
      this.onclick = null
      this.closed = false
      if (state.throwOnConstruct) throw new Error('系统通知服务不可用')
      calls.made.push(this)
    }
    close() { this.closed = true }
  }
  const notifier = createDesktopNotifier({
    NotificationCtor: state.unsupported ? null : FakeNotification,
    getPermission: () => state.permission,
    requestPermission: async () => { state.requested += 1; return state.requestResult },
    focus: () => { calls.focus += 1 },
    isEnabled: () => state.enabled,
    onPermission: (p) => calls.permission.push(p),
    record: (entry) => calls.record.push(entry),
  })
  return { state, calls, notifier }
}

// ══ 标题闪烁（用例 1–8）════════════════════════════════════════════════

test('1 页面可见时完全不碰标题（人正盯着，别拿标题闪他）', () => {
  const h = makeTitle('工作台', false) // hidden = false
  h.tf.flash('assist')
  h.tf.flash('complete')
  assert.equal(h.setCalls.length, 0, 'setTitle 一次都不许调用')
  assert.equal(h.timers.size, 0, '也不许排恢复定时器')
})

test('2 页面不可见时闪一次：标题变为带图标前缀', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  assert.equal(h.state.title, '🔔 工作台')
  h.tf.flash('complete') // complete 用 ✅
  assert.equal(h.state.title, '✅(2) 工作台')
})

test('3 兜底定时器到点后恢复原标题', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  h.fireTimers()
  assert.equal(h.state.title, '工作台')
  assert.equal(h.tf.active(), false)
})

test('4 切回页面立即恢复，且清掉未到点的定时器', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  const timerId = [...h.timers.keys()][0]
  h.state.hidden = false
  h.tf.onVisibilityChange(false)
  assert.equal(h.state.title, '工作台', '切回来那一刻就要安静，不等 6 秒')
  assert.ok(h.cleared.includes(timerId), '未到点的定时器必须清掉')
  assert.equal(h.tf.active(), false)
})

test('5 连续两次闪烁：标题里只有一个图标（不出现 ✅✅ 这种累积）', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  h.tf.flash('assist')
  const icons = [...h.state.title].filter((c) => c === '✅' || c === '🔔')
  assert.equal(icons.length, 1, `图标累积了：${h.state.title}`)
})

test('6 标题已被上一代污染（带前缀）时，仍能剥离并正确恢复', () => {
  const h = makeTitle('🔔 被污染的标题', true)
  h.tf.flash('complete')
  assert.equal(h.state.title, '✅ 被污染的标题', '旧前缀要被剥掉，不是往上叠')
  h.state.hidden = false
  h.tf.onVisibilityChange(false)
  assert.equal(h.state.title, '被污染的标题', '恢复后的标题里一个图标都不剩')
})

test('7 闪烁期间前缀带待看条数：两条未看显示 🔔(2)', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  assert.equal(h.state.title, '🔔 工作台', '一条时不标数字')
  h.tf.flash('assist')
  assert.equal(h.state.title, '🔔(2) 工作台', '两条起标注待看条数')
  h.tf.flash('assist')
  assert.equal(h.state.title, '🔔(3) 工作台')
})

test('8 dispose 后：清定时器、恢复标题、之后不再改标题', () => {
  const h = makeTitle('工作台', true)
  h.tf.flash('assist')
  const timerId = [...h.timers.keys()][0]
  h.tf.dispose()
  assert.ok(h.cleared.includes(timerId))
  assert.equal(h.state.title, '工作台', 'dispose 要把标题还回去')
  const before = h.setCalls.length
  h.tf.flash('assist')
  h.tf.onVisibilityChange(false)
  assert.equal(h.setCalls.length, before, 'dispose 之后一次都不许再改标题')
})

// ══ 桌面通知（用例 9–16）══════════════════════════════════════════════

test('9 权限 granted 且开关开 → 发一条，标题/正文正确', async () => {
  const h = makeNotifier()
  const ok = await h.notifier.notify('assist', 'agent 在等你拍板')
  assert.equal(ok, true)
  assert.equal(h.calls.made.length, 1)
  assert.equal(h.calls.made[0].title, '需要你协助')
  assert.equal(h.calls.made[0].options.body, 'agent 在等你拍板')
})

test('10 开关关 → 一条都不发（也不碰权限）', async () => {
  const h = makeNotifier({ state: { enabled: false } })
  const ok = await h.notifier.notify('assist', 'x')
  assert.equal(ok, false)
  assert.equal(h.calls.made.length, 0)
  assert.equal(h.calls.record.length, 0, '关着开关是正常状态，不该刷记录')
})

test('11 权限 denied → 不发，且记一条可见提示（不能静默）', async () => {
  const h = makeNotifier({ state: { permission: 'denied' } })
  const ok = await h.notifier.notify('assist', 'x')
  assert.equal(ok, false)
  assert.equal(h.calls.made.length, 0)
  assert.equal(h.calls.record.length, 1)
  assert.ok(h.calls.record[0].text.includes('denied'), '提示里要点明权限状态')
})

test('12 权限 default → 先请求，授予后再发；拒绝则记提示；结果回写', async () => {
  const granted = makeNotifier({ state: { permission: 'default', requestResult: 'granted' } })
  const ok = await granted.notifier.notify('assist', 'x')
  assert.equal(ok, true)
  assert.equal(granted.state.requested, 1, '必须先请求权限')
  assert.equal(granted.calls.made.length, 1, '授予后这条要补发出去')
  assert.deepEqual(granted.calls.permission, ['granted'], '结果要回传给装配方刷新 UI')

  const denied = makeNotifier({ state: { permission: 'default', requestResult: 'denied' } })
  const ok2 = await denied.notifier.notify('assist', 'x')
  assert.equal(ok2, false)
  assert.equal(denied.calls.made.length, 0)
  assert.equal(denied.calls.record.length, 1)
  assert.deepEqual(denied.calls.permission, ['denied'])
})

test('13 浏览器不支持 → 不发、记「此浏览器不支持」', async () => {
  const h = makeNotifier({ state: { unsupported: true } })
  const ok = await h.notifier.notify('assist', 'x')
  assert.equal(ok, false)
  assert.equal(h.calls.made.length, 0)
  assert.ok(h.calls.record.some((r) => r.text.includes('此浏览器不支持')))
})

test('14 点击通知 → 聚焦窗口且关闭该通知', async () => {
  const h = makeNotifier()
  await h.notifier.notify('assist', 'x')
  const note = h.calls.made[0]
  assert.equal(typeof note.onclick, 'function', '点击行为必须挂上')
  note.onclick()
  assert.equal(h.calls.focus, 1, '点击 = 回到页面')
  assert.equal(note.closed, true, '点完要关掉这条通知')
})

test('15 同类别通知带同 tag（系统据此合并），且标题标注「第 N 条」', async () => {
  const h = makeNotifier()
  await h.notifier.notify('assist', '第一条')
  await h.notifier.notify('assist', '第二条')
  await h.notifier.notify('complete', '另一类的第一条')
  const [a, b, c] = h.calls.made
  assert.equal(a.options.tag, 'dsh-chime-assist')
  assert.equal(b.options.tag, 'dsh-chime-assist', '同类别同 tag，系统托盘最多堆一条')
  assert.equal(c.options.tag, 'dsh-chime-complete', '不同类别不互相顶掉')
  assert.equal(a.title, '需要你协助')
  assert.equal(b.title, '需要你协助（第 2 条）')
  assert.equal(c.title, '活干完了', '另一类别重新计数')
})

test('16 构造通知抛异常 → 记一条失败原因（不吞异常）', async () => {
  const h = makeNotifier({ state: { throwOnConstruct: true } })
  const ok = await h.notifier.notify('assist', 'x')
  assert.equal(ok, false)
  assert.equal(h.calls.record.length, 1)
  assert.ok(h.calls.record[0].text.includes('桌面通知失败'), '失败要落成用户可见的记录')
  assert.ok(h.calls.record[0].text.includes('系统通知服务不可用'), '原因也要写出来')
})

// ══ 权限请求单飞（用例 17–19，TASK-notify-complete 附录 A2）═══════════

test('17 权限 default 时并发三条通知 → requestPermission() 只被调用一次', async () => {
  const h = makeNotifier({ state: { permission: 'default', requestResult: 'granted' } })
  // 不 await 单个调用，三条真正并发地压上去
  await Promise.all([
    h.notifier.notify('assist', '一'),
    h.notifier.notify('assist', '二'),
    h.notifier.notify('assist', '三'),
  ])
  assert.equal(h.state.requested, 1, '进行中的请求必须复用同一个 Promise（去掉单飞本用例必须红）')
  assert.deepEqual(h.calls.permission, ['granted'], '结果回写一次就够，不该刷三次')
})

test('18 三条并发通知在「授予」结果下各自都弹（单飞不许吃掉后两条）', async () => {
  const h = makeNotifier({ state: { permission: 'default', requestResult: 'granted' } })
  await Promise.all([
    h.notifier.notify('assist', '一'),
    h.notifier.notify('assist', '二'),
    h.notifier.notify('assist', '三'),
  ])
  assert.equal(h.calls.made.length, 3, '授予后等待期间到达的每一条都要补弹')
  assert.equal(h.calls.record.length, 0, '授予成功不该留下任何失败记录')
})

test('19 三条并发通知在「拒绝」结果下只记一条提示（不刷屏）', async () => {
  const h = makeNotifier({ state: { permission: 'default', requestResult: 'denied' } })
  await Promise.all([
    h.notifier.notify('assist', '一'),
    h.notifier.notify('assist', '二'),
    h.notifier.notify('assist', '三'),
  ])
  assert.equal(h.calls.made.length, 0)
  assert.equal(h.state.requested, 1)
  const hints = h.calls.record.filter((r) => r.text.includes('桌面通知未弹出'))
  assert.equal(hints.length, 1, `他只是还没来得及点「允许」，不该看到 ${hints.length} 条失败记录`)
})
