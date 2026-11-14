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

export async function taskRows(items, state, archived = new Set()) {
  const eligible = unarchivedSessions(items, archived)
    .sort((a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running)) || b.updatedAt - a.updatedAt)
  const rows = await Promise.all(eligible.slice(0, 120)
    .map(async item => {
      const status = item.running ? 'running' : 'idle'
      const observed = item.agentAvailable ? await state(item.sessionId).catch(() => undefined) : undefined
      const title = item.projections?.values.title || (item.cwd && basename(item.cwd)) || item.sessionId
      return { id: item.sessionId, title, updatedAt: item.updatedAt,
        observed: observed?.active === true || Boolean(observed?.pendingInput?.length) || !observed && Boolean(item.running),
        status: observed?.pendingInput?.length ? 'waiting' : observed ? observed.running ? 'running' : 'idle' : status }
    }))
  return { rows, omitted: eligible.length - rows.length }
}
