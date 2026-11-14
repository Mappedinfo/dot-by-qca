import { isDeepStrictEqual } from 'node:util'
import { consoleSystem } from './dot-bridge.mjs'
import { dotDisplayName } from './dot-entry.mjs'
import {
  CLOUD_TOOLS, consoleQuestionTool, dotDshFollowupTool, dotMaintenanceTool, dotMemoryTool, dotTaskbookTool,
  dshClockTool, dshContinueTool, dshDirectTool, dshProjectsTool, dshReviewTool, dshStatusTool, dshTool, macMarkerTool,
} from './qca.mjs'

const managedTools = [macMarkerTool, consoleQuestionTool, dotMemoryTool, dotTaskbookTool, dotDshFollowupTool,
  dotMaintenanceTool, dshClockTool, dshDirectTool, dshTool, dshContinueTool, dshProjectsTool, dshReviewTool, dshStatusTool]

export function consoleConfigurationPatch(session, skill) {
  const agent = session.agent
  const current = agent.tools || []
  const owned = tool => tool.type === CLOUD_TOOLS.type ||
    tool.type === 'custom' && managedTools.some(managed => managed.name === tool.name)
  const tools = [...current.filter(tool => !owned(tool)), ...managedTools, CLOUD_TOOLS]
  const system = consoleSystem(session)
  const patch = {}
  const name = dotDisplayName(agent.name)
  if (name !== agent.name) patch.name = name
  if (agent.system !== system) patch.system = system
  if (!isDeepStrictEqual(current, tools)) patch.tools = tools
  if (skill && !agent.skills?.some(item => item.skill_id === skill.skill_id && item.version === skill.version)) {
    patch.skills = [...(agent.skills || []).filter(item => item.skill_id !== skill.skill_id),
      { type: 'custom', skill_id: skill.skill_id, version: skill.version }]
  }
  return patch
}

export function maintenanceIntent(text) {
  const input = text.trim()
  if (/^(?:请\s*)?(?:帮我\s*)?(?:检查并修复|修复|更新)\s*(?:当前\s*)?Dot\s*(?:会话\s*)?配置[。！!]?$/iu.test(input)) return 'repair'
  if (/^(?:请\s*)?(?:帮我\s*)?(?:查看|查一下|看看|查询)\s*Dot\s*维护(?:状态|进度)[。？?！!]?$/iu.test(input)) return 'status'
}
