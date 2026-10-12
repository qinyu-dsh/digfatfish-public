/**
 * dsh-chime 判定规则（纯函数，无副作用，可直接喂假事件测）。
 *
 * 这里决定的只有一件事：一条会话事件值不值得响铃、响哪一档。
 * 「同一轮里问过就不再响第二次」这类需要跨事件记忆的规则不在这里——
 * 它由宿主半边的 assistPending 表实现（见 lib/index.js）。
 */

/** 需要用户拍板的工具：调用即代表 agent 停下来了。 */
export const ASSIST_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

/**
 * turn 结束原因 → 通知类型。
 *
 * - completed       这一轮正常干完 → 舒缓
 * - blocked         agent 主动停下等人 → 急促
 * - error           模型/工具失败，需要人接手 → 急促
 *
 * 不在表里的（aborted / interrupted / max-tokens / forked）一律不响：
 * aborted 是用户自己按的停（再响铃就是自问自答），interrupted 与 max-tokens
 * 之后通常还有自动续跑，响早了会变成连环铃；forked 是会话复制，不是一次工作结束。
 */
export const TURN_END_REASON = {
  completed: 'complete',
  blocked: 'assist',
  error: 'assist',
}

/**
 * 判定一条会话事件。
 *
 * @param {{ type?: string, data?: any }} event 会话事件（只读 type 与 data）
 * @returns {{ kind: 'complete'|'assist', sound: string, title: string, detail: string } | null}
 */
export function decide(event) {
  if (!event || typeof event.type !== 'string') return null

  if (event.type === 'tool/call') {
    const name = String((event.data && event.data.name) || '')
    if (!ASSIST_TOOLS.has(name)) return null
    return {
      kind: 'assist',
      sound: 'assist',
      title: name === 'exit_plan_mode' ? '计划待你批准' : '有事情问你',
      detail: 'agent 停下来了，等你回话',
    }
  }

  if (event.type === 'turn/end') {
    const reason = event.data && event.data.reason
    const kind = reason && TURN_END_REASON[reason.kind]
    if (!kind) return null
    const turn = event.data && event.data.turn
    if (kind === 'complete') {
      return {
        kind: 'complete',
        sound: 'complete',
        title: '活干完了',
        detail: turn ? `第 ${turn} 轮结束` : '',
      }
    }
    return {
      kind: 'assist',
      sound: 'assist',
      title: reason.kind === 'error' ? '出错了，需要你看一眼' : '卡住了，等你发话',
      detail: reason.kind === 'error'
        ? String((reason.error && reason.error.message) || '').slice(0, 200)
        : '这一轮没有正常收尾',
    }
  }

  return null
}

/** 这条通知是否需要用户出面（客户端据此选音色；也用于设置页的说明文案）。 */
export function needsUser(kind) {
  return kind === 'assist'
}
