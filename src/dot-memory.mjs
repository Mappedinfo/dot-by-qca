import { readFile } from 'node:fs/promises'

const headings = { preference: '项目偏好', decision: '已确认决定' }
const keyPattern = '[a-z0-9][a-z0-9-]{0,47}'
const entriesPattern = new RegExp('^- `(' + keyPattern + ')` (.+) <!-- source: (evt_[a-z0-9]+) -->$', 'i')
const readIntent = new RegExp('^(?:请\\s*)?(?:查(?:一下|看)?|读取|回忆)\\s*(?:Dot\\s*)?(?:记忆|偏好|决定)\\s*[：:]?\\s*(' + keyPattern + ')[。]?$','iu')
const editIntent = new RegExp('^(?:请\\s*)?(记住|更新)\\s*(项目偏好|已确认决定|决定)\\s+(' + keyPattern + ')\\s*[：:]\\s*(.+)$', 'iu')
const forgetIntent = new RegExp('^(?:请\\s*)?忘记\\s*(?:Dot\\s*)?记忆\\s*[：:]?\\s*(' + keyPattern + ')[。]?$', 'iu')

export function memoryIntent(text) {
  const cleaned = text.trim()
  const read = cleaned.match(readIntent)
  if (read) return { action: 'read', key: read[1].toLowerCase() }
  const forget = cleaned.match(forgetIntent)
  if (forget) return { action: 'forget', key: forget[1].toLowerCase() }
  const edit = cleaned.match(editIntent)
  if (edit && edit[4].length <= 600 && !/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(edit[4])) {
    return { action: edit[1] === '记住' ? 'save' : 'update', category: edit[2] === '项目偏好' ? 'preference' : 'decision',
      key: edit[3].toLowerCase(), text: edit[4].trim() }
  }
}

export async function readMemory(path) {
  const raw = await readFile(path, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  let category
  const entries = new Map()
  for (const line of raw.split('\n')) {
    if (line.startsWith('## ')) category = Object.keys(headings).find(key => headings[key] === line.slice(3))
    const row = entriesPattern.exec(line)
    if (row && category) entries.set(row[1], { key: row[1], text: row[2], source: row[3], category })
  }
  return entries
}

export function memoryMarkdown(entries) {
  return '# Dot 记忆\n' + Object.entries(headings).map(([category, title]) => {
    const rows = [...entries.values()].filter(row => row.category === category)
    return '\n## ' + title + '\n\n' + rows.map(row => '- `' + row.key + '` ' + row.text + ' <!-- source: ' + row.source + ' -->\n').join('')
  }).join('')
}

export function applyMemory(entries, intent, source) {
  const entry = entries.get(intent.key)
  if (intent.action === 'read') return { status: entry ? 'found' : 'missing', key: intent.key, ...(entry && { entry }) }
  if (entry?.source === source) return { status: 'saved', key: intent.key }
  if (intent.action === 'forget') {
    entries.delete(intent.key)
    return { status: 'forgotten', key: intent.key }
  }
  if (intent.action === 'save' && entry) return { status: 'already_exists', key: intent.key }
  if (intent.action === 'update' && !entry) return { status: 'missing', key: intent.key }
  entries.set(intent.key, { key: intent.key, category: intent.category, text: intent.text, source })
  return { status: 'saved', key: intent.key }
}
