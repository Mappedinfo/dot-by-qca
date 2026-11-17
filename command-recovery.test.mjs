import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { blockedTerminalCommand } from './task-review.mjs'
import { approvedDshTask, directlyRequestedDshTask, questionAnswer, requestedMacClock } from './console-approval.mjs'
import { CONSOLE_QUESTION, DOT_DSH_FOLLOWUP_TOOL, DOT_TASKBOOK_TOOL, DSH_CLOCK_TOOL, DSH_COMMAND_HEADER, DSH_COMMAND_PREFIX, DSH_CONTINUE_TOOL, DSH_DIRECT_TOOL, DSH_EXACT_COMMAND_HEADER, DSH_EXACT_COMMAND_PREFIX, DSH_REVIEW_TOOL, DSH_TOOL } from './qca.mjs'

const sessionId = 'sess_recovery_fixture'
const origin = 'evt_start'
const continuation = 'evt_continue'
const receipt = 'a'.repeat(20)
const continuationReceipt = 'b'.repeat(20)
const thread = 'fixture-thread'

function paused(id) {
  const stop_reason = { type: 'requires_action', event_ids: [id] }
  return [
    { id: `${id}_thread_idle`, type: 'session.thread_status_idle', stop_reason, session_thread_id: thread },
    { id: `${id}_idle`, type: 'session.status_idle', stop_reason },
  ]
}

function pendingEvents(target) {
  const question = `${DSH_COMMAND_PREFIX}在 Mac 上运行测试命令`
  return [
    { id: 'evt_user', type: 'user.message' },
    { id: 'evt_card', type: 'agent.custom_tool_use', name: CONSOLE_QUESTION, input: {
      questions: [{ header: 'Mac DSH', question, multiSelect: false, options: [{ label: '允许' }, { label: '拒绝' }] }],
    } },
    ...paused('evt_card'),
    { id: 'evt_answer', type: 'user.custom_tool_result', session_thread_id: thread, custom_tool_use_id: 'evt_card',
      content: [{ type: 'text', text: questionAnswer(question, '允许') }] },
    { id: origin, type: 'agent.custom_tool_use', name: DSH_TOOL, input: {} },
    ...paused(origin),
    ...(target === continuation ? [
      { id: 'evt_announced', type: 'user.custom_tool_result', custom_tool_use_id: origin },
      { id: continuation, type: 'agent.custom_tool_use', name: DSH_CONTINUE_TOOL, input: {} },
      ...paused(continuation),
    ] : []),
  ]
}

async function recover(t, target, saved, { retry = false, interruptedCard } = {}) {
  const decisions = {
    [origin]: { receipt, decision: 'allow' },
    ...(target === continuation && !interruptedCard && { [continuation]: { receipt: continuationReceipt, decision: 'allow', runReceipt: receipt } }),
  }
  const root = await prepareConsole(t, decisions)
  const runDir = join(root, '.dot-state', 'cn', 'dsh-runs')
  await mkdir(runDir)
  await writeFile(join(runDir, `${receipt}.json`), JSON.stringify({ receipt, qcaSessionId: sessionId, eventId: origin, commands: true, ...saved }))
  const history = pendingEvents(target)
  if (interruptedCard) {
    const question = '允许执行 printf fixture 一次吗？'
    const announcement = history.find(event => event.id === 'evt_announced')
    announcement.content = [{ type: 'text', text: JSON.stringify({ status: 'pending_command', approvalQuestion: question }) }]
    history.splice(history.findIndex(event => event.id === continuation), 0,
      { id: 'evt_interrupted_card', type: 'agent.custom_tool_use', name: CONSOLE_QUESTION, input: {
        questions: [{ header: DSH_COMMAND_HEADER, question, multiSelect: false, options: [{ label: '允许' }, { label: '拒绝' }] }],
      } }, ...paused('evt_interrupted_card'),
      { id: 'evt_interrupted_answer', type: 'user.custom_tool_result', session_thread_id: thread,
        custom_tool_use_id: 'evt_interrupted_card',
        content: [{ type: 'text', text: questionAnswer(interruptedCard === 'matched' ? question : 'other task', '允许') }] })
  }
  const posts = []
  await startConsole(t, root, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!url.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      const after = history.findIndex(event => event.id === url.searchParams.get('after_id'))
      return res.end(JSON.stringify({ data: history.slice(after + 1) }))
    }
    const input = JSON.parse((await Array.fromAsync(req)).join('')).events[0]
    posts.push({ input, key: req.headers['idempotency-key'] })
    if (retry && posts.length === 1) {
      res.statusCode = 503
      return res.end('{}')
    }
    const event = { id: 'evt_recovered', ...input }
    history.push(event)
    res.end(JSON.stringify({ data: [event] }))
  })
  for (let i = 0; i < 100 && posts.length < (retry ? 2 : 1); i++) await delay(50)
  assert.equal(posts.length, retry ? 2 : 1)
  if (retry) assert.deepEqual(posts[0], posts[1])
  const { input, key } = posts.at(-1)
  assert.equal(input.custom_tool_use_id, target)
  assert.match(key, /^mac-tool-[a-f0-9]{20}$/)
  if (!interruptedCard) assert.equal(key, `mac-tool-${target === continuation ? continuationReceipt : receipt}`)
  return input
}

async function prepareConsole(t, decisions) {
  const root = await mkdtemp(join(tmpdir(), 'dot-console-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateDir = join(root, '.dot-state', 'cn')
  await mkdir(stateDir, { recursive: true })
  await Promise.all([
    ...['server.mjs', 'qca.mjs', 'console-approval.mjs', 'task-review.mjs', 'dot-archive.mjs', 'dot-memory.mjs', 'dot-migration.mjs', 'dot-taskbook.mjs', 'dot-dsh-followup.mjs', 'dot-cloud-followup.mjs', 'dot-bridge.mjs', 'dot-maintenance.mjs', 'dot-entry.mjs', 'dot-approval-notify.mjs', 'dot-wechat-approval.mjs', 'dsh-task-source.mjs', 'dsh-panel'].map(file => cp(new URL(file, import.meta.url), join(root, file), { recursive: true })),
    writeFile(join(stateDir, 'session.json'), JSON.stringify({ sessionId, decisions })),
    writeFile(join(root, 'dsh-runner.mjs'), "export async function dshCliAvailable() { return true }\nexport function reviewDshTask() { return { verdict: 'allow', reason: 'fixture' } }\nexport function runDsh() { process.exit(90) }\nexport function runDshCommandTask() { process.exit(91) }\n"),
  ])
  return root
}

async function startConsole(t, root, handle, { notifications = false } = {}) {
  const gateway = createServer(handle)
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const freePort = createServer().listen(0, '127.0.0.1')
  await once(freePort, 'listening')
  const port = freePort.address().port
  await new Promise(resolve => freePort.close(resolve))
  const preload = `const request = globalThis.fetch; globalThis.fetch = (url, options) =>
    request(url.replace('https://api.qoder.com.cn/api/v1/cloud', 'http://127.0.0.1:${gateway.address().port}')
      .replace('https://api.qoder.com.cn/api/v1/forward', 'http://127.0.0.1:${gateway.address().port}'), options);`
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'server.mjs', '--qca-console'], {
    cwd: root, env: { QODER_SITE: 'cn', QODER_PAT: 'fixture', DOT_PORT: String(port),
      ...(notifications && { DOT_QCA_APPROVAL_SCHEDULE_ID: 'sched_fixture' }) }, stdio: 'ignore',
  })
  const exit = once(child, 'exit')
  t.after(async () => {
    child.kill('SIGTERM')
    gateway.closeAllConnections()
    gateway.close()
    await exit
  })
  t.after(() => assert.equal(child.exitCode, 0, 'the fixture DSH runner must never start'))
  return { url: `http://127.0.0.1:${port}`, child }
}

test('only a finished reply with no pending cloud return receives a completion marker', async t => {
  const root = await prepareConsole(t, {})
  const reply = id => ({ id, type: 'agent.message', content: [{ type: 'text', text: id }] })
  const ended = id => ({ id, type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
  const history = [
    { id: 'evt_first_user', type: 'user.message' },
    { id: 'evt_delegated', type: 'agent.thread_message_sent', to_session_thread_id: thread },
    reply('evt_interim'), ended('evt_first_idle'),
    { id: 'evt_returned', type: 'agent.thread_message_received', from_session_thread_id: thread },
    reply('evt_final'), ended('evt_final_idle'),
    { id: 'evt_second_user', type: 'user.message' },
    reply('evt_stopped'), { id: 'evt_interrupt', type: 'user.interrupt' }, ended('evt_stopped_idle'),
    { id: 'evt_third_user', type: 'user.message' },
    reply('evt_streaming'),
  ]
  const { url } = await startConsole(t, root, (req, res) => {
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (new URL(req.url, 'http://127.0.0.1').pathname.endsWith('/events')) {
      return res.end(JSON.stringify({ data: history }))
    }
    res.end(JSON.stringify({ id: sessionId, status: 'running' }))
  })
  let messages = []
  for (let i = 0; i < 100; i++) {
    const response = await fetch(url + '/api/state').catch(() => null)
    if (response?.ok) messages = (await response.json()).messages
    if (messages.some(message => message.id === 'evt_streaming')) break
    await delay(50)
  }
  assert.deepEqual(messages.map(message => [message.id, Boolean(message.replyCompleted)]), [
    ['evt_interim', false], ['evt_final', true], ['evt_stopped', false], ['evt_streaming', false],
  ])
})

test('the taskbook restores original Mac receipts and reads only the requested receipt', async t => {
  const root = await prepareConsole(t, {})
  const stateDir = join(root, '.dot-state', 'cn')
  const runDir = join(stateDir, 'dsh-runs')
  await mkdir(runDir)
  const older = 'sess_previous'
  const unrelated = 'sess_unrelated'
  const requestedReceipt = 'a'.repeat(20)
  const unfinishedReceipt = 'b'.repeat(20)
  const otherReceipt = 'c'.repeat(20)
  const now = Date.now()
  const record = (receipt, qcaSessionId, status, fields) => writeFile(join(runDir, receipt + '.json'),
    JSON.stringify({ receipt, qcaSessionId, eventId: 'evt_receipt_source', status, ...fields }))
  await Promise.all([
    writeFile(join(stateDir, 'migration.json'), JSON.stringify({ stage: 'ready', sourceSessionId: older, targetSessionId: sessionId })),
    record(requestedReceipt, older, 'completed', { text: 'accepted old output', startedAt: now - 5000, finishedAt: now - 1000 }),
    record(unfinishedReceipt, sessionId, 'started', { startedAt: now - 500 }),
    record(otherReceipt, unrelated, 'completed', { text: 'outside lineage' }),
  ])
  const request = { id: 'evt_lookup', type: 'agent.custom_tool_use', name: DOT_TASKBOOK_TOOL, input: {} }
  const history = [{ id: 'evt_user_lookup', type: 'user.message',
    content: [{ type: 'text', text: '查看 Mac 回执 ' + requestedReceipt }] }, request, ...paused(request.id)]
  const results = []
  const { url } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!endpoint.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      return res.end(JSON.stringify({ data: history.slice(history.findIndex(e => e.id === endpoint.searchParams.get('after_id')) + 1) }))
    }
    const [submitted] = JSON.parse((await Array.fromAsync(req)).join('')).events
    const answer = { id: 'evt_receipt_answer', ...submitted }
    history.push(answer)
    results.push(answer)
    res.end(JSON.stringify({ data: [answer] }))
  })
  for (let i = 0; i < 100 && results.length === 0; i++) await delay(50)
  assert.equal(results.length, 1)
  assert.equal(results[0].custom_tool_use_id, request.id)
  const response = JSON.parse(results[0].content[0].text)
  assert.deepEqual([response.receipt, response.cloudSessionId, response.output],
    [requestedReceipt, older, 'accepted old output'])
  const book = await fetch(url + '/api/taskbook', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(r => r.json())
  assert.deepEqual(book.macRuns.map(run => [run.receipt, run.status]), [[unfinishedReceipt, 'unconfirmed'], [requestedReceipt, 'completed']])
  assert.doesNotMatch(JSON.stringify(book), /accepted old output|outside lineage/)
})

test('a repair requested while the Mac is away is recovered once from QCA history without a tool call', async t => {
  const root = await prepareConsole(t, {})
  const stateDir = join(root, '.dot-state', 'cn')
  const now = Date.now()
  await writeFile(join(stateDir, 'maintenance-recovery.json'), JSON.stringify({ since: now - 2000 }))
  const maintenanceFile = join(stateDir, 'maintenance.json')
  let session = {
    id: sessionId, status: 'idle', metadata: { source: 'qoder-dot-demo' },
    agent: { name: 'Dot by QCA', system: 'old config', tools: [], multiagent: {
      agents: [{ name: 'Dot 云端助手', tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['WebSearch', 'WebFetch'] }] }],
    } },
  }
  const history = [
    { id: 'evt_offline_repair', type: 'user.message', processed_at: new Date(now - 1000).toISOString(),
      content: [{ type: 'text', text: '检查并修复 Dot 配置' }] },
    { id: 'evt_offline_ack', type: 'agent.message', content: [{ type: 'text', text: '已在对话收到，等 Mac 重连。' }] },
    { id: 'evt_offline_closed', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]
  let upgrades = 0
  const { url } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (endpoint.pathname.endsWith('/events')) {
      assert.equal(req.method, 'GET')
      const after = history.findIndex(event => event.id === endpoint.searchParams.get('after_id'))
      return res.end(JSON.stringify({ data: history.slice(after + 1) }))
    }
    if (endpoint.pathname.endsWith('/threads')) return res.end('{"data":[]}')
    if (req.method === 'POST') {
      const { agent } = JSON.parse((await Array.fromAsync(req)).join(''))
      session = { ...session, agent: { ...session.agent, ...agent } }
      upgrades++
    }
    return res.end(JSON.stringify(session))
  })
  let saved
  for (let attempt = 0; attempt < 120; attempt++) {
    saved = await readFile(maintenanceFile, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (saved?.status === 'completed') break
    await delay(200)
  }
  assert.equal(saved?.requestId, 'evt_offline_repair')
  assert.equal(saved.origin, 'recovered_chat')
  assert.equal(saved.status, 'completed')
  assert.equal(upgrades, 1)
  const state = await fetch(`${url}/api/state`).then(response => response.json())
  assert.equal(state.sessionId, sessionId)
})

test('approval notifications ignore replayed cancelled cards and send for a current card', async t => {
  const root = await prepareConsole(t, {})
  const tool = id => ({ id, type: 'agent.tool_use', name: 'Bash', evaluated_permission: 'ask', input: { command: 'private fixture' } })
  const history = [
    { id: 'evt_old_user', type: 'user.message' }, tool('evt_old'), ...paused('evt_old'),
    { id: 'evt_interrupt', type: 'user.interrupt' },
    { id: 'evt_old_result', type: 'agent.tool_result', tool_use_id: 'evt_old', is_error: true },
    { id: 'evt_ended', type: 'session.status_idle', stop_reason: { type: 'cancelled' } },
  ]
  let stream
  const sent = []
  const { url } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname === '/schedules/sched_fixture/run') {
      sent.push({ method: req.method, key: req.headers['idempotency-key'], body: (await Array.fromAsync(req)).join('') })
      return res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ id: 'srun_fixture', status: 'completed', push_status: 'succeeded' }))
    }
    if (endpoint.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    const data = endpoint.pathname.endsWith('/events') ? { data: history }
      : endpoint.pathname.endsWith('/threads') ? { data: [] } : { id: sessionId, status: 'idle' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
  }, { notifications: true })
  let initial
  for (let i = 0; i < 100; i++) {
    initial = await fetch(`${url}/api/state`).then(res => res.json()).catch(() => null)
    if (initial?.cloudConnection === 'connected') break
    await delay(50)
  }
  assert.equal(initial?.cloudConnection, 'connected')
  assert.deepEqual(initial.approvals, [])
  assert.equal(sent.length, 0)
  for (const event of [{ id: 'evt_new_user', type: 'user.message' }, tool('evt_new'), ...paused('evt_new')]) {
    stream.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  for (let i = 0; i < 100 && sent.length === 0; i++) await delay(50)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'POST')
  assert.equal(sent[0].body, '')
  assert.match(sent[0].key, /^dot-approval-[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(sent), /private fixture|evt_(?:old|new)|sess_recovery_fixture/)
})

test('the same Dot session can find, queue, read and stop a DSH conversation outside the recent taskbook', async t => {
  const root = await prepareConsole(t, {})
  const target = 'session-50000000-0000-4000-8000-000000000001'
  const later = 'session-50000000-0000-4000-8000-000000000002'
  const fixture = { sessionId: target, updatedAt: 1, projections: { values: { title: '合成旧会话' } } }
  await writeFile(join(root, 'dsh-task-source.mjs'), `
    const target = ${JSON.stringify(fixture)}
    let requestId
    let stopped = false
    const check = id => { if (id !== target.sessionId) throw new Error('Wrong DSH session') }
    export function webTaskSource() { return {
      list: async () => ({ source: '00000000-0000-4000-8000-000000000001',
        rows: [{ id: '${later}', title: '近期会话', status: 'idle' }], omitted: 1 }),
      eligibleSessions: async () => [target, { sessionId: '${later}', updatedAt: 2,
        projections: { values: { title: '合成新会话' } } }],
      state: async id => {
        check(id)
        return { cursor: stopped ? 15 : requestId ? 14 : 10, running: Boolean(requestId && !stopped), queue: [{ rpcId: 'keep' }] }
      },
      cancel: async id => {
        check(id)
        if (!requestId || stopped) throw new Error('Unexpected cancellation')
        stopped = true
        return { accepted: true }
      },
      prompt: async (id, rpcId, text) => {
        check(id)
        if (requestId || text !== '只回复合成结果') throw new Error('Unexpected dispatch')
        requestId = rpcId
        return { accepted: true }
      },
      history: async (id, _signal, _before, through) => {
        check(id)
        if (through === 15) return { hasMore: false, records: [
          { event: { seq: 15, type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } } },
        ] }
        if (through !== 14 && through !== 13) throw new Error('History cut was not pinned')
        return { hasMore: false, records: [
          { event: { seq: 10, type: 'turn/start', data: { turn: 1 } } },
          { event: { seq: 11, type: 'user/message', data: { source: { rpcId: requestId } } } },
          { event: { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '合成结果' }] } } } },
          { event: { seq: 13, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
          ...(through === 14 ? [{ event: { seq: 14, type: 'turn/start', data: { turn: 2 } } }] : []),
        ] }
      },
    } }
  `)
  const history = []
  const posts = []
  let stream
  const emit = (...events) => {
    history.push(...events)
    for (const event of events) stream?.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const turn = (n, text, tool) => emit(
    { id: `evt_history_user_${n}`, type: 'user.message', content: [{ type: 'text', text }] },
    { id: `evt_history_tool_${n}`, type: 'agent.custom_tool_use', name: tool, input: {} },
    ...paused(`evt_history_tool_${n}`),
  )
  turn(1, '查找 DSH 对话：合成旧会话', DOT_TASKBOOK_TOOL)
  const { url } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (endpoint.pathname.endsWith('/threads')) return res.end('{"data":[]}')
    if (!endpoint.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      const after = history.findIndex(event => event.id === endpoint.searchParams.get('after_id'))
      return res.end(JSON.stringify({ data: history.slice(after + 1) }))
    }
    const input = JSON.parse((await Array.fromAsync(req)).join('')).events[0]
    const n = posts.length + 1
    const result = { id: `evt_history_result_${n}`, ...input }
    posts.push(result)
    emit(result, { id: `evt_history_idle_${n}`, type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
    res.end(JSON.stringify({ data: [result] }))
  })
  async function result(n) {
    for (let i = 0; i < 100; i++) {
      const state = await fetch(`${url}/api/state`).then(response => response.json()).catch(() => null)
      if (posts[n - 1] && state?.phase === 'idle' && state?.cloudConnection === 'connected') {
        assert.equal(state.sessionId, sessionId)
        assert.equal(posts[n - 1].custom_tool_use_id, `evt_history_tool_${n}`)
        assert.equal(posts[n - 1].is_error, false)
        return JSON.parse(posts[n - 1].content[0].text)
      }
      await delay(50)
    }
    assert.fail(`no result for fixture turn ${n}`)
  }
  assert.deepEqual((await result(1)).matches, [{ id: target, title: '合成旧会话', updatedAt: 1 }])
  const taskbook = await fetch(`${url}/api/taskbook`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(res => res.json())
  assert(!taskbook.tasks.some(item => item.id === target))
  turn(2, '在 DSH 对话「合成旧会话」里继续：只回复合成结果', DOT_DSH_FOLLOWUP_TOOL)
  const queued = await result(2)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.sessionId, target)
  turn(3, `查看 DSH 续办结果 ${queued.receipt}`, DOT_DSH_FOLLOWUP_TOOL)
  const completed = await result(3)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.receipt, queued.receipt)
  assert.equal(completed.result, '合成结果')
  turn(4, '在 DSH 对话『合成』中继续：只回复合成结果', DOT_DSH_FOLLOWUP_TOOL)
  const ambiguous = await result(4)
  assert.equal(ambiguous.status, 'multiple_matches')
  assert.deepEqual(ambiguous.matches.map(match => match.id), [target, later])
  turn(5, '停止 DSH 对话『合成旧会话』', DOT_DSH_FOLLOWUP_TOOL)
  const stopped = await result(5)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.session.id, target)
  assert.equal(stopped.finishedAtSeq, 15)
  assert.equal(stopped.queued, 1)
  turn(6, `查看 DSH 结果 ${target} #13`, DOT_TASKBOOK_TOOL)
  const earlier = await result(6)
  assert.equal(earlier.session.id, target)
  assert.equal(earlier.finishedAtSeq, 13)
  assert.equal(earlier.result, '合成结果')
})

test('restores the command result to the same continuation after restart and retries the identical receipt', async t => {
  const input = await recover(t, continuation, {
    status: 'completed', resultEventId: continuation,
    commandResults: [{ status: 'completed', command: 'printf fixture', output: 'fixture' }],
  }, { retry: true })
  assert.equal(input.is_error, false)
  assert.match(input.content[0].text, /执行完成 · printf fixture/)
  assert.match(input.content[0].text, new RegExp(receipt))
})

test('restores a terminal failure saved before any command approval', async t => {
  const input = await recover(t, origin, { status: 'failed', resultEventId: origin })
  assert.equal(input.is_error, true)
  assert.match(input.content[0].text, /Mac DSH 任务已中止或失败/)
})

test('does not send a completed result to a different continuation', async t => {
  const input = await recover(t, continuation, { status: 'completed', resultEventId: 'evt_other', text: 'other task' })
  assert.equal(input.is_error, true)
  assert.match(input.content[0].text, /未能恢复/)
  assert.doesNotMatch(input.content[0].text, /other task/)
})

test('returns the interrupted command receipt when a Qoder card is answered after restart', async t => {
  const input = await recover(t, continuation, {
    status: 'cancelled', resultEventId: origin, interruptedAt: origin, approvedCommands: 1,
    commandResults: [{ status: 'completed', command: 'printf earlier', output: 'earlier' }],
  }, { interruptedCard: 'matched', retry: true })
  assert.equal(input.is_error, true)
  assert.match(input.content[0].text, /终端任务已中断，等待批准的命令未执行/)
  assert.match(input.content[0].text, /执行完成 · printf earlier/)
  assert.match(input.content[0].text, new RegExp(receipt))
})

test('a restarted command only returns its receipt for the matching approval card', async t => {
  const input = await recover(t, continuation, {
    status: 'cancelled', resultEventId: origin, interruptedAt: origin, text: 'earlier',
  }, { interruptedCard: 'mismatched' })
  assert.equal(input.is_error, true)
  assert.match(input.content[0].text, /没有对应的 Mac 终端审批/)
  assert.doesNotMatch(input.content[0].text, /earlier/)
})

test('reports a dropped cloud connection and resumes the same session with missed events', async t => {
  const root = await prepareConsole(t, {})
  const oldMessage = { id: 'evt_old', type: 'agent.message', content: [{ type: 'text', text: '已有消息' }] }
  const newMessage = { id: 'evt_new', type: 'agent.message', content: [{ type: 'text', text: '断线期间的消息' }] }
  let stream
  let online = true
  let resumeFrom
  let history = [oldMessage]
  const { url, child } = await startConsole(t, root, (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (!online) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}')
    } else if (endpoint.pathname.endsWith('/stream')) {
      resumeFrom = req.headers['last-event-id']
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': heartbeat\n\n')
    } else {
      const data = endpoint.pathname.endsWith('/events')
        ? { data: history.slice(history.findIndex(event => event.id === endpoint.searchParams.get('after_id')) + 1) }
        : { id: sessionId, status: 'idle' }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    }
  })
  async function waitForConnection(connection) {
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null)
      const state = await fetch(`${url}/api/state`).then(response => response.json()).catch(() => null)
      if (state?.cloudConnection === connection) return state
      await delay(50)
    }
    assert.fail(`never observed cloud connection state ${connection}`)
  }
  assert.deepEqual((await waitForConnection('connected')).messages.map(message => message.id), ['evt_old'])
  online = false
  stream.destroy()
  assert.deepEqual((await waitForConnection('reconnecting')).messages.map(message => message.id), ['evt_old'])
  const blocked = await fetch(`${url}/api/message`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(blocked.status, 503)
  history = [oldMessage, newMessage]
  online = true
  const recovered = await waitForConnection('connected')
  assert.equal(recovered.sessionId, sessionId)
  assert.deepEqual(recovered.messages.map(message => message.id), ['evt_old', 'evt_new'])
  assert.equal(resumeFrom, 'evt_new')
})

test('hides the old approval as soon as a Qoder cancellation starts and rejects submissions until it ends', async t => {
  const root = await prepareConsole(t, {})
  const cardId = 'evt_old_card'
  const history = [
    { id: 'evt_old_turn', type: 'user.message' },
    { id: cardId, type: 'agent.custom_tool_use', name: CONSOLE_QUESTION, input: {
      questions: [{ header: DSH_COMMAND_HEADER, question: '旧卡', multiSelect: false, options: [{ label: '允许' }, { label: '拒绝' }] }],
    } },
    ...paused(cardId),
  ]
  let stream
  let submissions = 0
  const { url } = await startConsole(t, root, (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    if (req.method === 'POST') submissions++
    const data = endpoint.pathname.endsWith('/events')
      ? { data: history.slice(history.findIndex(event => event.id === endpoint.searchParams.get('after_id')) + 1) }
      : { id: sessionId, status: 'idle' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
  })
  function append(event) {
    history.push(event)
    stream.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  async function waitForPhase(phase) {
    for (let i = 0; i < 100; i++) {
      const snapshot = await fetch(`${url}/api/state`).then(response => response.json()).catch(() => null)
      if (snapshot?.cloudConnection === 'connected' && snapshot.phase === phase) return snapshot
      await delay(50)
    }
    assert.fail(`never observed ${phase}`)
  }
  assert.equal((await waitForPhase('approval')).approvals[0]?.id, cardId)
  append({ id: 'evt_interrupt', type: 'user.interrupt' })
  append({ id: 'evt_late_idle', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [cardId] } })
  assert.deepEqual((await waitForPhase('stopping')).approvals, [])
  const request = (path, body) => fetch(`${url}${path}`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await request('/api/approval', { id: cardId, choice: '允许' })).status, 409)
  const draft = { text: '下一轮', requestId: 'ba018d2f-d6b0-4bbe-a53c-2241baca34fe' }
  assert.equal((await request('/api/message', draft)).status, 409)
  assert.equal(submissions, 0)
  append({ id: 'evt_cancelled', type: 'session.status_idle', stop_reason: { type: 'cancelled' } })
  assert.deepEqual((await waitForPhase('idle')).approvals, [])
  assert.equal((await request('/api/message', draft)).status, 200)
  assert.equal(submissions, 1)
})

test('a late approval from the Qoder console returns expiry without running the command', async t => {
  const root = await prepareConsole(t, {})
  const runner = `export async function dshCliAvailable() { return true }
    export function reviewDshTask() { return { verdict: 'allow', reason: 'fixture' } }
    export function runDsh() { process.exit(90) }
    export async function runDshCommandTask(task, cwd, signal, approve) {
      const deadline = Date.now() + 1200
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(1200)])
      if (await approve('printf expiry-fixture', timeout, deadline)) process.exit(91)
      throw Object.assign(new Error('expired'), {
        audit: { approvedCommands: 0, rejectedCommands: 0, commandResults: [] },
      })
    }`
  await writeFile(join(root, 'dsh-runner.mjs'), runner)
  const history = pendingEvents(origin)
  const posts = []
  let stream
  function append(...events) {
    history.push(...events)
    for (const event of events) stream?.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const { url, child } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST') {
      const input = JSON.parse((await Array.fromAsync(req)).join('')).events[0]
      const accepted = { id: `evt_post_${posts.length}`, ...input }
      posts.push(accepted)
      append(accepted)
      if (input.custom_tool_use_id === origin) {
        const question = JSON.parse(input.content[0].text).approvalQuestion
        append({ id: 'evt_command_card', type: 'agent.custom_tool_use', name: CONSOLE_QUESTION, input: {
          questions: [{ header: DSH_COMMAND_HEADER, question, multiSelect: false, options: [{ label: '允许' }, { label: '拒绝' }] }],
        } }, ...paused('evt_command_card'))
      }
      return res.end(JSON.stringify({ data: [accepted] }))
    }
    const data = endpoint.pathname.endsWith('/events')
      ? { data: history.slice(history.findIndex(event => event.id === endpoint.searchParams.get('after_id')) + 1) }
      : { id: sessionId, status: 'idle' }
    res.end(JSON.stringify(data))
  })
  let card
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null)
    const state = await fetch(`${url}/api/state`).then(response => response.json()).catch(() => null)
    card = state?.approvals.find(item => item.id === 'evt_command_card')
    if (card?.expired) break
    await delay(50)
  }
  assert.ok(card?.expired)
  assert.match(card.text, /截止/)
  const rejected = await fetch(`${url}/api/approval`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: card.id, choice: '允许' }),
  })
  assert.equal(rejected.status, 409)
  append({ id: 'evt_late_answer', type: 'user.custom_tool_result', custom_tool_use_id: card.id, session_thread_id: thread,
    content: [{ type: 'text', text: questionAnswer(card.text, '允许') }] },
  { id: continuation, type: 'agent.custom_tool_use', name: DSH_CONTINUE_TOOL, input: {} }, ...paused(continuation))
  for (let i = 0; i < 100 && posts.length < 2; i++) await delay(50)
  assert.equal(posts.length, 2)
  assert.equal(posts[1].custom_tool_use_id, continuation)
  assert.equal(posts[1].is_error, true)
  assert.match(posts[1].content[0].text, /审批已过期，等待批准的命令未执行/)
})

test('one approved card permits the exact command once and never asks for a second approval', async t => {
  const root = await prepareConsole(t, {})
  const command = 'printf one-card'
  const question = DSH_EXACT_COMMAND_PREFIX + command
  const runner = `let reviewed = false
    export async function dshCliAvailable() { return true }
    export function reviewDshTask(proposal) {
      if (proposal.command !== 'printf one-card' || proposal.mode !== 'exact') process.exit(95)
      reviewed = true
      return { verdict: 'allow', reason: 'fixture' }
    }
    export function runDsh() { process.exit(90) }
    export async function runDshCommandTask(task, cwd, signal, approve) {
      if (!reviewed || !task.endsWith('\\nprintf one-card')) process.exit(91)
      const check = command => approve(command, signal, Date.now() + 1000)
      if (!(await check('printf one-card'))) process.exit(92)
      if (await check('printf one-card')) process.exit(93)
      if (await check('printf extra')) process.exit(94)
      return { sessionId: 'fixture', approvedCommands: 1, rejectedCommands: 2,
        commandResults: [{ command: 'printf one-card', status: 'completed', output: 'one-card' }] }
    }`
  await writeFile(join(root, 'dsh-runner.mjs'), runner)
  const history = pendingEvents(origin)
  history[0].content = [{ type: 'text', text: `让 D 在 Mac 执行 \`${command}\`，把输出发回来` }]
  Object.assign(history[1].input.questions[0], { header: DSH_EXACT_COMMAND_HEADER, question })
  history.find(event => event.id === 'evt_answer').content[0].text = questionAnswer(question, '允许')
  const posts = []
  await startConsole(t, root, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!url.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      const after = history.findIndex(event => event.id === url.searchParams.get('after_id'))
      return res.end(JSON.stringify({ data: history.slice(after + 1) }))
    }
    const input = JSON.parse((await Array.fromAsync(req)).join('')).events[0]
    const event = { id: 'evt_one_card_result', ...input }
    posts.push(input)
    history.push(event)
    res.end(JSON.stringify({ data: [event] }))
  })
  for (let i = 0; i < 100 && !posts.length; i++) await delay(50)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].custom_tool_use_id, origin)
  assert.equal(posts[0].is_error, false)
  assert.match(posts[0].content[0].text, /执行完成 · printf one-card/)
  assert.doesNotMatch(posts[0].content[0].text, /pending_command/)
})

test('a single approval cannot authorize a command rewritten by Qoder', () => {
  const history = pendingEvents(origin)
  const question = DSH_EXACT_COMMAND_PREFIX + 'printf rewritten'
  history[0].content = [{ type: 'text', text: '让 D 在 Mac 上执行 `printf original`' }]
  Object.assign(history[1].input.questions[0], { header: DSH_EXACT_COMMAND_HEADER, question })
  history.find(event => event.id === 'evt_answer').content[0].text = questionAnswer(question, '允许')
  assert.equal(approvedDshTask(history, history.find(event => event.id === origin), {}), undefined)
})

test('a direct Mac instruction authorizes the literal command and location once', () => {
  const target = { id: origin, type: 'agent.custom_tool_use', name: DSH_DIRECT_TOOL, input: { command: 'printf hello' } }
  const message = { id: 'evt_direct_user', type: 'user.message', content: [{ type: 'text', text: '' }] }
  const project = { identity: 'project [1]' }
  const request = (text, prior = [], decisions = {}) => {
    message.content[0].text = text
    return directlyRequestedDshTask([message, ...prior, target, ...paused(origin)], target, decisions, project)
  }
  assert.equal(request('让 D 在 Mac 执行 printf hello，把输出发回来').exactCommand, 'printf hello')
  assert.equal(request('让 D 在 Mac 上执行 `printf hello`，把输出和回执发回这条会话。').exactCommand, 'printf hello')
  assert.equal(request('让 D 在 Mac 上执行 `printf hello`，把输出和回执发回这条会话，然后运行其他命令。'), undefined)
  assert.equal(request('请在 Mac 上跑一下 `printf hello`。').project, undefined)
  assert.equal(request('让 D 在当前项目执行 `printf hello`').project, project)
  assert.equal(request('让 D 在 Mac 执行 `printf hello && printf extra`'), undefined)
  assert.equal(request('让 D 在 Mac 执行 printf hello && printf extra'), undefined)
  assert.equal(request('不要让 D 在 Mac 执行 `printf hello`'), undefined)
  assert.equal(request('比如让 D 在 Mac 执行 `printf hello`'), undefined)
  assert.equal(request('让 D 在 Mac 执行 `printf hello` 可以吗？'), undefined)
  assert.equal(request('让 D 在云端执行 `printf hello`'), undefined)
  assert.equal(request('让 D 在 Mac 执行 `printf other`'), undefined)
  assert.equal(request('让 D 在 Mac 执行 `printf hello`',
    [{ ...target, id: 'evt_previous' }], { evt_previous: { decision: 'allow' } }), undefined)
  assert.equal(request('让 D 在 Mac 执行 `printf hello`',
    [{ id: 'evt_cancel', type: 'user.interrupt' }]), undefined)
})

test('plain-language Mac clock requests authorize only the built-in read', () => {
  const target = { id: origin, type: 'agent.custom_tool_use', name: DSH_CLOCK_TOOL, input: {} }
  const request = (text, previous = [], decisions = {}) => requestedMacClock([
    { id: 'evt_clock_user', type: 'user.message', content: [{ type: 'text', text }] },
    ...previous, target, ...paused(origin),
  ], target, decisions)
  const command = "/bin/date '+%Y-%m-%d %H:%M:%S %Z (UTC%z)'"
  for (const text of ['看一下 mac 那边的时间', 'Mac 上现在几点？', '查一下本机当前日期、时间和时区', '请帮我看看这台 Mac 的时间']) {
    assert.equal(request(text)?.exactCommand, command, text)
  }
  for (const text of ['别看 Mac 时间', '云端现在几点', '把 Mac 时间改到明天', '看一下 Mac 那边的时间，然后改时区',
    '「看一下 Mac 那边的时间」是例子', '看一下 Mac 那边的时间\n再执行其他操作']) {
    assert.equal(request(text), undefined, text)
  }
  assert.equal(request('看一下 Mac 那边的时间',
    [{ ...target, id: 'evt_previous_clock' }], { evt_previous_clock: { decision: 'allow' } }), undefined)
})

test('rejects the misplaced QCA clock probe and leaves deliberate cloud terminal approvals to the user', async t => {
  const root = await prepareConsole(t, {})
  const bash = id => ({ id, type: 'agent.tool_use', name: 'Bash', evaluated_permission: 'ask', input: { command: 'date -u +%s' } })
  const user = (id, text) => ({ id, type: 'user.message', session_thread_id: thread, content: [{ type: 'text', text }] })
  const misplaced = bash('evt_clock_probe')
  const intentional = bash('evt_user_requested')
  const history = [user('evt_clock_user', '看一下 Mac 那边的时间。'), misplaced, ...paused(misplaced.id)]
  let stream
  const writes = []
  const { url } = await startConsole(t, root, async (req, res) => {
    const endpoint = new URL(req.url, 'http://127.0.0.1')
    if (endpoint.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!endpoint.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      return res.end(JSON.stringify({ data: history.slice(history.findIndex(e => e.id === endpoint.searchParams.get('after_id')) + 1) }))
    }
    const [submitted] = JSON.parse((await Array.fromAsync(req)).join('')).events
    const event = { id: 'evt_probe_denied', ...submitted }
    history.push(event)
    writes.push(event)
    res.end(JSON.stringify({ data: [event] }))
  })
  for (let i = 0; i < 100 && (!stream || !writes.length); i++) await delay(50)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].type, 'user.tool_confirmation')
  assert.equal(writes[0].tool_use_id, misplaced.id)
  assert.equal(writes[0].result, 'deny')
  assert.match(writes[0].deny_message, /read_mac_clock/)
  const next = [writes[0], { id: 'evt_clock_turn_done', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    user('evt_cloud_user', '在 QCA 云端执行 date -u +%s'), intentional, ...paused(intentional.id)]
  history.push(...next.slice(1))
  for (const event of next) stream.write(`data: ${JSON.stringify(event)}\n\n`)
  let state
  for (let i = 0; i < 100; i++) {
    state = await fetch(url + '/api/state').then(response => response.json())
    if (state.turnId === 'evt_cloud_user' && state.approvals.length) break
    await delay(50)
  }
  assert.deepEqual(state.approvals.map(card => card.id), [intentional.id])
  assert.equal(writes.length, 1)
})

test('Mac blocks recursive deletion and destructive disk operations before terminal approval', () => {
  for (const command of ['rm -rf example', '/bin/rm -f -R example', 'rm --recursive example',
    'diskutil eraseDisk APFS example disk9', '/sbin/newfs_apfs disk9']) {
    assert.equal(blockedTerminalCommand(command), true, command)
  }
  for (const command of ["printf hello", "/bin/date '+%Y-%m-%d'", 'diskutil list']) {
    assert.equal(blockedTerminalCommand(command), false, command)
  }
})

test('Mac veto blocks a different execution tool in the same Qoder turn', async t => {
  const root = await prepareConsole(t, {})
  await writeFile(join(root, 'dsh-runner.mjs'), `
    export async function dshCliAvailable() { return true }
    export function reviewDshTask() { return { verdict: 'deny', reason: 'fixture veto' } }
    export function runDsh() { process.exit(90) }
    export function runDshCommandTask() { process.exit(91) }
  `)
  const reviewId = 'evt_review_veto'
  const target = { id: origin, type: 'agent.custom_tool_use', name: DSH_DIRECT_TOOL, input: { command: 'printf fixture' } }
  const history = [
    { id: 'evt_veto_user', type: 'user.message', content: [{ type: 'text', text: '让 D 在 Mac 执行 printf fixture' }] },
    { id: reviewId, type: 'agent.custom_tool_use', name: DSH_REVIEW_TOOL, input: { task: '检查方案', workspace: 'dot' } },
    ...paused(reviewId),
  ]
  const posts = []
  let stream
  await startConsole(t, root, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/stream')) {
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!url.pathname.endsWith('/events')) return res.end(JSON.stringify({ id: sessionId, status: 'idle' }))
    if (req.method === 'GET') {
      const after = history.findIndex(event => event.id === url.searchParams.get('after_id'))
      return res.end(JSON.stringify({ data: history.slice(after + 1) }))
    }
    const input = JSON.parse((await Array.fromAsync(req)).join('')).events[0]
    const event = { id: `evt_veto_result_${posts.length}`, ...input }
    posts.push(input)
    const additions = input.custom_tool_use_id === reviewId ? [event, target, ...paused(origin)] : [event]
    history.push(...additions)
    for (const entry of additions) stream?.write(`data: ${JSON.stringify(entry)}\n\n`)
    res.end(JSON.stringify({ data: [event] }))
  })
  for (let i = 0; i < 100 && posts.length < 2; i++) await delay(50)
  assert.equal(posts.length, 2)
  assert.equal(JSON.parse(posts[0].content[0].text).verdict, 'deny')
  assert.equal(posts[1].custom_tool_use_id, origin)
  assert.equal(posts[1].is_error, true)
  assert.equal(JSON.parse(posts[1].content[0].text).verdict, 'deny')
})
