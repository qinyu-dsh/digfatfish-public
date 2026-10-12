/**
 * dsh-chime 判定规则回归测试。
 *
 * 这些断言直接对应 README 的「触发规则表」——表改了这里必须一起改，
 * 否则「少响一次」这种 bug 只会在用户那儿表现为「怎么没响」而无法复现。
 *
 * 用法：node tests/rules.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, ASSIST_TOOLS, TURN_END_REASON } from '../lib/rules.js'

const turnEnd = (kind, extra = {}) => ({ type: 'turn/end', data: { turn: 3, reason: { kind, ...extra } } })
const toolCall = (name) => ({ type: 'tool/call', data: { name, callId: 'c1', arguments: '{}' } })

test('完成的回合响舒缓铃', () => {
  const d = decide(turnEnd('completed'))
  assert.equal(d.kind, 'complete')
  assert.equal(d.sound, 'complete')
  assert.equal(d.title, '活干完了')
  assert.match(d.detail, /第 3 轮/)
})

test('blocked / error 响急促铃', () => {
  assert.equal(decide(turnEnd('blocked')).kind, 'assist')
  const err = decide(turnEnd('error', { error: { message: '503 upstream', code: 'x' } }))
  assert.equal(err.kind, 'assist')
  assert.match(err.detail, /503 upstream/)
})

test('用户自己停的、被中断的、超长的、fork 的都不响', () => {
  for (const kind of ['aborted', 'interrupted', 'max-tokens', 'forked']) {
    assert.equal(decide(turnEnd(kind)), null, `${kind} 不该响铃`)
  }
})

test('未知 reason 不响（会话格式演进时宁可静默）', () => {
  assert.equal(decide({ type: 'turn/end', data: { turn: 1, reason: { kind: 'brand-new-reason' } } }), null)
  assert.equal(decide({ type: 'turn/end', data: { turn: 1 } }), null)
})

test('提问工具与计划批准响急促铃', () => {
  const ask = decide(toolCall('ask_user_question'))
  assert.equal(ask.kind, 'assist')
  assert.equal(ask.title, '有事情问你')
  const plan = decide(toolCall('exit_plan_mode'))
  assert.equal(plan.kind, 'assist')
  assert.equal(plan.title, '计划待你批准')
})

test('普通工具调用不响（否则每读一个文件都响一次）', () => {
  for (const name of ['read', 'bash', 'grep', 'write', 'todo_write', 'subagent']) {
    assert.equal(decide(toolCall(name)), null, `${name} 不该响铃`)
  }
})

test('无关事件类型不响', () => {
  for (const type of ['step/start', 'step/end', 'assistant/message', 'user/message', 'tool/result', 'turn/start']) {
    assert.equal(decide({ type, data: {} }), null)
  }
  assert.equal(decide(null), null)
  assert.equal(decide({}), null)
  assert.equal(decide({ type: 42 }), null)
})

test('规则表是一份事实：ASSIST_TOOLS 与 TURN_END_REASON 的内容被钉住', () => {
  assert.deepEqual([...ASSIST_TOOLS].sort(), ['ask_user_question', 'exit_plan_mode'])
  assert.deepEqual(TURN_END_REASON, { completed: 'complete', blocked: 'assist', error: 'assist' })
})
