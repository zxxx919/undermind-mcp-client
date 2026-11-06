// Transport-agnostic core of the Undermind MCP bridge: one JSON-RPC message in,
// zero or more JSON-RPC messages out, with the OAuth bearer token attached.
import { isExpired, readTokens, refreshTokens } from './tokens.mjs'

export function createBridge({
  mcpUrl,
  tokenFile,
  asMetadataUrl,
  clientId,
  emit,
  log = () => {},
  timeoutMs = 240_000,
  fetchImpl = fetch,
}) {
  let tokens = readTokens(tokenFile)
  let sessionId = null
  let protocolVersion = null
  let refreshing = null

  async function ensureToken(force) {
    if (!tokens) throw new Error('未登录：先运行 node src/login.mjs 完成一次性授权')
    if (!force && !isExpired(tokens)) return tokens.access_token
    refreshing ??= refreshTokens(tokens, { tokenFile, asMetadataUrl, mcpUrl, clientId })
      .then((next) => (tokens = next))
      .finally(() => (refreshing = null))
    return (await refreshing).access_token
  }

  function noteProtocol(message) {
    const version = message?.result?.protocolVersion
    if (version) protocolVersion = version
  }

  /** Decode a Streamable-HTTP response body (JSON or SSE) into JSON-RPC messages. */
  async function readResponse(res, wantsReply, requestId) {
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text()
      if (!text.trim()) return
      if (!contentType.includes('json')) {
        if (wantsReply) {
          emit({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: -32000, message: `upstream ${res.status}: ${text.slice(0, 500)}` },
          })
        }
        return
      }
      const parsed = JSON.parse(text)
      noteProtocol(parsed)
      emit(parsed)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let replied = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          const message = JSON.parse(data)
          noteProtocol(message)
          emit(message)
          if (wantsReply && message.id === requestId) replied = true
        }
        if (replied) break
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    if (wantsReply && !replied) {
      emit({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: 'upstream closed the stream without a response' },
      })
    }
  }

  async function forward(message) {
    const wantsReply = message.id !== undefined && message.id !== null
    let forcedRefresh = false

    for (let attempt = 0; ; attempt += 1) {
      const token = await ensureToken(forcedRefresh)
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      }
      if (sessionId) headers['mcp-session-id'] = sessionId
      if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion

      const res = await fetchImpl(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true
        await res.body?.cancel().catch(() => {})
        continue
      }

      const nextSession = res.headers.get('mcp-session-id')
      if (nextSession) sessionId = nextSession
      if (res.status === 202 || res.status === 204) return
      await readResponse(res, wantsReply, message.id)
      return
    }
  }

  return {
    async handle(message) {
      const wantsReply = message.id !== undefined && message.id !== null
      try {
        await forward(message)
      } catch (error) {
        log(`${message.method ?? 'response'} 失败：${error.message}`)
        if (wantsReply) {
          emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } })
        }
      }
    },
    get sessionId() {
      return sessionId
    },
    get protocolVersion() {
      return protocolVersion
    },
  }
}
