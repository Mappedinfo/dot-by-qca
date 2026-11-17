import { CONSOLE_QUESTION, DSH_CLOCK_TOOL, DSH_COMMAND_HEADER, DSH_COMMAND_PREFIX, DSH_CONTINUE_TOOL, DSH_DIRECT_TOOL, DSH_EXACT_COMMAND_HEADER, DSH_EXACT_COMMAND_PREFIX, DSH_EXACT_PROJECT_PREFIX, DSH_PROJECT_PREFIX, DSH_QUESTION_PREFIX, DSH_WORKSPACE_PREFIX, DSH_TOOL, MAC_TOOL } from './qca.mjs'

const localTools = [MAC_TOOL, DSH_TOOL, DSH_CONTINUE_TOOL, DSH_DIRECT_TOOL, DSH_CLOCK_TOOL]
const directRequest = /^(?:请\s*)?(?:(?:帮我|麻烦你)\s*)?(?:让\s*(?:D(?:SH)?|DeepSeek Harness)\s*)?在\s*(Mac(?:\s*(?:的\s*)?Dot\s*工作区|\s*上)?|本机|当前项目|这个项目)\s*(?:的?\s*终端\s*)?(?:执行|运行|跑(?:一下)?)\s*[：:]?\s*(.+)$/iu
const commandSuffix = /^(?:[。！]|[，。]\s*(?:(?:然后|并)\s*)?(?:(?:把|将)\s*(?:实际)?(?:输出|结果)\s*(?:发|传|回传|返回|给)(?:回|给|来|我)*|(?:返回|回传|报告|告诉我)\s*(?:实际)?(?:输出|结果))[。！]?)?$/u
const receiptSuffix = /^[，,]\s*(?:把|将)\s*(?:实际)?(?:输出|结果)\s*(?:和|与|及|、)\s*回执\s*(?:发回|传回|回传|返回)(?:\s*(?:这条|当前|同一条)会话|来|给我)?[。！]?$/u
const clockSubject = String.raw`(?:这台\s*)?(?:Mac(?:\s*(?:本机|那边|上|的电脑))?|本机)(?:\s*的)?`
const clockValue = String.raw`(?:(?:现在|当前)\s*)?(?:几点(?:了|钟)?|什么时间|日期(?:[、，和与及]\s*时间)?(?:[、，和与及]\s*时区)?|时间(?:[、，和与及]\s*时区)?|时区)`
const clockVerb = '(?:看(?:一下|看)?|查(?:一下|查|询|看)?|读取|告诉我)'
const clockRequest = new RegExp(`^(?:请\\s*)?(?:(?:帮我|麻烦你)\\s*)?(?:让\\s*(?:D(?:SH)?)\\s*)?(?:${clockVerb}\\s*(?:在\\s*)?${clockSubject}\\s*${clockValue}|${clockSubject}\\s*${clockValue}(?:\\s*是(?:什么|多少))?)[？?。！!]?$`, 'iu')

export function questionAnswer(question, label) {
  return `User has answered your questions: "${question}"="${label}". You can now continue with the user’s answers in mind.`
}

function endsTurn(event) {
  return event.type === 'user.interrupt' ||
    (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action')
}

export function approvedDshTask(events, target, decisions, project) {
  return approvedValue(events, target, decisions, (question, userMessage) => {
    if (question.header === DSH_EXACT_COMMAND_HEADER) {
      const projectPrefix = project && `${DSH_EXACT_PROJECT_PREFIX}${project.identity} · `
      const inProject = Boolean(projectPrefix && question.question.startsWith(projectPrefix))
      const prefix = inProject ? projectPrefix : DSH_EXACT_COMMAND_PREFIX
      if (!question.question.startsWith(prefix)) return
      const command = question.question.slice(prefix.length)
      if (!validTerminalCommand(command) || command.trim() !== command ||
          !userMessage.content?.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.includes(command))) return
      return exactDshTask(command, inProject ? project : undefined)
    }
    if (question.header !== 'Mac DSH') return
    const projectPrefix = project && `${DSH_PROJECT_PREFIX}${project.identity} · `
    if (projectPrefix && question.question.startsWith(projectPrefix)) {
      const task = question.question.slice(projectPrefix.length)
      if (validTask(task)) return { task, workspace: true, commands: true, project }
      return
    }
    const prefix = [DSH_QUESTION_PREFIX, DSH_WORKSPACE_PREFIX, DSH_COMMAND_PREFIX].find(value => question.question.startsWith(value))
    if (!prefix) return
    const task = question.question.slice(prefix.length)
    if (validTask(task)) {
      return { task, workspace: prefix !== DSH_QUESTION_PREFIX, commands: prefix === DSH_COMMAND_PREFIX }
    }
  })
}

function exactDshTask(command, project) {
  const task = `在当前工作目录通过终端工具逐字执行下面这一条命令一次。不要修改、加前缀或运行其他命令。报告实际执行结果。\n${command}`
  return { task, workspace: true, commands: true, exactCommand: command, ...(project && { project }) }
}

export function directlyRequestedDshTask(events, target, decisions, project) {
  const command = target.input?.command
  if (typeof command !== 'string' || Object.keys(target.input).length !== 1 ||
      !validTerminalCommand(command) || command.trim() !== command) return
  const text = directUserText(events, target, decisions)
  const match = text && directRequest.exec(text)
  if (!match) return
  const [, location, requested] = match
  const quoted = requested.startsWith('`')
  const literal = quoted ? '`' + command + '`' : command
  if (!requested.startsWith(literal)) return
  const suffix = requested.slice(literal.length)
  if (!commandSuffix.test(suffix) && !receiptSuffix.test(suffix)) return
  if (!quoted && /[^\x20-\x7e]/u.test(command)) return
  const inProject = ['当前项目', '这个项目'].includes(location)
  if (inProject && !project) return
  return exactDshTask(command, inProject ? project : undefined)
}

export function requestedMacClock(events, target, decisions) {
  const text = directUserText(events, target, decisions)
  if (text && clockRequest.test(text)) return exactDshTask("/bin/date '+%Y-%m-%d %H:%M:%S %Z (UTC%z)'")
}

export function misplacedMacClockProbe(events, target, decisions) {
  return target.type === 'agent.tool_use' && target.name === 'Bash' && target.evaluated_permission === 'ask' &&
    typeof target.input?.command === 'string' && /^(?:\/bin\/)?date[ \t]+-u[ \t]+\+%s$/u.test(target.input.command.trim()) &&
    Boolean(requestedMacClock(events, target, decisions))
}

function directUserText(events, target, decisions) {
  let message
  let attempted = false
  let reachedTarget = false
  for (const event of events) {
    if (event.type === 'user.message' || endsTurn(event)) {
      if (reachedTarget) return
      message = event.type === 'user.message' ? event : undefined
      attempted = false
    }
    if (reachedTarget && event.type === 'session.thread_status_idle' && event.stop_reason?.type === 'requires_action' &&
        event.stop_reason.event_ids?.includes(target.id)) {
      if (attempted || (message?.session_thread_id && message.session_thread_id !== event.session_thread_id)) return
      const [block] = message?.content || []
      if (message?.content?.length !== 1 || block?.type !== 'text' || typeof block.text !== 'string') return
      return block.text.trim()
    }
    if (reachedTarget && event.type === 'session.status_idle') return
    if (event.id === target.id) reachedTarget = true
    else if (!reachedTarget && event.type === 'agent.custom_tool_use' &&
        (event.name === CONSOLE_QUESTION || (localTools.includes(event.name) && decisions[event.id]?.decision === 'allow'))) attempted = true
  }
}

export function validTerminalCommand(command) {
  return Boolean(command.trim()) && command.length <= 1000 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)
}

function validTask(task) {
  return task.trim() && task.length <= 500 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(task)
}

export function approvedDshCommand(events, target, decisions, pending, label = '允许') {
  return Boolean(approvedValue(events, target, decisions, question =>
    question.header === DSH_COMMAND_HEADER && question.question === pending.question, pending.announcedId, label))
}

export function consoleApproves(events, target, decisions, expectedQuestion) {
  return Boolean(approvedValue(events, target, decisions, question => question.question === expectedQuestion))
}

function approvedValue(events, target, decisions, readQuestion, afterId, label = '允许') {
  let userMessage
  let approval
  let reachedTarget = false
  let after = !afterId
  const questions = new Map()
  for (const event of events) {
    if (reachedTarget) {
      if (event.type === 'session.thread_status_idle' && event.stop_reason?.type === 'requires_action' &&
          event.stop_reason.event_ids?.includes(target.id)) {
        return approval && event.session_thread_id === approval.thread ? approval.value : undefined
      }
      if (event.type === 'session.status_idle' || event.type === 'user.message' || event.type === 'user.interrupt') {
        return
      }
      continue
    }
    if (event.id === target.id) {
      reachedTarget = true
      continue
    }
    if (event.id === afterId) after = true
    if (event.type === 'user.message' || endsTurn(event)) {
      questions.clear()
      approval = undefined
      userMessage = event.type === 'user.message' ? event : undefined
    }
    if (event.type === 'agent.custom_tool_use') {
      if (localTools.includes(event.name) && decisions[event.id]?.decision === 'allow') {
        approval = undefined
        if (event.name === DSH_DIRECT_TOOL || event.name === DSH_CLOCK_TOOL) userMessage = undefined
      }
      if (!after || !userMessage || event.name !== CONSOLE_QUESTION || !Array.isArray(event.input?.questions) ||
          event.input.questions.length !== 1) continue
      const [question] = event.input.questions
      if (typeof question?.question === 'string' && question.multiSelect === false &&
          Array.isArray(question.options) && question.options.length === 2 &&
          question.options[0]?.label === '允许' && question.options[1]?.label === '拒绝') {
        const value = readQuestion(question, userMessage)
        if (value) {
          const answer = questionAnswer(question.question, label)
          questions.set(event.id, { value, answer })
        }
      }
    }
    if (event.type === 'session.thread_status_idle' && event.stop_reason?.type === 'requires_action') {
      for (const id of event.stop_reason.event_ids || []) {
        const question = questions.get(id)
        if (question) question.thread = event.session_thread_id
      }
    }
    if (event.type === 'user.custom_tool_result' && questions.has(event.custom_tool_use_id)) {
      const question = questions.get(event.custom_tool_use_id)
      questions.delete(event.custom_tool_use_id)
      const block = event.content?.length === 1 ? event.content[0] : undefined
      approval = question.thread && question.thread === event.session_thread_id && !event.is_error &&
        block?.type === 'text' && block.text === question.answer ? question : undefined
    }
  }
}
