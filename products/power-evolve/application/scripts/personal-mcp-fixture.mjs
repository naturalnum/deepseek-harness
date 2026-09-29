/** Loopback-only Streamable HTTP MCP fixture for the fixed read-only S6 trial. */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'

const port = Number(process.env.PE_MCP_PORT)
const tokenFile = process.env.PE_MCP_TOKEN_FILE
const readyFile = process.env.PE_READY_FILE
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535 || !tokenFile || !readyFile) {
  throw new Error('Invalid MCP fixture configuration')
}
const token = (await readFile(tokenFile, 'utf8')).trim()
if (token.length < 24) throw new Error('MCP fixture token is too short')
const instanceId = randomUUID()

const handler = createMcpHandler(context => {
  const authorizedUser = context.requestInfo?.headers.get('x-power-evolve-user')
  const server = new McpServer({ name: 'power-evolve-read-only-trial', version: '0.1.0' },
    { capabilities: { tools: {} } })
  server.registerTool('whoami', {
    description: 'Read the current PowerEvolve trial account identity.',
    inputSchema: z.object({ accountId: z.uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ accountId }) => {
    if (authorizedUser !== accountId) {
      return { isError: true, content: [{ type: 'text', text: 'identity mismatch' }] }
    }
    return { content: [{ type: 'text', text: `user:${accountId}` }] }
  })
  return server
})
const mcp = toNodeHandler(handler)

function authorized(value) {
  const supplied = Buffer.from(typeof value === 'string' ? value : '')
  const expected = Buffer.from(`Bearer ${token}`)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, { ready: true, service: 'mcp-fixture', instanceId }); return
  }
  if (path !== '/mcp') { json(res, 404, { error: 'not_found' }); return }
  if (!authorized(req.headers.authorization)) { json(res, 401, { error: 'unauthorized' }); return }
  void mcp(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'mcp_error' }); else res.end() })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('MCP fixture has no TCP address')
await mkdir(dirname(readyFile), { recursive: true, mode: 0o700 })
await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}`, instanceId }),
  { mode: 0o600 })

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.closeAllConnections()
  server.close(() => { void handler.close().finally(() => { process.exitCode = 0 }) })
})
