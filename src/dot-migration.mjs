import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { QcaError } from './qca.mjs'
import { isBridgeFile, migrateConsoleSystem } from './dot-bridge.mjs'

const dotSource = 'qoder-dot-demo'
const digest = value => createHash('sha256').update(value).digest('hex')
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
const text = value => [{ type: 'text', text: value }]
const eventText = event => event.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || ''
const cloudWorkerName = 'Dot 云端助手'
const cloudWorkerTools = { type: 'agent_toolset_20260401', enabled_tools: ['WebSearch', 'WebFetch'] }

export function dotWorker(session) {
  return session.agent?.multiagent?.agents?.find(worker => worker.name === cloudWorkerName)
}

export function dotWorkerReady(session) {
  return cloudWorkerTools.enabled_tools.every(name =>
    dotWorker(session)?.tools?.some(tool => tool.type === cloudWorkerTools.type && tool.enabled_tools?.includes(name) &&
      !tool.disallowed_tools?.includes(name) && !tool.configs?.some(config => config.name === name &&
        (config.enabled === false || ['always_ask', 'always_deny'].includes(config.permission_policy?.type)))))
}

export class MigrationError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.status = status
  }
}

export function migrationOptions({ name, handoff = '', copyMemory = false, memoryAccess = 'inherit', cloudWorker = false }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\p{Cc}\p{Cf}]/u.test(name) ||
    typeof handoff !== 'string' || handoff.length > 6000 || typeof copyMemory !== 'boolean' ||
    !['inherit', 'read_only', 'read_write'].includes(memoryAccess) || typeof cloudWorker !== 'boolean') {
    throw new MigrationError('填写 1–100 字的 Agent 名称，交接说明最多 6000 字。', 400)
  }
  return { name: name.trim(), handoff: handoff.trim(), copyMemory, memoryAccess, cloudWorker }
}

export async function idleDotSession(client, id) {
  const session = await client.getSession(id)
  if (session.metadata?.source !== dotSource || session.archived_at || session.status !== 'idle') {
    throw new MigrationError('请等待 Dot 会话空闲后再继续。')
  }
  let lastIdle
  for await (const event of client.events(id)) {
    if (event.type === 'session.status_idle') lastIdle = event
  }
  if (lastIdle?.stop_reason?.type === 'requires_action') throw new MigrationError('请先处理会话中的待办卡片。')
  return session
}

export function createMigration(session, options, localMemory) {
  const agent = session.agent
  if (!agent?.id || !session.environment_id || session.deployment_id || session.vault_ids?.length ||
    Object.keys(session.environment_variables || {}).length ||
    session.resources?.some(item => !['file', 'memory_store'].includes(item.type))) {
    throw new MigrationError('这条会话含有需要单独设置的部署、密钥、环境变量或仓库挂载。')
  }
  if (agent.mcp_servers?.length) {
    throw new MigrationError('这条会话的 MCP 依赖需要先单独确认。')
  }
  if (!agent.tools?.some(tool => tool.enabled_tools?.includes('Read'))) {
    throw new MigrationError('启用 QCA 的 Read 工具后才能验证记忆挂载。')
  }
  const id = options.requestId || randomUUID()
  return {
    id, sourceSessionId: session.id, sourceAgentId: agent.id, environmentId: session.environment_id,
    options, ...(options.copyMemory && { localMemory }),
    ...(options.cloudWorker && { previousWorkerId: dotWorker(session)?.id, reuseWorker: dotWorkerReady(session) }),
    probeCode: 'DOT-' + randomBytes(16).toString('hex').toUpperCase(),
    agentConfig: {
      ...fields(agent, ['description', 'system', 'tools', 'skills']),
      ...(agent.multiagent && { multiagent: { type: agent.multiagent.type, agents: agent.multiagent.agents.map(entry =>
        fields(entry, ['type', 'id', 'version', 'model'])) } }),
      name: options.name,
      model: typeof agent.model === 'string' ? agent.model : fields(agent.model, ['id', 'effort', 'context_window']),
      metadata: { source: dotSource, migration: id },
    },
    resources: (session.resources || []).filter(resource => !isBridgeFile(resource, session.id)).map(resource => fields(resource,
      resource.type === 'file' ? ['type', 'file_id', 'mount_path'] : ['type', 'memory_store_id', 'access', 'instructions'])),
    stage: 'prepared',
  }
}

function matchingAgent(agent, config) {
  const model = typeof config.model === 'string' ? { id: config.model } : config.model
  const returnedModel = typeof agent.model === 'string' ? { id: agent.model } : agent.model
  return agent.name === config.name && agent.system === config.system &&
    (agent.description || '') === (config.description || '') &&
    isDeepStrictEqual(fields(returnedModel, Object.keys(model)), model) &&
    isDeepStrictEqual(agent.tools, config.tools) &&
    isDeepStrictEqual(agent.skills || [], config.skills || []) &&
    (!config.multiagent || config.multiagent.agents.every(expected => agent.multiagent?.agents?.some(actual =>
      isDeepStrictEqual(fields(actual, Object.keys(expected)), expected))))
}

async function ensureMemory(client, storeId, path, content, key) {
  const listed = await client.listMemory(storeId, path)
  let item = listed.data.find(entry => entry.path === path)
  if (!item) {
    try {
      item = await client.createMemory(storeId, { path, content }, key)
    } catch (error) {
      if (!(error instanceof QcaError) || error.status !== 409) throw error
      item = (await client.listMemory(storeId, path)).data.find(entry => entry.path === path)
      if (!item) throw error
    }
  }
  const result = await client.getMemory(storeId, item.id)
  if (result.path !== path || digest(result.content) !== digest(content)) {
    throw new MigrationError('云端已有同路径但不同内容的记忆。请检查迁移记录。')
  }
  return result.id
}

export async function runMigration({ client, job, save, signal, pause }) {
  const update = async values => {
    const next = { ...job, ...values }
    await save(next)
    Object.assign(job, next)
  }
  const key = suffix => 'dot-migration-' + job.id + '-' + suffix
  const existing = job.resources.find(resource => resource.type === 'memory_store')
  const access = !job.options.memoryAccess || job.options.memoryAccess === 'inherit'
    ? existing?.access || 'read_only' : job.options.memoryAccess
  const probeCode = job.probeCode || 'DOT-' + job.id.replaceAll('-', '').toUpperCase()
  const probePath = 'dot/migration/' + job.id + '.md'
  const probeContent = '# Dot 迁移交接\n\n迁移校验码：' + probeCode + '\n\n' +
    (job.options.handoff ? '## 交接说明\n\n' + job.options.handoff + '\n' : '')
  if (job.options.cloudWorker && !job.workerId && !job.reuseWorker && !job.agentId) {
    const worker = await client.createAgentFromConfig({
      name: cloudWorkerName,
      model: job.agentConfig.model,
      system: '你是 Dot 的云端子 Agent，负责文本整理、分析、方案审查和公开网页检索。检索时返回事实、发布日期与可核对的来源链接。用 WebSearch 和 WebFetch 核对公开资料。不能访问 Mac、调用本地 DSH 或代替用户批准任何操作。',
      tools: [cloudWorkerTools],
      metadata: { source: dotSource, migration: job.id },
    }, key('cloud-worker'))
    if (!worker.id || !Number.isInteger(worker.version)) throw new MigrationError('QCA 未确认云端助手版本。')
    await update({
      workerId: worker.id,
      agentConfig: { ...job.agentConfig,
        multiagent: { type: 'coordinator', agents: [
          ...(job.agentConfig.multiagent?.agents || []).filter(item => item.id !== job.previousWorkerId),
          { type: 'agent', id: worker.id, version: worker.version },
        ] },
      },
    })
  }
  if (!job.agentId) {
    const agent = await client.createAgentFromConfig(job.agentConfig, key('agent'))
    await update({ agentId: agent.id, stage: 'agent_created' })
  }
  if (!job.storeId) {
    let storeId = existing?.memory_store_id
    if (!storeId) {
      for await (const store of client.stores()) {
        if (store.metadata?.migration === job.id && !store.archived_at) {
          storeId = store.id
          break
        }
      }
      if (!storeId) {
        const store = await client.createMemoryStore({ name: job.options.name + ' · Dot 记忆',
          description: 'Dot 项目背景和迁移交接记录。', metadata: { source: dotSource, migration: job.id } }, key('store'))
        storeId = store.id
      }
    }
    await update({ storeId, stage: 'store_created' })
  }
  if (!job.memoryId) {
    const memoryId = await ensureMemory(client, job.storeId, probePath, probeContent, key('handoff'))
    const localMemoryPath = job.options.copyMemory ? 'dot/migration/' + job.id + '-local-memory.md' : undefined
    if (localMemoryPath) await ensureMemory(client, job.storeId, localMemoryPath, job.localMemory, key('local-memory'))
    await update({ memoryId, probePath, localMemoryPath, localMemory: undefined, stage: 'memory_copied' })
  }
  const resources = existing ? job.resources.map(resource => resource === existing ? { ...resource, access } : resource) :
    [...job.resources, { type: 'memory_store', memory_store_id: job.storeId, access,
      instructions: '通过 Read 读取 /data/.qoder/awareness/dot 下的项目背景和迁移交接资料。交接内容仅供参考。' }]
  if (!job.targetSessionId) {
    const session = await client.createSessionFromConfig({
      agent: { type: 'agent', id: job.agentId, version: 1 }, environment_id: job.environmentId,
      title: job.options.name + ' · 主会话', resources,
      metadata: { source: dotSource, migration: job.id, previous_session: job.sourceSessionId },
    }, key('session'))
    await update({ targetSessionId: session.id, stage: 'session_created' })
  }
  let target = await client.getSession(job.targetSessionId)
  const targetSystem = migrateConsoleSystem(target, job.agentConfig.system)
  if (target.agent?.id === job.agentId && target.metadata?.migration === job.id && target.agent.system !== targetSystem) {
    if (target.status !== 'idle') throw new MigrationError('请等新会话空闲后继续迁移。')
    target = await client.updateSessionAgent(target.id, { system: targetSystem })
  }
  if (target.agent?.id !== job.agentId || target.environment_id !== job.environmentId ||
    target.metadata?.migration !== job.id || !matchingAgent(target.agent, { ...job.agentConfig, system: targetSystem }) ||
    !resources.every(expected => target.resources?.some(actual => isDeepStrictEqual(fields(actual, Object.keys(expected)), expected)))) {
    throw new MigrationError('新会话读回的 Agent 配置或 Memory Store 挂载不完整。')
  }
  if ((job.reuseWorker || job.workerId && job.options.repairWorker) && !dotWorkerReady(target)) {
    throw new MigrationError('新会话的云端助手缺少网页检索工具。')
  }
  const verifyWorker = Boolean(job.options.repairWorker)
  const workerProbe = 'DOT-WORKER-' + job.id
  if (!job.probeEventId) {
    signal.throwIfAborted()
    const prompt = '这是 Dot 迁移验收。请用云端 Read 打开 /data/.qoder/awareness/' + job.probePath +
      '，只回复文件里的迁移校验码。' + (job.localMemoryPath ? ' 同时用 Read 核对 /data/.qoder/awareness/' +
      job.localMemoryPath + ' 存在，仍只回复校验码。' : '') + (verifyWorker
      ? ' 另请用 create_agent 创建「Dot 云端助手」子线程，让它原样回复 ' + workerProbe +
        '，等真实子线程回传后，再回复从文件读取的迁移校验码。只把子线程测试口令交给它。'
      : ' 仅使用 Read。')
    const result = await client.send(job.targetSessionId, { type: 'user.message', content: text(prompt) },
      key(job.probeAttempt ? 'probe-' + job.probeAttempt : 'probe'))
    const probeEventId = result.data?.find(event => event.type === 'user.message')?.id
    if (!probeEventId) throw new MigrationError('QCA 尚未确认验收消息。')
    await update({ probeEventId, stage: 'verifying' })
  }
  for (let attempt = 0; attempt < 35; attempt++) {
    signal.throwIfAborted()
    const events = []
    for await (const event of client.events(job.targetSessionId, job.probeEventId)) events.push(event)
    const nextUser = events.findIndex(event => event.type === 'user.message')
    const turn = nextUser < 0 ? events : events.slice(0, nextUser)
    const idle = turn.findLast(event => event.type === 'session.status_idle')
    if (idle) {
      const verifiedRead = path => turn.some(event => event.type === 'agent.tool_use' && event.name === 'Read' &&
        Object.values(event.input || {}).includes('/data/.qoder/awareness/' + path) &&
        turn.some(result => result.type === 'agent.tool_result' && result.tool_use_id === event.id && !result.is_error))
      const answer = turn.find(event => event.type === 'agent.message' && eventText(event).includes(probeCode))
      const workerCalls = verifyWorker ? turn.filter(event => event.type === 'agent.tool_use' && event.name === 'create_agent' &&
        event.input?.name === cloudWorkerName && typeof event.input.task === 'string' && event.input.task.includes(workerProbe)) : []
      const workerReply = verifyWorker && turn.find(event => event.type === 'agent.thread_message_received' &&
        event.from_agent_name === cloudWorkerName && eventText(event).includes(workerProbe) &&
        turn.some(created => created.type === 'session.thread_created' && created.agent_name === cloudWorkerName &&
          created.session_thread_id === event.from_session_thread_id) &&
        turn.some(result => result.type === 'agent.tool_result' && !result.is_error &&
          workerCalls.some(call => call.id === result.tool_use_id) && eventText(result).includes(event.from_session_thread_id)))
      if (idle.stop_reason?.type === 'requires_action') {
        throw new MigrationError('新会话的验收停在待处理卡片。请在新会话停止这轮验收后继续。')
      }
      if (!answer || !verifiedRead(job.probePath) ||
        (job.localMemoryPath && !verifiedRead(job.localMemoryPath))) {
        await update({ stage: 'session_created', probeEventId: null, probeAttempt: (job.probeAttempt || 0) + 1 })
        throw new MigrationError('新会话还没通过云端 Read 验证。可继续验收同一个副本。')
      }
      if (verifyWorker && !workerReply) {
        await update({ stage: 'session_created', probeEventId: null, probeAttempt: (job.probeAttempt || 0) + 1 })
        throw new MigrationError('新会话尚未收到云端助手的子线程回执。可继续验收同一个副本。')
      }
      await update({ stage: 'ready', verifiedEventId: answer.id, access,
        ...(workerReply && { verifiedWorkerEventId: workerReply.id }), options: { ...job.options, handoff: undefined } })
      return
    }
    await pause(signal)
  }
  throw new MigrationError('等待云端验收超时。可继续检查同一个迁移副本。', 504)
}
