import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dotSessionUrl, entryTitle } from './dot-entry.mjs'

test('the same historical link points to the latest primary and can be restored', () => {
  const source = { id: 'sess_A', title: 'Qoder Dot', agent: { system: 'Original configuration', tools: [{ type: 'custom', name: 'example' }] } }
  const move = (session, active) => ({ ...session, title: entryTitle(session, active, 'cn', source) })
  assert.equal(entryTitle(source, 'sess_A', 'cn', source), 'Dot by QCA · 当前主会话')
  const first = move(source, 'sess_B')
  assert.match(first.title, /qoder\.com\.cn\/cloud\/sessions\/sess_B/)
  assert.deepEqual(first.agent, source.agent)
  assert.equal(entryTitle(first, 'sess_B', 'cn', source), first.title)
  const next = move(first, 'sess_C')
  assert.doesNotMatch(next.title, /sessions\/sess_B/)
  assert.match(next.title, /sessions\/sess_C/)
  assert.equal(next.title, '历史 · 现入口 https://qoder.com.cn/cloud/sessions/sess_C · Dot by QCA')
  assert.deepEqual(move(next, 'sess_A'), { ...source, title: 'Dot by QCA · 当前主会话' })
  assert.throws(() => dotSessionUrl('cn', 'sess_A/other'), /无效/)
})
