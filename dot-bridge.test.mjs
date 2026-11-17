import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bridgeHeartbeat, bridgeLeaseMs, consoleSystem, isBridgeFile, migrateConsoleSystem, turnAvailability } from './dot-bridge.mjs'
import { QcaError } from './qca.mjs'

test('renews only for a connected session and replaces the previous owner on cutover', async () => {
  const calls = []
  let entry
  const write = ({ path, content }) => {
    calls.push(JSON.parse(content))
    entry = { path, content, id: 'mem_test', content_sha256: String(calls.length) }
    return entry
  }
  const client = {
    getSession: async () => ({ resources: [{ type: 'memory_store', memory_store_id: 'store' }] }),
    listMemory: async () => ({ data: entry ? [entry] : [] }),
    createMemory: async (store, body) => write(body),
    updateMemory: async (store, id, { content, content_sha256 }) => {
      assert.equal(id, entry.id)
      assert.equal(content_sha256, entry.content_sha256)
      return write({ path: entry.path, content })
    },
  }
  const beat = bridgeHeartbeat(client)
  const yes = () => true
  const no = () => false
  const first = Date.parse('2026-11-14T06:00:00Z')
  await beat('sess_A', no, first)
  await beat('sess_A', yes, first)
  await beat('sess_A', yes, first + 30_000)
  await beat('sess_A', yes, first + 60_000)
  await beat('sess_A', no, first + 120_000)
  await beat('sess_B', yes, first + 121_000)
  assert.deepEqual(calls, [
    { sessionId: 'sess_A', expiresUnix: (first + bridgeLeaseMs) / 1000 },
    { sessionId: 'sess_A', expiresUnix: (first + 60_000 + bridgeLeaseMs) / 1000 },
    { sessionId: 'sess_B', expiresUnix: (first + 121_000 + bridgeLeaseMs) / 1000 },
  ])
})

test('a changed memory version is reread before trying again', async () => {
  let sha = 'first'
  const attempts = []
  const client = {
    getSession: async () => ({ resources: [{ type: 'memory_store', memory_store_id: 'store' }] }),
    listMemory: async () => ({ data: [{ path: 'dot/bridge-availability.json', id: 'mem_test', content_sha256: sha }] }),
    updateMemory: async (store, id, { content, content_sha256 }) => {
      attempts.push(content_sha256)
      if (sha === 'first') {
        sha = 'second'
        throw new QcaError(409)
      }
      return { path: 'dot/bridge-availability.json', id, content, content_sha256: 'third' }
    },
  }
  const beat = bridgeHeartbeat(client)
  await assert.rejects(beat('sess_A', () => true, 100_000), { status: 409 })
  await beat('sess_A', () => true, 110_000)
  assert.deepEqual(attempts, ['first', 'second'])
})

test('a transient renewal failure is retried before the existing lease expires', async () => {
  const path = 'dot/bridge-availability.json'
  let entry
  let updates = 0
  const save = content => {
    entry = { path, content, id: 'mem_test', content_sha256: String(updates) }
    return entry
  }
  const beat = bridgeHeartbeat({
    getSession: async () => ({ resources: [{ type: 'memory_store', memory_store_id: 'store' }] }),
    listMemory: async () => ({ data: entry ? [entry] : [] }),
    createMemory: async (_, { content }) => save(content),
    updateMemory: async (_, __, { content }) => {
      if (++updates <= 2) throw new QcaError(503)
      return save(content)
    },
  })
  const connected = () => true
  await beat('sess_A', connected, 100_000)
  await assert.rejects(beat('sess_A', connected, 160_000), { status: 503 })
  await assert.rejects(beat('sess_A', connected, 170_000), { status: 503 })
  assert.equal(JSON.parse(entry.content).expiresUnix, 250)
  await beat('sess_A', connected, 180_000)
  assert.equal(JSON.parse(entry.content).expiresUnix, 330)
})

test('a DSH capability change is sent before the bridge lease renewal', async () => {
  const writes = []
  const save = (path, content) => {
    writes.push(JSON.parse(content))
    return { path, content, id: 'mem_test', content_sha256: String(writes.length) }
  }
  const path = 'dot/bridge-availability.json'
  const beat = bridgeHeartbeat({
    getSession: async () => ({ resources: [{ type: 'memory_store', memory_store_id: 'store' }] }),
    listMemory: async () => ({ data: [] }),
    createMemory: async (_, body) => save(body.path, body.content),
    updateMemory: async (_, __, body) => save(path, body.content),
  })
  for (const [now, dshCli, dshWeb] of [
    [100_000, true, true],
    [110_000, true, false],
    [120_000, true, false],
    [130_000, false, false],
    [140_000, true, false],
    [150_000, true, true],
  ]) await beat('sess_A', () => true, now, { dshCli, dshWeb })

  assert.deepEqual(writes.map(({ dshCli, dshWeb }) => [dshCli, dshWeb]), [
    [true, true], [true, false], [false, false], [true, false], [true, true],
  ])
  assert(writes.every(record => record.sessionId === 'sess_A' && Number.isSafeInteger(record.expiresUnix)))
})

test('uses session-specific online checks only where a memory store is mounted', () => {
  assert.doesNotMatch(consoleSystem({ id: 'sess_old' }), /\/proc\/stat/)
  assert.match(consoleSystem({ id: 'sess_new', resources: [{ type: 'memory_store', memory_store_id: 'store' }] }), /精确等于 sess_new/)
})

test('publishes a different QCA file for each recent turn and cleans expired mounts after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-turn-availability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const file = join(root, 'records.json')
  const uploads = new Map()
  const deleted = []
  const client = {
    async uploadSessionFile(name, content) {
      const id = 'file_' + uploads.size
      uploads.set(id, { name, content: JSON.parse(content) })
      return { id }
    },
    async attachSessionFile(sessionId, fileId, mountPath) {
      const resource = { id: 'sesr_' + fileId, file_id: fileId, mount_path: mountPath, type: 'file' }
      assert.equal(isBridgeFile(resource, sessionId), true)
      assert.equal(isBridgeFile(resource, 'sess_other'), false)
      return resource
    },
    async detachSessionFile(sessionId, id) { deleted.push([sessionId, id]) },
    async deleteSessionFile(id) { deleted.push(id) },
  }
  const setup = () => turnAvailability({ client, file, save: (path, value) => writeFile(path, JSON.stringify(value)) })
  const signal = new AbortController().signal
  const capture = async () => ({ dshCli: true, dshWeb: false })
  const turn = id => ({ id, sessionId: 'sess_A', processed_at: new Date(now).toISOString() })
  const first = turn('evt_first')
  const publish = setup()
  await publish(first, capture, () => false, signal)
  assert.equal(uploads.size, 0)
  await publish(first, capture, () => true, signal)
  await publish(first, capture, () => true, signal)
  now += 30_000
  await publish(turn('evt_second'), capture, () => true, signal)
  assert.deepEqual([...uploads.values()].map(item => item.name), [
    'dot-bridge-live-sess_A-evt_first.json', 'dot-bridge-live-sess_A-evt_second.json',
  ])
  assert.deepEqual(uploads.get('file_1').content, { sessionId: 'sess_A',
    expiresUnix: Math.floor((now + bridgeLeaseMs) / 1000), dshCli: true, dshWeb: false })
  now += bridgeLeaseMs - 30_000
  await setup()(first, capture, () => true, signal)
  assert.deepEqual(deleted, [['sess_A', 'sesr_file_0'], 'file_0'])
  assert.equal(uploads.size, 2)
})

test('migration replaces the source session in a managed prompt and preserves a custom prompt', () => {
  const resources = [{ type: 'memory_store', memory_store_id: 'store' }]
  const source = consoleSystem({ id: 'sess_source', resources })
  const target = { id: 'sess_target', resources, agent: { multiagent: { agents: [{ name: 'Dot 云端助手' }] } } }
  const updated = migrateConsoleSystem(target, source)
  assert.match(updated, /精确等于 sess_target/)
  assert.match(updated, /必须调用 QCA 内置 create_agent/)
  assert.match(updated, /没重复说「掉线就用云端」/)
  assert.match(updated, /dshCli 为 false 或缺失时，尚未投递且可以在云端完成的 Mac 优先任务自动交给云端助手/)
  assert.match(updated, /不要用 dshWeb 的状态判断新建的 DSH 任务/)
  assert.match(updated, /已经投递或可能投递到 Mac 的工作只报告已知进度/)
  assert.match(updated, /直接调用 QCA 原生 list_agents/)
  assert.match(updated, /last_reply 晚于 last_task/)
  assert.doesNotMatch(updated, /sess_source/)
  assert.equal(migrateConsoleSystem(target, 'Custom project prompt'), 'Custom project prompt')
})
