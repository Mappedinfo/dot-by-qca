const requestPattern = /^(?:请\s*)?(?:在|用)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*((?:session-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\s*(?:里|中)?\s*(?:继续|续办|发送)\s*[：:]\s*([\s\S]{1,2000})$/iu

export function dshFollowupIntent(text) {
  const match = requestPattern.exec(text.trim())
  if (!match?.[2].trim()) return
  return { sessionId: match[1], task: match[2].trim() }
}

export function dshFollowupResultIntent(text) {
  return /^(?:请\s*)?(?:查看|查一下|看看|查询|告诉我)\s*(?:DSH\s*)?续办(?:回执|结果)\s*([a-f0-9]{20})\s*[。？?！!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export function observeFollowup(records, requestId, state, { includeResult = false } = {}) {
  const events = records.map(record => record.event).filter(Boolean)
  const start = events.findIndex(event => event.type === 'user/message' && event.data?.source?.rpcId === requestId)
  if (start < 0) {
    const queued = state.queue?.some(item => item.rpcId === requestId)
    return { status: queued ? 'queued' : 'unconfirmed' }
  }
  const turn = events.slice(start + 1)
  const end = turn.findIndex(event => event.type === 'turn/end' || event.type === 'turn/start')
  const boundary = turn[end]
  if (boundary?.type !== 'turn/end') return { status: state.pendingInput?.length ? 'waiting' : state.running ? 'running' : 'unconfirmed' }
  const reason = boundary.data?.reason?.kind
  const status = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed'
  const reply = includeResult && status === 'completed' && turn.slice(0, end).findLast(event => event.type === 'assistant/message' &&
    !event.data?.interrupted && event.data?.message?.content?.some(block => block.type === 'text' && block.text?.trim()))
  const text = reply ? reply.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
  return { status, ...(reason && { reason }), finishedAtSeq: boundary.seq,
    ...(text && { result: text.slice(0, 6000), truncated: text.length > 6000 }) }
}

export async function readFollowup(dsh, item, signal, { includeResult = false } = {}) {
  const state = await dsh.state(item.sessionId, signal)
  const records = []
  let beforeSeq
  let observed
  for (let index = 0; index < 8; index++) {
    const page = await dsh.history(item.sessionId, signal, beforeSeq)
    records.unshift(...page.records)
    observed = observeFollowup(records, item.requestId, state, { includeResult })
    if (observed.status !== 'unconfirmed' || !page.hasMore) break
    const first = page.records[0]?.event?.seq
    if (!Number.isSafeInteger(first) || first === beforeSeq || first <= (item.startCursor ?? -1)) break
    beforeSeq = first
  }
  return observed
}
