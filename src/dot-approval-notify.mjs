import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export function qcaApprovalSender(client, scheduleId) {
  if (!/^sched_[A-Za-z0-9_-]{1,100}$/.test(scheduleId)) throw new Error('QCA Schedule ID 格式无效。')
  return async (signal, approvals) => {
    const key = createHash('sha256').update(approvals.toSorted().join(':')).digest('hex')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
    let run = await client.runSchedule(scheduleId, `dot-approval-${key}`, deadline)
    const { id } = run
    if (!/^srun_[A-Za-z0-9_-]{1,100}$/.test(id ?? '')) throw new Error('QCA 没有返回提醒运行编号。')
    for (;;) {
      if (run.push_status === 'succeeded') return run
      if (['failed', 'skipped'].includes(run.push_status) && run.status !== 'pending' && run.status !== 'running') {
        throw new Error('QCA 未能投递审批提醒。')
      }
      await delay(3000, undefined, { signal: deadline })
      run = await client.getScheduleRun(id, deadline)
    }
  }
}

export function serverChanApprovalSender(sendKey, site, fetchRequest = fetch) {
  if (!/^SCT[A-Za-z0-9]{8,128}$/.test(sendKey)) throw new Error('Server酱 Turbo SendKey 格式无效。')
  const endpoint = `https://sctapi.ftqq.com/${sendKey}.send`
  const sessions = site === 'cn' ? 'https://qoder.com.cn/cloud/sessions' : 'https://qoder.com/cloud/sessions'
  return async signal => {
    const response = await fetchRequest(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      body: new URLSearchParams({ title: 'Dot 有待审批', desp: `[打开 Qoder 会话列表](${sessions})，选择「Dot by QCA · 当前主会话」。` }),
    })
    if (!response.ok || (await response.json())?.code !== 0) throw new Error('Server酱未确认接收提醒。')
  }
}

export function approvalNotifier({ file, save, send }) {
  let sent
  let pending
  return (sessionId, getPendingIds, signal) => {
    if (pending || signal.aborted || !getPendingIds().length) return pending
    pending = (async () => {
      sent ??= new Set(await readFile(file, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return []
      }))
      const hash = id => createHash('sha256').update(`${sessionId}:${id}`).digest('hex')
      const ids = getPendingIds().filter(id => !sent.has(hash(id)))
      if (!ids.length || signal.aborted) return
      const current = ids.map(hash)
      // Record the attempt before dispatch so a crash does not replay a reminder.
      const next = new Set([...sent, ...current])
      await save(file, [...next])
      sent = next
      if (!signal.aborted && getPendingIds().some(id => ids.includes(id))) await send(signal, current, ids, sessionId)
    })().finally(() => { pending = undefined })
    return pending
  }
}
