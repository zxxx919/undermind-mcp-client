// stdio entry point: DSH launches this as a stdio MCP server via
// @deepseek-ai/dsh-mcp-client, and every JSON-RPC line is relayed to Undermind.
import { createInterface } from 'node:readline'
import { createBridge } from './bridge-lib.mjs'
import { MCP_URL, AS_METADATA_URL, TOKEN_FILE, clientId } from './tokens.mjs'

let writeChain = Promise.resolve()

function emit(message) {
  const line = JSON.stringify(message) + '\n'
  writeChain = writeChain.then(() => new Promise((resolve) => process.stdout.write(line, resolve)))
}

function log(message) {
  process.stderr.write(`[undermind] ${message}\n`)
}

const bridge = createBridge({
  mcpUrl: MCP_URL,
  tokenFile: TOKEN_FILE,
  asMetadataUrl: AS_METADATA_URL,
  clientId: clientId(),
  emit,
  log,
  timeoutMs: Number(process.env.UNDERMIND_TIMEOUT_MS || 240_000),
})

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain = Promise.resolve()

input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log(`丢弃无法解析的一行：${line.slice(0, 200)}`)
    return
  }
  chain = chain.then(() => bridge.handle(message))
})

input.on('close', () => {
  chain.finally(() => process.exit(0))
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
