import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { wechatApproval, wechatChoice } from './dot-wechat-approval.mjs'

const sender = 'fixture_sender'
const sessionId = 'sess_main'
const id = 'evt_card'
const signal = new AbortController().signal
const response = (input, time = Date.now(), user = sender) => ({ type: 'user.message', session_id: 'sess_im',
  processed_at: new Date(time).toISOString(), content: [{ type: 'text', text: `用户信息：${user}\n` }, { type: 'text', text: input }] })

test('WeChat requires an exact choice and an eight-character code from the bound sender', () => {
  assert.deepEqual(wechatChoice(response('/yes 12abcdef'), sender), { code: '12ABCDEF', choice: '允许' })
  assert.deepEqual(wechatChoice(response('拒绝 12ABCDEF'), sender), { code: '12ABCDEF', choice: '拒绝' })
  for (const text of ['是', '同意', '/yes', '请同意 12ABCDEF', '同意 12ABCDEF 再执行']) {
    assert.equal(wechatChoice(response(text), sender), undefined)
  }
  assert.equal(wechatChoice(response('是 12ABCDEF', Date.now(), 'other'), sender), undefined)
})

test('an exact delivered card can be answered once and cannot approve a new or expired card', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-wechat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'approval.json')
  const pairing = { id: 'pair_fixture', status: 'active', scope_type: 'direct', scope_external_id: sender,
    channel_id: 'channel_fixture', identity_id: 'idn_fixture', template_id: 'tmpl_fixture' }
  const im = { id: 'sess_im', source_type: 'im', identity_id: pairing.identity_id, template: { id: pairing.template_id },
    metadata: { channel_id: pairing.channel_id, channel_type: 'wechat', channel_external_id: sender, channel_user_external_id: sender } }
  const updates = []
  let messages = []
  let output = ''
  let version = 0
  const client = {
    getSchedule: async () => ({ trigger_policy: { type: 'manual' }, sinks: [{ type: 'im_channel', channel_pairing_id: pairing.id }] }),
    getChannelPairing: async () => pairing,
    updateSchedule: async (_id, { initial_events: [event] }) => {
      updates.push(event.content)
      output = event.content.split('\n').slice(1).join('\n')
      return { initial_events_version: ++version }
    },
    listImSessions: async () => ({ data: [im] }),
    listImMessages: async () => ({ data: messages }),
  }
  let mismatch = false
  const save = (path, value) => writeFile(path, JSON.stringify(value))
  const create = () => wechatApproval({ client, pairingId: pairing.id, scheduleId: 'sched_fixture', file, save,
    deliver: async () => ({ result_payload: mismatch ? 'wrong text' : output, initial_events_version: version,
      push_finished_at: new Date().toISOString() }),
  })
  const card = { id, text: '允许测试吗？', choices: ['允许', '拒绝'] }
  await create().offer(sessionId, card, ['hash'], () => true, signal)
  const { issuedAt, code } = JSON.parse(await readFile(file, 'utf8'))
  assert.match(updates[0], new RegExp(`允许测试吗？.*同意 ${code}`, 's'))
  assert.ok(updates[0].includes(`\n\n同意 ${code}\n\n拒绝 ${code}`))
  assert.doesNotMatch(updates[1], /允许测试吗？/)

  const bridge = create()
  const approve = t.mock.fn(async () => true)
  messages = [response('同意 ' + code, issuedAt - 1), response('是', issuedAt), response('同意 ' + code, issuedAt + 600_000)]
  await bridge.poll(sessionId, () => true, approve, signal)
  messages = [response('同意 ' + code, issuedAt)]
  await bridge.poll('sess_other', () => true, approve, signal)
  await bridge.poll(sessionId, () => false, approve, signal)
  assert.equal(approve.mock.callCount(), 0)
  await bridge.poll(sessionId, item => item === id, approve, signal)
  await bridge.poll(sessionId, () => true, approve, signal)
  assert.deepEqual(approve.mock.calls.map(call => call.arguments), [[id, '允许', issuedAt + 600_000]])
  assert.equal(JSON.parse(await readFile(file, 'utf8')), null)

  mismatch = true
  await bridge.offer(sessionId, card, ['hash'], () => true, signal)
  assert.equal(JSON.parse(await readFile(file, 'utf8')), null)
  await bridge.offer(sessionId, { ...card, text: '读取 API_KEY' }, ['hash'], () => true, signal)
  assert.doesNotMatch(updates.at(-1), /API_KEY|同意/)
})
