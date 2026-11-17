import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cloudReplyIntent, cloudResultIntent, cloudSearchIntent, completionNumber, completionSelection, dshSearchIntent, matchDshSessions, offlineTaskbook, readCloudReply, readCloudResult, searchCloudTaskbook, Taskbook, taskbookActivity, taskbookCompleted, taskbookIntent } from '../src/dot-taskbook.mjs'
import { taskRows, unarchivedSessions } from '../dsh-panel/task-rows.js'
import { oldCloudFollowupIntent, oldCloudRelayText, oldCloudResultIntent, readOldCloudFollowup } from '../src/dot-cloud-followup.mjs'
import { dshFollowupIntent, dshFollowupResultIntent, dshSessionResultIntent, dshTurnResultIntent, observeFollowup, observedTurnEnd, readFollowup, readSessionResult, scanDshCompletions } from '../src/dot-dsh-followup.mjs'

test('followup state is correlated to the exact accepted request and its turn', () => {
  const sessionId = 'session-509c84b7-38a8-40af-8a92-d6136c00e080'
  assert.deepEqual(dshFollowupIntent(`在 DSH 对话 ${sessionId} 里继续：只回复 ok`), { sessionId, task: '只回复 ok' })
  assert.equal(dshFollowupIntent(`不要在 DSH 对话 ${sessionId} 里继续：只回复 ok`), undefined)
  assert.deepEqual(dshFollowupIntent('请在 DSH 对话「旧报告审查」里继续：核对结论'), { title: '旧报告审查', task: '核对结论' })
  assert.deepEqual(dshFollowupIntent('在 DSH 对话 旧报告审查 里续办：核对结论'), { title: '旧报告审查', task: '核对结论' })
  assert.equal(dshFollowupIntent('在 DSH 对话「旧报告审查」里继续： '), undefined)
  assert.equal(dshFollowupIntent('如何在 DSH 对话「旧报告审查」里继续：核对结论'), undefined)
  const user = { type: 'user/message', data: { source: { rpcId: 'request' } } }
  const end = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const records = (...events) => events.map(event => ({ event }))
  assert.equal(observeFollowup(records(end), 'request', { running: false }).status, 'unconfirmed')
  assert.equal(observeFollowup(records(user), 'request', { running: true, pendingInput: ['question'] }).status, 'waiting')
  assert.equal(observeFollowup(records(user, { type: 'turn/start' }, end), 'request', {}).status, 'unconfirmed')
  assert.equal(observeFollowup(records(user, end), 'request', {}).status, 'completed')
  const reply = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const adjacent = records(reply('earlier'), user, reply('this turn'), { ...end, seq: 20 }, reply('later'))
  assert.equal(observeFollowup(adjacent, 'request', {}).result, undefined)
  assert.equal(observeFollowup(adjacent, 'request', {}, { includeResult: true }).result, 'this turn')
  assert.equal(dshFollowupResultIntent('查一下 DSH 续办结果 5F54871771CCF5C9EA07'), '5f54871771ccf5c9ea07')
  assert.equal(dshFollowupResultIntent('不要查看 DSH 续办结果 5f54871771ccf5c9ea07'), undefined)
})

test('DSH projections exclude blank sessions and expose pending input without content', async () => {
  const { rows } = await taskRows([
    { sessionId: 'session_waiting', agentAvailable: true, running: true, updatedAt: 100, cwd: '/private/work',
      projections: { values: { title: '合成会话' } } },
    { sessionId: 'session_blank', blank: true },
    { sessionId: 'session_archive' },
  ], async id => {
    assert.equal(id, 'session_waiting')
    return { running: true, pendingInput: [{ secret: 'not forwarded' }] }
  }, new Set(['session_archive']))
  assert.deepEqual(rows, [{ id: 'session_waiting', title: '合成会话', updatedAt: 100, status: 'waiting', observed: true }])
})

test('DSH result lookup stays within the latest completed turn and never falls back to earlier replies', async () => {
  const event = (seq, type, data) => ({ event: { seq, type, data } })
  const reply = (seq, text, interrupted) => event(seq, 'assistant/message', {
    interrupted, message: { content: [{ type: 'text', text }] },
  })
  const end = (seq, turn, kind = 'completed') => event(seq, 'turn/end', { turn, reason: { kind } })
  const older = [reply(8, 'stale'), end(9, 1), event(10, 'turn/start', { turn: 2 }), reply(11, 'latest')]
  let recent = [reply(12, 'interrupted', true), end(13, 2)]
  let state = { cursor: 13 }
  let historyReads = 0
  const dsh = { state: async () => state, history: async (id, _signal, before, through) => {
    historyReads++
    assert.equal(id, 'session_target')
    assert.equal(through, 13)
    return before === 12 ? { records: older, hasMore: false } : { records: recent, hasMore: true }
  } }
  assert.deepEqual(await readSessionResult(dsh, 'session_target'), {
    status: 'completed', reason: 'completed', finishedAtSeq: 13, result: 'latest', truncated: false,
  })
  recent = [end(13, 2, 'aborted')]
  assert.equal((await readSessionResult(dsh, 'session_target')).status, 'cancelled')
  recent = [end(12, 2), event(13, 'turn/start', { turn: 3 })]
  assert.deepEqual(await readSessionResult(dsh, 'session_target'), { status: 'unconfirmed' })
  state = { ...state, pendingInput: ['approval'], running: true }
  assert.deepEqual(await readSessionResult(dsh, 'session_target'), { status: 'waiting' })
  assert.equal(historyReads, 4)
  recent = [reply(12, 'interrupted', true), end(13, 2)]
  assert.equal((await readSessionResult(dsh, 'session_target', undefined, { finishedAtSeq: 13 })).result, 'latest')
  recent = [end(12, 2)]
  assert.deepEqual(await readSessionResult(dsh, 'session_target', undefined, { finishedAtSeq: 13 }), { status: 'turn_not_found' })
  assert.equal(dshSessionResultIntent('请查看 DSH 对话最新结果：报告'), '报告')
  assert.equal(dshSessionResultIntent('不要查看 DSH 对话最新结果：报告'), undefined)
  assert.equal(dshSessionResultIntent('如何查看 DSH 对话最新结果：报告'), undefined)
  const id = 'session-509c84b7-38a8-40af-8a92-d6136c00e080'
  assert.deepEqual(dshTurnResultIntent(`请帮我查看 DSH 结果 ${id} #13。`), { sessionId: id, finishedAtSeq: 13 })
  assert.equal(dshTurnResultIntent(`不要查看 DSH 结果 ${id} #13`), undefined)
  assert.equal(dshTurnResultIntent(`查看 DSH 结果 ${id} #13，然后继续`), undefined)
  assert.equal(dshTurnResultIntent(`查看 DSH 结果 ${id} #9999999999999999`), undefined)
})

test('history lookup finds an old session outside the recent list without exposing archived lineage or paths', async () => {
  const target = { sessionId: 'session_older', cwd: '/private/fixture', updatedAt: 1,
    projections: { values: { title: '年度报告 Fixture' } } }
  const items = [...Array.from({ length: 120 }, (_, i) => ({ sessionId: 'session_recent_' + i, updatedAt: i + 2 })), target,
    { ...target, sessionId: 'session_archived' },
    { ...target, sessionId: 'session_child', origin: 'subagent', parentSessionId: 'session_archived' }]
  const archived = new Set(['session_archived'])
  const recent = await taskRows(items, async () => ({}), archived)
  assert.equal(recent.omitted, 1)
  assert(!recent.rows.some(row => row.id === target.sessionId))
  const catalog = unarchivedSessions(items, archived)
  assert.equal(dshSearchIntent('查找 DSH 对话：年度报告'), '年度报告')
  assert.equal(dshSearchIntent('找一下 DSH 对话 年度报告'), '年度报告')
  assert.equal(dshSearchIntent('不要查找 DSH 对话：年度报告'), undefined)
  assert.deepEqual(matchDshSessions(catalog, 'Ｆｉｘｔｕｒｅ'), { total: 1,
    matches: [{ id: target.sessionId, title: '年度报告 Fixture', updatedAt: 1 }] })
  assert.equal(matchDshSessions(catalog, 'fixture/').total, 0)
  assert.equal(matchDshSessions(catalog, target.sessionId).total, 1)
  assert.equal(matchDshSessions([...catalog, { sessionId: 'other', projections: { values: { title: target.sessionId } } }], target.sessionId).total, 1)
})

test('an older live conversation can report pending input ahead of recent inactive history', async () => {
  const idle = Array.from({ length: 120 }, (_, i) => ({ sessionId: 'session_recent_' + i, updatedAt: i + 2 }))
  const old = { sessionId: 'session_older', updatedAt: 1, agentAvailable: true }
  const report = await taskRows([...idle, old], async id => {
    assert.equal(id, old.sessionId)
    return { active: true, running: false, pendingInput: ['approval'] }
  })
  assert.equal(report.rows[0].id, old.sessionId)
  assert.equal(report.rows[0].status, 'waiting')
  assert.equal(report.omitted, 1)
})

test('a later live idle report replaces running, while a passive idle report cannot', () => {
  const book = new Taskbook('unused')
  const now = Date.now()
  const source = id => '00000000-0000-4000-8000-00000000000' + id
  const report = (id, checkedAt, status, observed) => book.acceptLocal({ source: source(id),
    rows: [{ id: 'session_fixture', title: '合成对话', updatedAt: now, status, observed }] }, checkedAt)
  report(1, now, 'running', true)
  report(2, now + 1000, 'idle', false)
  assert.equal(book.snapshot('sess_dot', now + 1000).tasks[0].status, 'running')
  report(2, now + 2000, 'idle', true)
  const [task] = book.snapshot('sess_dot', now + 2000).tasks
  assert.equal(task.status, 'idle')
  assert.equal(task.observed, undefined)
})

test('reconnect revisits an old active conversation and keeps its earlier observation until DSH confirms an outcome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-taskbook-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'taskbook.json')
  const save = (path, data) => writeFile(path, JSON.stringify(data))
  const now = Date.now()
  const source = '00000000-0000-4000-8000-000000000001'
  const id = 'session_tracking'
  const book = new Taskbook(file, save)
  book.acceptLocal({ source, rows: [{ id, title: '合成对话', status: 'waiting', cursor: 10 }] }, now)
  await book.persist()
  const restored = new Taskbook(file, save)
  await restored.load()
  const items = [...Array.from({ length: 120 }, (_, i) => ({ sessionId: 'session_recent_' + i, updatedAt: i + 2 })),
    { sessionId: id, updatedAt: 1 }]
  const eligibleIds = new Set(items.map(item => item.sessionId))
  const report = await taskRows(items, async session => {
    assert.equal(session, id)
    return { running: false, active: false, cursor: 12 }
  }, new Set(), new Map(Object.entries(restored.localTracking)))
  const row = report.rows.find(item => item.id === id)
  assert.equal(row.status, 'unknown')
  restored.acceptLocal({ ...report, source, eligibleIds }, now + 60_000)
  const waiting = taskbookActivity(restored.snapshot('sess_dot', now + 60_000), 'waiting')
  assert.equal(waiting.counts.dsh, 0)
  assert.deepEqual(waiting.unconfirmed.map(({ id, lastObservedStatus, lastObservedAt }) => [id, lastObservedStatus, lastObservedAt]), [[id, 'waiting', now]])
  const end = (seq, kind) => ({ event: { type: 'turn/end', seq, time: now + 100, data: { reason: { kind } } } })
  const previous = restored.localTracking[id]
  assert.equal(observedTurnEnd([end(9, 'completed')], previous), undefined)
  assert.equal(observedTurnEnd([end(11, 'completed'), { event: { type: 'turn/start', seq: 12 } }], previous), undefined)
  row.status = observedTurnEnd([end(12, 'aborted')], previous)
  row.observed = true
  assert.equal(row.status, 'cancelled')
  restored.acceptLocal({ ...report, source, eligibleIds }, now + 61_000)
  assert.equal(restored.snapshot('sess_dot', now + 61_000).tasks.find(task => task.id === id).status, 'cancelled')
  const plugin = '00000000-0000-4000-8000-000000000002'
  restored.acceptLocal({ source: plugin, rows: [{ id, title: '合成对话', status: 'running', cursor: 10 }] }, now + 62_000)
  assert.equal(restored.localTracking[id].status, 'cancelled')
  restored.acceptLocal({ source: plugin, rows: [{ id, title: '合成对话', status: 'running', cursor: 13 }] }, now + 63_000)
  assert.equal(restored.snapshot('sess_dot', now + 63_000).tasks.find(task => task.id === id).status, 'running')
})

test('DSH completion scans keep older turns across a restart and a new active turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-dsh-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'taskbook.json')
  const save = (path, data) => writeFile(path, JSON.stringify(data))
  const now = Date.parse('2026-11-15T02:00:00Z')
  const row = { id: 'session_fixture', title: '合成对话', updatedAt: now, cursor: 19, status: 'running' }
  const finish = (seq, kind) => ({ event: { seq, time: now - 100, type: 'turn/end', data: { reason: { kind, body: 'private output' } } } })
  const calls = []
  const records = new Map([[undefined, [finish(16, 'completed'), { event: { seq: 19, time: now, type: 'turn/start' } }]],
    [16, [finish(8, 'completed'), finish(10, 'aborted')]]])
  const dsh = { async history(id, signal, before, through) {
    calls.push({ id, before, through })
    return { cursor: through ?? 19, records: records.get(before), hasMore: before === undefined }
  } }
  const scan = (book, item) => scanDshCompletions(dsh, item, book.dshHistory[item.id], now - 10_000)
  const view = book => taskbookCompleted(book.snapshot('sess_dot', now), 'completed_today', now)
  const book = new Taskbook(file, save)
  book.acceptDshHistory(row, await scan(book, row), now)
  assert.equal(view(book).total, 1)
  assert.equal(book.historyCandidates([row], now).length, 1)
  await book.persist()
  const restored = new Taskbook(file, save)
  await restored.load()
  const next = { ...row, cursor: 22, updatedAt: now + 100 }
  restored.acceptDshHistory(next, await scan(restored, next), now)
  assert.deepEqual(calls.map(r => [r.before, r.through]), [[undefined, undefined], [16, 19]])
  assert.deepEqual(view(restored).items.map(item => item.finishedAtSeq), [16, 8])
  assert.equal(restored.historyCandidates([row], now).length, 0)
  assert.equal(restored.historyCandidates([next], now + 100).length, 1)
  restored.followups.sameTurn = { cloudSessionId: 'sess_dot', sessionId: row.id, finishedAtSeq: 8,
    status: 'completed', finishedAt: now - 100, checkedAt: now, receipt: 'fixture' }
  assert.equal(view(restored).total, 2)
  assert.doesNotMatch(JSON.stringify(restored.snapshot('sess_dot', now)), /private output/)
  assert.doesNotMatch(JSON.stringify(offlineTaskbook(restored, 'sess_dot', [], now)), /session_fixture|合成对话/)
  restored.acceptLocal({
    source: '00000000-0000-4000-8000-000000000001',
    rows: [row], eligibleIds: new Set([row.id]), historyExcluded: [row.id],
  }, now)
  assert.deepEqual(restored.historyCandidates([row], now), [])
  assert.equal(view(restored).total, 1)
  assert.equal(view(restored).items[0].receipt, 'fixture')
})

test('a newer DSH turn cannot hide completion of a queued followup on an older page', async () => {
  const row = (seq, type, data) => ({ event: { seq, type, data } })
  const older = [row(11, 'user/message', { source: { rpcId: 'mine' } }),
    row(12, 'assistant/message', { message: { content: [{ type: 'text', text: 'mine' }] } }),
    row(13, 'turn/end', { reason: { kind: 'completed' } })]
  const recent = [row(20, 'user/message', { source: { rpcId: 'other' } }),
    row(21, 'assistant/message', { message: { content: [{ type: 'text', text: 'other' }] } })]
  const dsh = {
    state: async () => ({ running: true }),
    history: async (_id, _signal, before) => before === 20
      ? { records: older, hasMore: false } : { records: recent, hasMore: true },
  }
  const item = { sessionId: 'session_a', requestId: 'mine', startCursor: 10 }
  assert.equal((await readFollowup(dsh, item)).status, 'completed')
  assert.equal((await readFollowup(dsh, item, undefined, { includeResult: true })).result, 'mine')
})

test('a recorded completion cursor anchors result lookup after many unrelated turns', async () => {
  const older = [
    { event: { seq: 12, type: 'user/message', data: { source: { rpcId: 'mine' } } } },
    { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'original' }] } } } },
    { event: { seq: 14, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
  const dsh = {
    state: async () => ({ cursor: 2048, running: true }),
    history: async (id, _signal, before, through) => {
      assert.equal(id, 'session_a')
      assert.equal(before, undefined)
      assert.equal(through, 14)
      return { records: older, hasMore: true }
    },
  }
  const item = { sessionId: 'session_a', requestId: 'mine', startCursor: 11, finishedAtSeq: 14, status: 'completed' }
  assert.equal((await readFollowup(dsh, item, undefined, { includeResult: true })).result, 'original')
})

test('QCA completion belongs to the child that reported a result for its latest assignment', () => {
  const book = new Taskbook('unused')
  const threads = ['a', 'b', 'c'].map(id => ({ id, parent_thread_id: 'main', status: 'idle' }))
  const result = id => ({ id: 'result-' + id, type: 'agent.thread_message_received', from_session_thread_id: id,
    processed_at: '2026-11-14T07:00:00Z' })
  const ended = id => ({ type: 'session.thread_status_idle', session_thread_id: id, stop_reason: { type: 'end_turn' } })
  book.acceptCloud('sess_dot', threads, [result('a'), result('b'), ended('a'), ended('b'), ended('c'),
    { type: 'agent.thread_message_sent', to_session_thread_id: 'b', processed_at: '2026-11-14T07:01:00Z' }])
  const tasks = Object.fromEntries(book.snapshot('sess_dot').tasks.map(row => [row.id, row]))
  assert.equal(tasks.a.status, 'completed')
  assert.equal(tasks.a.resultEventId, 'result-a')
  assert.equal(tasks.b.status, 'idle')
  assert.equal(tasks.c.status, 'idle')
})

test('completion history retains two deliveries from the same child while a new assignment is running', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-cloud-completions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'taskbook.json')
  const sid = 'sess_previous'
  const thread = 'sthr_book'
  const now = Date.parse('2026-11-15T01:00:00Z')
  const assignment = (id, text) => ({ id, type: 'agent.thread_message_sent', to_session_thread_id: thread,
    content: [{ type: 'text', text }] })
  const reply = (id, suffix, text) => ({ id, type: 'agent.thread_message_received', from_session_thread_id: thread,
    processed_at: '2026-11-15T00:' + suffix, content: [{ type: 'text', text }] })
  const idle = (event, type) => ({ type: 'session.thread_status_idle', session_thread_id: thread,
    processed_at: event.processed_at, stop_reason: { type } })
  const first = reply('evt_first', '10:00.000001Z', 'first private output')
  const second = reply('evt_second', '20:00.000001Z', 'second private output')
  const pending = reply('evt_pending', '30:00.000001Z', 'not complete')
  const events = [assignment('evt_task_1', '第一项'), idle(first, 'end_turn'), first, first,
    assignment('evt_task_2', '第二项'), idle(second, 'end_turn'), second,
    assignment('evt_task_3', '第三项'), idle(pending, 'requires_action'), pending]
  const book = new Taskbook(file, (path, value) => writeFile(path, JSON.stringify(value)))
  book.acceptCloud(sid, [{ id: thread, role: 'child', status: 'running' }], events.values(), now)
  await book.persist()
  const restored = new Taskbook(file)
  await restored.load()
  const view = restored.snapshot('sess_current', now, [sid])
  const summary = taskbookCompleted(view, 'completed_today', now)
  assert.equal(view.tasks[0].status, 'running')
  assert.deepEqual(summary.items.map(row => [row.title, row.resultEventId, row.cloudSessionId]), [
    ['第二项', second.id, sid], ['第一项', first.id, sid],
  ])
  assert.equal(summary.total, 2)
  assert.doesNotMatch(JSON.stringify(view), /private output|not complete/)
  assert.doesNotMatch(JSON.stringify(offlineTaskbook(restored, 'sess_current', [sid], now)), /evt_first|第一项/)

  const client = { async *events() { yield* events } }
  const result = await readCloudReply(client, sid, cloudReplyIntent('查看云端回传 EVT_FIRST'))
  assert.equal(result.result, 'first private output')
  assert.equal(result.threadId, thread)
  assert.equal(await readCloudReply(client, sid, 'evt_pending_not_found'), undefined)
  assert.equal(cloudReplyIntent('不要查看云端回传 evt_first'), undefined)
})

test('cloud result lookup reads only the requested child and ignores replies superseded by a new assignment', async () => {
  const send = (id, to) => ({ id, type: 'agent.thread_message_sent', to_session_thread_id: to })
  const receive = (id, from, text) => ({ id, type: 'agent.thread_message_received',
    from_session_thread_id: from, content: [{ type: 'text', text }] })
  const events = [send('evt_a', 'sthr_target'), receive('evt_old', 'sthr_target', 'older'),
    send('evt_b', 'sthr_target'), receive('evt_other', 'sthr_other', 'unrelated')]
  const client = { async *events(sessionId, cursor, types) {
    assert.equal(sessionId, 'sess_dot')
    assert.equal(cursor, undefined)
    assert.deepEqual(types, ['agent.thread_message_sent', 'agent.thread_message_received'])
    yield* events
  } }
  const lookup = () => readCloudResult(client, 'sess_dot', 'sthr_target')
  assert.deepEqual(await lookup(), { status: 'no_result_yet', assignmentEventId: 'evt_b' })
  events.push(receive('evt_result', 'sthr_target', 'new result'))
  assert.deepEqual(await lookup(), { status: 'result_received', assignmentEventId: 'evt_b',
    resultEventId: 'evt_result', result: 'new result', truncated: false })
  assert.equal(cloudResultIntent('查看云端子线程结果 sthr_TARGET'), 'sthr_target')
  assert.equal(cloudResultIntent('不要查看云端子线程结果 sthr_target'), undefined)
  assert.equal(cloudResultIntent('查看云端子线程结果 sthr_target 然后发新任务'), undefined)
})

test('old cloud continuation requires the exact relay request, one assignment and the matching child reply', async () => {
  const intent = oldCloudFollowupIntent('让旧云端子线程 sthr_old 继续：只回复合成结果')
  assert.deepEqual(intent, { threadId: 'sthr_old', task: '只回复合成结果' })
  assert.equal(oldCloudFollowupIntent('不要让旧云端子线程 sthr_old 继续：只回复合成结果'), undefined)
  assert.equal(oldCloudResultIntent('查看旧云端续办结果：0123456789ABCDEF0123'), '0123456789abcdef0123')
  assert.equal(oldCloudResultIntent('不要查看旧云端续办结果：0123456789ABCDEF0123'), undefined)
  const item = { ...intent, cursor: 'evt_cursor', relayId: 'relay_fixture', sessionId: 'sess_old' }
  const msg = (id, type, text, fields) => ({ id, type, content: [{ type: 'text', text }], ...fields })
  const request = msg('evt_request', 'user.message', oldCloudRelayText(item))
  const assignment = msg('evt_assignment', 'agent.thread_message_sent', item.task, { to_session_thread_id: item.threadId })
  const result = msg('evt_reply', 'agent.thread_message_received', '合成结果', { from_session_thread_id: item.threadId })
  const end = { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
  let events
  const read = () => readOldCloudFollowup({ async *events(session, cursor) {
    assert.equal(session, item.sessionId)
    assert.equal(cursor, item.cursor)
    yield* events
  } }, item)
  events = [request, assignment, result, end]
  assert.deepEqual(await read(), { status: 'result_received', requestEventId: request.id,
    assignmentEventId: assignment.id, resultEventId: result.id, result: '合成结果', truncated: false })
  events = [request, result, end]
  assert.equal((await read()).status, 'not_dispatched')
  events = [request, assignment, { ...assignment, to_session_thread_id: 'sthr_other' }, result, end]
  assert.equal((await read()).status, 'assignment_mismatch')
  events = [{ ...request, content: [] }, assignment, result, end]
  assert.equal((await read()).status, 'relay_pending')
  events = [{ ...request, content: [] }, assignment, result, end, request, assignment, result, end,
    msg('evt_later_request', 'user.message', '另一项任务'), assignment,
    msg('evt_later_result', 'agent.thread_message_received', '后来的结果', { from_session_thread_id: item.threadId }), end]
  assert.equal((await read()).resultEventId, result.id)
})

test('taskbook recovers a late cloud relay reply, persists only evidence, and counts the result once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-cloud-taskbook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'taskbook.json')
  const save = (path, value) => writeFile(path, JSON.stringify(value))
  const book = new Taskbook(file, save)
  const now = Date.now()
  const item = { relayId: '0123456789abcdef0123', sourceSessionId: 'sess_orig', sessionId: 'sess_old',
    threadId: 'sthr_old', createdAt: now - 100_000, task: 'private task text' }
  const snapshot = (value, at) => value.snapshot('sess_next', at, ['sess_orig', 'sess_old'])
  const receiptRows = (value, at) => snapshot(value, at).cloudFollowups
  book.acceptCloudFollowup(item, { status: 'requires_action' }, now - 60_000)
  assert.equal(receiptRows(book, now)[0].status, 'unconfirmed')
  assert.equal(taskbookActivity(snapshot(book, now - 55_000), 'waiting').cloudFollowups.length, 1)
  await book.persist()
  const restored = new Taskbook(file, save)
  await restored.load()
  const finishedAt = now - 1000
  restored.acceptCloudFollowup(item, { status: 'result_received', resultEventId: 'evt_reply',
    finishedAt, result: 'private result text' }, now)
  restored.acceptCloud('sess_old', [{ id: 'sthr_old', role: 'child', status: 'idle' }], [
    { id: 'evt_reply', type: 'agent.thread_message_received', from_session_thread_id: 'sthr_old', processed_at: new Date(finishedAt).toISOString() },
    { type: 'session.thread_status_idle', session_thread_id: 'sthr_old', stop_reason: { type: 'end_turn' } },
  ], now)
  assert.equal(restored.acceptCloudFollowup(item, { status: 'dispatched' }, now + 500), false)
  const view = snapshot(restored, now)
  assert.equal(view.cloudFollowups[0].status, 'completed')
  assert.equal(taskbookCompleted(view, 'completed_recent', now).total, 1)
  assert.equal(taskbookCompleted(view, 'completed_recent', now).items[0].relayReceipt, item.relayId)
  assert.doesNotMatch(JSON.stringify(view), /private (?:task|result) text/)
  assert.doesNotMatch(JSON.stringify(offlineTaskbook(restored, 'sess_next', ['sess_orig', 'sess_old'], now)),
    /0123456789abcdef0123|sthr_old|evt_reply/)
  assert.deepEqual(restored.snapshot('sess_unrelated', now).cloudFollowups, [])
})

test('cloud lookup uses the first assignment title and retains it across followups and migration', () => {
  const now = Date.now()
  const book = new Taskbook('unused')
  const thread = { id: 'sthr_report', role: 'child', agent_name: 'Dot 云端助手', title: 'Dot 云端助手', status: 'idle' }
  const sent = (text, id = thread.id) => ({ type: 'agent.thread_message_sent', to_session_thread_id: id,
    content: [{ type: 'text', text }] })
  book.acceptCloud('sess_old', [thread], [sent('\n## 年度报告核对\n私有正文不进任务本'),
    { type: 'agent.thread_message_received', id: 'evt_previous', from_session_thread_id: thread.id },
    sent('只回复已核对')], now)
  book.acceptCloud('sess_new', [{ ...thread, id: 'sthr_other', title: '另一个任务' }], [sent('报告', 'sthr_other')], now)
  const lookup = (query, at = now) => searchCloudTaskbook(book.snapshot('sess_new', at, ['sess_old']), query)
  const found = lookup(cloudSearchIntent('查找云端任务：年度报告'))
  assert.equal(found.total, 1)
  assert.equal(found.matches[0].title, '年度报告核对')
  assert.equal(found.matches[0].cloudSessionId, 'sess_old')
  assert.equal(found.matches[0].resultEventId, undefined)
  assert.equal(lookup('sthr_report').total, 1)
  assert.equal(lookup('私有正文').total, 0)
  assert.equal(lookup('年度报告', now + 46_000).total, 0)
  assert.equal(cloudSearchIntent('不要查找云端任务：年度报告'), undefined)
})

test('offline taskbook preserves counts without transferring identifiers, receipts, or content', () => {
  const book = new Taskbook('unused')
  const now = 1794640000000
  book.acceptLocal({ source: '00000000-0000-4000-8000-000000000001',
    rows: [{ id: 'private-session', title: 'private-title', status: 'running', updatedAt: now }], omitted: 3 }, now)
  book.acceptCloud('sess_dot', [{ id: 'sthr_child', parent_thread_id: 'sthr_main', status: 'idle' }], [], now)
  book.followups.example = { sessionId: 'private-session', cloudSessionId: 'sess_dot',
    receipt: '0123456789abcdef0123', status: 'completed', createdAt: now, checkedAt: now, result: 'private-content' }
  const snapshot = offlineTaskbook(book, 'sess_dot', [], now)
  assert.deepEqual(snapshot.mac.counts, { total: 1, running: 1, waiting: 0 })
  assert.deepEqual(snapshot.mac.followups, { tracked: 1, completed: 1, waiting: 0, inProgress: 0, unconfirmed: 0 })
  assert.equal(snapshot.qca.current, 1)
  assert.equal(snapshot.qca.observedAt, new Date(now).toISOString())
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|sthr_child|0123456789abcdef0123/)
  assert.equal(offlineTaskbook(book, 'sess_dot', [], now + 46000).mac.counts, null)
})

test('completion summaries use the recorded finish time and count a DSH turn with a receipt once', () => {
  const book = new Taskbook('unused')
  const now = Date.parse('2026-11-15T01:00:00Z')
  const midnight = Date.parse('2026-11-14T16:00:00Z')
  const raw = 'synthetic_private_session'
  const receipt = '0123456789abcdef0123'
  const rows = [
    { id: raw, status: 'completed', title: '合成交付', finishedAt: midnight, finishedAtSeq: 18, cursor: 18 },
    { id: 'no_time', status: 'completed', updatedAt: now - 1000 },
    { id: 'failed', status: 'failed', finishedAt: midnight, finishedAtSeq: 36 },
  ]
  book.acceptLocal({ source: '00000000-0000-4000-8000-000000000001', rows, eligibleIds: new Set(rows.map(row => row.id)) }, now - 60_000)
  book.followups.one = { sessionId: raw, cloudSessionId: 'sess_dot', receipt, status: 'completed',
    createdAt: midnight - 1000, finishedAt: midnight, finishedAtSeq: 18 }
  book.acceptCloud('sess_dot', [{ id: 'sthr_child', role: 'child', status: 'idle' }], [
    { type: 'agent.thread_message_received', id: 'evt_reply', from_session_thread_id: 'sthr_child',
      processed_at: new Date(midnight - 1000).toISOString() },
    { type: 'session.thread_status_idle', session_thread_id: 'sthr_child', stop_reason: { type: 'end_turn' } },
  ], now)
  const view = book.snapshot('sess_dot', now)
  const today = taskbookCompleted(view, taskbookIntent('今天完成了什么？'), now)
  assert.equal(today.since, new Date(midnight).toISOString())
  assert.deepEqual(today.counts, { mac: 1, qca: 0 })
  assert.equal(today.items[0].receipt, receipt)
  const recent = taskbookCompleted(view, taskbookIntent('最近完成的任务'), now)
  assert.equal(recent.total, 2)
  assert.equal(recent.items[1].resultEventId, 'evt_reply')
  assert.equal(taskbookIntent('不要汇总今天完成了什么'), undefined)
  const offline = offlineTaskbook(book, 'sess_dot', [], now)
  assert.deepEqual(offline.completions.map(({ mac, qca }) => [mac, qca]), [[1, 0], [1, 1]])
  assert.doesNotMatch(JSON.stringify(offline), /synthetic_private_session|0123456789abcdef0123|evt_reply/)
})

test('a completion number selects only the last verified summary in this conversation', () => {
  const target = { id: 'evt_lookup', type: 'user.message' }
  const user = (id, text) => ({ id, type: 'user.message', content: [{ type: 'text', text }] })
  const tool = id => ({ type: 'agent.custom_tool_use', name: 'dot_taskbook_status', id })
  const back = (id, items) => ({ type: 'user.custom_tool_result', custom_tool_use_id: id,
    content: [{ type: 'text', text: JSON.stringify({ mode: 'completed_recent', items }) }] })
  const done = { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
  const old = [user('evt_old', '最近完成了什么？'), tool('evt_old_tool'),
    back('evt_old_tool', [{ number: 1, provider: 'qca', resultEventId: 'evt_old_result' }]), done]
  const current = [user('evt_recent', '最近完成了什么？'), tool('evt_recent_tool'),
    back('evt_recent_tool', [{ number: 1, provider: 'qca', resultEventId: 'evt_new_result' },
      { number: 2, provider: 'dsh', id: 'session_fixture', finishedAtSeq: 31 }]), done]
  const receipts = { evt_old_tool: { decision: 'allow' }, evt_recent_tool: { decision: 'allow' } }
  const resolve = (list, number = 1) => completionSelection([...old, ...list, target], target.id, number, receipts)
  assert.deepEqual(resolve(current), { query: '查看云端回传 evt_new_result' })
  assert.deepEqual(resolve(current, completionNumber('查一下刚才的完成清单里的第二项结果')), { query: '查看 DSH 结果 session_fixture #31' })
  assert.deepEqual(resolve(current, 3), { status: 'completion_item_not_found', number: 3, available: 2 })
  assert.deepEqual(resolve([...current.slice(0, -1), { type: 'user.interrupt' }, done]), { status: 'no_completion_list' })
  assert.deepEqual(resolve([...current, { type: 'agent.message', content: [{ type: 'text', text: '第 1 项是别的任务' }] }]),
    { query: '查看云端回传 evt_new_result' })
  assert.deepEqual(resolve([user('evt_recent', '最近完成了什么？'), tool('evt_unknown'),
    back('evt_unknown', [{ number: 1, macReceipt: 'a'.repeat(20) }]), done]), { status: 'no_completion_list' })
  assert.equal(completionNumber('查看完成清单第２项。'), 2)
  assert.equal(completionNumber('不要查看完成清单第二项'), undefined)
  assert.equal(completionNumber('查看完成清单第二项，然后继续执行'), undefined)
})

test('activity queries prioritize old pending work and keep expired state out of current counts', () => {
  const book = new Taskbook('unused')
  const now = Date.now()
  const current = 'sess_current'
  const prior = 'sess_prior'
  book.acceptLocal({ source: '00000000-0000-4000-8000-000000000001', omitted: 4, rows: [
    { id: 'local_waiting', title: '合成待审批', status: 'waiting' },
    { id: 'local_idle', title: '合成空闲', status: 'idle' },
  ] }, now)
  book.acceptCloud(current, [{ id: 'sthr_running', role: 'child', status: 'running' }], [], now)
  book.acceptCloud(prior, [{ id: 'sthr_waiting', role: 'child', status: 'idle' }], [
    { type: 'session.thread_status_idle', session_thread_id: 'sthr_waiting', stop_reason: { type: 'requires_action' } },
  ], now)
  for (let i = 0; i < 20; i++) book.followups[i] = { cloudSessionId: current, status: 'completed', createdAt: now + i }
  book.followups.pending = { sessionId: 'local_waiting', cloudSessionId: prior, status: 'waiting', createdAt: now - 100, checkedAt: now }
  book.followups.queued = { sessionId: 'local_queued', cloudSessionId: current, status: 'queued', createdAt: now - 200, checkedAt: now }
  book.followups.unknown = { sessionId: 'local_old', cloudSessionId: current, status: 'waiting', createdAt: now - 60000, checkedAt: now - 60000 }
  const snapshot = book.snapshot(current, now, [prior])
  const waiting = taskbookActivity(snapshot, 'waiting')
  assert.equal(snapshot.followups.length, 23)
  assert.equal(snapshot.followups[0].sessionId, 'local_waiting')
  assert.deepEqual(waiting.counts, { dsh: 1, qca: 1, followups: 1 })
  assert.deepEqual(waiting.tasks.map(task => task.id), ['local_waiting', 'sthr_waiting'])
  assert.equal(waiting.localOmitted, 4)
  const running = taskbookActivity(snapshot, 'running')
  assert.deepEqual(running.counts, { dsh: 0, qca: 1, followups: 1 })
  assert.deepEqual(running.followups.map(item => item.sessionId), ['local_queued'])
  assert.deepEqual(offlineTaskbook(book, current, [prior], now).mac.followups,
    { tracked: 23, completed: 20, waiting: 1, inProgress: 1, unconfirmed: 1 })
  const expired = taskbookActivity(book.snapshot(current, now + 46000, [prior]), 'waiting')
  assert.deepEqual(expired.counts, { dsh: null, qca: null, followups: null })
  assert.deepEqual(expired.tasks, [])
  assert.deepEqual(expired.followups, [])
  assert.equal(taskbookIntent('现在有哪些任务在等我？'), 'waiting')
  assert.equal(taskbookIntent('有什么需要我处理？'), 'waiting')
  assert.equal(taskbookIntent('还有哪些对话在跑？'), 'running')
  assert.equal(taskbookIntent('看看进行中的任务'), 'running')
  assert.equal(taskbookIntent('不要列出待处理的任务'), undefined)
})

test('taskbook restores snapshots and marks expired observations as unconfirmed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-taskbook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'taskbook.json')
  const book = new Taskbook(file, (path, data) => writeFile(path, JSON.stringify(data)))
  const now = Date.now()
  const source = '00000000-0000-4000-8000-000000000001'
  assert.equal(book.acceptLocal({ source, rows: [{ id: 'session_1', title: '合成会话', status: 'running', updatedAt: now }] }, now), true)
  book.acceptCloud('sess_dot', [{ id: 'sthr_main', status: 'running' },
    { id: 'sthr_child', parent_thread_id: 'sthr_main', status: 'idle', agent_name: '测试助手' }],
  [{ type: 'session.thread_status_idle', session_thread_id: 'sthr_child', stop_reason: { type: 'requires_action' } }], now)
  await book.persist()
  const restored = new Taskbook(file)
  await restored.load()
  assert.deepEqual(restored.snapshot('sess_dot', now).tasks.map(row => [row.provider, row.status]),
    [['dsh', 'running'], ['qca', 'waiting']])
  assert(restored.snapshot('sess_dot', now + 46_000).tasks.every(row => !row.fresh && row.status === 'unknown'))
  assert.equal(restored.snapshot('other_session', now).tasks.length, 1)
  restored.followups.request = { sessionId: 'session_1', cloudSessionId: 'sess_dot', status: 'completed', createdAt: now, checkedAt: now }
  const afterMigration = restored.snapshot('other_session', now, ['sess_dot'])
  assert.equal(afterMigration.tasks.find(row => row.provider === 'qca')?.cloudSessionId, 'sess_dot')
  assert.equal(afterMigration.followups[0]?.status, 'completed')
  assert.equal(taskbookIntent('DSH 最近开了哪些对话？'), 'list')
  assert.equal(taskbookIntent('只查任务本的数量'), 'count')
  assert.equal(taskbookIntent('请删除任务本'), undefined)
  assert.equal(taskbookIntent('云端有任何任务吗？开一个子进程用来检索最近新闻，科技类的，10 天以内'), 'cloud')
  assert.equal(taskbookIntent('帮我先看看云端那边还有任务在跑吗？再开一个子线程'), 'cloud')
  assert.equal(taskbookIntent('QCA 上有没有在跑的子任务？'), 'cloud')
  assert.equal(taskbookIntent('请分析「云端有任何任务吗？」这句提示词'), undefined)
  assert.equal(taskbookIntent('请告诉我 QCA 子线程的状态'), 'cloud')
  assert.equal(taskbookIntent('开一个云端子进程检索最近新闻'), undefined)
  assert.equal(taskbookIntent('不要查询云端任务数量'), undefined)
})
