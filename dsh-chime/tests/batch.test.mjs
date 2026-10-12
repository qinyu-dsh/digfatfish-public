/**
 * 批次决策回归测试。
 *
 * 「只有一种声音」这个 bug 就出在这里：三条通知一起到达时，逐条循环 + 冷却把后面两条
 * 静默吃掉了。用户能看到的只是「怎么只响了一声」，在宿主侧完全查不出来。
 *
 * 这里不复制实现——直接从 lib/client.js 里抽出 decideBatch 的源码执行，
 * 所以测的就是线上跑的那份逻辑（改它就等于改测试）。
 *
 * 用法：node --test tests/batch.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 从 client 源码里取出 decideBatch 函数并求值成真函数。 */
function extractDecideBatch() {
  const start = source.indexOf('function decideBatch(')
  assert.ok(start >= 0, 'lib/client.js 里找不到 decideBatch —— 改名了就把这个测试一起改')
  // 从函数头开始按大括号配平截到函数尾（源码里有中文注释与模板串，配平比正则可靠）
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
  assert.ok(end > i, 'decideBatch 的大括号没配平')
  const code = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return decideBatch`)()
}

const decideBatch = extractDecideBatch()

/** 与 lib/client.js 里同名的两条线保持一致（改那边要一起改这里）。 */
const STALE = 120 * 1000
const FRESH = 120 * 1000
const priority = (kind) => (kind === 'assist' || kind === 'alert' ? 2 : 1)
const call = (items, now) => decideBatch(items, now, STALE, FRESH, priority)

const item = (seq, kind, ageMs, now) => ({ seq, kind, time: now - ageMs, title: `#${seq}` })

test('单条刚发生的通知：单独响它（最平常的情况）', () => {
  const now = 1_000_000
  const out = call([item(1, 'complete', 300, now)], now)
  assert.equal(out.play.seq, 1)
  assert.deepEqual(out.merged, [])
  assert.deepEqual(out.stale, [])
})

test('三条一起到达：只响最新那条，其余报「已合并」而不是静默丢掉', () => {
  const now = 1_000_000
  // 用户的真实场景：一条「活干完了」+ 两条试听，前后差不到 1 秒。
  // 三者优先级相同（都是非急类），所以取**最新**那条——用户最关心刚发生了什么。
  // 注意 age 越小越新：seq 3 = 400 ms 前，是最新的那条。
  const items = [item(1, 'complete', 900, now), item(2, 'test', 500, now), item(3, 'test', 400, now)]
  const out = call(items, now)
  assert.equal(out.play.seq, 3, '同类里取最新的那条')
  assert.deepEqual(out.merged.map((i) => i.seq), [1, 2], '其余全部报「已合并」，一条都不能静默丢')
  assert.equal(out.stale.length, 0)
})

test('一批里带「需要协助」时，急的那条胜出（不管谁先到）', () => {
  const now = 1_000_000
  const items = [item(1, 'complete', 700, now), item(2, 'assist', 200, now)]
  assert.equal(call(items, now).play.kind, 'assist')
  // 再来一批：assist 在前、complete 在后，也仍然是 assist
  const items2 = [item(1, 'assist', 700, now), item(2, 'complete', 200, now)]
  assert.equal(call(items2, now).play.kind, 'assist')
})

test('同类里取最新的那条', () => {
  const now = 1_000_000
  const items = [item(1, 'complete', 6000, now), item(2, 'complete', 100, now)]
  assert.equal(call(items, now).play.seq, 2)
})

test('太老的通知不响，但也不消失（记成过期）', () => {
  const now = 1_000_000
  const out = call([item(1, 'complete', STALE + 1, now)], now)
  assert.equal(out.play, null)
  assert.deepEqual(out.stale.map((i) => i.seq), [1])
})

test('边界：正好卡在寿命线上照样响，越过 1 ms 就算过期', () => {
  const now = 1_000_000
  // 这两条线现在合一（见 lib/client.js 的注释：8 秒→120 秒是因为后台节流把提醒吃掉了），
  // 但仍然要钉住边界方向——差一毫秒的判断最容易在改动时翻车。
  assert.equal(call([item(1, 'complete', FRESH, now)], now).play.seq, 1, '正好 FRESH_MS 仍算新鲜')
  const justOver = call([item(2, 'complete', FRESH + 1, now)], now)
  assert.equal(justOver.play, null, '超过寿命就不响')
  assert.deepEqual(justOver.stale.map((i) => i.seq), [2], '而且必须计入过期，不能悄悄消失')
})

test('后台切回来：一分钟前的提醒还是要响（这是放宽窗口的原因）', () => {
  const now = 1_000_000
  const out = call([item(1, 'assist', 60 * 1000, now)], now)
  assert.equal(out.play.seq, 1, '一分钟内切回来必须听得到——定时器被节流是浏览器的常态')
})

test('空批次不炸', () => {
  const out = call([], 1_000_000)
  assert.equal(out.play, null)
  assert.deepEqual(out.merged, [])
  assert.deepEqual(out.stale, [])
})

test('过期与新鲜混在一起：响新的，丢旧的', () => {
  const now = 1_000_000
  const items = [item(1, 'complete', STALE + 5, now), item(2, 'assist', 200, now)]
  const out = call(items, now)
  assert.equal(out.play.seq, 2)
  assert.deepEqual(out.stale.map((i) => i.seq), [1])
})
