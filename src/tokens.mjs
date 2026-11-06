// Shared paths, client metadata and token storage for the Undermind MCP bridge.
//
// Everything lives next to this repository so the DSH profile entry can point at
// stable absolute paths. Tokens are written with mode 0600 and are git-ignored.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const METADATA_FILE = path.join(ROOT, 'client-metadata.json')

// Env overrides exist for the mock-upstream tests; production uses the defaults.
export const MCP_URL = process.env.UNDERMIND_MCP_URL || 'https://mcp.undermind.ai/mcp'
export const AS_METADATA_URL =
  process.env.UNDERMIND_AS_METADATA_URL || 'https://api.undermind.ai/.well-known/oauth-authorization-server'
export const REDIRECT_PORT = Number(process.env.UNDERMIND_REDIRECT_PORT || 53682)
export const TOKEN_FILE =
  process.env.UNDERMIND_TOKEN_FILE || path.join(ROOT, '.state', 'tokens.json')

export function readClientMetadata(file = METADATA_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function clientId(file = METADATA_FILE) {
  return readClientMetadata(file).client_id
}

export function redirectUri(port = REDIRECT_PORT) {
  return `http://127.0.0.1:${port}/callback`
}

export function readTokens(file = TOKEN_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeTokens(tokens, file = TOKEN_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 })
}

export function isExpired(tokens, skewMs = 60_000) {
  if (!tokens?.access_token) return true
  if (!tokens.expires_at) return false
  return Date.now() + skewMs >= tokens.expires_at
}

export async function discoverAuthorizationServer(url = AS_METADATA_URL) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`authorization-server metadata ${res.status}`)
  return res.json()
}

/** Exchange a refresh token for a fresh access token, persisting the rotated pair. */
export async function refreshTokens(tokens, options = {}) {
  const {
    tokenFile = TOKEN_FILE,
    asMetadataUrl = AS_METADATA_URL,
    mcpUrl = MCP_URL,
    clientId: fallbackClientId,
  } = options
  if (!tokens?.refresh_token) throw new Error('no refresh_token; run `node src/login.mjs`')
  const meta = await discoverAuthorizationServer(asMetadataUrl)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id || fallbackClientId,
    resource: mcpUrl,
  })
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${text.slice(0, 400)}`)
  const json = JSON.parse(text)
  const next = {
    ...tokens,
    access_token: json.access_token,
    refresh_token: json.refresh_token || tokens.refresh_token,
    scope: json.scope ?? tokens.scope,
    token_type: json.token_type ?? tokens.token_type ?? 'Bearer',
    expires_at: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    client_id: tokens.client_id || fallbackClientId,
    resource: mcpUrl,
  }
  writeTokens(next, tokenFile)
  return next
}
