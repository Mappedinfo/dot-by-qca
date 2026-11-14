import { readFile } from 'node:fs/promises'

const ttl = 45_000
const visibleStates = new Set(['running', 'waiting', 'idle', 'archived', 'completed', 'failed', 'cancelled', 'unknown'])
const sourcePattern = /^[a-f0-9-]{36}$/
const sessionPattern = /^[a-zA-Z0-9_-]{1,100}$/
const clean = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 180) : ''

export class Taskbook {
  constructor(file, save) {
    this.file = file
    this.save = save
    this.sources = {}
    this.cloud = {}
    this.followups = {}
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
  }

  acceptLocal({ source, rows, omitted = 0 }, now = Date.now()) {
    if (typeof source !== 'string' || !sourcePattern.test(source) || !Array.isArray(rows) || rows.length > 120) return false
    const local = rows.flatMap(row => {
      if (!row || typeof row.id !== 'string' || !sessionPattern.test(row.id) || !visibleStates.has(row.status)) return []
      const { id, status } = row
      const title = clean(row.title) || id
      const updatedAt = Number.isFinite(row.updatedAt) && row.updatedAt > 0 ? Math.min(now, row.updatedAt) : now
      return [{ id, title, status, updatedAt, observed: row.observed === true || (row.observed === undefined &&
        ['running', 'waiting'].includes(status)) }]
    })
    this.sources[source] = { checkedAt: now, rows: local, omitted: Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0 }
    for (const key of Object.keys(this.sources)) {
      if (key !== source && now - this.sources[key].checkedAt > 30 * 24 * 3600_000) delete this.sources[key]
    }
    return true
  }

  acceptCloud(sessionId, threads, events, now = Date.now()) {
    const latest = new Map()
    const replies = new Map()
    const starts = new Map()
    for (const event of events) {
      if (event.type?.startsWith('session.thread_status_') && event.session_thread_id) latest.set(event.session_thread_id, event)
      if (event.type === 'agent.thread_message_received' && event.from_session_thread_id) replies.set(event.from_session_thread_id, event)
      if (event.type === 'agent.thread_message_sent' && event.to_session_thread_id) starts.set(event.to_session_thread_id, event)
    }
    this.cloud[sessionId] = { checkedAt: now, rows: threads.filter(row => row.parent_thread_id || row.role === 'child').map(row => {
      const event = latest.get(row.id)
      const received = replies.get(row.id)
      const sent = starts.get(row.id)
      const reply = received && (!sent || Date.parse(received.processed_at) >= Date.parse(sent.processed_at)) ? received : undefined
      const status = row.archived_at ? 'archived' : ['running', 'rescheduling', 'pending', 'canceling'].includes(row.status) ? 'running'
        : row.status === 'terminated' ? 'archived'
          : event?.stop_reason?.type === 'requires_action' ? 'waiting'
            : row.status === 'idle' && event?.stop_reason?.type === 'end_turn' && reply ? 'completed'
              : row.status === 'idle' ? 'idle' : 'unknown'
      return { id: row.id, title: clean(row.title || row.agent_name || row.agent?.name) || row.id,
        updatedAt: Date.parse(row.updated_at) || now, status, ...(reply && { resultEventId: reply.id }) }
    }) }
  }

  persist() {
    const value = structuredClone({ sources: this.sources, cloud: this.cloud, followups: this.followups })
    const pending = this.pending.catch(() => {}).then(() => this.save(this.file, value))
    this.pending = pending
    return pending
  }

  snapshot(sessionId, now = Date.now(), earlierSessions = []) {
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
        if (prior?.fresh && (!fresh || prior.observed && !observed)) continue
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
    const localTasks = [...rows.values()].map(({ observed, ...row }) => row)
    const tasks = [...localTasks, ...cloudTasks].sort((a, b) => Number(['running', 'waiting'].includes(b.status)) -
      Number(['running', 'waiting'].includes(a.status)) || b.updatedAt - a.updatedAt)
    const followups = Object.values(this.followups).filter(item => sessions.includes(item.cloudSessionId))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 15)
      .map(({ sessionId, status, reason, receipt, checkedAt, cloudSessionId }) => ({
        sessionId, receipt, checkedAt, reason, cloudSessionId,
        status: ['completed', 'failed', 'cancelled'].includes(status) || now - checkedAt <= ttl ? status : 'unconfirmed',
      }))
    return { localCheckedAt, localOmitted, localFresh: Boolean(localCheckedAt && now - localCheckedAt <= ttl),
      cloudCheckedAt, cloudFresh, tasks, followups }
  }
}

export function dshSearchIntent(text) {
  const query = /^(?:请\s*)?(?:帮我\s*)?(?:查找|搜索|找一下|找找)\s*(?:Mac\s*)?DSH\s*(?:对话|会话)\s*(?:[：:]\s*|\s+)([^\p{Cc}\p{Cf}]{1,180})$/iu.exec(text.trim())?.[1].trim()
  return query || undefined
}

export function matchDshSessions(items, query) {
  const normalize = text => text.normalize('NFKC').toLowerCase()
  const term = normalize(query)
  const found = items.flatMap(item => {
    const id = item.sessionId
    const title = clean(item.projections?.values.title)
    const name = normalize(title)
    if (normalize(id) !== term && !name.includes(term)) return []
    return [{ id, ...(title && { title }), updatedAt: item.updatedAt }]
  })
  return { total: found.length, matches: found.slice(0, 8) }
}

export function taskbookIntent(text) {
  // Scope a compound request to the question that explicitly asks about QCA.
  // A request to start a cloud task by itself does not grant a taskbook read.
  const clauses = text.normalize('NFKC').split(/[?。!;,\n]+/u).map(clause => clause.trim())
  if (clauses.some(clause => /^(?:请\s*)?(?:帮我\s*)?(?:先\s*)?(?:查一下|查看|查询|看看?|告诉我|列出)?\s*(?:(?:现在|目前)\s*)?(?:QCA|Qoder\s*云端|云端)(?:\s*(?:这边|那边|上))?(?:\s*(?:现在|目前|还|正在))*\s*(?:(?:有(?:没有|哪些|什么|多少|任何|几个|几项)?|有没有在跑的)\s*(?:任务|子线程|子任务)(?:\s*(?:在跑|在运行|正在跑))?(?:\s*(?:吗|么|呢))?|(?:任务|子线程|子任务)\s*的?\s*(?:数量|状态|进度))$/iu.test(clause))) return 'cloud'
  if (/^(?:请\s*)?(?:只查|查看|查询|告诉我)\s*(?:Dot\s*)?任务本的?(?:数量|条数)[？?。！!]?$/iu.test(text.trim())) return 'count'
  if (/^(?:请\s*)?(?:帮我\s*)?(?:看看?|看一下|查看|打开|列出|告诉我|盘点|查一下)?\s*(?:Dot\s*)?(?:任务本|(?:最近|现在|目前)?\s*(?:本机\s*|Mac\s*)?(?:DSH\s*)?(?:最近|现在|目前)?\s*(?:开了哪些对话|有哪些对话|哪些对话在跑|会话进度|任务进度|对话状态))(?:\s*(?:里有什么|的状态|里有哪些任务))?[？?。！!]?$/iu.test(text.trim())) return 'list'
}

export function offlineTaskbook(book, sessionId, earlierSessions, now = Date.now()) {
  const snapshot = book.snapshot(sessionId, now, earlierSessions)
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
    mac: { observedAt: snapshot.localCheckedAt ? new Date(snapshot.localCheckedAt).toISOString() : null,
      counts: snapshot.localFresh ? counts('dsh') : null, omitted: snapshot.localOmitted,
      followups: { tracked: snapshot.followups.length,
        completed: snapshot.followups.filter(item => item.status === 'completed').length } },
    qca: { observedAt: currentCloud.cloudCheckedAt ? new Date(currentCloud.cloudCheckedAt).toISOString() : null,
      current: currentCloud.cloudFresh ? currentCloud.tasks.filter(task => task.provider === 'qca').length : null,
      allObservedAt: snapshot.cloudCheckedAt ? new Date(snapshot.cloudCheckedAt).toISOString() : null,
      counts: snapshot.cloudFresh ? counts('qca') : null },
  }
}
