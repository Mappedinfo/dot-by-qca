import { readFile } from 'node:fs/promises'
import { DOT_TASKBOOK_TOOL } from './qca.mjs'

const ttl = 45_000
export const recentWindow = 7 * 86400_000
const visibleStates = new Set(['running', 'waiting', 'idle', 'archived', 'completed', 'failed', 'cancelled', 'unknown'])
const sourcePattern = /^[a-f0-9-]{36}$/
const sessionPattern = /^[a-zA-Z0-9_-]{1,100}$/
const clean = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 180) : ''
const followupPriority = { waiting: 0, running: 1, queued: 2, sending: 2, unconfirmed: 3 }
const activeStates = new Set(['running', 'waiting'])
const terminalStates = new Set(['completed', 'failed', 'cancelled'])
const runStates = new Set(['started', 'completed', 'failed', 'cancelled', 'expired', 'not_run'])
const relayStates = new Map([
  ['relay_pending', 'sending'], ['dispatched', 'running'], ['requires_action', 'waiting'],
  ['no_result_yet', 'unconfirmed'], ['result_received', 'completed'], ['no_text_result', 'completed'],
  ['relay_rejected', 'failed'], ['assignment_mismatch', 'failed'], ['not_dispatched', 'failed'], ['relay_ended', 'failed'],
])

export function cloudAssignmentTitle(event) {
  for (const block of event.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    for (const line of block.text.split(/\r?\n/u)) {
      const title = clean(line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/u, ''))
      if (title) return Array.from(title).slice(0, 96).join('')
    }
  }
}

function cloudCompletions(sessionId, events, now) {
  const ended = new Map()
  const replies = new Map()
  const assignments = new Map()
  for (const event of events) {
    if (event.type === 'agent.thread_message_sent' && event.to_session_thread_id) {
      const id = event.to_session_thread_id
      const title = assignments.has(id) ? undefined : event.assignmentTitle ?? cloudAssignmentTitle(event)
      assignments.set(id, title)
      continue
    }
    const at = Date.parse(event.processed_at)
    if (!Number.isFinite(at) || now - at > recentWindow || at > now) continue
    if (event.type === 'session.thread_status_idle' && event.session_thread_id && event.stop_reason?.type !== 'requires_action') {
      if (event.stop_reason?.type === 'end_turn') {
        ended.set(event.session_thread_id + ':' + event.processed_at, assignments.get(event.session_thread_id))
      }
      assignments.delete(event.session_thread_id)
    }
    if (event.type === 'agent.thread_message_received' && event.from_session_thread_id && event.id) {
      const key = event.from_session_thread_id + ':' + event.processed_at
      if (!replies.has(key)) replies.set(key, new Map())
      replies.get(key).set(event.id, { id: event.from_session_thread_id, resultEventId: event.id, finishedAt: at })
    }
  }
  // QCA emits the idle marker and the delivered reply with the same timestamp.
  // An ambiguous match is not evidence that a particular turn completed.
  return [...replies].flatMap(([key, matches]) => ended.has(key) && matches.size === 1
    ? [{ ...matches.values().next().value, cloudSessionId: sessionId, title: ended.get(key) || 'QCA 子线程任务' }]
    : [])
}

export function macRunReceipt(record, receipt) {
  if (!/^[a-f0-9]{20}$/.test(receipt) || record?.receipt !== receipt || !/^sess_[a-z0-9_-]{1,100}$/i.test(record.qcaSessionId) ||
    !/^evt_[a-z0-9_-]{1,100}$/i.test(record.eventId) || !runStates.has(record.status)) return
  const { qcaSessionId: cloudSessionId, status, dshSessionId, startedAt, finishedAt } = record
  return { receipt, cloudSessionId, status, title: clean(record.title) || 'Dot 发出的 Mac 任务',
    ...(typeof dshSessionId === 'string' && sessionPattern.test(dshSessionId) && { sessionId: dshSessionId }),
    ...(Number.isFinite(startedAt) && { startedAt }), ...(Number.isFinite(finishedAt) && { finishedAt }) }
}

export function macRunResultIntent(text) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询|读回)\s*Mac\s*(?:DSH\s*)?(?:任务(?:的)?(?:回执|结果)|回执)\s*[:：]?\s*([a-f0-9]{20})\s*[。？?！!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export class Taskbook {
  constructor(file, save) {
    this.file = file
    this.save = save
    this.sources = {}
    this.cloud = {}
    this.followups = {}
    this.cloudFollowups = {}
    this.macRuns = new Map()
    this.localTracking = Object.create(null)
    this.dshHistory = Object.create(null)
    this.dshHistoryAttempts = new Map()
    this.dshHistoryExcluded = new Set()
    this.pending = Promise.resolve()
  }

  async load() {
    const saved = await readFile(this.file, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return {}
    })
    this.sources = saved.sources || {}
    this.cloud = saved.cloud || {}
    this.followups = saved.followups || {}
    this.cloudFollowups = saved.cloudFollowups || {}
    Object.assign(this.localTracking, saved.localTracking)
    Object.assign(this.dshHistory, saved.dshHistory)
    this.dshHistoryExcluded = new Set(saved.dshHistoryExcluded)
    if (!saved.localTracking) {
      for (const snapshot of Object.values(this.sources).sort((a, b) => a.checkedAt - b.checkedAt)) {
        for (const row of snapshot.rows) {
          if (activeStates.has(row.status)) {
            this.localTracking[row.id] = { id: row.id, status: row.status, cursor: row.cursor, checkedAt: snapshot.checkedAt }
          } else if (row.observed) delete this.localTracking[row.id]
        }
      }
    }
  }

  acceptMacRun(receipt, record) {
    const run = macRunReceipt(record, receipt)
    if (run) this.macRuns.set(receipt, run)
  }

  macRun(receipt, activeRun) {
    const run = this.macRuns.get(receipt)
    if (!run || run.status !== 'started') return run
    return { ...run, status: run.receipt === activeRun?.receipt ? activeRun.status : 'unconfirmed' }
  }

  acceptCloudFollowup({ relayId, sessionId, threadId, sourceSessionId, createdAt }, observation, checkedAt = Date.now()) {
    const prior = this.cloudFollowups[relayId]
    const status = relayStates.get(observation.status)
    if (!status || terminalStates.has(prior?.status) || checkedAt < (prior?.checkedAt ?? 0)) return false
    const { resultEventId, finishedAt } = observation
    this.cloudFollowups[relayId] = { receipt: relayId, cloudSessionId: sessionId, threadId, sourceSessionId,
      status, checkedAt, createdAt: prior?.createdAt ?? createdAt ?? checkedAt,
      ...(resultEventId && { resultEventId }), ...(Number.isFinite(finishedAt) && { finishedAt }) }
    return true
  }

  acceptLocal({ source, rows, omitted = 0, eligibleIds, historyExcluded }, now = Date.now()) {
    if (typeof source !== 'string' || !sourcePattern.test(source) || !Array.isArray(rows) || rows.length > 120) return false
    const local = rows.flatMap(row => {
      if (!row || typeof row.id !== 'string' || !sessionPattern.test(row.id) || !visibleStates.has(row.status)) return []
      const { id, status } = row
      const title = clean(row.title) || id
      const updatedAt = Number.isFinite(row.updatedAt) && row.updatedAt > 0 ? Math.min(now, row.updatedAt) : now
      const cursor = Number.isSafeInteger(row.cursor) ? row.cursor : undefined
      const outcome = status === 'completed' && Number.isSafeInteger(row.finishedAtSeq) &&
        Number.isFinite(row.finishedAt) && row.finishedAt > 0 && row.finishedAt <= now
        ? { finishedAt: row.finishedAt, finishedAtSeq: row.finishedAtSeq } : {}
      return [{ id, title, status, updatedAt, ...outcome, ...(cursor !== undefined && { cursor }), observed: row.observed === true || (row.observed === undefined &&
        ['running', 'waiting'].includes(status)) }]
    })
    if (eligibleIds) {
      for (const id of Object.keys(this.localTracking)) if (!eligibleIds.has(id)) delete this.localTracking[id]
      if (historyExcluded) {
        this.dshHistoryExcluded = new Set(historyExcluded)
        for (const id of this.dshHistoryExcluded) delete this.dshHistory[id]
      }
    }
    for (const row of local) {
      const previous = this.localTracking[row.id]
      const newerCursor = Number.isSafeInteger(row.cursor) && row.cursor > (previous?.cursor ?? -1)
      const active = row.observed && activeStates.has(row.status) && (!terminalStates.has(previous?.status) || newerCursor)
      if (active || eligibleIds && terminalStates.has(row.status)) {
        if (Number.isSafeInteger(previous?.cursor) && !(row.cursor >= previous.cursor)) continue
        this.localTracking[row.id] = { id: row.id, status: row.status, cursor: row.cursor, checkedAt: now,
          ...(row.finishedAt && { finishedAt: row.finishedAt, finishedAtSeq: row.finishedAtSeq }) }
      } else if (eligibleIds && row.status === 'idle') delete this.localTracking[row.id]
    }
    this.sources[source] = { checkedAt: now, rows: local, omitted: Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0 }
    for (const key of Object.keys(this.sources)) {
      if (key !== source && now - this.sources[key].checkedAt > 30 * 24 * 3600_000) delete this.sources[key]
    }
    return true
  }

  historyCandidates(rows, now = Date.now()) {
    return rows.filter(row => {
      if (this.dshHistoryExcluded.has(row.id)) return false
      if (row.updatedAt < now - recentWindow && !this.dshHistory[row.id]?.pending) return false
      const before = this.dshHistory[row.id]
      return !before || before.pending || row.updatedAt !== before.updatedAt ||
        (Number.isSafeInteger(row.cursor) && row.cursor !== before.cursor)
    }).sort((a, b) => (this.dshHistoryAttempts.get(a.id) ?? 0) - (this.dshHistoryAttempts.get(b.id) ?? 0)).slice(0, 8)
  }

  acceptDshHistory(row, { cursor, updatedAt, pending, ends }, now = Date.now()) {
    const completed = new Map()
    for (const end of [...(this.dshHistory[row.id]?.completed || []), ...ends]) {
      if (end.finishedAt >= now - recentWindow) completed.set(`${end.finishedAtSeq}:${end.finishedAt}`, end)
    }
    this.dshHistory[row.id] = { title: clean(row.title) || row.id, cursor, updatedAt, pending, completed: [...completed.values()] }
    for (const [id, history] of Object.entries(this.dshHistory)) {
      if (history.updatedAt < now - recentWindow && !history.pending &&
        history.completed.every(item => item.finishedAt < now - recentWindow)) {
        delete this.dshHistory[id]
        this.dshHistoryAttempts.delete(id)
      }
    }
  }

  acceptCloud(sessionId, threads, events, now = Date.now()) {
    const history = [...events]
    const latest = new Map()
    const replies = new Map()
    const assignments = new Map()
    for (const event of history) {
      if (event.type?.startsWith('session.thread_status_') && event.session_thread_id) latest.set(event.session_thread_id, event)
      if (event.type === 'agent.thread_message_received' && event.from_session_thread_id) replies.set(event.from_session_thread_id, event)
      if (event.type === 'agent.thread_message_sent' && event.to_session_thread_id) {
        if (!assignments.has(event.to_session_thread_id)) {
          assignments.set(event.to_session_thread_id, event.assignmentTitle ?? cloudAssignmentTitle(event))
        }
        replies.delete(event.to_session_thread_id)
      }
    }
    const children = threads.filter(row => row.parent_thread_id || row.role === 'child')
    const childIds = new Set(children.map(row => row.id))
    const completions = cloudCompletions(sessionId, history, now).filter(row => childIds.has(row.id))
    const rows = children.map(row => {
      const event = latest.get(row.id)
      const reply = replies.get(row.id)
      const status = row.archived_at ? 'archived' : ['running', 'rescheduling', 'pending', 'canceling'].includes(row.status) ? 'running'
        : row.status === 'terminated' ? 'archived'
          : event?.stop_reason?.type === 'requires_action' ? 'waiting'
            : row.status === 'idle' && event?.stop_reason?.type === 'end_turn' && reply ? 'completed'
              : row.status === 'idle' ? 'idle' : 'unknown'
      const agent = clean(row.agent_name || row.agent?.name)
      const title = clean(row.title)
      const assignment = assignments.get(row.id)
      const finishedAt = Date.parse(reply?.processed_at)
      return { id: row.id, title: title && title !== agent ? title : assignment || agent || title || row.id,
        updatedAt: Date.parse(row.updated_at) || now, status, ...(reply && { resultEventId: reply.id }),
        ...(status === 'completed' && Number.isFinite(finishedAt) && { finishedAt }) }
    })
    this.cloud[sessionId] = { checkedAt: now, completions, rows }
  }

  persist() {
    const value = structuredClone({ sources: this.sources, cloud: this.cloud, followups: this.followups,
      cloudFollowups: this.cloudFollowups, localTracking: this.localTracking,
      dshHistory: this.dshHistory, dshHistoryExcluded: [...this.dshHistoryExcluded] })
    const pending = this.pending.catch(() => {}).then(() => this.save(this.file, value))
    this.pending = pending
    return pending
  }

  snapshot(sessionId, now = Date.now(), earlierSessions = [], activeRun) {
    const rows = new Map()
    let localCheckedAt = 0
    let localOmitted = 0
    for (const source of Object.values(this.sources).sort((a, b) => a.checkedAt - b.checkedAt)) {
      localCheckedAt = source.checkedAt
      const fresh = now - source.checkedAt <= ttl
      if (fresh) localOmitted = Math.max(localOmitted, source.omitted || 0)
      for (const row of source.rows) {
        const prior = rows.get(row.id)
        const observed = row.observed ?? ['running', 'waiting'].includes(row.status)
        const olderCursor = Number.isSafeInteger(row.cursor) && Number.isSafeInteger(prior?.cursor) && row.cursor < prior.cursor
        if (prior?.fresh && (!fresh || row.status !== 'unknown' && prior.observed && (!observed || olderCursor))) continue
        rows.set(row.id, { ...row, observed, provider: 'dsh', fresh, status: fresh ? row.status : 'unknown' })
      }
    }
    const sessions = [...new Set([sessionId, ...earlierSessions])]
    const cloud = sessions.map(id => ({ id, ...this.cloud[id] }))
    const cloudCheckedAt = Math.min(...cloud.map(item => item.checkedAt || 0))
    const cloudFresh = Boolean(cloudCheckedAt && now - cloudCheckedAt <= ttl)
    const cloudTasks = cloud.flatMap(item => {
      const fresh = Boolean(item.checkedAt && now - item.checkedAt <= ttl)
      return (item.rows || []).map(row => ({
        ...row, provider: 'qca', cloudSessionId: item.id, fresh, status: fresh ? row.status : 'unknown',
      }))
    })
    const cloudCompletions = cloud.flatMap(item => item.completions || [])
    const dshCompletions = Object.entries(this.dshHistory).flatMap(([id, record]) =>
      record.completed.map(item => ({ id, title: record.title, ...item })))
    const localTasks = [...rows.values()].map(({ observed, cursor, ...row }) => {
      const tracked = this.localTracking[row.id]
      if (row.fresh && row.status === 'idle' && !observed && tracked && activeStates.has(tracked.status)) row.status = 'unknown'
      if (terminalStates.has(tracked?.status) && !(cursor > tracked.cursor)) {
        if (row.fresh) row.status = tracked.status
        if (tracked.finishedAt) Object.assign(row, { finishedAt: tracked.finishedAt, finishedAtSeq: tracked.finishedAtSeq })
      }
      if (row.status === 'unknown' && tracked && activeStates.has(tracked.status)) {
        row.lastObservedStatus = tracked.status
        row.lastObservedAt = tracked.checkedAt
      }
      if (this.dshHistoryExcluded.has(row.id)) {
        delete row.finishedAt
        delete row.finishedAtSeq
      }
      return row
    })
    const priority = task => activeStates.has(task.status) ? 2 : task.lastObservedStatus ? 1 : 0
    const tasks = [...localTasks, ...cloudTasks].sort((a, b) => priority(b) - priority(a) || b.updatedAt - a.updatedAt)
    const followups = Object.values(this.followups).filter(item => sessions.includes(item.cloudSessionId))
      .map(({ sessionId, status, reason, receipt, checkedAt, cloudSessionId, createdAt, finishedAt, finishedAtSeq }) => ({
        sessionId, receipt, checkedAt, reason, cloudSessionId, createdAt, finishedAt, finishedAtSeq,
        status: ['completed', 'failed', 'cancelled'].includes(status) || now - checkedAt <= ttl ? status : 'unconfirmed',
      })).sort((a, b) => (followupPriority[a.status] ?? 4) - (followupPriority[b.status] ?? 4) || b.createdAt - a.createdAt)
    const cloudFollowups = Object.values(this.cloudFollowups)
      .filter(item => sessions.includes(item.cloudSessionId) && (!item.sourceSessionId || sessions.includes(item.sourceSessionId)))
      .map(item => ({ ...item, title: cloudTasks.find(task => task.id === item.threadId && task.cloudSessionId === item.cloudSessionId)?.title,
        status: terminalStates.has(item.status) || now - item.checkedAt <= ttl ? item.status : 'unconfirmed' }))
      .sort((a, b) => (followupPriority[a.status] ?? 4) - (followupPriority[b.status] ?? 4) || b.createdAt - a.createdAt)
    const macRuns = [...this.macRuns.values()].filter(run => sessions.includes(run.cloudSessionId))
      .map(run => this.macRun(run.receipt, activeRun))
      .sort((a, b) => (followupPriority[a.status] ?? 4) - (followupPriority[b.status] ?? 4) ||
        (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))
    return { localCheckedAt, localOmitted, localFresh: Boolean(localCheckedAt && now - localCheckedAt <= ttl),
      cloudCheckedAt, cloudFresh, tasks, followups, cloudFollowups, macRuns, cloudCompletions, dshCompletions }
  }
}

export function dshSearchIntent(text) {
  const query = /^(?:请\s*)?(?:帮我\s*)?(?:查找|搜索|找一下|找找)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*(?:[：:]\s*|\s+)([^\p{Cc}\p{Cf}]{1,180})$/iu.exec(text.trim())?.[1].trim()
  return query || undefined
}

export function matchDshSessions(items, query, { exactId = false } = {}) {
  const normalize = text => text.normalize('NFKC').toLowerCase()
  const term = normalize(query)
  const exact = items.filter(item => normalize(item.sessionId) === term)
  const found = (exact.length ? exact : items).flatMap(item => {
    const id = item.sessionId
    const title = clean(item.projections?.values.title)
    if (!exact.length && (exactId || !normalize(title).includes(term))) return []
    return [{ id, ...(title && { title }), updatedAt: item.updatedAt }]
  })
  return { total: found.length, matches: found.slice(0, 8) }
}

export function cloudResultIntent(text) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询|读回|告诉我)\s*(?:QCA|Qoder\s*云端|云端)\s*(?:子线程|子任务)(?:的)?\s*结果\s*[:：]?\s*(sthr_[a-z0-9_-]{1,95})\s*[。？?！!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export function cloudReplyIntent(text) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询|读回)\s*(?:QCA|Qoder\s*云端|云端)\s*(?:子线程\s*)?(?:回传|结果)\s*[:：]?\s*(evt_[a-z0-9_-]{1,95})\s*[。？?！!]?$/iu.exec(text.trim())?.[1].toLowerCase()
}

export function cloudSearchIntent(text) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:查找|搜索|找一下|找找)\s*(?:QCA|Qoder\s*云端|云端)\s*(?:任务|子线程|子任务)\s*(?:[：:]\s*|\s+)([^\p{Cc}\p{Cf}]{1,180})$/iu.exec(text.trim())?.[1].trim() || undefined
}

export function searchCloudTaskbook(snapshot, query) {
  const term = query.normalize('NFKC').toLowerCase()
  const matches = snapshot.tasks.filter(task => task.provider === 'qca' && task.fresh &&
    (task.id.toLowerCase() === term || task.title.normalize('NFKC').toLowerCase().includes(term)))
  return { cloudFresh: snapshot.cloudFresh, cloudCheckedAt: snapshot.cloudCheckedAt, total: matches.length, matches: matches.slice(0, 8) }
}

export async function readCloudResult(client, sessionId, threadId) {
  let assignment
  let reply
  for await (const event of client.events(sessionId, undefined, ['agent.thread_message_sent', 'agent.thread_message_received'])) {
    if (event.type === 'agent.thread_message_sent' && event.to_session_thread_id === threadId) {
      assignment = event
      reply = undefined
    }
    if (event.type === 'agent.thread_message_received' && event.from_session_thread_id === threadId) reply = event
  }
  if (!reply) return { status: 'no_result_yet', ...(assignment && { assignmentEventId: assignment.id }) }
  return cloudReplyResult(reply, assignment)
}

export async function readCloudReply(client, sessionId, resultEventId, signal) {
  for await (const event of client.events(sessionId, undefined, ['agent.thread_message_received'], signal)) {
    if (event.type === 'agent.thread_message_received' && event.id === resultEventId && event.from_session_thread_id) {
      return { ...cloudReplyResult(event), sessionId, threadId: event.from_session_thread_id }
    }
  }
}

function cloudReplyResult(reply, assignment) {
  const result = reply.content?.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim() || ''
  return { status: result ? 'result_received' : 'no_text_result', resultEventId: reply.id,
    ...(assignment && { assignmentEventId: assignment.id }), ...(result && { result: result.slice(0, 6000), truncated: result.length > 6000 }) }
}

export function taskbookIntent(text) {
  const completed = completedTaskbookIntent(text)
  if (completed) return completed
  // Scope a compound request to the question that explicitly asks about QCA.
  // A request to start a cloud task by itself does not grant a taskbook read.
  const clauses = text.normalize('NFKC').split(/[?。!;,\n]+/u).map(clause => clause.trim())
  if (clauses.some(clause => /^(?:请\s*)?(?:帮我\s*)?(?:先\s*)?(?:查一下|查看|查询|看看?|告诉我|列出)?\s*(?:(?:现在|目前)\s*)?(?:QCA|Qoder\s*云端|云端)(?:\s*(?:这边|那边|上))?(?:\s*(?:现在|目前|还|正在))*\s*(?:(?:有(?:没有|哪些|什么|多少|任何|几个|几项)?|有没有在跑的)\s*(?:任务|子线程|子任务)(?:\s*(?:在跑|在运行|正在跑))?(?:\s*(?:吗|么|呢))?|(?:任务|子线程|子任务)\s*的?\s*(?:数量|状态|进度))$/iu.test(clause))) return 'cloud'
  if (/^(?:请\s*)?(?:只查|查看|查询|告诉我)\s*(?:Dot\s*)?任务本的?(?:数量|条数)[？?。！!]?$/iu.test(text.trim())) return 'count'
  const question = text.normalize('NFKC').trim().replace(/[?。!]+$/u, '')
    .replace(/^(?:请\s*)?(?:帮我\s*)?(?:看看?|看一下|查一下|查看|告诉我|列出|盘点)?\s*(?:Dot\s*)?(?:现在|目前)?\s*/iu, '')
  if (/^(?:待处理(?:的)?(?:任务|对话)|(?:还有|有)?(?:哪些|什么)(?:任务|对话|子线程)?(?:在)?(?:等我(?:处理|确认|审批)?|需要我(?:处理|确认|审批)))(?:呢|吗)?$/u.test(question)) return 'waiting'
  if (/^(?:进行中(?:的)?(?:任务|对话)|(?:还有|有)?(?:哪些|什么)(?:任务|对话|子线程)?(?:还)?(?:在跑|在运行|正在运行|正在处理))(?:呢|吗)?$/u.test(question)) return 'running'
  if (/^(?:请\s*)?(?:帮我\s*)?(?:看看?|看一下|查看|打开|列出|告诉我|盘点|查一下)?\s*(?:Dot\s*)?(?:任务本|(?:最近|现在|目前)?\s*(?:本机\s*|Mac\s*)?(?:DSH\s*)?(?:最近|现在|目前)?\s*(?:开了哪些对话|有哪些对话|哪些对话在跑|会话进度|任务进度|对话状态))(?:\s*(?:里有什么|的状态|里有哪些任务))?[？?。！!]?$/iu.test(text.trim())) return 'list'
}

function completedTaskbookIntent(text) {
  const question = text.normalize('NFKC').trim().replace(/[?。!]+$/u, '')
    .replace(/^(?:请\s*)?(?:帮我\s*)?(?:查看|查询|看看?|告诉我|列出|汇总)?\s*(?:Dot\s*)?/iu, '')
  const match = /^(今天|最近|这几天|过去\s*7\s*天)\s*(?:(?:都)?完成了(?:哪些|什么)(?:任务|工作)?|(?:有)?哪些(?:任务|工作)(?:已|已经)完成|(?:已)?完成的?(?:任务|工作))$/u.exec(question)
  if (match) return match[1] === '今天' ? 'completed_today' : 'completed_recent'
}

export function completionNumber(text) {
  const reference = /^(?:请\s*)?(?:帮我\s*)?(?:查看|看看?|看一下|查一下|读回)\s*(?:刚才的?\s*)?完成清单\s*(?:里(?:的)?\s*|的\s*)?第\s*(\d{1,2}|[一二两三四五六七八九]|十[一二三四五六七八九]?)\s*(?:项|条)(?:的?结果)?\s*[。？?！!]?$/u.exec(text.normalize('NFKC').trim())?.[1]
  if (!reference) return
  const chinese = '一二三四五六七八九'
  if (/^\d+$/u.test(reference)) return Number(reference)
  if (reference === '两') return 2
  if (reference.startsWith('十')) return reference.length === 1 ? 10 : 11 + chinese.indexOf(reference[1])
  return chinese.indexOf(reference) + 1
}

export function completionSelection(events, beforeId, number, decisions) {
  let mode
  let items
  let latest
  let sources = new Set()
  for (const event of events) {
    if (event.id === beforeId) break
    if (event.type === 'user.message') {
      const [block] = event.content || []
      mode = event.content?.length === 1 && block?.type === 'text' && typeof block.text === 'string'
        ? completedTaskbookIntent(block.text) : undefined
      if (mode) latest = undefined
      items = undefined
      sources = new Set()
    }
    if (!mode) continue
    if (event.type === 'agent.custom_tool_use' && event.name === DOT_TASKBOOK_TOOL) sources.add(event.id)
    if (event.type === 'user.custom_tool_result' && !event.is_error && sources.has(event.custom_tool_use_id) &&
      decisions[event.custom_tool_use_id]?.decision === 'allow') {
      try {
        const [block] = event.content || []
        const report = event.content?.length === 1 && block?.type === 'text' && JSON.parse(block.text)
        if (report?.mode === mode && Array.isArray(report.items)) items = report.items
      } catch {}
    }
    if (event.type === 'user.interrupt' || event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action') {
      if (event.stop_reason?.type === 'end_turn') latest = items
      mode = undefined
    }
  }
  if (!latest) return { status: 'no_completion_list' }
  const item = latest[number - 1]
  if (item?.number !== number) return { status: 'completion_item_not_found', number, available: latest.length }
  if (item.macReceipt) return { query: '查看 Mac 回执 ' + item.macReceipt }
  if (item.provider === 'dsh' && item.receipt) return { query: '查看 DSH 续办结果 ' + item.receipt }
  if (item.provider === 'dsh' && Number.isSafeInteger(item.finishedAtSeq)) {
    return { query: '查看 DSH 结果 ' + item.id + ' #' + item.finishedAtSeq }
  }
  if (item.relayReceipt) return { query: '查看旧云端续办结果 ' + item.relayReceipt }
  if (item.provider === 'qca' && item.resultEventId) return { query: '查看云端回传 ' + item.resultEventId }
  return { status: 'completion_result_unavailable', number }
}

export function taskbookCompleted(snapshot, mode, now = Date.now()) {
  const start = mode === 'completed_today'
    ? Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000
    : now - recentWindow
  const inWindow = at => Number.isFinite(at) && at >= start && at <= now
  const followups = snapshot.followups.filter(item => item.status === 'completed' && inWindow(item.finishedAt))
  const cloudFollowups = snapshot.cloudFollowups.filter(item => item.status === 'completed' && inWindow(item.finishedAt))
  const macRuns = (snapshot.macRuns || []).filter(item => item.status === 'completed' && inWindow(item.finishedAt))
  const recordedTurns = new Set(followups.map(item => `${item.sessionId}:${item.finishedAtSeq}`))
  const belongsToMacRun = item => macRuns.some(run =>
    run.sessionId?.replace(/^session-/, '') === item.id.replace(/^session-/, '') &&
    item.finishedAt >= run.startedAt && item.finishedAt <= run.finishedAt)
  const dshTurns = (snapshot.dshCompletions || []).filter(item => inWindow(item.finishedAt) &&
    !recordedTurns.has(`${item.id}:${item.finishedAtSeq}`) && !belongsToMacRun(item))
  for (const item of dshTurns) recordedTurns.add(`${item.id}:${item.finishedAtSeq}`)
  const recordedReplies = new Set(cloudFollowups.map(item => item.resultEventId).filter(Boolean))
  const cloudTurns = (snapshot.cloudCompletions || []).filter(item => inWindow(item.finishedAt) && !recordedReplies.has(item.resultEventId))
  for (const item of cloudTurns) recordedReplies.add(item.resultEventId)
  const tasks = snapshot.tasks.filter(item => (item.status === 'completed' || !item.fresh && item.status === 'unknown') &&
    inWindow(item.finishedAt) && !recordedReplies.has(item.resultEventId) &&
    !(item.provider === 'dsh' && (recordedTurns.has(`${item.id}:${item.finishedAtSeq}`) || belongsToMacRun(item))))
  const rows = [...tasks.map(({ id, title, provider, cloudSessionId, finishedAt, resultEventId }) =>
    ({ id, title, provider, cloudSessionId, finishedAt, resultEventId })),
  ...cloudTurns.map(item => ({ ...item, provider: 'qca' })),
  ...dshTurns.map(item => ({ ...item, provider: 'dsh' })),
  ...followups.map(({ sessionId, cloudSessionId, finishedAt, receipt }) => ({ id: sessionId, provider: 'dsh',
    title: snapshot.tasks.find(task => task.provider === 'dsh' && task.id === sessionId)?.title,
    cloudSessionId, finishedAt, receipt })),
  ...macRuns.map(({ sessionId: id, title, cloudSessionId, finishedAt, receipt }) =>
    ({ id, provider: 'dsh', title, cloudSessionId, finishedAt, macReceipt: receipt })),
  ...cloudFollowups.map(({ threadId: id, title, cloudSessionId, finishedAt, receipt, resultEventId }) =>
    ({ id, title, provider: 'qca', cloudSessionId, finishedAt, relayReceipt: receipt, resultEventId }))].sort((a, b) => b.finishedAt - a.finishedAt)
  return { mode, since: new Date(start).toISOString(), through: new Date(now).toISOString(),
    localFresh: snapshot.localFresh, localOmitted: snapshot.localOmitted, cloudFresh: snapshot.cloudFresh,
    total: rows.length, counts: { mac: rows.filter(row => row.provider === 'dsh').length,
      qca: rows.filter(row => row.provider === 'qca').length }, items: rows.slice(0, 15).map((item, index) => ({ ...item, number: index + 1 })) }
}

export function taskbookActivity(snapshot, mode) {
  const statuses = mode === 'waiting' ? ['waiting'] : ['running', 'queued', 'sending']
  const matched = snapshot.tasks.filter(task => task.fresh && statuses.includes(task.status))
  const followups = snapshot.followups.filter(task => snapshot.localFresh && statuses.includes(task.status))
  const cloudFollowups = snapshot.cloudFollowups.filter(task => statuses.includes(task.status))
  const macRuns = (snapshot.macRuns || []).filter(task => statuses.includes(task.status))
  const unconfirmed = snapshot.tasks.filter(task => task.provider === 'dsh' && task.status === 'unknown' &&
    task.lastObservedStatus === (mode === 'waiting' ? 'waiting' : 'running'))
  return {
    mode, localCheckedAt: snapshot.localCheckedAt, localOmitted: snapshot.localOmitted, cloudCheckedAt: snapshot.cloudCheckedAt,
    counts: { dsh: snapshot.localFresh ? matched.filter(task => task.provider === 'dsh').length : null,
      qca: snapshot.cloudFresh ? matched.filter(task => task.provider === 'qca').length : null,
      followups: snapshot.localFresh ? followups.length : null },
    tasks: matched.slice(0, 15), followups: followups.slice(0, 15), cloudFollowups: cloudFollowups.slice(0, 15), macRuns: macRuns.slice(0, 15),
    unconfirmed: unconfirmed.slice(0, 15),
  }
}

export function offlineTaskbook(book, sessionId, earlierSessions, now = Date.now(), activeRun) {
  const snapshot = book.snapshot(sessionId, now, earlierSessions, activeRun)
  const completions = ['completed_today', 'completed_recent'].map(mode => {
    const { since, through, total, counts } = taskbookCompleted(snapshot, mode, now)
    return { mode, since, through, total, ...counts }
  })
  const counts = provider => {
    const rows = snapshot.tasks.filter(task => task.provider === provider && task.fresh)
    return {
      total: rows.length,
      running: rows.filter(task => task.status === 'running').length,
      waiting: rows.filter(task => task.status === 'waiting').length,
      ...(provider === 'qca' && { completed: rows.filter(task => task.status === 'completed').length }),
    }
  }
  const currentCloud = book.snapshot(sessionId, now)
  return {
    sessionId,
    observedAt: new Date(now).toISOString(),
    completions,
    mac: { observedAt: snapshot.localCheckedAt ? new Date(snapshot.localCheckedAt).toISOString() : null,
      counts: snapshot.localFresh ? counts('dsh') : null, omitted: snapshot.localOmitted,
      priorActiveUnconfirmed: snapshot.tasks.filter(task => task.provider === 'dsh' && task.lastObservedStatus).length,
      runs: { tracked: snapshot.macRuns.length,
        waiting: snapshot.macRuns.filter(item => item.status === 'waiting').length,
        inProgress: snapshot.macRuns.filter(item => item.status === 'running').length,
        unconfirmed: snapshot.macRuns.filter(item => item.status === 'unconfirmed').length },
      followups: { tracked: snapshot.followups.length,
        completed: snapshot.followups.filter(item => item.status === 'completed').length,
        waiting: snapshot.localFresh ? snapshot.followups.filter(item => item.status === 'waiting').length : null,
        inProgress: snapshot.localFresh ? snapshot.followups.filter(item => ['running', 'queued', 'sending'].includes(item.status)).length : null,
        unconfirmed: snapshot.followups.filter(item => item.status === 'unconfirmed').length } },
    qca: { observedAt: currentCloud.cloudCheckedAt ? new Date(currentCloud.cloudCheckedAt).toISOString() : null,
      current: currentCloud.cloudFresh ? currentCloud.tasks.filter(task => task.provider === 'qca').length : null,
      allObservedAt: snapshot.cloudCheckedAt ? new Date(snapshot.cloudCheckedAt).toISOString() : null,
      counts: snapshot.cloudFresh ? counts('qca') : null,
      followups: { tracked: snapshot.cloudFollowups.length,
        waiting: snapshot.cloudFollowups.filter(item => item.status === 'waiting').length,
        inProgress: snapshot.cloudFollowups.filter(item => ['sending', 'running'].includes(item.status)).length,
        unconfirmed: snapshot.cloudFollowups.filter(item => item.status === 'unconfirmed').length } },
  }
}
