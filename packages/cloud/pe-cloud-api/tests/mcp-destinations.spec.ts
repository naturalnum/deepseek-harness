import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { Agent, fetch, Response as UndiciResponse } from 'undici'
import { expect, it, vi } from 'vitest'
import { McpDestinations, publicMcpEndpoint } from '../src/mcp-destinations.ts'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>()
  return { ...original, fetch: vi.fn(original.fetch) }
})

it('admits the exact canonical Root endpoint and refuses nonpublic literals', async () => {
  const accepted = 'https://mcp.fixture.test/tools'
  expect(publicMcpEndpoint('HTTPS://MCP.FIXTURE.TEST:443/tools')).toBe(accepted)
  for (const value of ['http://127.0.0.1/mcp', 'http://localhost./mcp', 'http://10.0.0.1/mcp',
    'http://[::1]/mcp', 'http://169.254.169.254/mcp', 'http://168.63.129.16/mcp',
    'http://[::ffff:a83f:8110]/mcp', 'https://mcp.fixture.test/tools#fragment']) {
    expect(publicMcpEndpoint(value)).toBeUndefined()
  }
  const egress = new McpDestinations([accepted], new AbortController().signal)
  const send = vi.mocked(fetch).mockResolvedValueOnce(new UndiciResponse())
  const denied = { code: 'cloud/mcp-destination-forbidden' }
  try {
    await expect(egress.fetch(accepted + '/other')).rejects.toMatchObject(denied)
    await expect(egress.fetch('http://mcp.fixture.test/tools')).rejects.toMatchObject(denied)
    await expect(egress.fetch('https://mcp.fixture.test:8443/tools')).rejects.toMatchObject(denied)
    expect(send).not.toHaveBeenCalled()
    await egress.fetch(accepted, { redirect: 'follow' })
    expect(send).toHaveBeenCalledExactlyOnceWith(new URL(accepted), expect.objectContaining({ redirect: 'error' }))
  } finally { send.mockClear(); await egress.close() }
})

it('fails before dialing when an approved hostname resolves to a private address', async () => {
  const connected = vi.fn()
  const server = createServer((socket) => { connected(); socket.destroy() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const listening = server.address()
  if (listening === null || typeof listening === 'string') throw new Error('Missing test listener')
  const accepted = `http://mcp.fixture.test:${listening.port}/mcp`
  const egress = new McpDestinations([accepted], new AbortController().signal)
  lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
  try {
    await expect(egress.fetch(accepted)).rejects.toMatchObject({ cause: { code: 'cloud/mcp-destination-forbidden' } })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('mcp.fixture.test', { all: true, order: 'verbatim' })
    expect(connected).not.toHaveBeenCalled()
  } finally {
    await egress.close()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
})

it('does not dispatch a second HTTP request after an approved server redirects', async () => {
  const paths: (string | undefined)[] = []
  const server = createHttpServer((request, response) => {
    paths.push(request.url)
    response.writeHead(request.url === '/mcp' ? 302 : 200, { location: '/redirected' }).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const listening = server.address()
  if (listening === null || typeof listening === 'string') throw new Error('Missing test listener')
  const local = `http://127.0.0.1:${listening.port}`
  const synthetic = `http://redirect.fixture.test:${listening.port}`
  const egress = new McpDestinations([synthetic + '/mcp'], new AbortController().signal)
  const send = Agent.prototype.dispatch
  const dispatch = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation(function (this: Agent, options, handler) {
    expect(String(options.origin)).toBe(synthetic)
    return send.call(this, { ...options, origin: local }, handler)
  })
  try {
    await expect(egress.fetch(synthetic + '/mcp', { redirect: 'follow' })).rejects.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(paths).toEqual(['/mcp'])
  } finally {
    dispatch.mockRestore(); await egress.close()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
})
