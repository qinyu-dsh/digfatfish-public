/**
 * 设置页冒烟测试（TASK-settings-smoke.md）。两条腿：
 *
 * 一、纯逻辑单测（用例 1–12）：静音时段 / 音色解析 / 设置读写收敛 / 音色清单合并。
 *    全部从 lib/client.js 源码抽出执行（测的就是线上那份逻辑）。
 *
 * 二、UI 冒烟（用例 13–18）：用**极简 React stub** 渲染 createPanel 整棵组件树。
 *    钉住的是「至少能渲染出来、不抛异常」——它防的是那种「不会让插件挂掉、不会让
 *    现有测试变红、只会让用户点开设置页看到一片空白」的错（拼错属性名 / 引用不存在
 *    的变量 / hooks 用法不当）。
 *
 * 覆盖不到（诚实清单）：样式与布局、真实 React 的 hooks 语义（stub 的 useState 不会
 * 触发重渲染）、事件回调行为（onClick/onChange 只是被创建、从未被调用）、真实
 * localStorage / Notification。「冒烟绿了」只代表「树能建起来」。
 *
 * 硬约束遵守：不装 react / react-dom、不用 jsdom、零新依赖、不碰用户真实环境。
 *
 * 用法：node --test tests/settings-smoke.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * 抽一段声明。要同时伺候对象/数组字面量与函数声明，所以按形态分派：
 *
 *  - `const X = { ... }` / `const X = [ ... ]`：从第一个开括号起按通用括号配平（{ } [ ] ( ) 一起数）。
 *    为什么不能用「只数 {}」：`const HELP_TOPICS = [ { ... } ]` 这种以数组开头的声明，
 *    第一个 `{` 在数组内部，按 {} 配平会提前截断（真踩过）。
 *  - `function f(...) { ... }`：**跳过参数列表**，从函数体的 `{` 开始配平——否则会在参数列表的 `(`
 *    处就截断，返回一个没有函数体的残句（也真踩过）。
 */
function sliceDecl(marker) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `lib/client.js 里找不到「${marker}」—— 改名了就把这个测试一起改`)

  // 通用括号配平：depth 语义由调用方决定（整个表达式 / 仅函数体）
  const takeBalanced = (from) => {
    const OPEN = '([{'
    const CLOSE = ')]}'
    let i = from
    while (i < source.length && !OPEN.includes(source[i])) i += 1
    assert.ok(i < source.length, `「${marker}」后面没有开括号`)
    const stack = []
    for (let j = i; j < source.length; j += 1) {
      const ch = source[j]
      if (OPEN.includes(ch)) stack.push(ch)
      else if (CLOSE.includes(ch)) {
        stack.pop()
        if (stack.length === 0) return source.slice(start, j + 1)
      }
    }
    throw new Error(`「${marker}」的括号没配平`)
  }

  if (/^function\s/.test(marker)) {
    const paren = source.indexOf('(', start)
    assert.ok(paren >= 0, `「${marker}」没有参数列表`)
    const brace = source.indexOf('{', paren)
    assert.ok(brace >= 0, `「${marker}」没有函数体`)
    return takeBalanced(brace)
  }
  return takeBalanced(start)
}

// 纯逻辑：把相关声明一次性 eval 出来（声明之间的引用在同一段代码里成立）
const logic = new Function(`
  ${sliceDecl('const GAIN =')}
  ${sliceDecl('const SOUNDS =')}
  ${sliceDecl('const DEFAULTS =')}
  ${sliceDecl('function parseClock(')}
  ${sliceDecl('function inQuietHours(')}
  ${sliceDecl('function clampSettings(')}
  ${sliceDecl('function readSettingsFrom(')}
  ${sliceDecl('function soundOptionsOf(')}
  ${sliceDecl('function resolveSoundOf(')}
  ${sliceDecl('function soundPatchForDeleted(')}
  return { GAIN, SOUNDS, DEFAULTS, parseClock, inQuietHours, clampSettings, readSettingsFrom, soundOptionsOf, resolveSoundOf, soundPatchForDeleted }
`)()
const { DEFAULTS, inQuietHours, readSettingsFrom, soundOptionsOf, resolveSoundOf, soundPatchForDeleted } = logic

const at = (h, m) => new Date(2026, 0, 1, h, m)
const CUSTOMS = [
  { name: '我的铃', file: '我的铃.mp3', bytes: 20480 },
  { name: '木鱼', file: '木鱼.wav', bytes: 10240 },
]

// ══ 纯逻辑（用例 1–12）════════════════════════════════════════════════

test('1 静音时段：常规区间（09:00–17:00）内/外', () => {
  const s = { quietFrom: '09:00', quietTo: '17:00' }
  assert.equal(inQuietHours(s, at(10, 0)), true)
  assert.equal(inQuietHours(s, at(9, 0)), true, '起点含')
  assert.equal(inQuietHours(s, at(17, 0)), false, '终点不含')
  assert.equal(inQuietHours(s, at(18, 0)), false)
})

test('2 静音时段：跨零点（23:00–07:00）', () => {
  const s = { quietFrom: '23:00', quietTo: '07:00' }
  assert.equal(inQuietHours(s, at(23, 30)), true)
  assert.equal(inQuietHours(s, at(6, 0)), true)
  assert.equal(inQuietHours(s, at(12, 0)), false)
})

test('3 静音时段：from===to / 空串 / 非法值都视为不启用', () => {
  assert.equal(inQuietHours({ quietFrom: '08:00', quietTo: '08:00' }, at(8, 0)), false)
  assert.equal(inQuietHours({ quietFrom: '', quietTo: '' }, at(8, 0)), false)
  assert.equal(inQuietHours({ quietFrom: 'abc', quietTo: '25:61' }, at(8, 0)), false)
})

test('4 resolveSoundOf：内置四名各自解析到自己', () => {
  for (const name of ['complete', 'assist', 'alert', 'blip']) {
    const r = resolveSoundOf(name, [])
    assert.equal(r.file, name)
    assert.equal(typeof r.gain, 'number')
  }
})

test('5 resolveSoundOf：自定义名 → 用上传落盘的文件名（可能带 .mp3）', () => {
  const r = resolveSoundOf('我的铃', CUSTOMS)
  assert.equal(r.file, '我的铃.mp3', '不能直接拿音色名当文件名拼 URL')
  assert.equal(r.gain, 1, '用户自己的文件不该再被削一刀')
})

test('6 resolveSoundOf：未知名字 → 回退 blip 并说明（不能静默不响）', () => {
  const r = resolveSoundOf('不存在', CUSTOMS)
  assert.equal(r.file, 'blip')
  assert.ok(r.hint.includes('原音色已不可用'), 'hint 里必须告诉用户音色失效了')
})

test('7 soundOptionsOf：内置 + 自定义合并，自定义 gain === 1', () => {
  const opts = soundOptionsOf(CUSTOMS)
  assert.equal(opts.length, 4 + CUSTOMS.length)
  assert.equal(opts.filter((o) => o.builtin).length, 4)
  for (const o of opts.filter((o) => o.custom)) {
    assert.equal(o.gain, 1)
    assert.ok(o.file, '自定义项必须带落盘文件名')
  }
})

test('8 设置读写：localStorage 为空 → 全套默认值', () => {
  assert.deepEqual(readSettingsFrom(null), DEFAULTS)
  assert.deepEqual(readSettingsFrom(''), DEFAULTS)
})

test('9 设置读写：JSON 损坏 → 回默认值且不抛', () => {
  assert.deepEqual(readSettingsFrom('{oops'), DEFAULTS)
  assert.deepEqual(readSettingsFrom('不是json'), DEFAULTS)
})

test('10 设置读写：未知字段被忽略、缺失字段补默认', () => {
  const out = readSettingsFrom(JSON.stringify({ volume: 0.5, hacker: true }))
  assert.equal(out.volume, 0.5, '合法字段要保留')
  assert.equal('hacker' in out, false, '未知字段不许混进设置对象')
  assert.equal(out.enabled, DEFAULTS.enabled, '缺失字段补默认')
  assert.equal(out.assistSound, DEFAULTS.assistSound)
})

test('11 设置读写：volume 越界（负数 / >1 / 字符串）收敛到合法区间', () => {
  assert.equal(readSettingsFrom(JSON.stringify({ volume: -1 })).volume, 0)
  assert.equal(readSettingsFrom(JSON.stringify({ volume: 5 })).volume, 1)
  assert.equal(readSettingsFrom(JSON.stringify({ volume: 'abc' })).volume, DEFAULTS.volume)
})

test('12 自定义音色被删除后：清单里不再出现，正被选中的回退内置', () => {
  const opts = soundOptionsOf(CUSTOMS.filter((c) => c.name !== '我的铃'))
  assert.equal(opts.some((o) => o.name === '我的铃'), false)
  assert.deepEqual(
    soundPatchForDeleted({ completeSound: '我的铃', assistSound: 'assist' }, '我的铃'),
    { completeSound: 'complete' },
    '被指着的那个要回退内置，另一个不许动',
  )
  assert.deepEqual(
    soundPatchForDeleted({ completeSound: 'complete', assistSound: 'assist' }, '我的铃'),
    {},
    '没指着它就不许改任何设置',
  )
})

// ══ UI 冒烟（用例 13–18）══════════════════════════════════════════════

// 「怎么用」速查卡的两段声明。
// 关键：buildHelpNodes 引用了 HELP_TOPICS，所以**必须把它们放进同一个作用域**——
// 分开抽会得到 `HELP_TOPICS is not defined`（真踩过）。createPanel 内部同样会调 buildHelpNodes，
// 所以下面抽 createPanel 时也要带上这两段。
const helpInternals = new Function(`
  ${sliceDecl('const HELP_TOPICS =')};
  ${sliceDecl('function buildHelpNodes(')}
  return { HELP_TOPICS, buildHelpNodes }
`)()
const HELP_TOPICS_RAW = helpInternals.HELP_TOPICS
const buildHelpNodes = helpInternals.buildHelpNodes

const createPanel = new Function(`
  ${sliceDecl('const HELP_TOPICS =')};
  ${sliceDecl('function buildHelpNodes(')}
  ${sliceDecl('function createPanel(')}
  return createPanel
`)()

/** 极简 React stub：只承受组件树的结构与 props，不做真实渲染（任务单给的配方）。 */
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

function makeState(patch = {}) {
  const base = {
    settings: {
      enabled: true, volume: 0.85, quietFrom: '', quietTo: '',
      completeSound: 'complete', assistSound: 'assist',
      notifyDesktop: false, notifyTitle: true,
      escalateEnabled: true, escalateDelaySec: 30,
    },
    audioState: 'running',
    link: { ok: true, at: 1700000000000, error: '', pending: false, polls: 3 },
    mode: { push: true, since: 4 },
    customs: [],
    recent: [],
  }
  const out = { ...base, ...patch }
  if ('settings' in patch) {
    // settings: undefined 是「故意破坏必需输入」的用法，不能被默认值救活
    out.settings = patch.settings === undefined ? undefined : { ...base.settings, ...patch.settings }
  }
  return out
}

function makeDeps(statePatch = {}) {
  const state = makeState(statePatch)
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    update: () => {},
    poll: () => {},
    player: { unlock: async () => true, preload: async () => [], play: async () => true },
    uploadCustom: async () => ({}),
    deleteCustom: async () => ({}),
    resolveSound: (name) => ({ file: name, gain: 1, hint: name }),
    soundOptions: () => [
      ...['complete', 'assist', 'alert', 'blip'].map((name) => ({ name, label: name, hint: name })),
      ...state.customs.map((c) => ({ name: c.name, label: c.name, hint: '自定义' })),
    ],
    emit: () => {},
    getNotificationPermission: () => 'granted',
    requestNotificationPermission: async () => 'granted',
  }
}

/** 递归「渲染」：函数组件调起来，host 元素原样保留，孩子递归。 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      return render(node.type(node.props || {}))
    }
    if (node.props && node.props.children !== undefined) {
      return { ...node, props: { ...node.props, children: render(node.props.children) } }
    }
  }
  return node
}

/** 把渲染后的树拍平成「文本列表 + 元素列表」两个清单，供断言。 */
function flatten(node, out = { texts: [], els: [] }) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (typeof node === 'object') {
    if (node.type) out.els.push(node)
    if (node.props) flatten(node.props.children, out)
  }
  return out
}

function renderPanel(statePatch) {
  const { ChimePanel } = createPanel(stubReact, makeDeps(statePatch))
  return flatten(render(ChimePanel()))
}

test('13 正常设置渲染不抛异常，树非空', () => {
  const { texts, els } = renderPanel()
  assert.ok(els.length > 20, `树太空了（${els.length} 个元素）——像是只渲染了个壳`)
  assert.ok(texts.some((t) => t.includes('响铃提醒')))
})

test('14 树里能找到关键设置项文案', () => {
  const { texts } = renderPanel()
  for (const key of ['响过没人理就升级', '自定义铃声', '音量', '静音时段', '桌面通知', '标签页标题闪烁']) {
    assert.ok(texts.some((t) => t.includes(key)), `文案「${key}」不在树里`)
  }
})

test('15 边界输入渲染不抛：空/3 条 customs、超长 recent、非法 volume、失效音色名', () => {
  renderPanel({ customs: [] })
  renderPanel({ customs: CUSTOMS.concat([{ name: '第三只', file: '第三只.ogg', bytes: 1 }]) })
  renderPanel({ recent: Array.from({ length: 20 }, (_, i) => ({ time: 1700000000000 + i, kind: 'assist', ok: true, text: `第${i}条`, detail: '' })) })
  renderPanel({ recent: [] })
  renderPanel({ settings: { volume: 'abc' } })
  renderPanel({ settings: { completeSound: '已被删除的音色', assistSound: '也不存在' } })
})

test('16 关键控件都在：开关 / range / 两个下拉 / file input / 诊断按钮', () => {
  const { els, texts } = renderPanel({ customs: CUSTOMS })
  assert.ok(els.some((e) => e.props['aria-checked'] !== undefined && e.props.role === 'switch'), '开关不在')
  assert.ok(els.some((e) => e.type === 'input' && e.props.type === 'range'), '音量滑杆不在')
  assert.ok(els.filter((e) => e.type === 'select').length >= 2, '两个音色下拉不在')
  assert.ok(els.some((e) => e.type === 'input' && e.props.type === 'file'), '上传文件 input 不在')
  assert.ok(texts.some((t) => t.includes('看诊断信息')), '诊断按钮不在')
  assert.ok(texts.some((t) => t.includes('让宿主发一条测试通知')), '测试通知按钮不在')
})

test('17 总开关关闭（enabled: false）时的分支渲染不抛', () => {
  const { texts } = renderPanel({ settings: { enabled: false } })
  assert.ok(texts.some((t) => t.includes('已关闭')), '关闭分支的提示文案不在')
})

test('18 故意破坏一个必需输入会让渲染抛异常（证明冒烟测试有牙齿）', () => {
  // settings 是整个面板的必需输入；把它抽掉后若渲染仍不崩，说明上面那几条根本没测到东西
  const { ChimePanel } = createPanel(stubReact, makeDeps({ settings: undefined }))
  assert.throws(() => render(ChimePanel()), /undefined|Cannot read/)
})

// ══ 「怎么用」速查卡（19–21）══════════════════════════════════════════
// HELP_TOPICS_RAW / buildHelpNodes 已在上面 UI 冒烟区抽取（createPanel 需要它们在同一作用域），
// 这里复用，不再重复定义。
// 这段内容与 CHEATSHEET.md 同源同措辞，但没有自动同步机制（客户端 bundle 读不到文件系统），
// 所以用测试把「说明被删空 / 改坏」钉住——否则用户会看到一张空的「怎么用」。

test('19 速查卡渲染：分类名精确对上、关键条目都在结果里', () => {
  const nodes = buildHelpNodes(stubReact.createElement)
  const { texts } = flatten(render(nodes))
  // 分类名用**精确匹配**而不是 includes：否则「出问题先看哪」被改成
  // 「出问题先看哪(改坏了)」这类污染也照样通过（变异测试 M2 就是这么活下来的）。
  const missNames = ['什么时候响', '常用操作', '出问题先看哪', '要记住的取舍'].filter((n) => !texts.includes(n))
  assert.deepEqual(missNames, [], `分类名缺失或被改坏：texts=${JSON.stringify(texts).slice(0, 600)}`)
  const missKeys = ['解锁并加载', '静音时段', '没人理就升级', '让宿主发一条测试通知', '看诊断信息', '已合并']
    .filter((k) => !texts.some((t) => t.includes(k)))
  assert.deepEqual(missKeys, [], `条目缺失诊断：texts=${JSON.stringify(texts).slice(0, 600)}`)
})

test('20 速查卡出现在面板树里（不是只活在数据源里）', () => {
  const { texts } = renderPanel()
  assert.ok(texts.some((t) => t.includes('怎么用')), '面板里没有「怎么用」入口')
  assert.ok(texts.some((t) => t.includes('什么时候响')), '折叠卡的内容没进面板树')
})

test('21 速查数据源结构完整：分类都有名字、条目都不空、总量没被删过', () => {
  assert.ok(Array.isArray(HELP_TOPICS_RAW), 'HELP_TOPICS 应当是数组')
  assert.equal(HELP_TOPICS_RAW.length, 4, '分类数量变了就同步改 CHEATSHEET.md')
  let rows = 0
  for (const topic of HELP_TOPICS_RAW) {
    assert.ok(topic.name && topic.name.length > 0, '分类缺名字')
    assert.ok(Array.isArray(topic.rows) && topic.rows.length >= 2, `分类「${topic.name}」条目太少`)
    for (const [what, how] of topic.rows) {
      assert.ok(what && how, `分类「${topic.name}」里有空条目`)
      rows += 1
    }
  }
  assert.ok(rows >= 12, `速查条目太少（${rows} 条）——像是被删过`)
})
