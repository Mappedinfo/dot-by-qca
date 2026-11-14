import { markdownContent } from './markdown.js'

const byId = id => document.getElementById(id)
const ui = Object.fromEntries([
  'status', 'stop', 'session-id', 'cloud-link', 'project-picker', 'project', 'notice', 'start', 'transcript', 'approvals', 'composer', 'message', 'send', 'issue', 'reload',
  'chat-tab', 'memory-tab', 'chat-view', 'memory-view', 'memory-entries', 'task-status',
  'settings-tab', 'settings-view', 'migration-form', 'migration-name', 'migration-handoff', 'migration-memory',
  'migration-result', 'migration-status', 'migration-active', 'migration-source', 'migration-target',
  'migration-create', 'migration-resume', 'migration-switch', 'migration-error', 'migration-access', 'migration-history',
  'project-status', 'project-error',
  'tasks-tab', 'tasks-view', 'tasks-status', 'tasks-list',
  'followups-heading', 'followups-list',
  'migration-worker',
  'update-agent', 'update-agent-status',
].map(id => [id, byId(id)]))
const names = {
  'user.message': '我',
  'agent.message': 'Dot by QCA',
  'question.answer': '确认记录',
  'question.card': '历史审批',
  'memory.result': '记忆操作',
  'dsh.status': 'Mac 任务状态',
  'dsh.review': 'Mac 独立审查',
  'agent.tool_result': 'Qoder 云端工具',
  'user.custom_tool_result': 'Mac 操作回执',
}
const phases = { idle: '可发送', running: '处理中', approval: '等待审批', stopping: '正在停止', ended: '会话已结束' }
let state
let working = false
let actionVersion = 0
let syncError
let actionError
let draft
const renderedMessages = new Set()
let readingPosition
let renderedSessionId
let migrationRequestId
let renderedMigrations
let approvalSignature = ''
let projects = new Map()
let projectChoices = ''
let projectCatalog
let pendingProject
let projectError
let taskbookRefresh
let renderedTasks
let dshParentOrigin

const linkKey = new URLSearchParams(location.hash.slice(1)).get('access')
if (linkKey && /^[A-Za-z0-9_-]{43}$/.test(linkKey)) {
  sessionStorage.setItem('qoder-dot-access', linkKey)
  history.replaceState(null, '', location.pathname + location.search)
}
const accessKey = sessionStorage.getItem('qoder-dot-access')
const draftKey = 'qoder-dot-draft'
function loadDraft(sessionId) {
  const key = sessionId ? draftKey + ':' + sessionId : draftKey
  draft = undefined
  try { draft = JSON.parse(sessionStorage.getItem(key) || 'null') } catch {}
  ui.message.value = draft?.text || ''
}
function storeDraft(sessionId) {
  const key = sessionId ? draftKey + ':' + sessionId : draftKey
  if (draft) sessionStorage.setItem(key, JSON.stringify(draft))
  else sessionStorage.removeItem(key)
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function browserRequestError(message, code) {
  return Object.assign(new Error(message), { code })
}

async function request(path, body) {
  const options = {
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(body === undefined ? 20_000 : 50_000),
  }
  if (accessKey) options.headers['X-Dot-Access-Key'] = accessKey
  if (body !== undefined) {
    options.method = 'POST'
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(path, options)
  } catch {
    const message = body === undefined
      ? '暂时无法读取会话，页面会自动重试。'
      : '提交结果未确认。请先查看对话或审批状态，再决定是否重试。'
    throw browserRequestError(message, 'network')
  }
  const json = response.headers.get('content-type')?.includes('application/json')
  if (response.type === 'opaqueredirect' || (!json && [401, 403].includes(response.status))) {
    throw browserRequestError('此页面的登录状态未通过验证。请重新打开页面，在 Safari 中完成登录。', 'login')
  }
  if (!json) throw browserRequestError(`测试入口返回异常（HTTP ${response.status}）。请重新打开页面。`, 'gateway')
  let result
  try {
    result = await response.json()
  } catch {
    throw browserRequestError('响应未完整接收，请检查页面上的会话状态。', 'network')
  }
  if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）。`)
  return result
}

function renderApprovals(approvals) {
  const disabled = actionsUnavailable() || state?.phase === 'stopping'
  const signature = JSON.stringify([approvals, disabled])
  if (approvalSignature === signature) return
  approvalSignature = signature
  ui.approvals.replaceChildren(...approvals.map(approval => {
    const card = element('article', '', 'approval')
    if (approval.choices) {
      card.append(element('h3', approval.title || '待确认'), element('p', approval.text))
      if (approval.expired) card.append(element('p', '审批已过期。请结束此卡片，再决定是否重新发起任务。', 'issue'))
      const actions = element('div', '', 'actions')
      for (const choice of approval.choices) {
        const label = approval.expired && choice === '拒绝' ? '结束审批' : choice
        const button = element('button', label, choice === '拒绝' ? 'secondary' : undefined)
        button.type = 'button'
        button.disabled = disabled || (approval.expired && choice === '允许')
        button.addEventListener('click', () => submit('/api/approval', { id: approval.id, choice }))
        actions.append(button)
      }
      card.append(actions)
      return card
    }
    card.append(element('h3', '允许在 Mac 写入测试标记？'))
    card.append(element('p', approval.label ? `标记 · ${approval.label}` : '参数无效，可拒绝此请求。'))
    const actions = element('div', '', 'actions')
    for (const [decision, label] of [['allow', '允许'], ['deny', '拒绝']]) {
      if (approval.decision && approval.decision !== decision) continue
      if (decision === 'allow' && !approval.canApprove) continue
      const button = element('button', approval.decision ? '重发审批结果' : label, decision === 'deny' ? 'secondary' : undefined)
      button.type = 'button'
      button.disabled = disabled
      button.addEventListener('click', () => submit('/api/approval', { id: approval.id, decision }))
      actions.append(button)
    }
    card.append(actions)
    return card
  }))
}

function actionsUnavailable() {
  return working || Boolean(syncError) || ['connecting', 'reconnecting'].includes(state?.cloudConnection)
}

function renderProject(disabled) {
  if (!projectCatalog) return
  const current = state?.project?.path || ''
  const choices = [['', 'Dot 工作区'], ...[...projects.values()].map(({ path, title }) => [path, title])]
  if (current && !projects.has(current)) choices.push([current, state.project.title + '（已选）'])
  if (pendingProject?.path && !choices.some(([path]) => path === pendingProject.path)) {
    choices.push([pendingProject.path, pendingProject.title])
  }
  const signature = JSON.stringify(choices)
  if (signature !== projectChoices) {
    ui.project.replaceChildren(...choices.map(([path, title]) => new Option(title, path)))
    projectChoices = signature
  }
  const displayed = pendingProject ? pendingProject.path || '' : current
  if (ui.project.value !== displayed) ui.project.value = displayed
  const hasChoice = choices.length > 1
  const ready = projectCatalog === 'ready'
  const canReset = !ready && Boolean(current)
  ui.project.disabled = !state || Boolean(pendingProject) || disabled || state.phase !== 'idle' || (!ready && !canReset) || !hasChoice
  for (const option of ui.project.options) {
    option.disabled = Boolean(option.value && (!ready || !projects.has(option.value)))
  }
  ui.project.title = ui.project.selectedOptions[0]?.text || 'Dot 工作区'
  const status = pendingProject ? '正在保存…'
    : projectCatalog === 'loading' ? '正在读取 DSH 项目…'
      : projectCatalog === 'unavailable' ? '暂时无法读取 DSH 项目'
        : current && !projects.has(current) ? '已选项目不在 DSH 列表中'
          : !projects.size ? '在 DSH 中添加项目后可选'
            : state?.sessionId && state.phase !== 'idle' ? '本轮结束后可切换' : ''
  ui['project-status'].textContent = status
  ui['project-status'].hidden = !status
  ui['project-error'].textContent = projectError || ''
  ui['project-error'].hidden = !projectError
}

function cloudUrl(sessionId) {
  const host = state.mode === 'cn' ? 'qoder.com.cn' : 'qoder.com'
  return `https://${host}/cloud/sessions/${encodeURIComponent(sessionId)}`
}

function renderMigration(disabled) {
  const job = state.migration
  ui['settings-tab'].hidden = !job
  if (!job) return
  ui['update-agent'].disabled = disabled || state.phase !== 'idle' || job.running
  const updated = state.consoleUpdate?.sessionId === state.sessionId && state.consoleUpdate
  ui['update-agent-status'].textContent = updated
    ? updated.workerReady ? '已核对当前会话的配置和云端助手'
      : job.running ? '正在准备带网页检索的新会话' : '云端助手待修复，请查看迁移状态'
    : ''
  const pending = job.id && job.stage !== 'ready'
  const labels = { prepared: '正在准备迁移', agent_created: '新 Agent 已创建', store_created: '记忆库已就绪',
    memory_copied: '交接资料已写入', session_created: '新会话已创建', verifying: '正在验证新会话',
    ready: job.verifiedWorkerEventId ? '新会话已验证云端记忆和子线程回执' : '新会话已通过云端记忆验证' }
  ui['migration-result'].hidden = !job.id
  ui['migration-status'].textContent = job.issue || labels[job.stage] || ''
  const isNew = job.activeSessionId === job.targetSessionId
  const isOld = job.activeSessionId === job.sourceSessionId
  ui['migration-active'].textContent = isNew ? '面板当前连接新会话' : isOld ? '面板当前连接旧会话' : '面板当前连接另一条会话'
  ui['migration-source'].href = cloudUrl(job.sourceSessionId)
  ui['migration-target'].hidden = !job.targetSessionId || (pending && job.running)
  if (job.targetSessionId) ui['migration-target'].href = cloudUrl(job.targetSessionId)
  ui['migration-form'].hidden = Boolean(pending)
  ui['migration-create'].disabled = disabled || state.phase !== 'idle'
  ui['migration-resume'].hidden = !pending || job.running
  ui['migration-resume'].disabled = disabled
  ui['migration-switch'].hidden = job.stage !== 'ready'
  ui['migration-switch'].disabled = disabled || state.phase !== 'idle' || job.running
  ui['migration-switch'].textContent = isNew ? '切回旧会话' : '切换到新会话'
  ui['migration-error'].textContent = actionError?.message || ''
  ui['migration-error'].hidden = !actionError
  const lastHistoryId = job.history?.at(-1)?.id
  if (renderedMigrations !== lastHistoryId) {
    const history = ui['migration-history']
    history.hidden = !lastHistoryId
    history.querySelector('ul').replaceChildren(...(job.history || []).slice().reverse().map(receipt => {
      const link = element('a', receipt.name)
      link.href = cloudUrl(receipt.targetSessionId)
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      const item = element('li', '')
      const switchButton = element('button', '切换', 'secondary')
      switchButton.type = 'button'
      switchButton.dataset.session = receipt.targetSessionId
      switchButton.addEventListener('click', () => submit('/api/migration/switch', { sessionId: receipt.targetSessionId }))
      item.append(link, switchButton)
      return item
    }))
    renderedMigrations = lastHistoryId
  }
  for (const button of ui['migration-history'].querySelectorAll('button')) {
    button.disabled = disabled || job.stage !== 'ready' || state.phase !== 'idle' || button.dataset.session === job.activeSessionId
  }
}

function render() {
  const requestError = syncError?.code === 'login' ? syncError : actionError || syncError
  const error = requestError?.message || state?.issue || ''
  ui.issue.textContent = error
  ui.issue.hidden = !error
  ui.reload.hidden = !['login', 'gateway'].includes(requestError?.code)
  if (!state) {
    ui.status.textContent = syncError ? '连接失败' : '正在连接'
    renderProject(true)
    return
  }
  const source = state.mode === 'mock' ? '模拟网关' : `QCA ${state.mode === 'cn' ? '中国站' : '国际站'}`
  const sessionStatus = state.phase === 'approval' && state.approvals.length
    ? `${state.approvals.length} 项待审批` : state.sessionId ? phases[state.phase] : '待创建'
  const connection = syncError ? '本机服务连接失败'
    : { connecting: '正在连接', reconnecting: '正在重连' }[state.cloudConnection] || sessionStatus
  const disabled = actionsUnavailable()
  ui.status.textContent = `${source} · ${connection}`
  ui['memory-tab'].hidden = !state.consoleMode
  ui['tasks-tab'].hidden = !state.consoleMode
  renderMigration(disabled)
  const taskStatus = state.phase === 'approval' && state.approvals.length ? '等待你处理当前卡片'
    : state.phase === 'stopping' ? '正在停止当前轮' : state.activity
  ui['task-status'].textContent = taskStatus || ''
  ui['task-status'].hidden = !taskStatus
  ui.stop.hidden = !state.consoleMode || !state.turnId || !['running', 'approval', 'stopping'].includes(state.phase)
  ui.stop.disabled = disabled || state.phase === 'stopping'
  ui['session-id'].textContent = state.sessionId || ''
  ui.notice.textContent = !state.configured ? '请在 Mac 配置 QCA PAT，再重启服务。'
    : ''
  ui.start.hidden = Boolean(state.sessionId) || !state.configured
  ui.start.disabled = disabled
  ui.composer.hidden = !state.sessionId
  ui.send.disabled = disabled || !state.configured || state.phase !== 'idle'
  ui.send.textContent = working ? '提交中' : '发送'
  renderProject(disabled)

  const transcript = ui.transcript
  if (renderedSessionId !== state.sessionId) {
    if (!renderedSessionId && !sessionStorage.getItem(draftKey + ':' + state.sessionId)) {
      loadDraft()
      storeDraft(state.sessionId)
      sessionStorage.removeItem(draftKey)
    } else loadDraft(state.sessionId)
    transcript.replaceChildren()
    renderedMessages.clear()
    readingPosition = undefined
    renderedSessionId = state.sessionId
  }
  const activeApprovals = new Set(state.approvals.map(approval => approval.id))
  const readingChat = !ui['chat-view'].hidden
  const height = transcript.clientHeight
  const nearBottom = readingChat && transcript.scrollHeight - transcript.scrollTop - height < 40
  const firstRender = renderedMessages.size === 0
  const newMessages = state.messages.filter(message => !renderedMessages.has(message.id))
  for (const message of newMessages) {
    const item = element('article', '', 'message')
    item.dataset.kind = message.type
    if (message.type === 'question.card') item.dataset.approval = message.id
    if (['user.message', 'agent.message'].includes(message.type)) {
      item.append(element('h3', names[message.type]), markdownContent(message.text))
    } else {
      const detail = element('details', '')
      detail.append(element('summary', message.summary || names[message.type] || '操作记录'), element('p', message.text))
      item.append(detail)
    }
    transcript.append(item)
    renderedMessages.add(message.id)
  }
  for (const item of transcript.querySelectorAll('[data-approval]')) item.hidden = activeApprovals.has(item.dataset.approval)
  renderApprovals(state.approvals)
  if (readingChat && (nearBottom || firstRender) && (newMessages.length || height !== transcript.clientHeight)) {
    transcript.scrollTop = transcript.scrollHeight
  }
  if (state.consoleMode && state.sessionId) {
    ui['cloud-link'].href = cloudUrl(state.sessionId)
    ui['cloud-link'].hidden = false
  }
}

function showPage(page) {
  const wasChat = !ui['chat-view'].hidden
  if (wasChat && page !== 'chat') {
    const transcript = ui.transcript
    readingPosition = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40 ? 'latest' : transcript.scrollTop
  }
  for (const name of ['chat', 'tasks', 'memory', 'settings']) {
    ui[name + '-tab'].setAttribute('aria-pressed', String(name === page))
    ui[name + '-view'].hidden = name !== page
  }
  if (page === 'chat' && readingPosition !== undefined) {
    ui.transcript.scrollTop = readingPosition === 'latest' ? ui.transcript.scrollHeight : readingPosition
    readingPosition = undefined
  }
}

async function refreshTaskbook() {
  if (ui['tasks-view'].hidden || taskbookRefresh) return
  taskbookRefresh = request('/api/taskbook')
  try {
    const result = await taskbookRefresh
    const labels = { running: '运行中', waiting: '等你处理', idle: '空闲', archived: '已归档', completed: '已完成',
      failed: '失败', cancelled: '已取消', unknown: '状态未确认' }
    const providers = { dsh: 'Mac DSH', qca: 'QCA' }
    ui['tasks-status'].textContent = [
      result.localFresh ? 'Mac DSH 已同步' : 'Mac DSH 状态待同步',
      result.cloudFresh ? 'QCA 子线程已同步' : 'QCA 子线程状态待同步',
      result.localOmitted ? '显示 ' + result.tasks.length + ' 条，另有更早的 DSH 对话' : result.tasks.length + ' 条',
    ].join(' · ')
    const signature = JSON.stringify([result.tasks, result.followups])
    if (signature === renderedTasks) return
    ui['tasks-list'].replaceChildren(...result.tasks.map(task => {
      const row = element('li', '')
      if (task.provider === 'dsh' && dshParentOrigin) {
        const open = element('button', task.title, 'task-name task-open')
        open.type = 'button'
        open.addEventListener('click', () => window.parent.postMessage({ type: 'qoder-dot/open-session', id: task.id }, dshParentOrigin))
        row.append(open)
      } else if (task.provider === 'qca' && task.cloudSessionId) {
        const link = element('a', task.title, 'task-name')
        link.href = cloudUrl(task.cloudSessionId)
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        row.append(link)
      } else row.append(element('span', task.title, 'task-name'))
      const status = element('span', providers[task.provider] + ' · ' + labels[task.status], 'task-state')
      status.dataset.status = task.status
      const date = new Date(task.updatedAt)
      const time = element('time', date.toLocaleString(), 'task-time')
      time.dateTime = date.toISOString()
      row.append(status, time)
      return row
    }))
    const followups = result.followups || []
    ui['followups-heading'].hidden = !followups.length
    ui['followups-list'].replaceChildren(...followups.map(task => {
      const row = element('li', '')
      const title = result.tasks.find(item => item.id === task.sessionId && item.provider === 'dsh')?.title || task.sessionId
      const label = labels[task.status] || { sending: '正在投递', queued: '已投递', unconfirmed: '状态未确认' }[task.status]
      row.append(element('span', title, 'task-name'), element('span', label, 'task-state'),
        element('code', task.receipt, 'task-time'))
      return row
    }))
    renderedTasks = signature
  } catch (error) {
    ui['tasks-status'].textContent = error.message
  } finally {
    taskbookRefresh = undefined
  }
}

async function showMemory() {
  showPage('memory')
  const entries = ui['memory-entries']
  entries.replaceChildren(element('p', '正在读取本机记忆…'))
  try {
    const result = await request('/api/memory')
    entries.replaceChildren(...result.entries.map(entry => {
      const card = element('article', '')
      card.append(element('h3', entry.key), markdownContent(entry.text),
        element('small', `${entry.category === 'preference' ? '项目偏好' : '已确认决定'} · 来源 ${entry.source}`))
      return card
    }))
    if (!result.entries.length) entries.append(element('p', '还没有保存的记忆。'))
  } catch (error) {
    entries.replaceChildren(element('p', error.message, 'issue'))
  }
}

ui['memory-tab'].addEventListener('click', showMemory)
ui['tasks-tab'].addEventListener('click', () => {
  showPage('tasks')
  void refreshTaskbook()
})
ui['chat-tab'].addEventListener('click', () => showPage('chat'))
ui['settings-tab'].addEventListener('click', () => showPage('settings'))
ui['update-agent'].addEventListener('click', () => submit('/api/settings/update-agent', { sessionId: state.sessionId }))
ui['migration-form'].addEventListener('submit', async event => {
  event.preventDefault()
  migrationRequestId ||= crypto.randomUUID()
  if (await submit('/api/migration', { requestId: migrationRequestId, name: ui['migration-name'].value, handoff: ui['migration-handoff'].value,
    copyMemory: ui['migration-memory'].checked, memoryAccess: ui['migration-access'].value,
    cloudWorker: ui['migration-worker'].checked })) {
    migrationRequestId = undefined
    ui['migration-handoff'].value = ''
    ui['migration-memory'].checked = false
  }
})
ui['migration-form'].addEventListener('input', () => { migrationRequestId = undefined })
ui['migration-resume'].addEventListener('click', () => submit('/api/migration', { resume: true }))
ui['migration-switch'].addEventListener('click', () => {
  const job = state.migration
  return submit('/api/migration/switch', { sessionId: job.activeSessionId === job.targetSessionId ? job.sourceSessionId : job.targetSessionId })
})

async function submit(path, body, onError = error => { actionError = error }) {
  if (working) return false
  actionVersion++
  working = true
  actionError = undefined
  render()
  try {
    state = await request(path, body)
    syncError = undefined
    return true
  } catch (error) {
    onError(error)
    return false
  } finally {
    working = false
    render()
  }
}

async function refresh() {
  const version = actionVersion
  try {
    if (working) return
    const next = await request('/api/state')
    if (version !== actionVersion) return
    state = next
    syncError = undefined
    if (actionError?.code === 'login') actionError = undefined
  } catch (error) {
    if (version === actionVersion) syncError = error
  } finally {
    render()
    void refreshTaskbook()
    setTimeout(refresh, syncError ? 4000 : 1300)
  }
}

ui.start.addEventListener('click', () => submit('/api/start', {}))
ui.reload.addEventListener('click', () => location.reload())
ui.stop.addEventListener('click', () => submit('/api/stop', { turnId: state.turnId }))
const dshOrigins = new Set(['http://127.0.0.1:3080', 'http://localhost:3080', 'dsh-app://app'])
window.addEventListener('message', event => {
  if (window.parent === window || event.source !== window.parent || !dshOrigins.has(event.origin)) return
  if (event.data?.type === 'qoder-dot/session-unavailable') {
    ui['tasks-status'].textContent = '当前 DSH 宿主无法打开该会话。'
    return
  }
  if (event.data?.type !== 'qoder-dot/projects' || !Array.isArray(event.data.items)) return
  if (event.data.canOpenSessions === true && !dshParentOrigin) {
    dshParentOrigin = event.origin
    renderedTasks = undefined
  }
  projects = new Map(event.data.items.filter(item => typeof item?.path === 'string' && item.path &&
    typeof item.title === 'string' && item.title.trim()).map(item => [item.path, item]))
  projectCatalog = ['loading', 'unavailable'].includes(event.data.status) ? event.data.status : 'ready'
  ui['project-picker'].hidden = false
  render()
})
const parentOrigin = location.ancestorOrigins?.[0]
if (dshOrigins.has(parentOrigin)) window.parent.postMessage({ type: 'qoder-dot/ready' }, parentOrigin)
ui.project.addEventListener('change', async () => {
  const value = ui.project.value
  const project = value ? projects.get(value) : { path: null }
  if (!project || ui.project.disabled || (value && projectCatalog !== 'ready')) {
    render()
    return
  }
  projectError = undefined
  pendingProject = project
  await submit('/api/project', project, error => { projectError = error.message })
  pendingProject = undefined
  render()
})
ui.composer.addEventListener('submit', async event => {
  event.preventDefault()
  const text = ui.message.value.trim()
  if (!text || ui.send.disabled) return
  if (draft?.text !== text || !draft.requestId) draft = { text, requestId: crypto.randomUUID() }
  storeDraft(state.sessionId)
  if (await submit('/api/message', { ...draft, sessionId: state.sessionId })) {
    if (ui.message.value.trim() === text) {
      ui.message.value = ''
      draft = undefined
      storeDraft(state.sessionId)
    }
  }
})
ui.message.addEventListener('input', () => {
  if (!ui.message.value.trim()) {
    draft = undefined
    storeDraft(state?.sessionId)
    return
  }
  draft = { text: ui.message.value }
  storeDraft(state?.sessionId)
})

refresh()
