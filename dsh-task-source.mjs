import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { taskRows, unarchivedSessions } from './dsh-panel/task-rows.js'
import { observedTurnEnd } from './dot-dsh-followup.mjs'

const run = promisify(execFile)

export function webTaskSource({ internalWorkDir } = {}) {
  const source = '00000000-0000-4000-8000-000000000001'
  const origin = 'http://127.0.0.1:3080'
  const script = process.env.DOT_DSH_WEB_STATUS || 'dsh-web.sh'
  let cookie

  async function connect(signal) {
    const { stdout } = await run(script, ['status'], { signal, timeout: 4000 })
    const url = stdout.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/)?.[0]
    if (!url) throw new Error('DSH Web is unavailable')
    const response = await fetch(url, { redirect: 'manual', signal })
    const value = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
    if (!value) throw new Error('DSH Web did not provide a session cookie')
    return value
  }

  async function rpc(method, args, signal) {
    cookie ||= await connect(signal)
    const rpcId = randomUUID()
    const response = await fetch(origin + '/api/' + method, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    if ([401, 403].includes(response.status)) cookie = undefined
    if (!response.ok) throw new Error('DSH Web RPC is unavailable')
    const message = await response.json()
    if (message.rpcId !== rpcId || !message.result?.ok) {
      const error = new Error('DSH Web did not confirm the RPC')
      error.code = message.result?.error?.code
      throw error
    }
    return message.result.value
  }

  async function history(sessionId, signal, beforeSeq, throughSeq) {
    return rpc('session/events', { request: {
      address: { kind: 'session', sessionId }, maxMessages: 16, beforeSeq, throughSeq,
    } }, signal)
  }

  async function list(signal, tracked = []) {
    const { items, archived } = await catalog(signal)
    const previous = new Map(tracked.map(row => [row.id, row]))
    const report = await taskRows(items, sessionId => rpc('session/state', { request: { sessionId } }, signal), archived, previous)
    const recovering = report.rows.filter(row => row.status === 'unknown' && Number.isSafeInteger(row.cursor))
    await Promise.all(recovering.map(async row => {
      try {
        const page = await history(row.id, signal, undefined, row.cursor)
        const ended = observedTurnEnd(page.records, previous.get(row.id), { includeTime: true })
        if (ended) Object.assign(row, ended, { observed: true })
      } catch {
        // Keep the last active observation until a full observation succeeds.
      }
    }))
    const historyExcluded = internalWorkDir ? items.filter(item => item.cwd === internalWorkDir).map(item => item.sessionId) : []
    return { source, ...report, eligibleIds: new Set(unarchivedSessions(items, archived).map(item => item.sessionId)), historyExcluded }
  }

  async function archivedSessions(signal) {
    cookie ||= await connect(signal)
    signal.throwIfAborted()
    const socket = new WebSocket('ws://127.0.0.1:3080/api/remote.mux', { headers: { Cookie: cookie } })
    const streamId = randomUUID()
    let abort
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        const failed = () => reject(new Error('DSH Web did not provide workspace status'))
        socket.addEventListener('error', () => { cookie = undefined; failed() }, { once: true })
        socket.addEventListener('close', failed, { once: true })
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId,
          endpoint: 'workspace/follow', payload: { args: {} } })), { once: true })
        socket.addEventListener('message', event => {
          try {
            const frame = JSON.parse(event.data)
            if (frame.streamId !== streamId) return
            if (frame.type === 'error' || frame.type === 'end') return failed()
            if (frame.type !== 'item' || frame.value?.type !== 'baseline') return
            const ids = frame.value.value?.archivedSessionIds
            if (!Array.isArray(ids)) return failed()
            resolve(new Set(ids))
          } catch (error) { reject(error) }
        })
      })
    } finally {
      signal.removeEventListener('abort', abort)
      socket.close()
    }
  }

  async function catalog(signal) {
    cookie ||= await connect(signal)
    const [{ items }, archived] = await Promise.all([rpc('session/list', { _request: {} }, signal), archivedSessions(signal)])
    return { items, archived }
  }

  async function eligibleSessions(signal) {
    const { items, archived } = await catalog(signal)
    return unarchivedSessions(items, archived).filter(item => item.formatStatus !== 'migration-required')
  }

  return {
    list,
    eligibleSessions,
    state: (sessionId, signal) => rpc('session/state', { request: { sessionId } }, signal),
    cancel: (sessionId, signal) => rpc('session/cancel', { request: { sessionId } }, signal),
    prompt: (sessionId, requestId, task, signal) => rpc('session/prompt', { request: {
      sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: task }],
    } }, signal),
    history,
  }
}
