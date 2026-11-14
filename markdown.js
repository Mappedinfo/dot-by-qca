import MarkdownIt from './vendor/markdown-it.mjs'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
markdown.validateLink = url => /^https?:\/\//i.test(url)
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  markdown.utils.escapeHtml(renderer.renderInlineAsText(tokens[index].children || [], options, env) || '图片')
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}

export function markdownContent(text) {
  const content = document.createElement('div')
  content.className = 'markdown'
  content.innerHTML = markdown.render(text)
  for (const block of content.querySelectorAll('pre, table')) {
    const scroll = document.createElement('div')
    scroll.className = 'markdown-scroll'
    scroll.tabIndex = 0
    scroll.setAttribute('role', 'region')
    scroll.setAttribute('aria-label', block.tagName === 'TABLE' ? '表格' : '代码块')
    block.replaceWith(scroll)
    scroll.append(block)
  }
  return content
}
