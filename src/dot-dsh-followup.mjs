const sessionIdPattern = /^(?:session-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu
const requestPattern = /^(?:请\s*)?(?:在|用)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*(?:「([^」\p{Cc}\p{Cf}]{1,180})」|『([^』\p{Cc}\p{Cf}]{1,180})』|([^「」『』\p{Cc}\p{Cf}]{1,180}?))\s*(?:里|中)?\s*(?:继续|续办|发送)\s*[：:]\s*([\s\S]{1,2000})$/iu

export function dshFollowupIntent(text) {
  const match = requestPattern.exec(text.trim())
  if (!match) return
  const reference = (match[1] ?? match[2] ?? match[3]).trim()
  const task = match[4].trim()
  if (!reference || !task) return
  return { ...(sessionIdPattern.test(reference) ? { sessionId: reference } : { title: reference }), task }
}

export function dshStopIntent(text) {
  const match = /^(?:请\s*)?(?:帮我\s*)?(?:停止|中止|取消)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*(?:「([^」\p{Cc}\p{Cf}]{1,180})」|『([^』\p{Cc}\p{Cf}]{1,180})』|([^「」『』\p{Cc}\p{Cf}。？?！!]{1,180}?))\s*[。！!]?$/iu.exec(text.trim())
  const reference = match && (match[1] ?? match[2] ?? match[3]).trim()
  if (!reference) return
  return sessionIdPattern.test(reference) ? { sessionId: reference } : { title: reference }
}

export function dshFollowupResultIntent(text) {
  return /^(?:请\s*)?(?:查看|查一下|看看|查询|告诉我)\s*(?:DSH\s*)?续办(?:回执|结果)\s*([a-f0-9]{20})\s*[。？?！!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export function dshSessionResultIntent(text) {
  const input = text.trim().replace(/[。？?！!]$/u, '')
  const query = /^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询|读回|告诉我)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*(?:的)?\s*(?:最新(?:一轮的?)?结果|最新交付|最近结果)(?:\s*[：:]\s*|\s+)([^\p{Cc}\p{Cf}]{1,180})$/iu.exec(input)?.[1]
  return query?.trim() || undefined
}

export function dshTurnResultIntent(text) {
  const match = /^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询|读回)\s*(?:Mac\s*)?DSH\s*(?:对话\s*)?结果\s*[:：]?\s*([a-f0-9-]+|session-[a-f0-9-]+)\s+#\s*([0-9]{1,16})\s*[。？?！!]?$/iu.exec(text.trim())
  if (!match || !sessionIdPattern.test(match[1])) return
  const finishedAtSeq = Number(match[2])
  if (Number.isSafeInteger(finishedAtSeq)) return { sessionId: match[1].toLowerCase(), finishedAtSeq }
}

const terminalStatus = reason => reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed'

export async function readStoppedTurn(dsh, item, signal) {
  const state = await dsh.state(item.session.id, signal)
  if (!Number.isSafeInteger(state.cursor) || state.cursor <= item.cursor) return
  let before
  for (let i = 0; i < 8; i++) {
    const page = await dsh.history(item.session.id, signal, before, state.cursor)
    const events = page.records.map(record => record.event)
    const end = events.find(event => event?.type === 'turn/end' && event.seq > item.cursor && event.data?.turn === item.turn)
    if (end?.data.reason?.kind) return { status: terminalStatus(end.data.reason.kind), reason: end.data.reason.kind,
      finishedAtSeq: end.seq, running: state.running, queued: state.queue?.length ?? null }
    const first = events[0]?.seq
    if (!page.hasMore || !Number.isSafeInteger(first) || first <= item.cursor || (before !== undefined && first >= before)) return
    before = first
  }
}

function finalReply(events) {
  const reply = events.findLast(event => event.type === 'assistant/message' && !event.data?.interrupted &&
    event.data?.message?.content?.some(block => block.type === 'text' && block.text?.trim()))
  const text = reply?.data.message.content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n') || ''
  return text ? { result: text.slice(0, 6000), truncated: text.length > 6000 } : {}
}

export function observedTurnEnd(records, previous, { includeTime = false } = {}) {
  const newer = event => Number.isSafeInteger(previous.cursor) ? event.seq > previous.cursor : event.time >= previous.checkedAt
  const boundaries = records.map(({ event }) => event)
    .filter(event => (event?.type === 'turn/start' || event?.type === 'turn/end') && newer(event))
  const boundary = boundaries.at(-1)
  if (boundary?.type !== 'turn/end' || !boundary.data?.reason?.kind) return
  const status = terminalStatus(boundary.data.reason.kind)
  return includeTime ? { status, finishedAtSeq: boundary.seq, finishedAt: boundary.time } : status
}

export async function scanDshCompletions(dsh, row, prior, since, signal) {
  const pending = prior?.pending
  const page = await dsh.history(row.id, signal, pending?.before, pending?.through)
  if (!Number.isSafeInteger(page.cursor) || (pending && page.cursor !== pending.through)) throw new Error('DSH history cut changed')
  const cursor = prior?.cursor <= page.cursor ? prior.cursor : -1
  const events = page.records.map(record => record.event)
  const ends = events.filter(event => event?.type === 'turn/end' && event.data?.reason?.kind === 'completed' &&
    Number.isSafeInteger(event.seq) && event.seq > cursor && Number.isFinite(event.time) && event.time >= since)
  const first = events[0]
  const done = !page.hasMore || first?.seq <= cursor || events.every(event => Number.isFinite(event?.time) && event.time < since)
  if (!done && (!Number.isSafeInteger(first?.seq) || (pending && first.seq >= pending.before))) throw new Error('DSH history did not advance')
  const updatedAt = pending?.updatedAt ?? row.updatedAt
  return {
    cursor: done ? page.cursor : cursor,
    updatedAt,
    ...(done ? {} : { pending: { through: page.cursor, before: first.seq, updatedAt } }),
    ends: ends.map(event => ({ finishedAt: event.time, finishedAtSeq: event.seq })),
  }
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
  const status = terminalStatus(reason)
  return { status, ...(reason && { reason }), finishedAtSeq: boundary.seq,
    ...(Number.isFinite(boundary.time) && { finishedAt: boundary.time }),
    ...(includeResult && status === 'completed' && finalReply(turn.slice(0, end))) }
}

export async function readSessionResult(dsh, sessionId, signal, { finishedAtSeq } = {}) {
  let through = finishedAtSeq
  if (finishedAtSeq === undefined) {
    const state = await dsh.state(sessionId, signal)
    if (state.pendingInput?.length) return { status: 'waiting' }
    if (state.running) return { status: 'running' }
    if (state.queue?.length) return { status: 'queued' }
    if (!Number.isSafeInteger(state.cursor) || state.cursor < -1) return { status: 'unconfirmed' }
    if (state.cursor === -1) return { status: 'no_turn' }
    through = state.cursor
  }

  const events = []
  let beforeSeq
  for (let index = 0; index < 8; index++) {
    const page = await dsh.history(sessionId, signal, beforeSeq, through)
    const batch = page.records.map(record => record.event).filter(Boolean)
    if (index === 0 && finishedAtSeq !== undefined && !batch.some(event =>
      event.seq === finishedAtSeq && event.type === 'turn/end')) return { status: 'turn_not_found' }
    events.unshift(...batch)
    const end = finishedAtSeq === undefined
      ? events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
      : events.findIndex(event => event.seq === finishedAtSeq && event.type === 'turn/end')
    if (events[end]?.type === 'turn/start') return { status: 'unconfirmed' }
    if (end >= 0) {
      const boundary = events[end]
      const reason = boundary.data?.reason?.kind
      if (!reason) return { status: 'unconfirmed' }
      const status = terminalStatus(reason)
      const start = events.findLastIndex((event, i) => i < end && (event.type === 'turn/start' || event.type === 'turn/end'))
      const base = { status, reason, finishedAtSeq: boundary.seq, ...(Number.isFinite(boundary.time) && { finishedAt: boundary.time }) }
      if (status !== 'completed') return base
      if (events[start]?.type === 'turn/start' && Number.isSafeInteger(boundary.data.turn) && events[start].data?.turn === boundary.data.turn) {
        return { ...base, ...finalReply(events.slice(start + 1, end)) }
      }
      if (start >= 0 || !page.hasMore) return { ...base, output: 'turn_boundary_unconfirmed' }
    }
    if (!page.hasMore) return { status: 'no_turn' }
    const firstSeq = batch[0]?.seq
    if (!Number.isSafeInteger(firstSeq) || (beforeSeq !== undefined && firstSeq >= beforeSeq)) break
    beforeSeq = firstSeq
  }
  return { status: 'unconfirmed' }
}

export async function readFollowup(dsh, item, signal, { includeResult = false } = {}) {
  const state = await dsh.state(item.sessionId, signal)
  const throughSeq = Number.isSafeInteger(item.finishedAtSeq) ? item.finishedAtSeq : state.cursor
  const records = []
  let beforeSeq
  let observed
  for (let index = 0; index < 8; index++) {
    const page = await dsh.history(item.sessionId, signal, beforeSeq, throughSeq)
    records.unshift(...page.records)
    observed = observeFollowup(records, item.requestId, state, { includeResult })
    if (observed.status !== 'unconfirmed' || !page.hasMore) break
    const first = page.records[0]?.event?.seq
    if (!Number.isSafeInteger(first) || first === beforeSeq || first <= (item.startCursor ?? -1)) break
    beforeSeq = first
  }
  return observed
}
