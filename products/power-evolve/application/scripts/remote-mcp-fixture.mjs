/** Loopback-only, synthetic catalog and quote tools for native remote-MCP trial acceptance. */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'

const port = Number(process.env.PE_REMOTE_MCP_PORT)
const delayMs = Number(process.env.PE_REMOTE_MCP_DELAY_MS ?? 10000)
const privateDir = process.env.PE_PRIVATE_DIR
const readyFile = process.env.PE_READY_FILE
if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !privateDir || !readyFile
  || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 60000) {
  throw new Error('Invalid remote MCP fixture configuration')
}
const accounts = z.array(z.object({ username: z.string().min(1), token: z.string().min(24),
  unitPrice: z.number().int().positive() })).min(2).parse(
  JSON.parse(await readFile(join(privateDir, 'remote-mcp-fixture-users.json'), 'utf8')))
const instanceId = randomUUID()
function accountFor(header) {
  const supplied = Buffer.from(typeof header === 'string' ? header : '')
  return accounts.find(account => {
    const expected = Buffer.from(`Bearer ${account.token}`)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  })
}
async function result(account, tool, args, value) {
  await appendFile(join(privateDir, 'remote-mcp-fixture-calls.jsonl'),
    `${JSON.stringify({ owner: account.username, tool, args, value })}\n`, { mode: 0o600 })
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
// Fixed synthetic test prices; this catalog does not represent a real merchant.
const publicAccount = { username: 'public', unitPrice: 7 }
function catalogServer(account) {
  const server = new McpServer({ name: `trial-catalog-${account.username}`, version: '1' })
  server.registerTool('lookup_item', {
    description: account === publicAccount
      ? 'Look up synthetic fixed test data in the public catalog: notebook unit price 7 CNY, pencil 2 CNY. No real merchant or purchase.'
      : `Look up a synthetic item in ${account.username}'s private catalog. Returns its unit price and quote code.`,
    inputSchema: z.object({ sku: z.enum(['notebook', 'pencil']) }),
    outputSchema: z.object({ owner: z.string(), sku: z.enum(['notebook', 'pencil']),
      unitPrice: z.number().int().min(1), quoteCode: z.string(), currency: z.literal('CNY') }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ sku }) => result(account, 'lookup_item', { sku }, {
    owner: account.username, sku, unitPrice: sku === 'notebook' ? account.unitPrice : 2,
    quoteCode: `${account.username}-${sku}-2026`, currency: 'CNY',
  }))
  server.registerTool('calculate_quote', {
    description: 'Calculate a synthetic quote using the exact quoteCode from lookup_item and a quantity. No purchase or external write occurs.',
    inputSchema: z.object({ quoteCode: z.string(), quantity: z.number().int().min(1).max(100) }),
    outputSchema: z.object({ owner: z.string(), sku: z.enum(['notebook', 'pencil']),
      quantity: z.number().int().min(1).max(100), total: z.number().int().min(1), currency: z.literal('CNY') }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ quoteCode, quantity }) => {
    const sku = ['notebook', 'pencil'].find(item => quoteCode === `${account.username}-${item}-2026`)
    if (!sku) return { isError: true, content: [{ type: 'text', text: account === publicAccount
      ? 'Quote code is not in this synthetic public catalog.' : 'Quote code is not in this private catalog.' }] }
    return result(account, 'calculate_quote', { quoteCode, quantity }, {
      owner: account.username, sku, quantity, total: quantity * (sku === 'notebook' ? account.unitPrice : 2), currency: 'CNY',
    })
  })
  return server
}
const handler = createMcpHandler(context => {
  const account = accountFor(context.requestInfo?.headers.get('authorization'))
  if (!account) throw new Error('Unauthorized fixture account')
  return catalogServer(account)
})
const publicHandler = createMcpHandler(() => catalogServer(publicAccount))
const emptyHandler = createMcpHandler(() => new McpServer({ name: 'trial-empty-catalog', version: '1' },
  { capabilities: { tools: {} } }))
const mcp = toNodeHandler(handler)
const publicMcp = toNodeHandler(publicHandler)
const emptyMcp = toNodeHandler(emptyHandler)
const delayedRequests = new Set()
function waitForDiscovery(response) {
  return new Promise(resolve => {
    const cancel = () => finish(false)
    const timer = setTimeout(() => finish(true), delayMs)
    function finish(ready) {
      clearTimeout(timer)
      response.off('close', cancel)
      delayedRequests.delete(cancel)
      resolve(ready)
    }
    delayedRequests.add(cancel)
    response.once('close', cancel)
    if (response.destroyed) cancel()
  })
}
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ready: true, service: 'remote-mcp-fixture', instanceId })); return
  }
  if (!['/mcp', '/mcp/public', '/mcp/empty', '/mcp/slow'].includes(req.url)) { res.writeHead(404).end(); return }
  if (req.url === '/mcp' && !accountFor(req.headers.authorization)) { res.writeHead(401).end(); return }
  const selected = req.url === '/mcp' ? mcp : req.url === '/mcp/empty' ? emptyMcp : publicMcp
  void (async () => {
    if (req.url === '/mcp/slow' && !await waitForDiscovery(res)) return
    if (!res.destroyed) await selected(req, res)
  })().catch(() => { if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end() } })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Remote MCP fixture has no TCP address')
await mkdir(dirname(readyFile), { recursive: true, mode: 0o700 })
await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}`, instanceId }), { mode: 0o600 })
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  for (const cancel of delayedRequests) cancel()
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await Promise.all([closed, handler.close(), publicHandler.close(), emptyHandler.close()])
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void stop().catch(() => { process.exitCode = 1 })
})
