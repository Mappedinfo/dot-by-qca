import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consoleConfigurationPatch, maintenanceIntent } from './dot-maintenance.mjs'
import { CLOUD_TOOLS, macMarkerTool } from './qca.mjs'

test('requires a direct maintenance request and does not treat a question as permission to update', () => {
  assert.equal(maintenanceIntent('检查并修复 Dot 配置'), 'repair')
  assert.equal(maintenanceIntent('请帮我更新 Dot 会话配置。'), 'repair')
  assert.equal(maintenanceIntent('查看 Dot 维护状态？'), 'status')
  assert.equal(maintenanceIntent('如何更新 Dot 会话配置？'), undefined)
  assert.equal(maintenanceIntent('不要更新 Dot 会话配置'), undefined)
  assert.equal(maintenanceIntent('举例：“检查并修复 Dot 配置”'), undefined)
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
