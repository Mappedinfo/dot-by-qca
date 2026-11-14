import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dshSearchIntent, matchDshSessions, offlineTaskbook, Taskbook, taskbookIntent } from './dot-taskbook.mjs'
import { taskRows, unarchivedSessions } from './dsh-panel/task-rows.js'
import { dshFollowupIntent, dshFollowupResultIntent, observeFollowup, readFollowup } from './dot-dsh-followup.mjs'

test('followup state is correlated to the exact accepted request and its turn', () => {
  const sessionId = 'session-509c84b7-38a8-40af-8a92-d6136c00e080'
  assert.deepEqual(dshFollowupIntent(`在 DSH 对话 ${sessionId} 里继续：只回复 ok`), { sessionId, task: '只回复 ok' })
  assert.equal(dshFollowupIntent(`不要在 DSH 对话 ${sessionId} 里继续：只回复 ok`), undefined)
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
  assert.deepEqual(snapshot.mac.followups, { tracked: 1, completed: 1 })
  assert.equal(snapshot.qca.current, 1)
  assert.equal(snapshot.qca.observedAt, new Date(now).toISOString())
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|sthr_child|0123456789abcdef0123/)
  assert.equal(offlineTaskbook(book, 'sess_dot', [], now + 46000).mac.counts, null)
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
