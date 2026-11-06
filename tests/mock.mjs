// Minimal mock of the Undermind MCP server + authorization server for tests.
import http from 'node:http'

export async function startMock({ accessToken = 'good-token' } = {}) {
  const state = {
    accessToken,
    refreshCount: 0,
    calls: [],
    sessionId: 'mock-session-1',
  }

  const mcp = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const auth = req.headers.authorization
      state.calls.push({ headers: req.headers, body })
      if (auth !== `Bearer ${state.accessToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      const message = JSON.parse(body)
      const send = (payload, headers = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      if (message.method === 'initialize') {
        send(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-undermind', version: '0.0.0' },
            },
          },
          { 'mcp-session-id': state.sessionId },
        )
        return
      }
      if (message.method === 'tools/list') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              { name: 'search', description: 'search papers', inputSchema: { type: 'object' } },
              { name: 'fetch', description: 'fetch paper', inputSchema: { type: 'object' } },
            ],
          },
        })
        return
      }
      if (message.method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `called ${message.params?.name}` }] },
        })
        return
      }
      if (message.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } })
    })
  })

  const as = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const port = as.address().port
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          issuer: `http://127.0.0.1:${port}`,
          authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
          token_endpoint: `http://127.0.0.1:${port}/token`,
        }),
      )
      return
    }
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        state.refreshCount += 1
        state.accessToken = `refreshed-${state.refreshCount}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: state.accessToken,
            refresh_token: `refresh-${state.refreshCount}`,
            expires_in: 3600,
          }),
        )
      })
      return
    }
    res.writeHead(404).end()
  })

  await new Promise((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => as.listen(0, '127.0.0.1', resolve))
  return {
    state,
    mcpUrl: `http://127.0.0.1:${mcp.address().port}/mcp`,
    asUrl: `http://127.0.0.1:${as.address().port}/.well-known/oauth-authorization-server`,
    close: () =>
      Promise.all([
        new Promise((resolve) => mcp.close(resolve)),
        new Promise((resolve) => as.close(resolve)),
      ]),
  }
}
