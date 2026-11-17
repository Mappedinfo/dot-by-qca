import { basename } from 'node:path'

export function unarchivedSessions(items, archived) {
  const byId = new Map(items.map(item => [item.sessionId, item]))
  return items.filter(item => {
    const visited = new Set()
    for (let current = item; current; current = byId.get(current.parentSessionId)) {
      if (archived.has(current.sessionId) || visited.has(current.sessionId)) return false
      if (current.origin !== 'subagent' || !current.parentSessionId) break
      if (archived.has(current.parentSessionId)) return false
      visited.add(current.sessionId)
    }
    return !item.blank
  })
}

export async function taskRows(items, state, archived = new Set(), tracked = new Map()) {
  const priority = id => {
    const status = tracked.get(id)?.status
    return status === 'waiting' || status === 'running' ? 2 : status ? 1 : 0
  }
  const eligible = unarchivedSessions(items, archived)
    .sort((a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running)) ||
      priority(b.sessionId) - priority(a.sessionId) ||
      Number(Boolean(b.agentAvailable)) - Number(Boolean(a.agentAvailable)) || b.updatedAt - a.updatedAt)
  const rows = await Promise.all(eligible.slice(0, 120)
    .map(async item => {
      const status = item.running ? 'running' : 'idle'
      const previous = tracked.get(item.sessionId)
      const observed = item.agentAvailable || previous ? await state(item.sessionId).catch(() => undefined) : undefined
      const title = item.projections?.values.title || (item.cwd && basename(item.cwd)) || item.sessionId
      const live = observed?.pendingInput?.length ? 'waiting' : observed?.queue?.length ? 'running'
        : observed?.running ? 'running' : undefined
      const cursor = Number.isSafeInteger(observed?.cursor) ? observed.cursor : undefined
      const terminal = previous && ['completed', 'failed', 'cancelled'].includes(previous.status)
      const recovering = previous && !terminal && !live && !observed?.running && (!item.running || observed?.active)
      const settled = terminal && !live && status === 'idle' && previous.cursor === cursor && cursor !== undefined
      return { id: item.sessionId, title, updatedAt: item.updatedAt,
        ...(cursor !== undefined && { cursor }),
        ...(settled && { finishedAt: previous.finishedAt, finishedAtSeq: previous.finishedAtSeq }),
        observed: observed?.active === true || Boolean(live) || !observed && Boolean(item.running),
        status: live ?? (settled ? previous.status : recovering ? 'unknown' : observed?.active ? 'idle' : status) }
    }))
  return { rows, omitted: eligible.length - rows.length }
}
