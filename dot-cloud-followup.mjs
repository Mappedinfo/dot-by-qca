export function oldCloudFollowupIntent(text) {
  const match = /^(?:请\s*)?(?:让|在)\s*(?:旧|迁移前的?)\s*(?:QCA|Qoder\s*云端|云端)\s*子线程\s*(sthr_[a-z0-9_-]{1,95})\s*(?:里|中)?\s*(?:继续|续办)\s*[：:]\s*([\s\S]{1,2000})$/iu.exec(text.trim())
  const task = match?.[2].trim()
  if (task) return { threadId: match[1].toLowerCase(), task }
}

export function oldCloudResultIntent(text) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:查看|查询|查一下|看看|读回)\s*(?:旧(?:的)?\s*)?(?:QCA|云端)\s*(?:子线程\s*)?续办(?:结果|回执)\s*[：:]?\s*([a-f0-9]{20})\s*[。？！?!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export function oldCloudRelayText({ threadId, task, relayId }) {
  return [
    `这是从现 Dot 主会话转来的明确请求（${relayId}）。仅用 send_to_agent，向本会话已有子线程 ${threadId} 发送下面任务原文一次。等待真实线程回传。`,
    '不要启动其他线程、调用其他工具或自行执行。无法原样投递就直接返回失败。下面是任务原文：',
    task,
  ].join('\n')
}

function messageText(event) {
  return event.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || ''
}

export async function readOldCloudFollowup(client, item, signal) {
  let request
  let assignment
  let result
  let end
  let closed = false
  for await (const event of client.events(item.sessionId, item.cursor, undefined, signal)) {
    if (event.type === 'user.message') {
      if (request) {
        closed = true
        break
      }
      if (messageText(event) !== oldCloudRelayText(item)) continue
      request = event.id
    }
    if (!request) continue
    if (event.type === 'agent.thread_message_sent') {
      if (assignment || event.to_session_thread_id !== item.threadId || messageText(event).trim() !== item.task) {
        return { status: 'assignment_mismatch', requestEventId: request }
      }
      assignment = event.id
    }
    if (assignment && event.type === 'agent.thread_message_received' && event.from_session_thread_id === item.threadId) result = event
    if (event.type === 'session.status_idle') end = event.stop_reason?.type
    if (event.type === 'session.status_running') end = undefined
  }
  const evidence = { ...(request && { requestEventId: request }), ...(assignment && { assignmentEventId: assignment }) }
  if (!request) return { status: 'relay_pending' }
  if (closed && (end !== 'end_turn' || !result)) return { status: 'relay_ended', ...evidence }
  if (end === 'requires_action') return { status: 'requires_action', ...evidence }
  if (end !== 'end_turn') return { status: end ? 'relay_ended' : assignment ? 'dispatched' : 'relay_pending', ...evidence }
  if (!result) return { status: assignment ? 'no_result_yet' : 'not_dispatched', ...evidence }
  const output = messageText(result).trim()
  const finishedAt = Date.parse(result.processed_at)
  return { status: output ? 'result_received' : 'no_text_result', ...evidence, resultEventId: result.id,
    ...(Number.isFinite(finishedAt) && { finishedAt }),
    ...(output && { result: output.slice(0, 6000), truncated: output.length > 6000 }) }
}
