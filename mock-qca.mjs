import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAC_TOOL } from './qca.mjs'

export async function startMockGateway(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'gateway.json')
  const saved = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  const state = { events: [], requests: {}, ...JSON.parse(saved) }
  const sessionId = 'sess_mock_qoder_dot'
  const sessionPath = `/sessions/${sessionId}`

  function add(type, fields = {}) {
    const event = { id: `evt_mock_${state.events.length + 1}`, type, ...fields }
    state.events.push(event)
    return event
  }

  function reply(text) {
    add('agent.message', { content: [{ type: 'text', text }] })
    add('session.status_idle', { stop_reason: { type: 'end_turn' } })
  }

  function handleInput(event) {
    const last = state.events.at(-1)
    const pending = last?.stop_reason?.event_ids?.[0]
    const text = event.content?.[0]?.text || ''
    if (pending && event.custom_tool_use_id !== pending) return null
    if (event.type === 'user.custom_tool_result' && !pending) return null

    add('session.status_running')
    const accepted = add(event.type, event)
    if (event.type === 'user.custom_tool_result') {
      reply(`模拟回复：${text}`)
      return accepted
    }

    const marker = text.match(/(?:标记|marker)\s*[：:]?\s*([A-Za-z0-9_-]{1,48})/i)
    const memory = text.match(/(?:口令|code)\s*[：:]?\s*([A-Za-z0-9_-]{1,48})/i)
    if (marker) {
      const call = add('agent.custom_tool_use', { name: MAC_TOOL, input: { label: marker[1] } })
      add('session.status_idle', { stop_reason: { type: 'requires_action', event_ids: [call.id] } })
    } else if (memory) {
      state.memory = memory[1]
      reply(`模拟回复：已记住 ${state.memory}。`)
    } else {
      reply(state.memory ? `模拟回复：会话口令是 ${state.memory}。` : `模拟回复：收到「${text}」。`)
    }
    return accepted
  }

  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/models') return json(200, { data: [{ id: 'auto', is_enabled: true }] })
    if (req.method === 'POST' && url.pathname === '/environments') return json(200, { id: 'env_mock' })
    if (req.method === 'POST' && url.pathname === '/agents') return json(200, { id: 'agent_mock' })
    if (req.method === 'POST' && url.pathname === '/sessions') return json(200, { id: sessionId })
    if (req.method === 'GET' && url.pathname === sessionPath) return json(200, { id: sessionId, status: 'idle' })
    if (url.pathname !== `${sessionPath}/events`) return json(404, { error: { type: 'not_found_error' } })
    if (req.method === 'GET') {
      const after = url.searchParams.get('after_id')
      const page = url.searchParams.get('page')
      const start = page ? Number(page) : state.events.findIndex(event => event.id === after) + 1
      const end = start + Number(url.searchParams.get('limit') || 100)
      return json(200, { data: state.events.slice(start, end), next_page: end < state.events.length ? String(end) : null })
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks)).events[0]
      const key = req.headers['idempotency-key']
      if (Object.hasOwn(state.requests, key)) return json(200, { data: [state.requests[key]] })
      const accepted = handleInput(input)
      if (!accepted) return json(409, { error: { type: 'invalid_request_error' } })
      state.requests[key] = accepted
      const temp = `${file}.tmp`
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
      await rename(temp, file)
      return json(200, { data: [accepted] })
    } catch {
      return json(500, { error: { type: 'mock_error' } })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseURL: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
