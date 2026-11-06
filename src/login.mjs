// One-time OAuth login for the Undermind MCP server.
//
// Usage:  node src/login.mjs
// Opens your browser, captures the loopback callback, and stores the token pair
// in .state/tokens.json (git-ignored). Re-run any time to re-authorize.
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  MCP_URL,
  REDIRECT_PORT,
  clientId,
  redirectUri,
  discoverAuthorizationServer,
  writeTokens,
} from './tokens.mjs'

const client_id = clientId()
const redirect_uri = redirectUri()
const verifier = crypto.randomBytes(48).toString('base64url')
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
const state = crypto.randomBytes(16).toString('base64url')

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`)
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('not found')
    return
  }
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')

  if (error) return finish(res, 400, `授权失败：${error} ${url.searchParams.get('error_description') ?? ''}`)
  if (returnedState !== state) return finish(res, 400, 'state 不匹配，请重试')

  try {
    const meta = await discoverAuthorizationServer()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      client_id,
      code_verifier: verifier,
      resource: MCP_URL,
    })
    const tokenRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    const text = await tokenRes.text()
    if (!tokenRes.ok) return finish(res, 500, `换取 token 失败：${tokenRes.status} ${text.slice(0, 600)}`)

    const json = JSON.parse(text)
    writeTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      scope: json.scope,
      token_type: json.token_type ?? 'Bearer',
      expires_at: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
      client_id,
      resource: MCP_URL,
      obtained_at: new Date().toISOString(),
    })
    finish(res, 200, '授权成功，可以关闭此页面回到 DSH。')
  } catch (e) {
    finish(res, 500, `出错：${e.message}`)
  }
})

function finish(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Undermind</title>
    <body style="font:16px/1.6 system-ui;margin:4rem auto;max-width:34rem">
    <h1 style="font-size:1.25rem">Undermind MCP</h1><p>${message}</p></body>`)
  console.log(message)
  setTimeout(() => server.close(() => process.exit(status === 200 ? 0 : 1)), 300)
}

server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
  try {
    const meta = await discoverAuthorizationServer()
    const auth = new URL(meta.authorization_endpoint)
    auth.searchParams.set('response_type', 'code')
    auth.searchParams.set('client_id', client_id)
    auth.searchParams.set('redirect_uri', redirect_uri)
    auth.searchParams.set('scope', 'mcp')
    auth.searchParams.set('state', state)
    auth.searchParams.set('code_challenge', challenge)
    auth.searchParams.set('code_challenge_method', 'S256')
    auth.searchParams.set('resource', MCP_URL)
    console.log(`client_id: ${client_id}`)
    console.log(`redirect_uri: ${redirect_uri}`)
    console.log(`在浏览器里完成授权（没有自动打开就用这个链接）：\n${auth.href}`)
    openBrowser(auth.href)
  } catch (e) {
    console.error(`无法读取授权服务器元数据：${e.message}`)
    process.exit(1)
  }
})

server.on('error', (e) => {
  console.error(`本地回调端口 ${REDIRECT_PORT} 不可用：${e.message}`)
  process.exit(1)
})
