const historyTitle = /^历史 · 现入口 https:\/\/qoder\.com(?:\.cn)?\/cloud\/sessions\/sess_[a-z0-9_-]+ · /i
export const dotName = 'Dot by QCA'
const activeTitle = dotName + ' · 当前主会话'
const legacyName = /^(?:Qoder Dot|qoder-dot(?:-demo)?)(?=$|\s|·)/i

export function dotDisplayName(name) {
  return name?.replace(legacyName, dotName)
}

export function dotSessionUrl(site, sessionId) {
  if (!/^sess_[a-z0-9_-]+$/i.test(sessionId)) throw new Error('Dot 会话 ID 无效。')
  return `https://${site === 'cn' ? 'qoder.com.cn' : 'qoder.com'}/cloud/sessions/${sessionId}`
}

export function entryTitle(session, activeId, site, original) {
  if (session.id === activeId) return activeTitle
  const previous = session.title?.replace(historyTitle, '')
  const name = dotDisplayName(original?.title || previous) || dotName
  return Array.from(`历史 · 现入口 ${dotSessionUrl(site, activeId)} · ${name === activeTitle ? dotName : name}`).slice(0, 250).join('')
}
