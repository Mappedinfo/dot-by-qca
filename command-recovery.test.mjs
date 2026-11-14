import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { blockedTerminalCommand } from './task-review.mjs'
import { approvedDshTask, directlyRequestedDshTask, questionAnswer, requestedMacClock } from './console-approval.mjs'
import { CONSOLE_QUESTION, DSH_CLOCK_TOOL, DSH_COMMAND_HEADER, DSH_COMMAND_PREFIX, DSH_CONTINUE_TOOL, DSH_DIRECT_TOOL, DSH_EXACT_COMMAND_HEADER, DSH_EXACT_COMMAND_PREFIX, DSH_REVIEW_TOOL, DSH_TOOL } from './qca.mjs'

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
    ...['server.mjs', 'qca.mjs', 'console-approval.mjs', 'task-review.mjs', 'dot-archive.mjs', 'dot-memory.mjs', 'dot-migration.mjs', 'dot-taskbook.mjs', 'dot-dsh-followup.mjs', 'dot-bridge.mjs', 'dot-maintenance.mjs', 'dot-entry.mjs', 'dsh-task-source.mjs', 'dsh-panel'].map(file => cp(new URL(file, import.meta.url), join(root, file), { recursive: true })),
    writeFile(join(stateDir, 'session.json'), JSON.stringify({ sessionId, decisions })),
    writeFile(join(root, 'dsh-runner.mjs'), "export function reviewDshTask() { return { verdict: 'allow', reason: 'fixture' } }\nexport function runDsh() { process.exit(90) }\nexport function runDshCommandTask() { process.exit(91) }\n"),
  ])
  return root
}

async function startConsole(t, root, handle) {
  const gateway = createServer(handle)
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const freePort = createServer().listen(0, '127.0.0.1')
  await once(freePort, 'listening')
  const port = freePort.address().port
  await new Promise(resolve => freePort.close(resolve))
  const preload = `const request = globalThis.fetch; globalThis.fetch = (url, options) =>
    request(url.replace('https://api.qoder.com.cn/api/v1/cloud', 'http://127.0.0.1:${gateway.address().port}'), options);`
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'server.mjs', '--qca-console'], {
    cwd: root, env: { QODER_SITE: 'cn', QODER_PAT: 'fixture', DOT_PORT: String(port) }, stdio: 'ignore',
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
  const runner = `export function reviewDshTask() { return { verdict: 'allow', reason: 'fixture' } }
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
