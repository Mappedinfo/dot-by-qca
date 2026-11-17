import { lstat, mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const archiveFixture = 'archive-preview-fixture'
export const archiveSamples = [
  ['report-2024.md', '2024-06-12T01:00:00Z'],
  ['report-conflict.md', '2024-08-15T01:00:00Z'],
  ['report-2026.md', '2026-10-01T01:00:00Z'],
  ['notes.txt', '2024-05-03T01:00:00Z'],
  ['archive/report-conflict.md', '2025-06-03T01:00:00Z'],
]

export async function seedArchivePreview(workspace) {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const root = join(workspace, archiveFixture)
  for (const directory of [workspace, root, join(root, 'archive')]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!(await lstat(directory)).isDirectory()) throw new Error('Archive fixture directories are unavailable')
  }
  for (const [relative, time] of archiveSamples) {
    const path = join(root, relative)
    const created = await writeFile(path, '合成样本，仅供 Dot 归档预演。\n', { flag: 'wx', mode: 0o600 })
      .then(() => true).catch(error => {
        if (error.code !== 'EEXIST') throw error
        return false
      })
    if (created) await utimes(path, new Date(time), new Date(time))
  }
  await previewArchive(workspace)
}

export const archiveRequest = text => /^(?:请\s*)?让\s*D(?:SH)?\s*整理(?:一下)?\s*Dot\s*工作区的旧报告(?:\s*[，,。；;：:]\s*[^\n]*)?[。！]?$/iu.test(text.trim())

export const archiveDateReply = text => /^(?:(?:截止)?日期(?:为|是)?\s*)?\d{4}-\d{2}-\d{2}(?:\s*为界)?[。！]?$/.test(text.trim())

export function archiveCutoff(text) {
  const value = text.match(/(?:截止(?:日期)?(?:为|是)?\s*)?(\d{4}-\d{2}-\d{2})(?=\s*(?:之前|以前|为界|[，。！；,;]|$))/u)?.[1]
  const date = value && new Date(value + 'T00:00:00Z')
  return date && Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : undefined
}

export async function previewArchive(workspace, cutoff) {
  const root = join(workspace, archiveFixture)
  const workspaceStat = await lstat(workspace)
  const folder = await lstat(root)
  const archive = await lstat(join(root, 'archive'))
  if (!workspaceStat.isDirectory() || !folder.isDirectory() || !archive.isDirectory()) {
    throw new Error('Archive fixture directories are unavailable')
  }
  const rows = await Promise.all(archiveSamples.map(async ([path]) => {
    const file = await lstat(join(root, path))
    if (!file.isFile() || file.nlink !== 1) throw new Error('Archive fixture is not a regular file')
    const report = path.startsWith('report-') && path.endsWith('.md')
    return { path, type: report ? 'report' : path.startsWith('archive/') ? 'archived_report' : 'other', modifiedAt: file.mtime.toISOString() }
  }))
  const boundary = cutoff && Date.parse(cutoff + 'T00:00:00+08:00')
  const knownPaths = new Set(rows.map(row => row.path))
  const inventory = rows.map(row => {
    const conflict = row.type === 'report' && knownPaths.has('archive/' + row.path)
    const disposition = row.type !== 'report' ? 'excluded' : conflict ? 'keep_in_place' :
      !cutoff ? 'pending_cutoff' : Date.parse(row.modifiedAt) < boundary ? 'candidate' : 'too_recent'
    return { ...row, conflict, disposition }
  })
  return { scope: archiveFixture, previewOnly: true, cutoff: cutoff ?? null, inventory,
    candidates: inventory.filter(row => ['candidate', 'pending_cutoff'].includes(row.disposition)).map(row => row.path) }
}
