import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('the root launcher serves packaged web assets and saves mock state in the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-startup-test-'))
  const cwd = join(root, 'other-directory')
  let child
  let exited
  try {
    const paths = ['server.mjs', 'package.json', 'src', 'dsh-panel', 'web']
    await Promise.all([
      ...paths.map(path => cp(new URL('../' + path, import.meta.url), join(root, path), { recursive: true })),
      mkdir(cwd),
      symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir'),
    ])
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const { port } = listener.address()
    await new Promise(resolve => listener.close(resolve))
    const origin = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [join(root, 'server.mjs'), '--mock'], {
      cwd, env: { DOT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
    })
    exited = once(child, 'exit')
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })

    const assets = new Map([
      ['/', 'text/html'],
      ['/app.js', 'text/javascript'],
      ['/markdown.js', 'text/javascript'],
      ['/planet.js', 'text/javascript'],
      ['/styles.css', 'text/css'],
      ['/dot-planet.png', 'image/png'],
      ['/vendor/markdown-it.mjs', 'text/javascript'],
    ])
    for (const [path, type] of assets) {
      const response = await fetch(origin + path)
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('content-type').split(';')[0], type, path)
      assert((await response.arrayBuffer()).byteLength > 0, path)
    }
    assert.equal((await fetch(origin + '/src/server.mjs')).status, 404)
    const started = await fetch(origin + '/api/start', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(started.status, 200)
    const { sessionId } = await started.json()
    const stored = JSON.parse(await readFile(join(root, '.dot-state-mock', 'local', 'session.json'), 'utf8'))
    assert(sessionId)
    assert.equal(stored.sessionId, sessionId)
    await assert.rejects(readFile(join(cwd, '.dot-state-mock', 'local', 'session.json')), { code: 'ENOENT' })
  } finally {
    child?.kill('SIGTERM')
    await exited
    await rm(root, { recursive: true, force: true })
  }
})
