import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const inject = ['tools']
const allowed = ['read', 'write', 'edit']

export function apply(ctx) {
  const root = realpathSync(process.cwd())
  ctx.effect(() => ctx.tools.guard(execution => {
    if (!allowed.includes(execution.name)) return 'This workspace only provides read, write, and edit.'
    const path = execution.arguments?.file_path
    if (typeof path !== 'string' || !path.trim() || path.startsWith('~') || path.split(sep).includes('..')) {
      return 'Specify a file inside the approved workspace without home or parent shortcuts.'
    }
    const target = resolve(root, path)
    const subpath = relative(root, target)
    if (!subpath || isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`)) {
      return 'The path must be inside the approved workspace.'
    }
    for (let current = target; current !== root; current = dirname(current)) {
      try {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) ||
            (current === target && !stat.isFile()) || (current !== target && !stat.isDirectory())) {
          return 'Use regular files and directories inside the approved workspace.'
        }
      } catch (error) {
        if (error.code !== 'ENOENT') return 'Could not verify the workspace path.'
      }
    }
  }))
}
