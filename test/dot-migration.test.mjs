import assert from 'node:assert/strict'
import test from 'node:test'
import { createMigration, dotWorkerReady, migrationOptions, runMigration } from '../src/dot-migration.mjs'

const source = {
  id: 'sess_source',
  environment_id: 'env_fixture',
  agent: {
    id: 'agent_source', name: '旧 Agent', system: '当前会话提示词', model: { id: 'auto', effective_context_window: 200000 },
    tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Read'] }],
    skills: [{ type: 'custom', skill_id: 'skill_fixture', version: '123' }],
  },
  resources: [{ type: 'memory_store', memory_store_id: 'memstore_original', access: 'read_only' }],
}

test('migration preserves pinned QCA child agents without copying response-only fields', () => {
  const session = structuredClone(source)
  const report = { type: 'file', file_id: 'file_report', mount_path: '/data/report.md' }
  session.resources.push(report,
    { type: 'file', file_id: 'file_online', mount_path: '/mnt/session/uploads/dot-bridge-live-sess_source-evt_test.json' })
  session.agent.multiagent = { type: 'coordinator', agents: [
    { type: 'agent', id: 'agent_child', version: 3, name: 'Cloud worker' },
  ] }
  const job = createMigration(session, migrationOptions({ name: 'Dot successor' }))
  assert.deepEqual(job.agentConfig.multiagent, { type: 'coordinator', agents: [
    { type: 'agent', id: 'agent_child', version: 3 },
  ] })
  assert.deepEqual(job.resources, [...source.resources, report])
})

test('a search worker must be able to use search and fetch without blocking for approval', () => {
  const tools = { type: 'agent_toolset_20260401', enabled_tools: ['WebSearch', 'WebFetch'] }
  const session = { agent: { multiagent: { agents: [{ name: 'Dot 云端助手', tools: [tools] }] } } }
  assert.equal(dotWorkerReady(session), true)
  tools.configs = [{ name: 'WebFetch', permission_policy: { type: 'always_ask' } }]
  assert.equal(dotWorkerReady(session), false)
})

test('a repair cutover requires a real reply from the child created in its probe', async () => {
  const options = { ...migrationOptions({ name: 'Dot repair', cloudWorker: true }), repairWorker: true }
  const job = createMigration(source, options)
  Object.assign(job, { targetSessionId: 'sess_new', agentId: 'agent_new', workerId: 'agent_child',
    storeId: 'memstore_original', memoryId: 'memory_fixture', probePath: 'dot/probe.md' })
  const name = 'Dot 云端助手'
  const child = { type: 'agent', id: job.workerId, version: 1 }
  job.agentConfig.multiagent = { type: 'coordinator', agents: [child] }
  const target = { id: job.targetSessionId, environment_id: source.environment_id,
    resources: source.resources, metadata: { migration: job.id }, agent: { ...job.agentConfig, id: job.agentId,
      multiagent: { type: 'coordinator', agents: [{ ...child, name,
        tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['WebSearch', 'WebFetch'] }] }] } } }
  const probe = 'DOT-WORKER-' + job.id
  let from = 'sthr_unrelated'
  const client = {
    getSession: async () => target,
    async send(id, event) {
      assert.equal(id, target.id)
      assert(event.content[0].text.includes(probe))
      return { data: [{ id: 'evt_probe', type: 'user.message' }] }
    },
    async *events() {
      yield { id: 'evt_read', type: 'agent.tool_use', name: 'Read', input: { file_path: '/data/.qoder/awareness/' + job.probePath } }
      yield { type: 'agent.tool_result', tool_use_id: 'evt_read' }
      yield { id: 'evt_create', type: 'agent.tool_use', name: 'create_agent', input: { name, task: probe } }
      yield { type: 'session.thread_created', agent_name: name, session_thread_id: 'sthr_verified' }
      yield { type: 'agent.tool_result', tool_use_id: 'evt_create', content: [{ type: 'text', text: 'Created agent thread: sthr_verified' }] }
      yield { id: 'evt_child_reply', type: 'agent.thread_message_received', from_agent_name: name,
        from_session_thread_id: from, content: [{ type: 'text', text: probe }] }
      yield { id: 'evt_answer', type: 'agent.message', content: [{ type: 'text', text: job.probeCode }] }
      yield { type: 'session.status_idle' }
    },
  }
  const run = () => runMigration({ client, job, save: async () => {}, signal: new AbortController().signal })
  await assert.rejects(run, /尚未收到云端助手的子线程回执/)
  assert.equal(job.stage, 'session_created')
  from = 'sthr_verified'
  await run()
  assert.equal(job.stage, 'ready')
  assert.equal(job.verifiedWorkerEventId, 'evt_child_reply')
})

test('resumes a partially completed migration, reuses its memory store, and verifies both files', async () => {
  const options = migrationOptions({ name: '新 Agent', handoff: '继续整理合成报告', copyMemory: true, memoryAccess: 'read_write' })
  let job = createMigration(source, options, '# 本机记忆')
  assert.deepEqual(job.agentConfig.model, { id: 'auto' })
  const entries = new Map()
  const actions = []
  let session
  let checkpoint
  let finishRead = false
  let sentKey
  const client = {
    async createAgentFromConfig(config) {
      actions.push('agent')
      assert.equal(config.system, source.agent.system)
      return { id: 'agent_new' }
    },
    async listMemory(store, path) {
      assert.equal(store, 'memstore_original')
      return { data: entries.has(path) ? [entries.get(path)] : [] }
    },
    async createMemory(store, { path, content }) {
      const entry = { id: path, path, content }
      entries.set(path, entry)
      return entry
    },
    async getMemory(store, entry) { return entries.get(entry) },
    async createSessionFromConfig(config) {
      actions.push('session')
      assert.equal(config.resources[0].access, 'read_write')
      session = { ...config, id: 'sess_new', agent: { ...job.agentConfig, id: config.agent.id } }
      return session
    },
    async getSession(id) {
      assert.equal(id, 'sess_new')
      return session
    },
    async send(id, event, key) {
      assert.equal(id, 'sess_new')
      assert(!event.content[0].text.includes(job.probeCode))
      sentKey = key
      return { data: [{ id: 'evt_probe', type: 'user.message' }] }
    },
    async *events(id, cursor) {
      assert.equal(id, 'sess_new')
      assert.equal(cursor, 'evt_probe')
      if (!finishRead) throw new Error('transport disconnected')
      for (const [index, path] of [...entries.keys()].entries()) {
        const tool = 'evt_read' + index
        yield { id: tool, type: 'agent.tool_use', name: 'Read', input: { path: '/data/.qoder/awareness/' + path } }
        yield { type: 'agent.tool_result', tool_use_id: tool }
      }
      yield { id: 'evt_answer', type: 'agent.message', content: [{ type: 'text', text: job.probeCode }] }
      yield { type: 'session.status_idle' }
    },
  }
  const run = () => runMigration({ client, job, save: next => { checkpoint = structuredClone(next) },
    signal: new AbortController().signal, pause: async () => {} })
  await assert.rejects(run, /transport disconnected/)
  assert.equal(checkpoint.stage, 'verifying')
  assert.equal(checkpoint.localMemory, undefined)
  assert.equal(entries.size, 2)
  assert.match(sentKey, /-probe$/)
  job = checkpoint
  finishRead = true
  await run()
  assert.deepEqual(actions, ['agent', 'session'])
  assert.equal(checkpoint.stage, 'ready')
  assert.equal(checkpoint.verifiedEventId, 'evt_answer')
  assert.equal(checkpoint.access, 'read_write')
})
