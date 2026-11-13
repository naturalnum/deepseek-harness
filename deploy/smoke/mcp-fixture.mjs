/** One owned, keyless MCP ping service; stop and restart retain the original URL. */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

const require = createRequire(new URL('../../packages/mcp/mcp-client/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)).href)

/** Select only the default loopback or an exact, currently assigned private LAN IPv4. */
export function resolveMcpFixtureHost(value = '127.0.0.1') {
  if (value === '127.0.0.1') return value
  const [first, second] = typeof value === 'string' ? value.split('.').map(Number) : []
  const privateAddress = first === 10 || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168
  if (typeof value !== 'string' || isIP(value) !== 4 || !privateAddress
    || !Object.values(networkInterfaces()).flat().some(row => row?.family === 'IPv4' && !row.internal && row.address === value)) {
    throw new Error('MCP 测试服务地址必须是 127.0.0.1 或本机当前网卡上的私网 IPv4；未开启监听。')
  }
  return value
}

/** Load the SDK only for an explicitly requested optional check.
 * @param input One host used for both binding and advertising; no wildcard, DNS or separate advertised address.
 * @returns One owned service with joined stop/close and same-address restart.
 */
export async function createMcpSmokeFixture({ host = '127.0.0.1' } = {}) {
  host = resolveMcpFixtureHost(host)
  const [{ createMcpHandler, McpServer }, { toNodeHandler, hostHeaderValidation }, { z }] = await Promise.all([
    load('@modelcontextprotocol/server'), load('@modelcontextprotocol/node'), load('zod'),
  ])
  const marker = `mcp-smoke-${randomBytes(12).toString('hex')}`
  const calls = []
  let port = 0, state = 'new', server, handler, stopping
  const pending = new Set()

  async function start() {
    if (state !== 'new' && state !== 'stopped') throw new Error('MCP fixture cannot restart before confirmed stop.')
    state = 'starting'
    handler = createMcpHandler(() => {
      const service = new McpServer({ name: 'cloud-smoke', version: '1.0.0' }, { capabilities: { tools: {} } })
      service.registerTool('ping', { description: 'Return this smoke service marker.', inputSchema: z.object({}) }, async () => {
        calls.push('ping')
        return { content: [{ type: 'text', text: marker }] }
      })
      return service
    })
    const handle = toNodeHandler(handler)
    const validateHost = hostHeaderValidation([host])
    server = createServer((request, response) => {
      if (!validateHost(request, response)) return
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/mcp') {
        response.writeHead(404).end(); return
      }
      const task = Promise.resolve().then(() => handle(request, response))
      pending.add(task)
      void task.then(() => pending.delete(task), () => {
        pending.delete(task)
        if (!response.headersSent) response.writeHead(500)
        response.end('MCP smoke request failed.')
      })
    })
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); reject(error) }
        const listening = () => { server.off('error', failed); resolve() }
        server.once('error', failed); server.once('listening', listening)
        server.listen(port, host)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('MCP fixture has no listening address.')
      port = address.port
      state = 'running'
    } catch (error) {
      state = 'unknown'
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => handler.close()),
        new Promise((resolve, reject) => {
          if (!server.listening) { resolve(); return }
          server.close(failure => failure ? reject(failure) : resolve())
        }),
        ...pending,
      ])
      if (cleanup.some(result => result.status === 'rejected') || server.listening || pending.size !== 0) {
        throw new Error('MCP fixture startup cleanup is not confirmed.', { cause: error })
      }
      state = 'stopped'
      throw error
    }
  }

  async function stop() {
    if (state === 'stopped') return
    if (stopping !== undefined) return stopping
    if (state !== 'running') throw new Error('MCP fixture stop is not confirmed.')
    state = 'stopping'
    stopping = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => handler.close()),
        new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        ...pending,
      ])
      if (results.some(result => result.status === 'rejected') || server.listening || pending.size !== 0) {
        state = 'unknown'
        throw new Error('MCP fixture cleanup is not confirmed.')
      }
      state = 'stopped'
    })()
    return stopping
  }

  await start()
  return {
    get url() { return `http://${host}:${port}/mcp` },
    get state() { return state },
    marker,
    calls,
    stop,
    async restart() { await stop(); stopping = undefined; await start() },
    close: stop,
  }
}
