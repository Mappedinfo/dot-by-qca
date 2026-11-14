import { blockedTerminalCommand } from './task-review.mjs'

export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(execution =>
    execution.name === 'bash' ? undefined : 'Only individually approved Bash commands are available in this session.'))
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name !== 'bash') return next()
    const input = execution.arguments
    if (!input || typeof input.command !== 'string' || !input.command.trim() ||
        Object.keys(input).some(key => !['command', 'timeoutMs', 'description', 'workdir'].includes(key)) ||
        (input.workdir !== undefined && input.workdir !== '.' && input.workdir !== process.cwd())) {
      return { kind: 'deny', reason: 'Use a foreground command in the Dot workspace without permission overrides.' }
    }
    if (blockedTerminalCommand(input.command)) {
      return { kind: 'deny', reason: 'Dot blocks recursive deletion and destructive disk operations.' }
    }
    const policy = await next()
    if (policy.kind !== 'allow') return policy
    return { kind: 'ask', reason: 'Approve this exact command once on the Mac.' }
  })
}
