import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeHeartbeat, bridgeLeaseMs, consoleSystem, migrateConsoleSystem } from './dot-bridge.mjs'
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

test('uses session-specific online checks only where a memory store is mounted', () => {
  assert.doesNotMatch(consoleSystem({ id: 'sess_old' }), /\/proc\/stat/)
  assert.match(consoleSystem({ id: 'sess_new', resources: [{ type: 'memory_store', memory_store_id: 'store' }] }), /精确等于 sess_new/)
})

test('migration replaces the source session in a managed prompt and preserves a custom prompt', () => {
  const resources = [{ type: 'memory_store', memory_store_id: 'store' }]
  const source = consoleSystem({ id: 'sess_source', resources })
  const target = { id: 'sess_target', resources, agent: { multiagent: { agents: [{ name: 'Dot 云端助手' }] } } }
  const updated = migrateConsoleSystem(target, source)
  assert.match(updated, /精确等于 sess_target/)
  assert.match(updated, /必须调用 QCA 内置 create_agent/)
  assert.doesNotMatch(updated, /sess_source/)
  assert.equal(migrateConsoleSystem(target, 'Custom project prompt'), 'Custom project prompt')
})
