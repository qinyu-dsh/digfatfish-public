/**
 * 「响过没人理就升级」升级计划回归测试。
 *
 * 与 batch.test.mjs 同款手法：不复制实现，直接从 lib/client.js 里抽出
 * buildEscalationPlan 的源码执行——测的就是线上跑的那份逻辑。
 *
 * 要钉住的规则（HANDOFF §6）：
 *  - 只追「需协助」类；完成音不追着人跑；
 *  - 首响后 firstDelay 没人理 → ×1.3；再 +45 s → ×1.6；再 +45 s → ×1.9；
 *  - 最多 3 次（可配置，封顶 5），别无限轰炸；
 *  - 首次延迟收敛到 5–600 秒，非法输入落回默认 30 秒。
 *
 * 用法：node --test tests/escalation.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 从 client 源码里取出 buildEscalationPlan 函数并求值成真函数。 */
function extractPlan() {
  const start = source.indexOf('function buildEscalationPlan(')
  assert.ok(start >= 0, 'lib/client.js 里找不到 buildEscalationPlan —— 改名了就把这个测试一起改')
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
  assert.ok(end > i, 'buildEscalationPlan 的大括号没配平')
  const code = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return buildEscalationPlan`)()
}

const plan = extractPlan()

test('完成音不追着人跑：complete / merged 不生成升级计划', () => {
  assert.deepEqual(plan('complete', true, 30000, 3), [])
  assert.deepEqual(plan('merged', true, 30000, 3), [])
})

test('开关关掉就不升级，与类别无关', () => {
  assert.deepEqual(plan('assist', false, 30000, 3), [])
  assert.deepEqual(plan('alert', false, 30000, 3), [])
})

test('需协助类（assist/alert/test）默认节奏：30 s → +45 s → +45 s，音量 ×1.3/×1.6/×1.9', () => {
  for (const kind of ['assist', 'alert', 'test']) {
    const steps = plan(kind, true, 30000, 3)
    assert.deepEqual(steps.map((s) => s.delayMs), [30000, 75000, 120000], `${kind} 的节奏`)
    assert.deepEqual(steps.map((s) => s.gainScale), [1.3, 1.6, 1.9], `${kind} 的增益递增`)
  }
})

test('首次延迟可配置：10 秒则整体节奏跟着平移', () => {
  const steps = plan('assist', true, 10000, 3)
  assert.deepEqual(steps.map((s) => s.delayMs), [10000, 55000, 100000])
})

test('首次延迟收敛到 5–600 秒，非法输入落回默认 30 秒', () => {
  assert.equal(plan('assist', true, 100, 3)[0].delayMs, 5000, '太小抬到 5 秒')
  assert.equal(plan('assist', true, 99999999, 3)[0].delayMs, 600000, '太大压到 600 秒')
  assert.equal(plan('assist', true, NaN, 3)[0].delayMs, 30000, 'NaN 回默认')
  assert.equal(plan('assist', true, 'abc', 3)[0].delayMs, 30000, '字符串垃圾回默认')
})

test('次数可配置但封顶 5：1 次就 1 步，100 次也只给 5 步', () => {
  assert.equal(plan('assist', true, 30000, 1).length, 1)
  assert.equal(plan('assist', true, 30000, 100).length, 5)
})

test('次数非法输入落回默认 3 次', () => {
  assert.equal(plan('assist', true, 30000, 0).length, 3)
  assert.equal(plan('assist', true, 30000, NaN).length, 3)
  assert.equal(plan('assist', true, 30000, undefined).length, 3)
})

test('增益单调递增（封顶由播放处 clamp 到 1.0 负责，计划本身只管递增）', () => {
  const steps = plan('assist', true, 30000, 5)
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i].gainScale > steps[i - 1].gainScale, '必须一轮比一轮响')
  }
})
