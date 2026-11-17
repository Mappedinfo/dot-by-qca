import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFile } from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { configureQcaProxy } from '../src/qca.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
loadEnvFile(join(root, '.env'))
configureQcaProxy()
const site = process.env.QODER_SITE || 'global'
const token = process.env.QODER_PAT || process.env.QODER_ACCESS_TOKEN
if (!token || !['global', 'cn'].includes(site)) throw new Error('缺少 QCA 站点配置。')
const base = site === 'cn' ? 'https://api.qoder.com.cn' : 'https://api.qoder.com'
const manifest = join(root, '.dot-state', site, 'consultation-skill.json')
const skillDir = join(root, 'skills')
const name = 'dot-task-consultation'
const hash = createHash('sha256').update(await readFile(join(skillDir, name, 'SKILL.md'))).digest('hex')
const previous = await readFile(manifest, 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error
})
if (previous?.hash === hash) {
  console.log(previous.skill_id, previous.version)
} else {
  const temp = await mkdtemp(join(tmpdir(), 'dot-skill-'))
  try {
    const archive = join(temp, 'skill.zip')
    await promisify(execFile)('/usr/bin/zip', ['-X', archive, name + '/SKILL.md'], { cwd: skillDir })
    const form = new FormData()
    form.append('files', new Blob([await readFile(archive)], { type: 'application/zip' }), 'dot-task-consultation.zip')
    const path = previous ? '/skills/' + encodeURIComponent(previous.skill_id) + '/versions' : '/skills'
    const response = await fetch(base + '/api/v1/cloud' + path, {
      method: 'POST', body: form, signal: AbortSignal.timeout(25000),
      headers: { Authorization: 'Bearer ' + token, 'Idempotency-Key': 'dot-consultation-' + hash },
    })
    if (!response.ok) throw new Error('QCA 技能上传 HTTP ' + response.status)
    const result = await response.json()
    const id = previous?.skill_id || result.id
    const version = String(result.latest_version || result.version || '')
    if (!/^skill_[a-z0-9]+$/i.test(id || '') || !/^\d+$/.test(version)) throw new Error('QCA 未确认技能版本。')
    await writeFile(manifest, JSON.stringify({ type: 'custom', skill_id: id, version, hash }) + '\n', { mode: 0o600 })
    console.log(id, version)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
