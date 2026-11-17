export const taskVerdicts = ['allow', 'consult', 'deny', 'ask_user']

export function blockedTerminalCommand(command) {
  const words = command.match(/[A-Za-z0-9_./-]+/g) || []
  for (const [index, word] of words.entries()) {
    const program = word.split('/').at(-1)
    if (['mkfs', 'newfs', 'shred', 'srm'].includes(program) || /^(?:mkfs|newfs)[._]/.test(program)) return true
    if (program === 'diskutil' && words.slice(index + 1).some(arg => /^(?:erase|partition|secureErase)/i.test(arg))) return true
    if (program === 'rm') {
      const args = words.slice(index + 1)
      if (args.some(arg => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg))) return true
    }
  }
  return false
}
