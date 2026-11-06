// End-to-end tests for the bridge core against a mock Undermind MCP server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../src/bridge-lib.mjs'
import { startMock } from './mock.mjs'

function tokenFile(tokens) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'undermind-')), 'tokens.json')
  fs.writeFileSync(file, JSON.stringify(tokens))
  return file
}

function makeBridge(mock, tokens) {
  const emitted = []
  const bridge = createBridge({
    mcpUrl: mock.mcpUrl,
    tokenFile: tokens,
    asMetadataUrl: mock.asUrl,
    clientId: 'https://example.test/client.json',
    emit: (message) => emitted.push(message),
    log: () => {},
  })
  return { bridge, emitted }
}

test('relays initialize, tools/list and tools/call with a bearer token', async () => {
  const mock = await startMock()
  const tokens = tokenFile({
    access_token: 'good-token',
    refresh_token: 'refresh-0',
    expires_at: Date.now() + 3600_000,
    client_id: 'https://example.test/client.json',
  })
  const { bridge, emitted } = makeBridge(mock, tokens)
  try {
    await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    assert.equal(emitted.at(-1).result.serverInfo.name, 'mock-undermind')
    assert.equal(bridge.sessionId, 'mock-session-1')

    await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(
      emitted.at(-1).result.tools.map((tool) => tool.name),
      ['search', 'fetch'],
    )

    await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: {} } })
    assert.equal(emitted.at(-1).result.content[0].text, 'called search')

    // Session id from initialize must be reused, and the token injected upstream.
    const toolCall = mock.state.calls.find((entry) => entry.body.includes('tools/call'))
    assert.equal(toolCall.headers['mcp-session-id'], 'mock-session-1')
    assert.equal(toolCall.headers.authorization, 'Bearer good-token')
  } finally {
    await mock.close()
  }
})

test('refreshes an expired token and retries the request', async () => {
  const mock = await startMock({ accessToken: 'stale-token' })
  const tokens = tokenFile({
    access_token: 'stale-token',
    refresh_token: 'refresh-0',
    expires_at: Date.now() + 3600_000,
    client_id: 'https://example.test/client.json',
  })
  const { bridge, emitted } = makeBridge(mock, tokens)
  try {
    // Simulate a server-side rotation the client has not seen yet: the first
    // request is rejected with 401, the bridge must refresh and retry.
    mock.state.accessToken = 'rotated-token'
    await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(emitted.at(-1).result.tools.length, 2)
    assert.equal(mock.state.refreshCount, 1)

    const stored = JSON.parse(fs.readFileSync(tokens, 'utf8'))
    assert.equal(stored.access_token, 'refreshed-1')
    assert.equal(stored.refresh_token, 'refresh-1')
  } finally {
    await mock.close()
  }
})

test('reports a clear error when no token has been stored yet', async () => {
  const mock = await startMock()
  const { bridge, emitted } = makeBridge(mock, path.join(os.tmpdir(), 'undermind-missing', 'tokens.json'))
  try {
    await bridge.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    assert.match(emitted.at(-1).error.message, /login/)
  } finally {
    await mock.close()
  }
})
