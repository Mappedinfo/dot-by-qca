import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveCutoff, archiveDateReply, archiveRequest, previewArchive, seedArchivePreview } from '../src/dot-archive.mjs'
import { applyMemory, memoryIntent, memoryMarkdown, readMemory } from '../src/dot-memory.mjs'

test('archive preview leaves conflicts in place and applies a stated local calendar cutoff', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dot-preview-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await seedArchivePreview(workspace)
  const request = '让 D 整理一下 Dot 工作区的旧报告，截止日期为 2025-01-01，只预演'
  assert.equal(archiveRequest(request), true)
  assert.equal(archiveCutoff(request), '2025-01-01')
  assert.equal(archiveCutoff('截止日期为 2025-02-29'), undefined)
  assert.equal(archiveDateReply('2025-01-01。'), true)
  assert.equal(archiveCutoff('2025-01-01。'), '2025-01-01')
  const dated = await previewArchive(workspace, archiveCutoff(request))
  assert.deepEqual(dated.candidates, ['report-2024.md'])
  assert.equal(dated.inventory.find(row => row.path === 'report-conflict.md').disposition, 'keep_in_place')
  assert.equal(dated.inventory.find(row => row.path === 'notes.txt').disposition, 'excluded')
  const pending = await previewArchive(workspace)
  assert.equal(pending.cutoff, null)
  assert.deepEqual(pending.candidates, ['report-2024.md', 'report-2026.md'])
  await seedArchivePreview(workspace)
  assert.deepEqual(await previewArchive(workspace, dated.cutoff), dated)
})

test('Markdown remembers the source, persists a single updated entry, and forgets by key', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-memory-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const path = join(folder, 'MEMORY.md')
  const entries = await readMemory(path)
  const save = memoryIntent('记住 项目偏好 test-order：按年份排序')
  assert.equal(applyMemory(entries, save, 'evt_123').status, 'saved')
  assert.equal(applyMemory(entries, save, 'evt_123').status, 'saved')
  assert.equal(applyMemory(entries, save, 'evt_124').status, 'already_exists')
  assert.equal(entries.size, 1)
  const update = memoryIntent('更新 已确认决定 test-order：按季度排序')
  assert.equal(applyMemory(entries, update, 'evt_125').status, 'saved')
  await writeFile(path, memoryMarkdown(entries))
  const restored = await readMemory(path)
  assert.deepEqual(applyMemory(restored, memoryIntent('查一下 Dot 记忆 test-order')), {
    status: 'found', key: 'test-order',
    entry: { key: 'test-order', text: '按季度排序', source: 'evt_125', category: 'decision' },
  })
  const forget = memoryIntent('忘记 Dot 记忆 test-order')
  assert.equal(applyMemory(restored, forget, 'evt_126').status, 'forgotten')
  assert.equal(applyMemory(restored, forget, 'evt_126').status, 'forgotten')
  assert.equal(restored.size, 0)
  assert.equal(memoryIntent('Qoder 建议记住 项目偏好 test-order：按季度排序'), undefined)
})
