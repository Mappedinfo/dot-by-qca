import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { approvalNotifier, qcaApprovalSender, serverChanApprovalSender } from './dot-approval-notify.mjs'
import { qcaClient } from './qca.mjs'

test('a current card is reminded once across reconnects and a service restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-approval-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'notifications.json')
  const signal = new AbortController().signal
  const send = t.mock.fn(async () => {})
  const save = (path, value) => writeFile(path, JSON.stringify(value))
  const create = () => approvalNotifier({ file, save, send })
  let ids = []
  const pending = () => ids
  const notify = create()
  await notify('sess_fixture', pending, signal)
  assert.equal(send.mock.callCount(), 0)
  ids = ['evt_card']
  await Promise.all([notify('sess_fixture', pending, signal), notify('sess_fixture', pending, signal)])
  await create()('sess_fixture', pending, signal)
  assert.equal(send.mock.callCount(), 1)
  assert.doesNotMatch(await readFile(file, 'utf8'), /sess_fixture|evt_card/)
  ids = ['evt_card', 'evt_new']
  await notify('sess_fixture', pending, signal)
  assert.equal(send.mock.callCount(), 2)
})

test('a cancelled card and an uncertain delivery do not cause a later notification', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-approval-race-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'notifications.json')
  const signal = new AbortController().signal
  let ids = ['evt_cancelled']
  const send = t.mock.fn(async () => { throw new Error('uncertain delivery') })
  const notify = approvalNotifier({ file, send, async save(path, value) {
    if (ids.includes('evt_cancelled')) ids = []
    await writeFile(path, JSON.stringify(value))
  } })
  await notify('sess_fixture', () => ids, signal)
  assert.equal(send.mock.callCount(), 0)
  ids = ['evt_uncertain']
  await assert.rejects(notify('sess_fixture', () => ids, signal), /uncertain delivery/)
  await notify('sess_fixture', () => ids, signal)
  assert.equal(send.mock.callCount(), 1)
})

test('ServerChan receives a generic reminder and never follows a redirect with the send key', async t => {
  const request = t.mock.fn(async () => Response.json({ code: 0 }))
  const key = 'SCTfixture12345'
  await serverChanApprovalSender(key, 'cn', request)(new AbortController().signal)
  const [url, options] = request.mock.calls[0].arguments
  assert.equal(url, `https://sctapi.ftqq.com/${key}.send`)
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.deepEqual(Object.fromEntries(options.body), { title: 'Dot 有待审批',
    desp: '[打开 Qoder 会话列表](https://qoder.com.cn/cloud/sessions)，选择「Dot by QCA · 当前主会话」。' })
})

test('QCA reminders send only a schedule ID and idempotency key and check IM delivery', async t => {
  const runSchedule = t.mock.fn(async () => ({ id: 'srun_fixture', status: 'completed', push_status: 'succeeded' }))
  const send = qcaApprovalSender({ runSchedule }, 'sched_fixture')
  const signal = new AbortController().signal
  await send(signal, ['approval_2', 'approval_1'])
  await send(signal, ['approval_1', 'approval_2'])
  const [id, key, deadline] = runSchedule.mock.calls[0].arguments
  assert.equal(id, 'sched_fixture')
  assert.match(key, /^dot-approval-[a-f0-9]{64}$/)
  assert.equal(key, runSchedule.mock.calls[1].arguments[1])
  assert.equal(deadline.aborted, false)

  const failed = qcaApprovalSender({
    runSchedule: async () => ({ id: 'srun_fixture', status: 'completed', push_status: 'failed' }),
  }, 'sched_fixture')
  await assert.rejects(failed(signal, ['approval_1']), /未能投递/)
})

test('a QCA run uses the bodyless POST endpoint and waits for reported delivery', async t => {
  const requests = []
  const server = createServer(async (req, res) => {
    const body = []
    for await (const chunk of req) body.push(chunk)
    requests.push([req.method, req.url, Buffer.concat(body).length])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.method === 'POST'
      ? { id: 'srun_fixture', status: 'pending', push_status: 'pending' }
      : { id: 'srun_fixture', status: 'completed', push_status: 'succeeded' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = qcaClient(`http://127.0.0.1:${server.address().port}`, 'fixture')
  await qcaApprovalSender(client, 'sched_fixture')(new AbortController().signal, ['approval'])
  assert.deepEqual(requests, [['POST', '/schedules/sched_fixture/run', 0], ['GET', '/schedule_runs/srun_fixture', 0]])
})
