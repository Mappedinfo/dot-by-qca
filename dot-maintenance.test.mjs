import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consoleConfigurationPatch, latestMaintenanceRequest, maintenanceIntent } from './dot-maintenance.mjs'
import { CLOUD_TOOLS, macMarkerTool } from './qca.mjs'

test('requires a direct maintenance request and does not treat a question as permission to update', () => {
  assert.equal(maintenanceIntent('检查并修复 Dot 配置'), 'repair')
  assert.equal(maintenanceIntent('请帮我更新 Dot 会话配置。'), 'repair')
  assert.equal(maintenanceIntent('查看 Dot 维护状态？'), 'status')
  assert.equal(maintenanceIntent('如何更新 Dot 会话配置？'), undefined)
  assert.equal(maintenanceIntent('不要更新 Dot 会话配置'), undefined)
  assert.equal(maintenanceIntent('举例：“检查并修复 Dot 配置”'), undefined)
})

test('recovers the latest explicit repair from a normally completed turn after enabling recovery', () => {
  const now = Date.parse('2026-11-15T01:00:00Z')
  const message = (id, text, offset = 1000, type = 'user.message') => ({
    id, type, processed_at: new Date(now + offset).toISOString(), content: [{ type: 'text', text }],
  })
  const end = { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
  const pause = { type: 'session.status_idle', stop_reason: { type: 'requires_action' } }
  const repair = '检查并修复 Dot 配置'
  const cancelled = message('cancelled', repair, 3000)
  const events = [
    message('old', repair, -1000), end,
    message('echo', repair, 1000, 'agent.message'), end,
    message('question', '如何检查并修复 Dot 配置？'), end,
    message('first', repair), end,
    message('latest', repair, 2000), pause, end,
    cancelled, { type: 'user.interrupt' }, end,
    message('still_open', repair, 4000), pause,
  ]
  assert.deepEqual(latestMaintenanceRequest(events, now), { requestId: 'latest', requestedAt: now + 2000 })
  assert.equal(latestMaintenanceRequest(events, now + 2500), undefined)
  assert.equal(latestMaintenanceRequest([cancelled, { type: 'session.status_terminated' }, end], now), undefined)
})

test('restores missing Dot tools and retains unrelated tools and skill bindings', () => {
  const extra = { type: 'custom', name: 'other_tool' }
  const existingSkill = { type: 'custom', skill_id: 'other_skill', version: '1' }
  const skill = { skill_id: 'dot_skill', version: '2' }
  const session = { id: 'sess_dot', agent: { name: 'Qoder Dot · 旧 Agent', system: 'old', tools: [extra], skills: [existingSkill] } }
  const patch = consoleConfigurationPatch(session, skill)
  assert.ok(patch.tools.includes(macMarkerTool))
  assert.ok(patch.tools.includes(CLOUD_TOOLS))
  assert.equal(patch.name, 'Dot by QCA · 旧 Agent')
  assert.equal(patch.tools[0], extra)
  assert.deepEqual(patch.skills, [existingSkill, { type: 'custom', ...skill }])
  assert.deepEqual(consoleConfigurationPatch({ ...session, agent: { ...session.agent, ...patch } }, skill), {})
})
