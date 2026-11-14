import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { loadEnvFile } from 'node:process'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CONSOLE_QUESTION, DOT_DSH_FOLLOWUP_TOOL, DOT_MAINTENANCE_TOOL, DOT_MEMORY_TOOL, DOT_TASKBOOK_TOOL, DSH_CLOCK_TOOL, DSH_COMMAND_HEADER, DSH_CONTINUE_TOOL, DSH_DIRECT_TOOL, DSH_PROJECTS_TOOL, DSH_REVIEW_TOOL, DSH_STATUS_TOOL, DSH_TOOL, MAC_TOOL, QcaError, configureQcaProxy, qcaClient } from './qca.mjs'
import { approvedDshCommand, approvedDshTask, consoleApproves, directlyRequestedDshTask, questionAnswer, requestedMacClock, validTerminalCommand } from './console-approval.mjs'
import { reviewDshTask, runDsh, runDshCommandTask } from './dsh-runner.mjs'
import { blockedTerminalCommand } from './task-review.mjs'
import { archiveCutoff, archiveDateReply, archiveRequest, previewArchive, seedArchivePreview } from './dot-archive.mjs'
import { applyMemory, memoryIntent, memoryMarkdown, readMemory } from './dot-memory.mjs'
import { createMigration, dotWorkerReady, idleDotSession, MigrationError, migrationOptions, runMigration } from './dot-migration.mjs'
import { dshSearchIntent, matchDshSessions, offlineTaskbook, Taskbook, taskbookIntent } from './dot-taskbook.mjs'
import { webTaskSource } from './dsh-task-source.mjs'
import { dshFollowupIntent, dshFollowupResultIntent, readFollowup } from './dot-dsh-followup.mjs'
import { bridgeHeartbeat, maintenancePath, offlineTaskbookPath, publishStatus } from './dot-bridge.mjs'
import { consoleConfigurationPatch, maintenanceIntent } from './dot-maintenance.mjs'
import { dotName, entryTitle } from './dot-entry.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
try {
  loadEnvFile(resolve(root, '.env'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const mock = process.argv.includes('--mock')
const consoleMode = process.argv.includes('--qca-console')
const configureConsole = process.argv.includes('--configure-qca-console')
const sites = { global: 'https://api.qoder.com/api/v1/cloud', cn: 'https://api.qoder.com.cn/api/v1/cloud' }
const site = process.env.QODER_SITE || 'global'
if (!Object.hasOwn(sites, site)) throw new Error('QODER_SITE 须为 global 或 cn。')
const token = process.env.QODER_PAT || process.env.QODER_ACCESS_TOKEN
const stateDir = resolve(root, mock ? '.dot-state-mock' : '.dot-state', mock ? 'local' : site)
const markerDir = resolve(stateDir, 'mac-markers')
const dshRunDir = resolve(stateDir, 'dsh-runs')
const dshWorkDir = resolve(stateDir, 'dsh-work')
const dshWorkspaceDir = resolve(stateDir, 'dot-workspace')
const stateFile = resolve(stateDir, 'session.json')
const projectFile = resolve(stateDir, 'selected-project.json')
const memoryFile = resolve(stateDir, 'MEMORY.md')
const migrationFile = resolve(stateDir, 'migration.json')
const maintenanceFile = resolve(stateDir, 'maintenance.json')
const historyEntryFile = resolve(stateDir, 'history-entries.json')
const taskbook = new Taskbook(resolve(stateDir, 'taskbook.json'), writeJson)
const dshWeb = consoleMode ? webTaskSource() : undefined
const port = Number(process.env.DOT_PORT || 4317)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DOT_PORT 无效。')

if (process.argv.includes('--seed-archive-preview')) {
  await seedArchivePreview(dshWorkspaceDir)
  console.log('归档预演样本已就绪。')
  process.exit(0)
}

let client
let mockGateway
if (mock) {
  const { startMockGateway } = await import('./mock-qca.mjs')
  mockGateway = await startMockGateway(stateDir)
  client = qcaClient(mockGateway.baseURL, 'local-demo')
} else if (token) {
  configureQcaProxy()
  client = qcaClient(sites[site], token)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { provisioningId: randomUUID(), decisions: {} }
  }
}

async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function eventText(event) {
  return event.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || ''
}

const state = await readState()
if (consoleMode) await taskbook.load()
if (consoleMode && (mock || !client || !state.sessionId)) {
  throw new Error('QCA 控制台模式需要个人访问令牌和现有主会话。')
}
async function readConsultationSkill() {
  return readFile(resolve(stateDir, 'consultation-skill.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function configureActiveConsole() {
  if (mock || !client || !state.sessionId) throw new HttpError(409, '需要已配置的 QCA 主会话。')
  const session = await idleDotSession(client, state.sessionId)
  const agent = consoleConfigurationPatch(session, await readConsultationSkill())
  if (!Object.keys(agent).length) return session
  let updated
  try {
    updated = await client.updateSessionAgent(session.id, agent)
  } catch (error) {
    if (!agent.skills || !(error instanceof QcaError) || ![400, 403, 404].includes(error.status)) throw error
    console.warn(`QCA Skill 绑定未生效（HTTP ${error.status}），协商流程由系统提示词提供。`)
    delete agent.skills
    if (!Object.keys(agent).length) return session
    updated = await client.updateSessionAgent(session.id, agent)
  }
  if (updated.id !== session.id || !updated.agent ||
    !Object.entries(agent).every(([field, value]) => isDeepStrictEqual(updated.agent[field], value))) {
    throw new Error('QCA 响应未确认 Dot 配置变更。')
  }
  return updated
}
if (configureConsole) {
  await configureActiveConsole()
  console.log(`QCA 控制台已配置 · ${state.sessionId}`)
  process.exit(0)
}
const events = new Map()
let cursor
let sessionChecked = false
let phase = 'idle'
let pauseIds = []
let lastIssue = ''
let cloudConnection = 'connecting'
let refreshPromise
let nextRefresh = 0
let mutating = false
let acceptedEvent
let stopRequested
let latestTurnId
let selectedProject = consoleMode ? await readFile(projectFile, 'utf8')
  .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error }) : undefined
let migration = consoleMode ? await readFile(migrationFile, 'utf8')
  .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error }) : undefined
let migrationRun
let migrationIssue
let consoleUpdate
let maintenance = consoleMode ? await readFile(maintenanceFile, 'utf8')
  .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error }) : undefined
let maintenanceRunning
let publishedMaintenance
let publishingMaintenance
let nextConfigurationCheck = 0
let syncingEntries
let nextEntryCheck = 0
let historyEntries = consoleMode ? await readFile(historyEntryFile, 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error
  return {}
}) : {}

async function saveMaintenance(fields) {
  const next = { ...maintenance, ...fields, updatedAt: Date.now() }
  await writeJson(maintenanceFile, next)
  maintenance = next
}

function maintenanceStatus() {
  if (!maintenance) return { status: 'none' }
  const { status, requestId, sourceSessionId, updatedAt, outcome, origin } = maintenance
  if (status === 'checking' && migration?.options.repairWorker && migration.sourceSessionId === sourceSessionId) {
    if (state.sessionId === migration.targetSessionId) return { status: 'completed', requestId, sourceSessionId,
      activeSessionId: state.sessionId, updatedAt, origin, outcome: 'migrated' }
    if (migrationRun || migration.stage === 'ready') return { status: migrationRun ? 'migrating' : 'ready_to_switch',
      requestId, sourceSessionId, targetSessionId: migration.targetSessionId, updatedAt, origin }
    if (migrationIssue) return { status: 'needs_retry', requestId, sourceSessionId, updatedAt, origin }
  }
  return { status, requestId, sourceSessionId, activeSessionId: state.sessionId, updatedAt, outcome, origin }
}

function canMaintain() {
  return !serviceSignal.signal.aborted && !mutating && !migrationRun && !acceptedEvent && !finishing &&
    phase === 'idle' && cloudConnection === 'connected'
}

function runQueuedMaintenance() {
  if (maintenanceRunning || !canMaintain() || !['queued', 'checking'].includes(maintenance?.status)) return
  if (maintenance.sourceSessionId !== state.sessionId) {
    const result = maintenanceStatus().status === 'completed'
      ? { status: 'completed', outcome: 'migrated' }
      : { status: 'cancelled', outcome: 'active_session_changed' }
    maintenanceRunning = saveMaintenance(result).catch(() => {}).finally(() => { maintenanceRunning = undefined })
    return
  }
  if (maintenance.status === 'checking' && migrationIssue && migration?.options.repairWorker && migration.stage !== 'ready') return
  if (maintenance.retryAfter && Date.now() < maintenance.retryAfter) return
  if (maintenance.origin !== 'automatic') {
    const history = [...events.values()]
    const start = history.findIndex(event => event.id === maintenance.requestId)
    if (start < 0) return
    const turn = history.slice(start + 1)
    const boundary = turn.findIndex(event => event.type === 'user.interrupt' || event.type === 'user.message' ||
      (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action'))
    if (boundary < 0) return
    const acknowledged = turn.slice(0, boundary).some(event => event.type === 'user.custom_tool_result' &&
      event.custom_tool_use_id === maintenance.toolEventId && !event.is_error)
    if (turn[boundary].type === 'user.interrupt' || !acknowledged) {
      maintenanceRunning = saveMaintenance({ status: 'cancelled' }).catch(() => {}).finally(() => { maintenanceRunning = undefined })
      return
    }
  }
  maintenanceRunning = (async () => {
    await saveMaintenance({ status: 'checking', retryAfter: undefined })
    const repair = await updateDotConsole({ sessionId: state.sessionId }, { automatic: maintenance.origin === 'automatic' })
    if (repair === 'migrated') await saveMaintenance({ status: 'completed', outcome: 'migrated' })
    else if (consoleUpdate.workerReady || state.workerMigrationHeldFor === state.sessionId) {
      await saveMaintenance({ status: 'completed', outcome: consoleUpdate.workerReady ? 'configuration_verified' : 'configuration_verified_on_rollback' })
    } else if (!migrationRun) await saveMaintenance({ status: 'needs_retry' })
  })().catch(error => {
    if (error instanceof MigrationError || error instanceof HttpError) {
      return saveMaintenance({ status: 'checking', retryAfter: Date.now() + 30_000 })
    }
    return saveMaintenance({ status: 'needs_retry' })
  }).catch(() => {}).finally(() => { maintenanceRunning = undefined })
}

async function updateDotConsole({ sessionId }, { automatic = false } = {}) {
  if (sessionId !== state.sessionId || phase !== 'idle' || acceptedEvent || migrationRun) {
    throw new HttpError(409, '请在当前 Dot 会话空闲时更新。')
  }
  const session = await configureActiveConsole()
  const workerReady = dotWorkerReady(session)
  if (!workerReady && (!automatic || state.workerMigrationHeldFor !== sessionId)) {
    if (migration?.stage !== 'ready' && migration?.options.repairWorker && migration.sourceSessionId === sessionId) {
      await startMigration({ resume: true })
    } else if (migration?.stage === 'ready' && migration.options.repairWorker && migration.sourceSessionId === sessionId) {
      const target = await client.getSession(migration.targetSessionId)
      if (dotWorkerReady(target) && !target.archived_at && target.status !== 'terminated') {
        await switchMigrationSession({ sessionId: target.id }, { repairCutover: true })
        consoleUpdate = { sessionId: target.id, checkedAt: Date.now(), workerReady: true }
        return 'migrated'
      }
      await startMigration({ requestId: randomUUID(), name: session.agent.name, cloudWorker: true, repairWorker: true })
    } else if (!migration || migration.stage === 'ready') {
      await startMigration({ requestId: randomUUID(), name: session.agent.name, cloudWorker: true, repairWorker: true })
    }
  }
  consoleUpdate = { sessionId, checkedAt: Date.now(), workerReady }
}

function checkManagedConfiguration() {
  if (maintenanceRunning || !canMaintain() || ['queued', 'checking'].includes(maintenance?.status) ||
    Date.now() < nextConfigurationCheck) return
  const sessionId = state.sessionId
  nextConfigurationCheck = Date.now() + 60_000
  maintenanceRunning = (async () => {
    const session = await client.getSession(sessionId)
    if (session.metadata?.source !== 'qoder-dot-demo' || session.archived_at || session.status !== 'idle' ||
      state.sessionId !== sessionId || !canMaintain()) return
    const patch = consoleConfigurationPatch(session, await readConsultationSkill())
    if (state.sessionId !== sessionId || !canMaintain()) return
    const canRepairWorker = !dotWorkerReady(session) && state.workerMigrationHeldFor !== sessionId &&
      (!migration || migration.stage === 'ready' || migration.options.repairWorker && migration.sourceSessionId === sessionId)
    if (!Object.keys(patch).length && !canRepairWorker) return
    await saveMaintenance({ status: 'checking', origin: 'automatic', requestId: randomUUID(),
      sourceSessionId: sessionId, toolEventId: undefined, retryAfter: undefined, outcome: undefined })
  })().catch(error => {
    const detail = error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name
    console.error('Dot 配置检查 · ' + detail)
  }).finally(() => { maintenanceRunning = undefined })
}
let cloudTaskRefresh
const cloudTaskEvents = new Map()

async function cloudThreadStatus(sessionId, threads) {
  if (sessionId === state.sessionId) return events.values()
  const saved = cloudTaskEvents.get(sessionId) || { events: new Map() }
  cloudTaskEvents.set(sessionId, saved)
  const fingerprint = JSON.stringify(threads.map(row => [row.id, row.status, row.updated_at]))
  if (saved.fingerprint === fingerprint) return saved.events.values()
  for await (const event of client.events(sessionId, saved.cursor)) {
    if (event.type.startsWith('session.thread_status_') && event.session_thread_id) {
      saved.events.set(event.session_thread_id, event)
    } else if (event.type === 'agent.thread_message_received' && event.from_session_thread_id) {
      const { type, id, from_session_thread_id, processed_at } = event
      saved.events.set('reply:' + from_session_thread_id, { type, id, from_session_thread_id, processed_at })
    } else if (event.type === 'agent.thread_message_sent' && event.to_session_thread_id) {
      const { type, to_session_thread_id, processed_at } = event
      saved.events.set('sent:' + to_session_thread_id, { type, to_session_thread_id, processed_at })
    }
    saved.cursor = event.id
  }
  saved.fingerprint = fingerprint
  return saved.events.values()
}

function refreshTaskbookCloud() {
  if (!cloudTaskRefresh) {
    const id = state.sessionId
    const tracked = [id, ...earlierDotSessions()]
    cloudTaskRefresh = Promise.allSettled(tracked.map(async sessionId => {
      const threads = await client.listThreads(sessionId)
      const history = await cloudThreadStatus(sessionId, threads)
      taskbook.acceptCloud(sessionId, threads, history)
    })).then(async results => {
      if (results.some(result => result.status === 'fulfilled')) await taskbook.persist()
      if (results[0].status === 'rejected') throw results[0].reason
    }).finally(() => { cloudTaskRefresh = undefined })
  }
  return cloudTaskRefresh
}

function earlierDotSessions() {
  if (!migration) return []
  return [...new Set([migration, ...(migration.history || [])].filter(job => job.stage === 'ready')
    .flatMap(job => [job.sourceSessionId, job.targetSessionId]))].filter(id => id && id !== state.sessionId)
}

async function updateEntry(session, activeId) {
  const title = entryTitle(session, activeId, site, historyEntries[session.id])
  if (session.title === title) return
  const updated = await client.updateSessionTitle(session.id, title)
  if (updated.id !== session.id || updated.title !== title) {
    throw new Error('QCA 未确认会话入口配置。')
  }
}

function syncHistoryEntries() {
  if (syncingEntries || mutating || migrationRun || maintenanceRunning || cloudConnection !== 'connected' ||
    serviceSignal.signal.aborted || Date.now() < nextEntryCheck) return
  const id = state.sessionId
  const tracked = [id, ...earlierDotSessions()]
  nextEntryCheck = Date.now() + 60_000
  syncingEntries = Promise.allSettled(tracked.map(async sessionId => {
    const session = await client.getSession(sessionId)
    if (session.metadata?.source !== 'qoder-dot-demo' || session.archived_at || session.status === 'terminated' ||
      state.sessionId !== id || mutating || migrationRun || maintenanceRunning) return
    if (session.title !== entryTitle(session, id, site, historyEntries[sessionId])) return session
  })).then(async results => {
    for (const result of results) {
      if (result.status !== 'rejected' || result.reason instanceof MigrationError) continue
      const error = result.reason
      const detail = error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name
      console.error('Dot 历史会话入口 · ' + detail)
    }
    const candidates = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value)
    if (!candidates.length || state.sessionId !== id || mutating || migrationRun || maintenanceRunning || serviceSignal.signal.aborted) return
    const originals = Object.fromEntries(candidates.filter(session => !Object.hasOwn(historyEntries, session.id))
      .map(session => [session.id, { title: session.title }]))
    if (Object.keys(originals).length) {
      const next = { ...historyEntries, ...originals }
      await writeJson(historyEntryFile, next)
      historyEntries = next
    }
    if (state.sessionId === id && !mutating && !migrationRun && !serviceSignal.signal.aborted) {
      const writes = await Promise.allSettled(candidates.map(session => updateEntry(session, id)))
      const failed = writes.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    }
  }).catch(error => {
    const detail = error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name
    console.error('Dot 历史会话入口 · ' + detail)
  }).finally(() => { syncingEntries = undefined })
}

function fullTaskbook() {
  return taskbook.snapshot(state.sessionId, Date.now(), earlierDotSessions())
}

function migrationReceipt(job) {
  const { id, sourceSessionId, sourceAgentId, targetSessionId, agentId, storeId, stage, verifiedEventId, verifiedWorkerEventId, options, access } = job
  return { id, sourceSessionId, sourceAgentId, targetSessionId, agentId, storeId, stage, verifiedEventId, verifiedWorkerEventId, access, name: options.name }
}

function migrationStatus() {
  if (!migration) return { activeSessionId: state.sessionId }
  return { ...migrationReceipt(migration), history: migration.history || [], activeSessionId: state.sessionId,
    running: Boolean(migrationRun), issue: migrationIssue }
}

async function startMigration(body) {
  if (migrationRun) return
  if (body.requestId && body.requestId === migration?.id && migration.stage === 'ready') return
  if (migration?.history?.some(receipt => receipt.id === body.requestId)) return
  if (migration && migration.stage !== 'ready') {
    if (body.resume !== true && body.requestId !== migration.id) throw new HttpError(409, '请先继续已有迁移。')
  } else {
    if (body.resume === true) return
    if (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.requestId)) {
      throw new HttpError(400, '迁移请求 ID 无效。')
    }
    const options = { ...migrationOptions(body), requestId: body.requestId, ...(body.repairWorker && { repairWorker: true }) }
    const session = await idleDotSession(client, state.sessionId)
    const localMemory = options.copyMemory ? await readFile(memoryFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return memoryMarkdown(new Map())
    }) : undefined
    if (localMemory && Buffer.byteLength(localMemory) > 100_000) throw new HttpError(400, '本机记忆超过云端单条记忆的大小限制。')
    const job = createMigration(session, options, localMemory)
    if (migration) job.history = [...(migration.history || []), migrationReceipt(migration)]
    await writeJson(migrationFile, job)
    migration = job
  }
  migrationIssue = undefined
  migrationRun = runMigration({ client, job: migration, save: next => writeJson(migrationFile, next),
    signal: serviceSignal.signal, pause: signal => delay(1500, undefined, { signal }),
  }).then(async () => {
    if (!migration.options.repairWorker || migration.sourceSessionId !== state.sessionId) return
    await switchMigrationSession({ sessionId: migration.targetSessionId }, { finishingMigration: true, repairCutover: true })
    consoleUpdate = { sessionId: state.sessionId, checkedAt: Date.now(), workerReady: true }
  }).catch(error => {
    if (serviceSignal.signal.aborted) return
    migrationIssue = migration.stage === 'ready' ? '新会话已就绪，请在当前会话空闲后切换。'
      : error instanceof MigrationError ? error.message
      : error instanceof QcaError ? 'QCA 暂未完成当前步骤（HTTP ' + error.status + '）。可继续同一个迁移。'
        : '迁移暂时中断。可继续同一个迁移。'
    console.error('Dot 迁移 · ' + migration.id + ' · ' + migration.stage + ' · ' +
      (error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name))
  }).finally(() => { migrationRun = undefined })
}

async function switchMigrationSession({ sessionId }, { finishingMigration = false, repairCutover = false } = {}) {
  const known = migration && [migration, ...(migration.history || [])].some(job =>
    job.stage === 'ready' && [job.sourceSessionId, job.targetSessionId].includes(sessionId))
  if ((migrationRun && !finishingMigration) || migration?.stage !== 'ready' ||
    !known) {
    throw new HttpError(409, '请选择已验证的迁移会话。')
  }
  if (sessionId === state.sessionId) return
  if (syncingEntries) await syncingEntries
  await refresh(true)
  if (phase !== 'idle' || acceptedEvent || commandRun || localDshRun) {
    throw new HttpError(409, '请等当前任务完成后再切换。')
  }
  await idleDotSession(client, state.sessionId)
  const target = await idleDotSession(client, sessionId)
  if (phase !== 'idle' || commandRun || localDshRun) throw new HttpError(409, '当前会话有新任务，稍后再切换。')
  const workerMigrationHeldFor = !repairCutover && !dotWorkerReady(target) ? sessionId : undefined
  await writeJson(stateFile, { ...state, sessionId, agentId: target.agent.id, workerMigrationHeldFor })
  consoleWorker.abort()
  if (refreshPromise) await refreshPromise.catch(() => {})
  if (finishing) await finishing
  state.sessionId = sessionId
  state.agentId = target.agent.id
  state.workerMigrationHeldFor = workerMigrationHeldFor
  nextConfigurationCheck = 0
  nextEntryCheck = 0
  events.clear()
  cursor = undefined
  phase = 'idle'
  pauseIds = []
  lastIssue = ''
  sessionChecked = false
  acceptedEvent = undefined
  stopRequested = undefined
  latestTurnId = undefined
  cloudConnection = 'connecting'
  consoleWorker = new AbortController()
  void watchConsole()
}

async function selectProject({ path, title }) {
  await refresh(true)
  if (phase !== 'idle' || acceptedEvent) throw new HttpError(409, '当前回合结束后才能更换项目。')
  if (path === null) {
    await writeJson(projectFile, null)
    selectedProject = null
    return
  }
  if (typeof path !== 'string' || !isAbsolute(path) || typeof title !== 'string' ||
      !title.trim() || title.length > 100 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)) {
    throw new HttpError(400, '请选择 DSH 里的项目。')
  }
  const canonical = await realpath(path).catch(() => undefined)
  const directory = canonical && await stat(canonical).catch(() => undefined)
  if (!directory?.isDirectory()) throw new HttpError(400, '该项目目录已不可用。')
  const fingerprint = `${directory.dev}:${directory.ino}`
  if (selectedProject?.path === canonical && selectedProject.title === title && selectedProject.fingerprint === fingerprint) return
  const project = { title, path: canonical, fingerprint, identity: `${title} [${randomUUID().slice(0, 8)}]` }
  await writeJson(projectFile, project)
  selectedProject = project
}

async function projectIsCurrent(project) {
  const actual = await realpath(project.path).catch(() => undefined)
  const directory = actual === project.path && await stat(actual).catch(() => undefined)
  return directory?.isDirectory() && `${directory.dev}:${directory.ino}` === project.fingerprint
}

function requireClient() {
  if (!client) throw new HttpError(503, '请在 Mac 配置 QODER_PAT，再重启服务。')
}

async function provision() {
  requireClient()
  if (state.sessionId) return
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeJson(stateFile, state)
  const save = async (field, id) => {
    const updated = { ...state, [field]: id }
    await writeJson(stateFile, updated)
    Object.assign(state, updated)
  }
  const id = state.provisioningId
  let model
  if (!state.agentId) {
    const { data } = await client.listModels()
    const available = data.filter(item => item.is_enabled !== false).map(item => item.id)
    const requested = process.env.QODER_MODEL
    model = requested || (available.includes('auto') ? 'auto' : available[0])
    if (!model || !available.includes(model)) throw new HttpError(400, 'QODER_MODEL 在当前账号不可用。')
  }
  if (!state.environmentId) await save('environmentId', (await client.createEnvironment(`${id}-env`)).id)
  if (model) {
    const modelKey = createHash('sha256').update(model).digest('hex').slice(0, 12)
    await save('agentId', (await client.createAgent(model, `${id}-agent-${modelKey}`)).id)
  }
  if (!state.sessionId) await save('sessionId', (await client.createSession(state.agentId, state.environmentId, `${id}-session`)).id)
}

function ingest(event) {
  if (!event.id) throw new Error('QCA 事件缺少 ID。')
  if (acceptedEvent === event.id) acceptedEvent = undefined
  if (events.has(event.id)) return
  cursor = event.id
  events.set(event.id, event)
  const turnEnded = (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action') ||
    ['session.status_terminated', 'session.deleted'].includes(event.type)
  if (turnEnded || event.type === 'user.interrupt' || event.type === 'user.message') {
    stopRequested = event.type === 'user.interrupt' ? latestTurnId : undefined
    commandRun?.controller.abort()
    commandRun = undefined
    localDshRun?.abort()
  }
  if (event.type === 'user.interrupt') pauseIds = []
  if (event.type === 'user.message') {
    latestTurnId = event.id
    lastIssue = ''
    phase = 'running'
    pauseIds = []
  }
  if (['session.status_running', 'session.status_rescheduled'].includes(event.type)) {
    phase = 'running'
    pauseIds = []
  }
  if (event.type === 'session.status_idle') {
    const waiting = event.stop_reason?.type === 'requires_action'
    phase = waiting ? 'approval' : 'idle'
    pauseIds = waiting && !stopRequested ? event.stop_reason.event_ids || [] : []
  }
  if (event.type === 'session.error') lastIssue = event.error?.message || 'QCA 执行出错。'
  if (['session.status_terminated', 'session.deleted'].includes(event.type)) {
    phase = 'ended'
    pauseIds = []
  }
}

async function refresh(force = false) {
  if (!state.sessionId || !client) return
  if (refreshPromise) return refreshPromise
  if (!force && Date.now() < nextRefresh) return
  refreshPromise = (async () => {
    if (!sessionChecked) {
      const session = await client.getSession(state.sessionId)
      for await (const event of client.events(state.sessionId)) ingest(event)
      if (session.archived_at || session.status === 'terminated') phase = 'ended'
      else if (['running', 'rescheduling'].includes(session.status) && phase !== 'approval') phase = 'running'
      sessionChecked = true
    } else {
      for await (const event of client.events(state.sessionId, cursor)) ingest(event)
    }
    if (acceptedEvent && events.has(acceptedEvent)) acceptedEvent = undefined
    nextRefresh = Date.now() + 1_200
  })()
  try {
    await refreshPromise
  } finally {
    refreshPromise = undefined
  }
}

function approvalRequests() {
  const resolved = new Set([...events.values()]
    .filter(event => event.type === 'user.custom_tool_result')
    .map(event => event.custom_tool_use_id))
  return pauseIds.map(id => events.get(id)).filter(event => event?.type === 'agent.custom_tool_use' && !resolved.has(event.id))
}

function consoleApprovals() {
  const confirmed = new Set([...events.values()].filter(event => event.type === 'user.tool_confirmation')
    .map(event => event.tool_use_id))
  const approvals = approvalRequests().flatMap(event => {
    const questions = event.input?.questions
    if (event.name !== CONSOLE_QUESTION || !Array.isArray(questions) || questions.length !== 1) return []
    const [question] = questions
    if (typeof question?.question !== 'string' || question.multiSelect !== false || !Array.isArray(question.options)) return []
    const choices = question.options.map(option => option?.label)
    if (!choices.length || choices.some(choice => typeof choice !== 'string')) return []
    const expired = question.header === DSH_COMMAND_HEADER && question.question === commandRun?.expiredCommand?.question
    return [{ id: event.id, title: question.header, text: question.question, choices, expired }]
  })
  for (const id of pauseIds) {
    const event = events.get(id)
    if (event?.type === 'agent.tool_use' && event.evaluated_permission === 'ask' && !confirmed.has(id)) {
      approvals.push({ id, title: `Qoder 云端 · ${event.name}`, text: JSON.stringify(event.input, null, 2), choices: ['允许', '拒绝'], native: true })
    }
  }
  return approvals
}

function validLabel(event) {
  const input = event.input
  return event.name === MAC_TOOL && input && Object.keys(input).length === 1 &&
    typeof input.label === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(input.label)
}

function snapshot() {
  const transcript = []
  let activity
  for (const event of events.values()) {
    if (event.type === 'user.message') activity = undefined
    if (['user.interrupt', 'session.status_terminated', 'session.deleted'].includes(event.type)) activity = undefined
    if (event.type === 'agent.custom_tool_use' && event.name === DSH_REVIEW_TOOL) activity = 'Mac DSH 正在审查方案'
    if (event.type === 'agent.custom_tool_use' && [DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL, DSH_CONTINUE_TOOL].includes(event.name)) activity = 'Mac DSH 正在处理'
    if (consoleMode && event.type === 'agent.custom_tool_use' && event.name === CONSOLE_QUESTION) {
      const questions = event.input?.questions
      const text = Array.isArray(questions) && questions.map(question => question?.question).filter(text => typeof text === 'string').join('\n')
      if (text) transcript.push({ id: event.id, type: 'question.card', text })
    }
    const isToolResult = consoleMode && event.type === 'agent.tool_result'
    if (!isToolResult && !['user.message', 'agent.message', 'user.custom_tool_result'].includes(event.type)) continue
    const message = { id: event.id, type: event.type, text: eventText(event) }
    const tool = events.get(event.tool_use_id || event.custom_tool_use_id)
    if (isToolResult && tool?.type === 'agent.custom_tool_use') {
      message.type = 'user.custom_tool_result'
    }
    if (isToolResult && tool?.type === 'agent.tool_use' && tool.name) message.summary = 'Qoder 云端 · ' + tool.name
    if (tool?.name === DOT_TASKBOOK_TOOL) {
      message.type = 'taskbook.result'
      message.summary = 'Dot 任务本'
    }
    if (tool?.name === DOT_MAINTENANCE_TOOL) {
      message.type = 'maintenance.result'
      message.summary = 'Dot 配置维护'
    }
    if (event.type === 'user.custom_tool_result' && events.get(event.custom_tool_use_id)?.name === CONSOLE_QUESTION) {
      message.type = 'question.answer'
    }
    if (event.type === 'user.custom_tool_result' && events.get(event.custom_tool_use_id)?.name === DSH_STATUS_TOOL) {
      message.type = 'dsh.status'
    }
    if (event.type === 'user.custom_tool_result' && events.get(event.custom_tool_use_id)?.name === DOT_MEMORY_TOOL) {
      message.type = 'memory.result'
    }
    if (event.type === 'user.custom_tool_result' && events.get(event.custom_tool_use_id)?.name === DSH_REVIEW_TOOL) {
      message.type = 'dsh.review'
      try {
        const review = JSON.parse(message.text)
        message.summary = { allow: 'Mac 审查通过', consult: 'Mac 建议补充方案', deny: 'Mac 已否决', ask_user: '有待决定的问题' }[review.verdict]
        activity = { allow: review.previewOnly ? '归档预演已审查' : 'Mac 已审查方案', consult: phase === 'idle' ? 'Mac 建议补充方案' : 'Qoder 正在整理审查意见',
          deny: 'Mac 已否决此任务', ask_user: '等你补充决定' }[review.verdict]
      } catch {}
    }
    if (event.type === 'user.custom_tool_result' && [DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL, DSH_CONTINUE_TOOL].includes(events.get(event.custom_tool_use_id)?.name)) {
      if (event.is_error) activity = 'Mac 任务未完成'
      else if (message.text.includes('回执：')) activity = 'Mac 已返回执行回执'
      const receipt = message.text.match(/回执：([a-f0-9]{20})/)?.[1]
      if (receipt) message.summary = 'Mac 回执 · ' + receipt
    }
    if (message.text) transcript.push(message)
  }
  const approvals = consoleMode ? consoleApprovals() : approvalRequests().map(event => ({
    id: event.id,
    label: validLabel(event) ? event.input.label : '',
    canApprove: Boolean(validLabel(event)),
    decision: state.decisions[event.id]?.decision,
  }))
  return {
    mode: mock ? 'mock' : site,
    configured: Boolean(client),
    sessionId: state.sessionId,
    phase: stopRequested ? 'stopping' : acceptedEvent || (phase === 'approval' && approvals.length === 0) ? 'running' : phase,
    turnId: latestTurnId,
    activity,
    messages: transcript,
    approvals,
    consoleMode,
    ...(consoleMode && phase !== 'ended' && { cloudConnection }),
    ...(consoleMode && { migration: migrationStatus(), ...(consoleUpdate?.sessionId === state.sessionId && { consoleUpdate }) }),
    project: selectedProject ? { title: selectedProject.title, path: selectedProject.path } : null,
    issue: lastIssue,
  }
}

async function sendMessage({ text, requestId, sessionId }) {
  requireClient()
  if (!state.sessionId) throw new HttpError(409, '请先创建主会话。')
  if (sessionId !== undefined && sessionId !== state.sessionId) throw new HttpError(409, '面板已切换会话。请确认目标会话后再发送。')
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new HttpError(400, '请输入 1–4000 字。')
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId)) throw new HttpError(400, '消息 ID 无效。')
  await refresh(true)
  if (stopRequested) throw new HttpError(409, '当前轮正在取消。取消完成后可发送，草稿会保留。')
  if (phase === 'approval' && consoleMode && consoleApprovals().length) {
    throw new HttpError(409, '当前轮还有待审批事项。请处理最新审批卡，或取消当前轮后再发送。')
  }
  if (phase !== 'idle' || acceptedEvent) throw new HttpError(409, '主会话忙，请等待当前回合结束。')
  const result = await client.send(state.sessionId, { type: 'user.message', content: textBlocks(text.trim()) }, requestId)
  recordAcceptedEvent(result)
}

async function stopTurn({ turnId }) {
  await refresh(true)
  if (typeof turnId !== 'string' || turnId !== latestTurnId ||
      (phase !== 'running' && phase !== 'approval')) {
    throw new HttpError(409, '当前任务已结束或已切换，请查看会话。')
  }
  if (stopRequested === turnId) return
  stopRequested = turnId
  try {
    const result = await client.send(state.sessionId, { type: 'user.interrupt' }, `dot-stop-${turnId}`)
    recordAcceptedEvent(result)
    if (stopRequested === turnId) {
      commandRun?.controller.abort()
      localDshRun?.abort()
    }
  } catch (error) {
    if (stopRequested === turnId) stopRequested = undefined
    throw error
  }
}

async function recordApproval({ id, decision, choice }) {
  requireClient()
  if (!state.sessionId) throw new HttpError(409, '请先创建主会话。')
  if (typeof id !== 'string') throw new HttpError(400, '审批参数无效。')
  await refresh(true)
  if (consoleMode) {
    const card = consoleApprovals().find(approval => approval.id === id)
    if (!card || stopRequested) throw new HttpError(409, '这张卡片已经处理或不在当前回合。')
    if (!card.choices.includes(choice)) throw new HttpError(400, '请选择卡片上的选项。')
    if (card.expired && choice === '允许') throw new HttpError(409, '这条命令的审批已过期。请结束此卡片，再决定是否重新发起任务。')
    const event = card.native
      ? { type: 'user.tool_confirmation', tool_use_id: id, result: choice === '允许' ? 'allow' : 'deny' }
      : { type: 'user.custom_tool_result', custom_tool_use_id: id, content: textBlocks(questionAnswer(card.text, choice)) }
    const result = await client.send(state.sessionId, event, `dot-card-${id}`)
    recordAcceptedEvent(result)
    return
  }
  if (!['allow', 'deny'].includes(decision)) throw new HttpError(400, '审批参数无效。')
  const event = approvalRequests().find(request => request.id === id)
  if (!event) throw new HttpError(409, '这条审批已结束或不在当前回合。')
  await finishMacRequest(event, decision)
}

async function finishMacRequest(event, decision) {
  const { id } = event
  if (decision === 'allow' && !validLabel(event)) throw new HttpError(400, '仅允许写入格式有效的测试标签。')
  const approval = await saveDecision(id, decision)
  let text = consoleMode ? '这次请求没有匹配的 QCA 审批，Mac 未写入。' : '用户拒绝写入 Mac 测试标记。'
  if (decision === 'allow') {
    await mkdir(markerDir, { recursive: true, mode: 0o700 })
    await writeJson(resolve(markerDir, `${approval.receipt}.json`), {
      receipt: approval.receipt, label: event.input.label, sessionId: state.sessionId, eventId: id, writtenAt: approval.at,
    })
    text = `Mac 已写入测试标记 ${event.input.label}。receipt=${approval.receipt}`
  }
  await returnToolResult(id, approval.receipt, text, decision === 'deny')
}

async function saveDecision(id, decision, runReceipt, expiredFrom) {
  let approval = state.decisions[id]
  if (approval && approval.decision !== decision) throw new HttpError(409, '此审批已有决定，请刷新。')
  if (!approval) {
    const receipt = createHash('sha256').update(`${state.sessionId}:${id}`).digest('hex').slice(0, 20)
    approval = { decision, receipt, at: new Date().toISOString(), ...(runReceipt && { runReceipt }), ...(expiredFrom && { expiredFrom }) }
    const decisions = { ...state.decisions, [id]: approval }
    await writeJson(stateFile, { ...state, decisions })
    state.decisions = decisions
  }
  return approval
}

async function returnToolResult(id, receipt, text, isError) {
  const result = await client.send(state.sessionId, {
    type: 'user.custom_tool_result', custom_tool_use_id: id, content: textBlocks(text), is_error: isError,
  }, `mac-tool-${receipt}`)
  recordAcceptedEvent(result)
  return result.data?.at(-1)?.id
}

function recordAcceptedEvent(result) {
  const id = result.data?.at(-1)?.id
  acceptedEvent = id && !events.has(id) ? id : undefined
}

const serviceSignal = new AbortController()
let consoleWorker = new AbortController()
let commandRun
let localDshRun
let finishing
let finishAgain = false

function startCommandRun(request, identity, cwd) {
  const controller = new AbortController()
  const run = { controller, identity, project: request.project }
  commandRun = run
  void runDshCommandTask(request.task, cwd, AbortSignal.any([consoleWorker.signal, controller.signal]),
    async (command, signal, deadline) => {
      if (run.rejected || run.pending || !validTerminalCommand(command) || blockedTerminalCommand(command)) return false
      if (request.exactCommand) {
        if (run.exactRequested) return false
        run.exactRequested = true
        if (command !== request.exactCommand || (request.project && !(await projectIsCurrent(request.project)))) return false
        return !signal.aborted && Date.now() < deadline && commandRun === run && !stopRequested &&
          approvalRequests().some(event => event.id === identity.eventId)
      }
      return new Promise(resolve => {
        const abort = () => {
          run.interruptedCommand = run.pending
          if (signal.reason?.name === 'TimeoutError') run.expiredCommand = run.pending
          run.pending = undefined
          resolve(false)
        }
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        const code = randomUUID().slice(0, 8)
        const workspace = request.project?.identity || 'Dot 工作区'
        const expires = new Intl.DateTimeFormat('zh-CN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
        }).format(deadline)
        const question = `允许在 Mac 的 ${workspace} 执行以下命令一次吗？ ${command}（审批号 ${code}，截止 ${expires}）`
        run.pending = {
          question,
          decide(allow) {
            signal.removeEventListener('abort', abort)
            const waiting = run.pending === this
            if (waiting) run.pending = undefined
            const timely = !signal.aborted && Date.now() < deadline
            if (waiting && !timely) run.expiredCommand = this
            resolve(waiting && timely && allow)
            return waiting && timely && allow
          },
        }
      })
    }).then(answer => {
      const exactResult = request.exactCommand && answer.commandResults.find(result => result.command === request.exactCommand)
      const completed = !request.exactCommand || exactResult?.status === 'completed'
      return { ...identity, status: completed ? 'completed' : 'failed', dshSessionId: answer.sessionId,
        text: request.exactCommand
          ? exactResult ? undefined : 'DSH 未返回获批命令的执行结果。修改过的命令和额外命令均不会执行。'
          : answer.text,
        approvedCommands: answer.approvedCommands, rejectedCommands: answer.rejectedCommands, commandResults: answer.commandResults }
    },
    error => ({ ...identity, status: controller.signal.aborted || consoleWorker.signal.aborted ? 'cancelled' : 'failed',
      dshSessionId: error.sessionId, ...error.audit }))
    .then(outcome => {
      const interruptedAt = run.interruptedCommand?.relayEventId
      run.outcome = { ...outcome, ...(run.expiredCommand && { status: 'expired' }), resultEventId: run.continueId || identity.eventId,
        ...(interruptedAt && { interruptedAt }) }
      return persistCommandOutcome(run)
    })
    .catch(error => console.error(`QCA DSH 回执保存失败 · ${identity.receipt} · ${error.code || error.name}`))
  return run
}

function persistCommandOutcome(run) {
  run.saving ??= writeJson(resolve(dshRunDir, `${run.identity.receipt}.json`), run.outcome).catch(error => {
    run.saving = undefined
    throw error
  })
  return run.saving
}

async function readCommandOutcome(receipt, resultEventId, interruptedEventId) {
  if (!/^[a-f0-9]{20}$/.test(receipt || '')) return
  const saved = await readFile(resolve(dshRunDir, `${receipt}.json`), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error })
  const matchingResult = saved?.resultEventId === resultEventId && ['completed', 'failed', 'cancelled', 'expired'].includes(saved.status)
  const matchingInterruption = interruptedEventId && saved?.resultEventId === interruptedEventId &&
    (saved.status === 'expired' || (saved.status === 'cancelled' && saved.interruptedAt === interruptedEventId))
  if (saved?.receipt === receipt && saved.qcaSessionId === state.sessionId && saved.commands === true &&
      (matchingResult || matchingInterruption)) {
    return saved
  }
}

function findInterruptedCommand(target) {
  if (!emptyToolInput(target)) return
  let announcement
  for (const event of events.values()) {
    if (event.id === target.id) break
    if (event.type === 'user.message' || event.type === 'user.interrupt' ||
        (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action')) announcement = undefined
    if (event.type !== 'user.custom_tool_result') continue
    const source = events.get(event.custom_tool_use_id)
    if (![DSH_TOOL, DSH_CONTINUE_TOOL].includes(source?.name)) continue
    announcement = undefined
    if (event.is_error) continue
    const decision = state.decisions[source.id]
    const receipt = source.name === DSH_TOOL ? decision?.receipt : decision?.runReceipt
    if (!receipt) continue
    let payload
    try {
      payload = JSON.parse(eventText(event))
    } catch {
      continue
    }
    if (payload?.status === 'pending_command' && typeof payload.approvalQuestion === 'string') {
      announcement = { receipt, question: payload.approvalQuestion, announcedId: event.id, relayEventId: source.id }
    }
  }
  if (announcement && ['允许', '拒绝'].some(label =>
    approvedDshCommand(events.values(), target, state.decisions, announcement, label))) return announcement
}

async function relayCommandRun(run, eventId, receipt) {
  while (!run.pending && !run.outcome) await delay(100)
  if (stopRequested || !approvalRequests().some(item => item.id === eventId)) return
  const pending = run.pending || (run.expiredCommand?.relayEventId === eventId && run.expiredCommand)
  if (pending) {
    const message = pending.relayText || JSON.stringify({ status: 'pending_command', approvalQuestion: pending.question })
    pending.relayEventId = eventId
    pending.relayText = message
    pending.announcedId = await returnToolResult(eventId, receipt, message, false)
    return
  }
  await persistCommandOutcome(run)
  if (stopRequested || !approvalRequests().some(item => item.id === eventId)) return
  await returnCommandOutcome(eventId, receipt, run.outcome)
  if (commandRun === run) commandRun = undefined
}

async function returnCommandOutcome(eventId, receipt, outcome) {
  if (stopRequested || !approvalRequests().some(item => item.id === eventId)) return
  const completed = outcome.status === 'completed'
  const evidence = (outcome.commandResults || []).map(result =>
    `${result.status === 'completed' ? '执行完成' : '执行失败'} · ${result.command}\n${result.output}`).join('\n\n').slice(0, 2500)
  const status = outcome.status === 'expired' ? 'Mac 终端审批已过期，等待批准的命令未执行。'
    : outcome.status === 'cancelled' && outcome.interruptedAt ? 'Mac 终端任务已中断，等待批准的命令未执行。'
    : completed ? 'Mac DSH 任务结束。' : 'Mac DSH 任务已中止或失败。'
  const text = [
    status, outcome.dshSessionId && `DSH 会话 ID：${outcome.dshSessionId}`, `回执：${outcome.receipt}`,
    outcome.review?.dshSessionId && `Mac DSH 独立审查：${outcome.review.dshSessionId}`,
    Number.isInteger(outcome.approvedCommands) && `命令批准 ${outcome.approvedCommands} 条，拒绝 ${outcome.rejectedCommands} 条。`,
    evidence, outcome.text,
  ].filter(Boolean).join('\n')
  await returnToolResult(eventId, receipt, text, !completed)
}

function emptyToolInput(event) {
  return event.input && typeof event.input === 'object' && !Array.isArray(event.input) &&
    Object.keys(event.input).length === 0
}

async function reviewLocalProposal(proposal) {
  if (blockedTerminalCommand(proposal.command || proposal.task)) {
    return { verdict: 'deny', reason: 'Mac 拦截递归删除和破坏磁盘等操作。' }
  }
  const user = events.get(latestTurnId)
  if (!user) return { verdict: 'ask_user', reason: '缺少本轮用户任务。' }
  const history = [...events.values()]
  const before = history.findIndex(event => event.id === user.id)
  const context = proposal.inventory || proposal.mode === 'existing_dsh_session' ? [] : history.slice(0, before).filter(event => ['user.message', 'agent.message'].includes(event.type))
    .slice(-4).map(event => ({ role: event.type === 'user.message' ? 'user' : 'qoder', text: eventText(event).slice(0, 700) }))
  await mkdir(dshWorkDir, { recursive: true, mode: 0o700 })
  const controller = new AbortController()
  localDshRun = controller
  try {
    return await reviewDshTask({ userRequest: eventText(user).slice(0, 4000), context, ...proposal }, dshWorkDir,
      AbortSignal.any([consoleWorker.signal, controller.signal]))
  } catch {
    return { verdict: 'consult', reason: 'Mac DSH 暂未给出可核验的审查结果。' }
  } finally {
    if (localDshRun === controller) localDshRun = undefined
  }
}

async function finishDshRequest(event, request) {
  const { id } = event
  const { receipt } = await saveDecision(id, request ? 'allow' : 'deny')
  if (!request) {
    const text = [DSH_DIRECT_TOOL, DSH_CLOCK_TOOL].includes(event.name)
      ? '未通过本轮原文校验，Mac 上的 DSH 未运行。'
      : '没有有效的本轮 Mac 审批，Mac 上的 DSH 未运行。'
    await returnToolResult(id, receipt, text, true)
    return
  }
  const cwd = request.project?.path || (request.workspace ? dshWorkspaceDir : dshWorkDir)
  await mkdir(dshRunDir, { recursive: true, mode: 0o700 })
  if (request.project && !(await projectIsCurrent(request.project))) {
    await returnToolResult(id, receipt, '授权项目目录已变化，请在 Mac 重新选择项目。', true)
    return
  }
  if (!request.project) await mkdir(cwd, { recursive: true, mode: 0o700 })
  const path = resolve(dshRunDir, `${receipt}.json`)
  const identity = { receipt, qcaSessionId: state.sessionId, eventId: id, workspace: request.workspace,
    ...(request.project && { project: request.project.identity }) }
  if (commandRun?.identity.eventId !== id) {
    const prior = await readFile(path, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!prior) {
      const review = await reviewLocalProposal({ task: request.task, command: request.exactCommand,
        workspace: request.project?.identity || 'Dot 工作区', mode: request.exactCommand ? 'exact' : request.commands ? 'terminal_with_approval' : request.workspace ? 'workspace' : 'text' })
      if (stopRequested || !approvalRequests().some(item => item.id === id)) return
      identity.review = review
      if (review.verdict !== 'allow') {
        await writeJson(path, { ...identity, status: 'not_run' })
        await returnToolResult(id, receipt, JSON.stringify({ status: 'not_run', receipt, ...review }), true)
        return
      }
    } else if (prior.status === 'not_run' && prior.review) {
      await returnToolResult(id, receipt, JSON.stringify({ status: 'not_run', receipt, ...prior.review }), true)
      return
    }
  }
  if (stopRequested || !approvalRequests().some(item => item.id === id)) return
  if (request.commands) {
    if (commandRun?.identity.eventId === id) return relayCommandRun(commandRun, id, receipt)
    if (commandRun) {
      await returnToolResult(id, receipt, 'Mac 已有一项终端任务，请先完成该任务。', true)
      return
    }
    try {
      await writeFile(path, JSON.stringify({ ...identity, commands: true, status: 'started' }), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const outcome = await readCommandOutcome(receipt, id)
      if (outcome) return returnCommandOutcome(id, receipt, outcome)
      await returnToolResult(id, receipt, `这项终端任务曾启动，请核对本地回执。回执：${receipt}`, true)
      return
    }
    return relayCommandRun(startCommandRun(request, { ...identity, commands: true }, cwd), id, receipt)
  }
  let outcome
  try {
    outcome = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(path, JSON.stringify({ ...identity, status: 'started' }), { flag: 'wx', mode: 0o600 })
    const controller = new AbortController()
    localDshRun = controller
    try {
      const answer = await runDsh(request.task, cwd, AbortSignal.any([consoleWorker.signal, controller.signal]), request.workspace)
      outcome = { ...identity, status: 'completed', dshSessionId: answer.sessionId, text: answer.text }
    } catch (error) {
      console.error(`QCA DSH 运行失败 · ${receipt} · ${error.code || error.name}`)
      outcome = { ...identity, status: controller.signal.aborted ? 'cancelled' : 'failed' }
    } finally {
      localDshRun = undefined
    }
    await writeJson(path, outcome)
  }
  const completed = outcome.status === 'completed'
  const text = completed
    ? [`Mac 上的 DSH 已完成。DSH 会话 ID：${outcome.dshSessionId}`, `回执：${receipt}`,
      ...(outcome.review?.dshSessionId ? [`Mac DSH 独立审查：${outcome.review.dshSessionId}`] : []), '', outcome.text].join('\n')
    : `Mac 上的 DSH 未返回结果，请重新提交任务并审批。回执：${receipt}`
  if (!stopRequested && outcome.status !== 'cancelled' && approvalRequests().some(item => item.id === id)) {
    await returnToolResult(id, receipt, text, !completed)
  }
}

function isArchivePreviewTurn(userText) {
  if (archiveRequest(userText)) return true
  if (!archiveDateReply(userText)) return false
  const history = [...events.values()]
  const earlier = history.slice(0, history.findIndex(event => event.id === latestTurnId))
  const previous = earlier.findLastIndex(event => event.type === 'user.message')
  return previous >= 0 && archiveRequest(eventText(earlier[previous])) &&
    earlier.slice(previous + 1).some(event => {
      if (event.type !== 'user.custom_tool_result' || events.get(event.custom_tool_use_id)?.name !== DSH_REVIEW_TOOL) return false
      try {
        const result = JSON.parse(eventText(event))
        return result?.previewOnly && result.verdict === 'ask_user' && result.cutoff === null
      } catch {
        return false
      }
    })
}

async function refreshDshFollowups(signal) {
  const pending = Object.values(taskbook.followups).filter(item =>
    ['sending', 'queued', 'running', 'waiting', 'unconfirmed'].includes(item.status))
  pending.sort((a, b) => (a.pollAttemptAt || 0) - (b.pollAttemptAt || 0))
  const pollAttemptAt = Date.now()
  await Promise.all(pending.slice(0, 12).map(async item => {
    item.pollAttemptAt = pollAttemptAt
    try {
      const observed = await readFollowup(dshWeb, item, signal)
      Object.assign(item, observed, { checkedAt: Date.now() })
    } catch {
      // Retain the last observed status and time when the host cannot be reached.
    }
  }))
}

async function finishDshFollowup(event, user) {
  const lookup = emptyToolInput(event) && user && dshFollowupResultIntent(eventText(user))
  if (lookup) {
    const sessions = new Set([state.sessionId, ...earlierDotSessions()])
    const item = Object.values(taskbook.followups).find(entry => entry.receipt === lookup && sessions.has(entry.cloudSessionId))
    const { receipt } = await saveDecision(event.id, item ? 'allow' : 'deny')
    if (!item) return returnToolResult(event.id, receipt, JSON.stringify({ status: 'unknown_receipt', receipt: lookup }), true)
    const signal = AbortSignal.any([consoleWorker.signal, AbortSignal.timeout(8000)])
    let observed
    try {
      observed = await readFollowup(dshWeb, item, signal, { includeResult: true })
    } catch {}
    const result = { sessionId: item.sessionId, receipt: lookup, status: item.status, checkedAt: item.checkedAt }
    if (observed?.finishedAtSeq !== undefined || !['completed', 'cancelled', 'failed'].includes(item.status) && observed) {
      Object.assign(result, observed, { checkedAt: Date.now() })
    }
    if (!result.result && result.status === 'completed') result.output = 'not_found_in_recent_history'
    return returnToolResult(event.id, receipt, JSON.stringify(result), false)
  }
  const intent = emptyToolInput(event) && user && dshFollowupIntent(eventText(user))
  const existing = user && taskbook.followups[user.id]
  const approved = state.decisions[event.id]?.decision
  const valid = Boolean(intent && !turnHasLocalVeto(event))
  const reply = (receipt, status, extra, isError = false) =>
    returnToolResult(event.id, receipt, JSON.stringify({ status, ...extra }), isError)
  if (!valid || approved === 'deny') {
    const { receipt } = await saveDecision(event.id, approved || 'deny')
    await reply(receipt, intent ? 'session_not_available' : 'explicit_session_and_task_required', undefined, true)
    return
  }
  const { receipt } = await saveDecision(event.id, 'allow')
  if (existing) {
    await reply(receipt, existing.status, { sessionId: existing.sessionId, receipt: existing.receipt })
    return
  }
  const findTarget = async () => {
    const signal = AbortSignal.any([consoleWorker.signal, AbortSignal.timeout(8000)])
    const items = await dshWeb.eligibleSessions(signal)
    return items.find(item => item.sessionId === intent.sessionId)
  }
  const target = await findTarget().catch(() => undefined)
  if (!approvalRequests().some(item => item.id === event.id) || stopRequested || latestTurnId !== user.id) return
  if (!target) return reply(receipt, 'session_not_available', undefined, true)
  const review = await reviewLocalProposal({ task: intent.task, workspace: target.projections?.values.title || target.sessionId,
    mode: 'existing_dsh_session' })
  if (!approvalRequests().some(item => item.id === event.id) || stopRequested || latestTurnId !== user.id) return
  if (review.verdict !== 'allow') {
    await reply(receipt, 'not_sent', { review }, true)
    return
  }
  const currentTarget = await findTarget().catch(() => undefined)
  const signal = AbortSignal.any([consoleWorker.signal, AbortSignal.timeout(8000)])
  const current = currentTarget && await dshWeb.state(intent.sessionId, signal).catch(() => undefined)
  if (!approvalRequests().some(item => item.id === event.id) || stopRequested || latestTurnId !== user.id) return
  if (!current) return reply(receipt, 'session_not_available', undefined, true)
  const requestId = randomUUID()
  const item = { sessionId: intent.sessionId, requestId, receipt, cloudSessionId: state.sessionId,
    status: 'sending', createdAt: Date.now(), checkedAt: Date.now(), startCursor: current.cursor }
  taskbook.followups[user.id] = item
  try {
    await taskbook.persist()
  } catch (error) {
    delete taskbook.followups[user.id]
    throw error
  }
  if (!approvalRequests().some(pending => pending.id === event.id) || stopRequested || latestTurnId !== user.id) {
    item.status = 'cancelled'
    await taskbook.persist()
    return
  }
  try {
    const promptSignal = AbortSignal.any([consoleWorker.signal, AbortSignal.timeout(8000)])
    const result = await dshWeb.prompt(intent.sessionId, requestId, intent.task, promptSignal)
    item.status = result.accepted === true ? 'queued' : 'unconfirmed'
  } catch {
    item.status = 'unconfirmed'
  }
  item.checkedAt = Date.now()
  await taskbook.persist()
  if (approvalRequests().some(pending => pending.id === event.id) && !stopRequested) {
    await reply(receipt, item.status, { sessionId: intent.sessionId, receipt }, item.status === 'unconfirmed')
  }
}

async function finishConsoleRequest() {
  const event = approvalRequests().find(request => [MAC_TOOL, DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL, DSH_CONTINUE_TOOL, DSH_PROJECTS_TOOL, DSH_REVIEW_TOOL, DSH_STATUS_TOOL, DOT_MEMORY_TOOL, DOT_TASKBOOK_TOOL, DOT_MAINTENANCE_TOOL, DOT_DSH_FOLLOWUP_TOOL].includes(request.name))
  if (!event || acceptedEvent || stopRequested) return
  const user = events.get(latestTurnId)
  const userText = user ? eventText(user) : ''
  if (event.name === DOT_MAINTENANCE_TOOL) {
    const intent = emptyToolInput(event) && maintenanceIntent(userText)
    const { receipt } = await saveDecision(event.id, intent ? 'allow' : 'deny')
    const current = maintenanceStatus().status
    if (intent === 'repair' && maintenance?.requestId !== user.id &&
      !['queued', 'checking', 'migrating', 'ready_to_switch'].includes(current)) {
      await saveMaintenance({ status: 'queued', origin: 'chat', requestId: user.id, sourceSessionId: state.sessionId,
        toolEventId: event.id, retryAfter: undefined, outcome: undefined })
    }
    const result = intent ? maintenanceStatus() : { status: 'explicit_maintenance_request_required' }
    await returnToolResult(event.id, receipt, JSON.stringify(result), !intent)
    return
  }
  if (event.name === DOT_DSH_FOLLOWUP_TOOL) return finishDshFollowup(event, user)
  const searchQuery = dshSearchIntent(userText)
  if ((dshFollowupIntent(userText) || dshFollowupResultIntent(userText) || searchQuery) &&
    [DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL, DSH_CONTINUE_TOOL, MAC_TOOL].includes(event.name)) {
    const existing = state.decisions[event.id]?.decision
    const { receipt } = await saveDecision(event.id, existing || 'deny')
    await returnToolResult(event.id, receipt, JSON.stringify({ status: 'existing_dsh_session_required' }), true)
    return
  }
  if (event.name === DOT_TASKBOOK_TOOL) {
    const query = emptyToolInput(event) && searchQuery
    if (query) {
      const { receipt } = await saveDecision(event.id, 'allow')
      const signal = AbortSignal.any([consoleWorker.signal, AbortSignal.timeout(8000)])
      const matches = await dshWeb.eligibleSessions(signal).then(items => matchDshSessions(items, query)).catch(() => undefined)
      if (stopRequested || latestTurnId !== user.id || !approvalRequests().some(item => item.id === event.id)) return
      return returnToolResult(event.id, receipt, JSON.stringify(matches || { status: 'dsh_catalog_unavailable' }), !matches)
    }
    const intent = emptyToolInput(event) && taskbookIntent(userText)
    const { receipt } = await saveDecision(event.id, intent ? 'allow' : 'deny')
    if (intent === 'cloud') {
      const refreshed = await refreshTaskbookCloud().then(() => true, () => false)
      const { cloudFresh, cloudCheckedAt, tasks } = taskbook.snapshot(state.sessionId)
      const cloud = tasks.filter(task => task.provider === 'qca')
      const current = refreshed && cloudFresh
      await returnToolResult(event.id, receipt, JSON.stringify({ cloudFresh: current, cloudCheckedAt,
        total: current ? cloud.length : null, tasks: current ? cloud.slice(0, 15) : [] }), false)
      return
    }
    const { tasks, followups, ...status } = fullTaskbook()
    const counts = Object.fromEntries(['dsh', 'qca'].map(provider => [provider, tasks.filter(task => task.provider === provider).length]))
    const result = intent ? { ...status, total: tasks.length, counts, ...(intent === 'list' && { tasks: tasks.slice(0, 15), followups }) }
      : { status: 'explicit_taskbook_request_required' }
    await returnToolResult(event.id, receipt, JSON.stringify(result), !intent)
    return
  }
  const archiveTurn = isArchivePreviewTurn(userText)
  if (archiveTurn && event.name !== DSH_REVIEW_TOOL) {
    const { receipt } = await saveDecision(event.id, 'deny')
    await returnToolResult(event.id, receipt, JSON.stringify({ status: 'preview_only' }), true)
    return
  }
  if (event.name === DOT_MEMORY_TOOL) {
    const intent = emptyToolInput(event) && memoryIntent(userText)
    const { receipt } = await saveDecision(event.id, intent ? 'allow' : 'deny')
    if (!intent) {
      await returnToolResult(event.id, receipt, JSON.stringify({ status: 'explicit_request_required' }), true)
      return
    }
    const entries = await readMemory(memoryFile)
    const before = memoryMarkdown(entries)
    const result = applyMemory(entries, intent, user.id)
    const after = memoryMarkdown(entries)
    if (before !== after) {
      if (stopRequested || latestTurnId !== user.id || !approvalRequests().some(item => item.id === event.id)) return
      const temp = memoryFile + '.' + randomUUID() + '.tmp'
      await writeFile(temp, after, { mode: 0o600 })
      await rename(temp, memoryFile)
    }
    await returnToolResult(event.id, receipt, JSON.stringify(result), false)
    return
  }
  if (![DSH_PROJECTS_TOOL, DSH_STATUS_TOOL].includes(event.name) && turnHasLocalVeto(event)) {
    const { receipt } = await saveDecision(event.id, 'deny')
    await returnToolResult(event.id, receipt, JSON.stringify({ verdict: 'deny', reason: 'Mac 已拒绝本轮任务。' }), true)
    return
  }
  if (event.name === DSH_REVIEW_TOOL) {
    const { task, workspace, preview, cutoff } = event.input || {}
    const archive = preview === 'archive_reports' || archiveTurn
    const valid = typeof task === 'string' && task.trim() && task.length <= 1000 && ['dot', 'project'].includes(workspace) &&
      (!archive || (workspace === 'dot' && archiveTurn && (cutoff === undefined || cutoff === archiveCutoff(userText))))
    const { receipt } = await saveDecision(event.id, valid ? 'allow' : 'deny')
    const history = [...events.values()]
    const turn = history.findLastIndex(item => item.id === latestTurnId)
    const attempts = history.slice(turn + 1).filter(item => item.type === 'agent.custom_tool_use' && item.name === DSH_REVIEW_TOOL)
    const result = !valid ? { verdict: 'ask_user', reason: '审查方案缺少明确的任务或工作区。' }
      : attempts.indexOf(event) >= 2 ? { verdict: 'ask_user', reason: '本轮审查仍未解决范围问题。' }
      : archive ? await reviewArchiveProposal(task, userText)
      : workspace === 'project' && (!selectedProject || !(await projectIsCurrent(selectedProject)))
        ? { verdict: 'ask_user', reason: '请在 Mac 选择要操作的 DSH 项目。' }
        : await reviewLocalProposal({ task, workspace: workspace === 'project' ? selectedProject.identity : 'Dot 工作区', mode: 'review_only' })
    if (approvalRequests().some(item => item.id === event.id) && !stopRequested) {
      await returnToolResult(event.id, receipt, JSON.stringify(result), !valid)
    }
    return
  }
  if (event.name === DSH_CLOCK_TOOL) {
    const request = emptyToolInput(event) ? requestedMacClock(events.values(), event, state.decisions) : undefined
    await finishDshRequest(event, request)
    return
  }
  if (event.name === DSH_STATUS_TOOL) {
    const valid = emptyToolInput(event)
    const { receipt } = await saveDecision(event.id, valid ? 'allow' : 'deny')
    const result = valid ? await latestDshStatus(event.processed_at) : { status: 'invalid_request' }
    await returnToolResult(event.id, receipt, JSON.stringify(result), !valid)
    return
  }
  if (event.name === DSH_PROJECTS_TOOL) {
    const valid = emptyToolInput(event)
    const { receipt } = await saveDecision(event.id, valid ? 'allow' : 'deny')
    const text = valid && selectedProject && await projectIsCurrent(selectedProject)
      ? JSON.stringify({ project: selectedProject.identity })
      : '当前没有用户在 Mac 授权的 DSH 项目。'
    await returnToolResult(event.id, receipt, text, !valid)
    return
  }
  if (event.name === DSH_CONTINUE_TOOL) {
    const run = commandRun
    const interrupted = run ? undefined : findInterruptedCommand(event)
    const card = run?.pending || run?.expiredCommand
    if (card && !card.announcedId && card.relayEventId) {
      const announcement = [...events.values()].find(item => item.type === 'user.custom_tool_result' &&
        item.custom_tool_use_id === card.relayEventId &&
        eventText(item) === card.relayText)
      card.announcedId = announcement?.id
    }
    const existing = state.decisions[event.id]
    const projectCurrent = !run?.project || await projectIsCurrent(run.project)
    const pending = run?.pending
    const cardCurrent = commandRun === run && emptyToolInput(event) && card?.announcedId
    const matchedAllow = cardCurrent && approvedDshCommand(events.values(), event, state.decisions, card)
    const approved = Boolean(!stopRequested && projectCurrent && pending === card && matchedAllow)
    const matchedAnswer = matchedAllow || (cardCurrent &&
      approvedDshCommand(events.values(), event, state.decisions, card, '拒绝'))
    const expiredFromEvent = matchedAnswer ? card.relayEventId : interrupted?.relayEventId
    const { receipt, runReceipt, expiredFrom } = await saveDecision(event.id, existing?.decision || (approved ? 'allow' : 'deny'),
      run && (pending || expiredFromEvent) ? run.identity.receipt : interrupted?.receipt, expiredFromEvent)
    if (stopRequested || !approvalRequests().some(item => item.id === event.id)) return
    if (run && expiredFromEvent && card === run.expiredCommand && commandRun === run) {
      while (!run.outcome) await delay(100)
      await persistCommandOutcome(run)
      await returnCommandOutcome(event.id, receipt, run.outcome)
      if (commandRun === run) commandRun = undefined
      return
    }
    if (!run || (!pending && run.continueId !== event.id)) {
      const outcome = await readCommandOutcome(runReceipt, event.id, expiredFrom)
      if (outcome) return returnCommandOutcome(event.id, receipt, outcome)
      if (runReceipt) {
        const reason = interrupted ? 'Mac 已无法继续这张终端审批卡。' : 'Mac 未能恢复这项终端任务。'
        await returnToolResult(event.id, receipt, `${reason}请核对本地回执：${runReceipt}`, true)
        return
      }
      await returnToolResult(event.id, receipt, '没有对应的 Mac 终端审批。任务未继续。', true)
      return
    }
    if (run.continueId !== event.id) {
      run.continueId = event.id
      const allow = pending?.decide(approved && !stopRequested && commandRun === run)
      if (!allow) run.rejected = true
    }
    return relayCommandRun(run, event.id, receipt)
  }
  if (event.name === DSH_TOOL || event.name === DSH_DIRECT_TOOL) {
    const request = event.name === DSH_DIRECT_TOOL
      ? directlyRequestedDshTask(events.values(), event, state.decisions, selectedProject)
      : emptyToolInput(event) ? approvedDshTask(events.values(), event, state.decisions, selectedProject) : undefined
    await finishDshRequest(event, request)
    console.log(`QCA DSH 工具 · ${state.decisions[event.id].decision} · ${event.id} · ${state.decisions[event.id].receipt}`)
    return
  }
  const approved = validLabel(event) && consoleApproves(events.values(), event, state.decisions,
    `允许在 Mac 写入测试标记 ${event.input.label} 吗？`)
  const existing = state.decisions[event.id]
  if (approved && !existing) {
    const review = await reviewLocalProposal({ task: `写入 demo 测试标记 ${event.input.label}`,
      workspace: 'demo 专用标记目录', mode: 'workspace' })
    if (stopRequested || !approvalRequests().some(item => item.id === event.id)) return
    if (review.verdict !== 'allow') {
      const { receipt } = await saveDecision(event.id, 'deny')
      await returnToolResult(event.id, receipt, JSON.stringify({ status: 'not_run', receipt, ...review }), true)
      return
    }
  }
  const decision = existing?.decision || (approved ? 'allow' : 'deny')
  await finishMacRequest(event, decision)
  console.log(`QCA Mac 工具 · ${decision} · ${event.id} · ${state.decisions[event.id].receipt}`)
}

async function reviewArchiveProposal(task, userText) {
  let preview
  try {
    preview = await previewArchive(dshWorkspaceDir, archiveCutoff(userText))
  } catch {
    return { verdict: 'consult', reason: 'Mac 无法读取归档预演样本。', previewOnly: true }
  }
  const assessment = await reviewLocalProposal({ task, workspace: 'Dot 工作区的合成报告样本',
    mode: 'review_only', inventory: preview,
    reviewScope: '只读预演。保留同名目标，冲突源留原处，排除非报告。日期缺失时只问日期；日期已明确且有清单时，核对候选和冲突。' })
  return { ...assessment, ...preview }
}

function turnHasLocalVeto(target) {
  const history = [...events.values()]
  const start = history.findLastIndex(event => event.id === latestTurnId)
  for (const event of history.slice(start + 1)) {
    if (event.id === target.id) break
    if (event.type !== 'user.custom_tool_result') continue
    const source = events.get(event.custom_tool_use_id)
    if (![DSH_REVIEW_TOOL, DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL, DOT_DSH_FOLLOWUP_TOOL, MAC_TOOL].includes(source?.name)) continue
    let result
    try {
      result = JSON.parse(eventText(event))
    } catch {
      continue
    }
    if (result?.verdict === 'deny' || result?.review?.verdict === 'deny') return true
  }
  return false
}

async function latestDshStatus(checkedAt) {
  const history = [...events.values()]
  const index = history.findLastIndex(event =>
    event.type === 'agent.custom_tool_use' && [DSH_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL].includes(event.name))
  if (index < 0) return { status: 'no_task' }
  const task = history[index]
  const { decision, receipt } = state.decisions[task.id] || {}
  if (decision === 'deny') return { status: 'not_run', toolEventId: task.id }
  const laterEvents = history.slice(index + 1)
  const endedAt = laterEvents.findIndex(event => event.type === 'user.message' || event.type === 'user.interrupt' ||
    (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action'))
  const end = laterEvents[endedAt]
  const lastEvent = end || laterEvents.at(-1)
  if (!/^[a-f0-9]{20}$/.test(receipt || '')) return { status: 'unverified', toolEventId: task.id }
  const record = await readFile(resolve(dshRunDir, `${receipt}.json`), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (record?.receipt !== receipt || record.qcaSessionId !== state.sessionId || record.eventId !== task.id) {
    return { status: 'unverified', receipt, toolEventId: task.id }
  }
  const result = {
    status: record.status === 'started' && end ? 'unverified' : record.status,
    receipt, toolEventId: task.id, dshSessionId: record.dshSessionId,
    checkedAt, lastTurnEventAt: lastEvent?.processed_at,
  }
  if (record.commands) {
    result.completedCommands = (record.commandResults || []).filter(command => command.status === 'completed').length
    result.failedCommands = (record.commandResults || []).filter(command => command.status === 'failed').length
    result.approvedCommands = record.approvedCommands
    result.rejectedCommands = record.rejectedCommands
  }
  return result
}

function queueConsoleRequest() {
  if (consoleWorker.signal.aborted) return
  const { signal } = consoleWorker
  if (finishing) {
    finishAgain = true
    return
  }
  finishing = finishConsoleRequest().catch(async error => {
    if (signal.aborted) return
    const message = error instanceof QcaError || error instanceof HttpError ? error.message : error.code || error.name
    console.error(`QCA 工具回传失败 · ${message}`)
    await delay(2500, undefined, { signal }).catch(() => {})
    finishAgain = true
  }).finally(() => {
    finishing = undefined
    if (finishAgain) {
      finishAgain = false
      queueConsoleRequest()
    }
  })
}

async function watchConsole() {
  const { signal } = consoleWorker
  let lastError
  let retryDelay = 2_500
  while (!signal.aborted && phase !== 'ended') {
    try {
      await refresh(true)
      queueConsoleRequest()
      if (phase === 'ended') return
      for await (const event of client.stream(state.sessionId, cursor, signal, () => {
        cloudConnection = 'connected'
        lastError = undefined
        retryDelay = 2_500
      })) {
        if (signal.aborted) return
        ingest(event)
        if (event.type === 'session.updated' && !maintenanceRunning && !mutating) nextConfigurationCheck = 0
        if (event.type === 'session.status_idle' || event.type === 'user.custom_tool_result') {
          queueConsoleRequest()
        }
        if (phase === 'ended') return
      }
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof QcaError || error instanceof HttpError ? error.message : error.code || error.name
      if (message !== lastError) console.error(`QCA 事件连接 · ${message}`)
      lastError = message
    }
    cloudConnection = 'reconnecting'
    await delay(retryDelay, undefined, { signal }).catch(() => {})
    retryDelay = Math.min(retryDelay * 2, 30_000)
  }
}

function startBridgeHeartbeat() {
  const publish = bridgeHeartbeat(client)
  let lastError
  let lastTaskbookError
  let publishedTaskbookSession
  let nextTaskbookPublish = 0
  let publishingTaskbook
  const tick = () => {
    runQueuedMaintenance()
    checkManagedConfiguration()
    syncHistoryEntries()
    const id = state.sessionId
    const connected = () => !serviceSignal.signal.aborted && state.sessionId === id &&
      cloudConnection === 'connected' && phase !== 'ended'
    const now = Date.now()
    if (connected() && !publishingTaskbook && (publishedTaskbookSession !== id || now >= nextTaskbookPublish)) {
      const record = offlineTaskbook(taskbook, id, earlierDotSessions(), now)
      if (record.mac.counts || record.qca.current !== null) {
        publishedTaskbookSession = id
        nextTaskbookPublish = now + 120_000
        publishingTaskbook = publishStatus(client, id, offlineTaskbookPath, record).then(() => { lastTaskbookError = undefined })
          .catch(error => {
            nextTaskbookPublish = Date.now() + 30_000
            const detail = error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name
            if (detail !== lastTaskbookError) console.error('Dot 离线任务本 · ' + detail)
            lastTaskbookError = detail
          }).finally(() => { publishingTaskbook = undefined })
      }
    }
    if (maintenance && connected() && !publishingMaintenance) {
      const record = maintenanceStatus()
      const key = JSON.stringify([id, record])
      if (publishedMaintenance !== key) {
        publishingMaintenance = publishStatus(client, id, maintenancePath, record).then(() => { publishedMaintenance = key })
          .catch(() => {}).finally(() => { publishingMaintenance = undefined })
      }
    }
    void publish(id, connected).then(() => { lastError = undefined }).catch(error => {
      const detail = error instanceof QcaError ? 'HTTP ' + error.status : error.code || error.name
      if (detail !== lastError) console.error('Dot 在线状态 · ' + detail)
      lastError = detail
    })
  }
  const timer = setInterval(tick, 10_000)
  timer.unref()
  serviceSignal.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}

async function readJson(req, limit = 20_000) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > limit) throw new HttpError(413, '请求过大。')
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data
  } catch {
    throw new HttpError(400, '请求格式无效。')
  }
}

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/markdown.js', ['markdown.js', 'text/javascript']],
  ['/vendor/markdown-it.mjs', ['node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', 'text/javascript']],
])
const postRoutes = new Map([['/api/start', provision], ['/api/message', sendMessage], ['/api/approval', recordApproval]])
if (consoleMode) {
  postRoutes.set('/api/project', selectProject)
  postRoutes.set('/api/stop', stopTurn)
  postRoutes.set('/api/migration', ({ repairWorker, ...body }) => startMigration(body))
  postRoutes.set('/api/migration/switch', switchMigrationSession)
  postRoutes.set('/api/settings/update-agent', updateDotConsole)
}
const originsByHost = new Map([
  [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
  [`localhost:${port}`, `http://localhost:${port}`],
])
const remoteKey = consoleMode ? undefined : process.env.DOT_REMOTE_KEY
const remotePort = consoleMode ? 0 : Number(process.env.DOT_REMOTE_PORT || 0)
const remoteKeyExpiresAt = Date.now() + 60 * 60 * 1000
if ((remoteKey || remotePort) && (!process.env.DOT_HTTPS_ORIGIN || !/^[A-Za-z0-9_-]{43}$/.test(remoteKey || '') ||
    !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535 || remotePort === port)) {
  throw new Error('测试链接需要 HTTPS 来源、独立的 DOT_REMOTE_PORT 和 32 字节的 base64url 随机凭据。')
}
const digestKey = key => createHash('sha256').update(key).digest()
const remoteKeyHash = remoteKey && digestKey(remoteKey)
let remoteOrigin
if (!consoleMode && process.env.DOT_HTTPS_ORIGIN) {
  const url = new URL(process.env.DOT_HTTPS_ORIGIN)
  if (url.protocol !== 'https:' || url.href !== `${url.origin}/`) {
    throw new Error('DOT_HTTPS_ORIGIN 须为单一 HTTPS 来源，例 https://demo.example.com。')
  }
  if (remotePort) remoteOrigin = url
  else originsByHost.set(url.host, url.origin)
}
async function handleRequest(req, res) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const frameOrigin = consoleMode ? 'http://127.0.0.1:3080 http://localhost:3080 dsh-app://app' : "'none'"
  res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'none'; frame-ancestors ${frameOrigin}; form-action 'self'`)
  try {
    const remote = req.socket.localPort === remotePort
    const origin = remote
      ? req.headers.host === remoteOrigin.host && remoteOrigin.origin
      : originsByHost.get(req.headers.host)
    if (!origin) throw new HttpError(403, '此访问地址未配置。')
    const path = new URL(req.url, 'http://localhost').pathname
    if (remote && path.startsWith('/api/')) {
      const supplied = req.headers['x-dot-access-key']
      if (Date.now() >= remoteKeyExpiresAt || typeof supplied !== 'string' ||
          !timingSafeEqual(remoteKeyHash, digestKey(supplied))) {
        throw new HttpError(401, '测试链接缺少有效凭据或已过期，请打开完整的测试链接。')
      }
    }
    const asset = assets.get(path)
    if (req.method === 'GET' && asset) {
      const content = await readFile(resolve(root, asset[0]))
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` })
      return res.end(content)
    }
    if (req.method === 'GET' && path === '/api/state') {
      if (!consoleMode) await refresh()
      return json(200, snapshot())
    }
    if (consoleMode && req.method === 'POST' && path === '/api/taskbook/local') {
      if (req.headers.origin || req.headers['sec-fetch-site'] || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        throw new HttpError(403, '仅接收本机 DSH 宿主的会话状态。')
      }
      if (!taskbook.acceptLocal(await readJson(req, 64_000))) throw new HttpError(400, '会话状态格式无效。')
      await taskbook.persist()
      return json(200, { ok: true })
    }
    if (consoleMode && req.method === 'GET' && ['/api/memory', '/api/taskbook'].includes(path)) {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest' || (req.headers.origin && req.headers.origin !== origin)) {
        throw new HttpError(403, '请从本机 Dot 面板查看记忆。')
      }
      return json(200, path === '/api/taskbook' ? fullTaskbook() : { entries: [...(await readMemory(memoryFile)).values()] })
    }
    const action = req.method === 'POST' && postRoutes.get(path)
    if (!action) throw new HttpError(404, '页面不存在。')
    if (consoleMode && path === '/api/start') throw new HttpError(409, '已连接现有 Qoder 主会话。')
    if (req.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(403, '请求必须来自 demo 页面。')
    }
    const body = await readJson(req)
    if (consoleMode && phase !== 'ended' && cloudConnection !== 'connected') {
      throw new HttpError(503, '正在重新连接 Qoder。连接恢复后可继续操作。')
    }
    if (mutating || (maintenanceRunning && ['/api/migration', '/api/migration/switch', '/api/settings/update-agent'].includes(path))) {
      throw new HttpError(409, 'Dot 正在提交或核对配置，请稍后再试。')
    }
    mutating = true
    try {
      await action(body)
      nextRefresh = 0
      return json(200, snapshot())
    } finally {
      mutating = false
    }
  } catch (error) {
    const status = error.status || 502
    const message = error instanceof HttpError || error instanceof MigrationError || error instanceof QcaError ? error.message : '连接或保存失败，请重试。'
    return json(status, { error: message })
  }
}
const server = createServer(handleRequest)
const remoteServer = remotePort ? createServer(handleRequest) : undefined
server.listen(port, '127.0.0.1', () => console.log(`${dotName} · ${mock ? '模拟网关' : site} · http://127.0.0.1:${port}`))
remoteServer?.listen(remotePort, '127.0.0.1', () => console.log(`${dotName} · HTTPS 转发端口 ${remotePort}`))
if (consoleMode) {
  void watchConsole()
  startBridgeHeartbeat()
  if (!process.env.DOT_DISABLE_THREAD_POLL) {
    let readingDsh = false
    const poll = () => {
      void refreshTaskbookCloud().catch(() => {})
      if (readingDsh) return
      readingDsh = true
      const signal = AbortSignal.any([serviceSignal.signal, AbortSignal.timeout(8500)])
      void dshWeb.list(signal).then(async report => {
        await refreshDshFollowups(signal)
        if (taskbook.acceptLocal(report)) await taskbook.persist()
      }).catch(() => {}).finally(() => { readingDsh = false })
    }
    void poll()
    const timer = setInterval(poll, 15_000)
    timer.unref()
    serviceSignal.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    serviceSignal.abort()
    consoleWorker.abort()
    mockGateway?.close()
    server.close()
    remoteServer?.close()
  })
}
