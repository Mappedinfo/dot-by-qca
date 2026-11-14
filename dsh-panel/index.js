import { randomUUID } from 'node:crypto'
import { taskRows } from './task-rows.js'

export const name = 'qoder-dot-panel'
export const inject = ['sessionController', 'workspaceRegistry']

export function apply(ctx) {
  const source = randomUUID()
  ctx.effect(() => {
    const controller = new AbortController()
    let updating = false
    async function publish() {
      if (updating || controller.signal.aborted) return
      updating = true
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
      try {
        const { items } = await ctx.sessionController.list({}, signal)
        const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
        const report = await taskRows(items, sessionId => ctx.sessionController.state({ sessionId }, signal), archived)
        await fetch('http://127.0.0.1:4320/api/taskbook/local', { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, ...report }) })
      } catch {
        // Dot may be stopped independently of DSH. The next snapshot retries.
      } finally {
        updating = false
      }
    }
    void publish()
    const timer = setInterval(publish, 12_000)
    timer.unref()
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, 'qoder-dot taskbook')
}
