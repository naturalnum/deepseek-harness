/** Real authentication/native carrier component tests. All socket pairs stay in process; no listen(). */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, IncomingMessage, request as httpRequest } from 'node:http'
import { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { bindTypertRemote, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountUse, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Auth } from 'better-auth'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { LoginPeerRegistry, type LoginPeer, type LoginPeerPorts } from '../src/peers.ts'
import type { AccessConfig, AuthenticatedPrincipal } from '../src/types.ts'

const configPath = process.env.PE_ACCESS_POSTGRES_CONFIG
const requestId = 'access-peer-test' as Branded<'pe-request-id'>
const cleanups: (() => Promise<void>)[] = []

function config(): AccessConfig {
  return {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test-reference',
    sessionRecheckMs: 60_000, authCheckTimeoutMs: 1000, maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerWaiters: 24, maxPeerWaitersPerAccount: 20, maxPeerCarriers: 8, maxPeerCarriersPerAccount: 4,
    maxPeerCarriersPerLogin: 2, peerCloseTimeoutMs: 100,
    maxAuthOperations: 8, maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 16,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}

function poolConfig(): pg.PoolConfig {
  if (configPath === undefined) throw new Error('Dedicated access database configuration required')
  const input: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  if (input === null || typeof input !== 'object' || !('host' in input) || typeof input.host !== 'string'
    || !('port' in input) || typeof input.port !== 'number' || !('user' in input) || typeof input.user !== 'string'
    || !('password' in input) || typeof input.password !== 'string' || !('databases' in input)
    || input.databases === null || typeof input.databases !== 'object'
    || !('access' in input.databases) || typeof input.databases.access !== 'string') throw new Error('Invalid private access database configuration')
  return { host: input.host, port: input.port, user: input.user, password: input.password, database: input.databases.access,
    max: 2, connectionTimeoutMillis: 1000, query_timeout: 2000 }
}

class NativeFixture extends Service {
  readonly typertRemote = bindTypertRemote(this, 'accessPeerFixture')
  readonly peers: string[] = []
  constructor(ctx: Context) { super(ctx, 'accessPeerFixture') }
  @Remote
  identity(): { peer: string } {
    const peer = this.ctx.invocation?.peer
    if (peer === undefined) throw new Error('Native invocation missing Peer')
    this.peers.push(peer.id)
    return { peer: peer.id }
  }
  @Remote({ mode: 'stream' })
  async *follow(): AsyncGenerator<{ peer: string }> { yield this.identity() }
}

declare module '@deepseek-ai/cordis' {
  interface Context { accessPeerFixture: NativeFixture }
}

/** Memory-only Node sockets still run Node's real HTTP parser and ws's native handshake/frame parser. */
class MemorySocket extends Socket {
  other: MemorySocket | undefined
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.other === undefined || this.other.destroyed) { callback(new Error('Memory peer closed')); return }
    this.other.push(Buffer.from(chunk))
    callback()
  }
  override _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], callback: (error?: Error | null) => void): void {
    this._write(Buffer.concat(chunks.map(item => Buffer.from(item.chunk))), 'utf8', callback)
  }
  override _final(callback: (error?: Error | null) => void): void { this.other?.push(null); callback() }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.other?.push(null)
    callback(error)
    // net.Socket disables Duplex's automatic close event; native sockets emit it from their handle.
    process.nextTick(() => { this.emit('close', error !== null) })
  }
}

function pair(): [MemorySocket, MemorySocket] {
  const a = new MemorySocket()
  const b = new MemorySocket()
  a.other = b
  b.other = a
  a.on('error', (_error: Error) => {
    // Expected disconnects are observed by the HTTP request or upgrade completion; do not report them twice.
  })
  b.on('error', (_error: Error) => {
    // Registry tasks and the client completion observe this carrier failure; fixture teardown only contains it here.
  })
  cleanups.push(async () => { a.destroy(); b.destroy() })
  return [a, b]
}

function authRequest(cookie: string): IncomingMessage {
  const socket = new Socket()
  cleanups.push(async () => { socket.destroy() })
  const request = new IncomingMessage(socket)
  request.url = '/api/accessPeerFixture/identity'
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:4100', cookie }
  request.rawHeaders = ['Host', '127.0.0.1:4100', 'Cookie', cookie]
  return request
}

interface Fixture {
  readonly auth: BetterAuthAccess
  readonly registry: LoginPeerRegistry
  readonly a: AuthenticatedPrincipal
  readonly b: AuthenticatedPrincipal
  readonly cookieA: string
  readonly cookieB: string
  readonly bindingA: AccountBinding
  readonly bindingB: AccountBinding
  readonly lifetimeA: AbortController
  readonly contexts: Map<string, Context>
  readonly borrows: Map<string, number>
  readonly releases: Map<string, number>
  readonly invalidations: { id: string; returned: boolean }[]
  readonly failures: unknown[]
  readonly borrow: LoginPeerPorts['borrow']
  readonly expireA: () => Promise<void>
}

async function setup(
  overrides: Partial<AccessConfig> = {}, borrowGate?: Promise<void>,
  customize?: (ports: LoginPeerPorts) => LoginPeerPorts,
): Promise<Fixture> {
  const settings = { ...config(), ...overrides }
  const pool = new pg.Pool(poolConfig())
  const lifecycle: { registry?: LoginPeerRegistry } = {}
  const invalidations: { id: string; returned: boolean }[] = []
  const auth = await BetterAuthAccess.create(settings, pool, `peer-secret-${randomUUID()}-${randomUUID()}`, async (id) => {
    const invocation = { id, returned: false }
    invalidations.push(invocation)
    await lifecycle.registry?.invalidateLogin(id)
    invocation.returned = true
  })
  await (await auth.planMigrations(requestId)).runMigrations()
  const library = Reflect.get(auth, 'auth') as Auth
  async function signup(): Promise<{ cookie: string; principal: AuthenticatedPrincipal }> {
    const response = await library.handler(new Request(`${settings.publicOrigin}/cloud/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: settings.publicOrigin },
      body: JSON.stringify({ email: `peer-${randomUUID()}@access.example.test`, password: 'Probe-password-12345!', name: 'Peer test' }),
    }))
    expect(response.status).toBe(200)
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    return { cookie, principal: await auth.authenticate(authRequest(cookie), requestId) }
  }
  const a = await signup()
  const b = await signup()
  const lifetimeA = new AbortController()
  const lifetimeB = new AbortController()
  const bindingA: AccountBinding = { accountId: a.principal.accountId, epoch: '91001' as OwnerEpoch, recipeVersion: 'fixture', lifetime: lifetimeA.signal }
  const bindingB: AccountBinding = { accountId: b.principal.accountId, epoch: '91002' as OwnerEpoch, recipeVersion: 'fixture', lifetime: lifetimeB.signal }
  const contexts = new Map<string, Context>()
  const borrows = new Map<string, number>()
  const releases = new Map<string, number>()
  const failures: unknown[] = []
  const directories: string[] = []
  async function context(binding: AccountBinding): Promise<Context> {
    const found = contexts.get(binding.accountId)
    if (found !== undefined) return found
    const directory = await mkdtemp(fileURLToPath(new URL('../.peer-fixture-', import.meta.url)))
    directories.push(directory)
    const ctx = new Context()
    contexts.set(binding.accountId, ctx)
    await ctx.plugin(LocalCredentials, { dshHome: directory, path: `${directory}/credentials.yaml`, watch: false })
    await ctx.plugin({ apply: applyConnection, inject: [...connectionInject] })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 60_000, streamInboxBytes: 65536 })
    await ctx.plugin(NativeFixture)
    return ctx
  }
  const ports: LoginPeerPorts = {
    borrow: async (binding): Promise<AccountUse> => {
      borrows.set(binding.accountId, (borrows.get(binding.accountId) ?? 0) + 1)
      await borrowGate
      const ctx = await context(binding)
      let released = false
      return { binding, context: ctx,
        assertCurrent: () => { if (released || binding.lifetime.aborted) throw new Error('Fixture Use ended') },
        release: () => {
          if (released) return
          released = true
          releases.set(binding.accountId, (releases.get(binding.accountId) ?? 0) + 1)
        },
      }
    },
    beforeHttp: () => {}, beforeStream: () => {}, cleanupFailed: (failure) => { failures.push(failure) },
  }
  const registry = new LoginPeerRegistry(settings, auth, customize === undefined ? ports : customize(ports))
  lifecycle.registry = registry
  const owned = registry
  cleanups.push(async () => {
    await owned.close(Date.now() + 2000).catch((_error: unknown) => {
      // Uncertain-close cases already assert retained ownership and diagnostics before explicit fixture teardown.
    })
    await auth.close()
    for (const ctx of contexts.values()) await ctx.fiber.dispose()
    await pool.end()
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
  })
  return { auth, registry, a: a.principal, b: b.principal, cookieA: a.cookie, cookieB: b.cookie,
    bindingA, bindingB, lifetimeA, contexts, borrows, releases, failures, invalidations, borrow: ports.borrow,
    expireA: async () => {
      await pool.query('UPDATE "session" SET "expiresAt" = $1 WHERE "id" = $2', [new Date(Date.now() - 1000), a.principal.authSessionId])
    },
  }
}

const acquire = (fixture: Fixture, principal = fixture.a, binding = fixture.bindingA): Promise<LoginPeer> =>
  fixture.registry.acquire(principal, binding, Date.now() + 2000, undefined, requestId)

/** Route fixture over memory sockets only, deliberately no native product boot or TCP listener. */
function memoryHttp(fixture: Fixture, handle: LoginPeer, cookie = fixture.cookieA): Promise<unknown> {
  const server = createServer((req, res) => {
    void fixture.registry.handleNodeRequest(handle, req, res, 65536, requestId).catch((_error: unknown) => {
      // The client request observes the rejected exchange; fixture routing only closes its response here.
      res.destroy()
    })
  })
  const [client, incoming] = pair()
  server.emit('connection', incoming)
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${config().publicOrigin}/api/accessPeerFixture/identity`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, createConnection: () => client,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(JSON.stringify({ type: 'client-request', rpcId: 'peer-rpc', method: 'accessPeerFixture/identity', payload: { args: {} } }))
  })
}

/** Minimal RFC6455 test client, independent of the native server's parsing implementation. */
async function memoryWebsocket(
  fixture: Fixture, handle: LoginPeer, origins: readonly string[] = [config().publicOrigin],
): Promise<{ socket: MemorySocket; frames: unknown[] }> {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    void Promise.resolve().then(() => fixture.registry.handleUpgrade(handle, req, socket, head, requestId)).catch((error: unknown) => {
      // The real admission error settles the handshake; caller-owned early refusals close only this fixture socket.
      handshake.reject(error instanceof Error ? error : new Error('Upgrade refused before handshake'))
      socket.destroy()
    })
  })
  const [client, incoming] = pair()
  const frames: unknown[] = []
  let pending = Buffer.alloc(0)
  const handshake = Promise.withResolvers<undefined>()
  let upgraded = false
  client.once('close', () => { if (!upgraded) handshake.reject(new Error('Upgrade refused before handshake')) })
  client.on('data', (data: Buffer) => {
    pending = Buffer.concat([pending, data])
    if (!upgraded) {
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      expect(pending.subarray(0, end).toString('utf8')).toContain('101 Switching Protocols')
      pending = pending.subarray(end + 4)
      upgraded = true
      handshake.resolve(undefined)
    }
    while (pending.length >= 2) {
      const opcode = pending[0]! & 15
      let size = pending[1]! & 127
      let offset = 2
      if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4 }
      if (pending.length < offset + size) return
      if (opcode === 1) frames.push(JSON.parse(pending.subarray(offset, offset + size).toString('utf8')))
      pending = pending.subarray(offset + size)
    }
  })
  server.emit('connection', incoming)
  const originFields = origins.map(origin => `Origin: ${origin}\r\n`).join('')
  client.write(`GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${originFields}Cookie: ${fixture.cookieA}\r\n\r\n`)
  await handshake.promise
  return { socket: client, frames }
}

function openStream(socket: MemorySocket, id: string): void {
  const body = Buffer.from(JSON.stringify({ type: 'open', streamId: id, endpoint: 'accessPeerFixture/follow', payload: { args: {} } }))
  if (body.length >= 126) throw new Error('Small test frame required')
  const header = Buffer.from([0x81, body.length | 0x80, 1, 2, 3, 4])
  const mask = header.subarray(2)
  const masked = Buffer.from(body.map((value, index) => value ^ mask[index % 4]!))
  socket.write(Buffer.concat([header, masked]))
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

describe.skipIf(configPath === undefined)('internal login Peer with real PG/native services', () => {
  it('merges creation and reuses one Peer across real native HTTP and WS, without tying it to a socket', async () => {
    const fixture = await setup()
    const initialRequestUse = await fixture.borrow(fixture.bindingA)
    const handles = await Promise.all(Array.from({ length: 20 }, () => acquire(fixture)))
    const handle = handles[0]!
    expect(handles.every(item => item === handle)).toBe(true)
    expect(fixture.borrows.get(fixture.a.accountId)).toBe(2)
    initialRequestUse.release()
    fixture.registry.assertCurrent(handle, requestId)
    expect(handle.principal).toBe(fixture.a)
    await expect(memoryHttp(fixture, handle, fixture.cookieB)).rejects.toThrow()
    expect(await memoryHttp(fixture, handle)).toMatchObject({ result: { ok: true, value: { peer: handle.peer.id } } })
    const ws = await memoryWebsocket(fixture, handle)
    openStream(ws.socket, 'first')
    await vi.waitFor(() => { expect(ws.frames).toContainEqual({ type: 'item', streamId: 'first', value: { peer: handle.peer.id } }) })
    ws.socket.destroy()
    await vi.waitFor(() => { expect(fixture.registry.reservedCarriers).toBe(0) })
    expect(handle.peer.signal.aborted).toBe(false)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(await acquire(fixture)).toBe(handle)
    await fixture.registry.close(Date.now() + 2000)
    expect(handle.peer.signal.aborted).toBe(true)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(2)
    expect(fixture.registry.reservedPeers).toBe(0)
  })

  it.each([
    { name: 'missing', origins: [] },
    { name: 'cross-origin', origins: ['https://other.example.test'] },
    { name: 'literal-null', origins: ['null'] },
    { name: 'duplicate', origins: [config().publicOrigin, config().publicOrigin] },
  ])('refuses $name WS Origin before DB authentication, native upgrade or logical dispatch', async ({ origins }) => {
    const beforeStream = vi.fn()
    const fixture = await setup({}, undefined, ports => ({ ...ports, beforeStream }))
    const initialUse = await fixture.borrow(fixture.bindingA)
    const gateway = initialUse.context.get('typertGateway')
    if (!(gateway instanceof TypertGatewayService)) throw new Error('Real fixture Gateway unavailable')
    const realFactory = gateway.createNodeStreamTransport.bind(gateway)
    let nativeUpgradeCalls = 0
    const factory = vi.spyOn(gateway, 'createNodeStreamTransport').mockImplementation((peer, guard) => {
      const native = realFactory(peer, guard)
      return { ...native, handleUpgrade: (...args: Parameters<typeof native.handleUpgrade>) => {
        nativeUpgradeCalls++
        native.handleUpgrade(...args)
      } }
    })
    const handle = await acquire(fixture)
    initialUse.release()
    expect(factory).toHaveBeenCalledOnce()
    const authenticate = vi.spyOn(fixture.auth, 'authenticate')
    await expect(memoryWebsocket(fixture, handle, origins)).rejects.toMatchObject({ code: 'cloud/forbidden', status: 403 })
    expect(authenticate).not.toHaveBeenCalled()
    expect(fixture.auth.pendingOperations).toBe(0)
    expect(nativeUpgradeCalls).toBe(0)
    expect(beforeStream).not.toHaveBeenCalled()
    expect(fixture.contexts.get(fixture.a.accountId)?.get('accessPeerFixture')?.peers).toHaveLength(0)
    expect(fixture.registry.reservedCarriers).toBe(0)
    expect(handle.peer.signal.aborted).toBe(false)
  })

  it('closes exact revoked login carriers and Peer while B keeps serving native calls', async () => {
    const fixture = await setup()
    const a = await acquire(fixture)
    const b = await acquire(fixture, fixture.b, fixture.bindingB)
    const ws = await memoryWebsocket(fixture, a)
    await fixture.auth.revokeLogin(fixture.a.authSessionId, requestId)
    await vi.waitFor(() => { expect(ws.socket.readableEnded).toBe(true) })
    expect(a.peer.signal.aborted).toBe(true)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    fixture.registry.assertCurrent(b, requestId)
    expect(await memoryHttp(fixture, b, fixture.cookieB)).toMatchObject({ result: { ok: true, value: { peer: b.peer.id } } })
    expect(b.peer.signal.aborted).toBe(false)
  })

  it('ends only each caller wait, bounds waiting records, and releases late borrow after epoch end', async () => {
    const gate = Promise.withResolvers<undefined>()
    const fixture = await setup({ maxPeers: 1, maxPeersPerAccount: 1, maxPeerWaiters: 1, maxPeerWaitersPerAccount: 1 }, gate.promise)
    const abort = new AbortController()
    const abandoned = fixture.registry.acquire(fixture.a, fixture.bindingA, Date.now() + 2000, abort.signal, requestId)
    await expect(acquire(fixture)).rejects.toMatchObject({ code: 'cloud/capacity' })
    abort.abort()
    await expect(abandoned).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(fixture.registry.waitingCallers).toBe(0)
    await expect(fixture.registry.acquire(fixture.a, fixture.bindingA, Date.now() + 10, undefined, requestId)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(fixture.registry.waitingCallers).toBe(0)
    expect(fixture.registry.reservedPeers).toBe(1)
    await expect(acquire(fixture, fixture.b, fixture.bindingB)).rejects.toMatchObject({ code: 'cloud/capacity' })
    fixture.lifetimeA.abort()
    await expect(fixture.registry.closeBinding(fixture.bindingA, Date.now() + 10)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(fixture.releases.size).toBe(0)
    gate.resolve(undefined)
    await fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000)
    expect(fixture.borrows.get(fixture.a.accountId)).toBe(1)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(fixture.registry.reservedPeers).toBe(0)
  })

  it('keeps root-close ownership through a pending borrow and releases its late Use exactly once', async () => {
    const gate = Promise.withResolvers<undefined>()
    const fixture = await setup({}, gate.promise)
    const creating = acquire(fixture)
    const stopping = fixture.registry.close(Date.now() + 20)
    await expect(creating).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(stopping).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(fixture.registry.reservedPeers).toBe(1)
    expect(fixture.releases.size).toBe(0)
    gate.resolve(undefined)
    await fixture.registry.close(Date.now() + 2000)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(fixture.registry.reservedPeers).toBe(0)
    await expect(acquire(fixture, fixture.b, fixture.bindingB)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('watches real login expiry and closes native Peer without waiting for another request', async () => {
    const fixture = await setup({ sessionRecheckMs: 400 })
    const handle = await acquire(fixture)
    await fixture.expireA()
    await vi.waitFor(() => { expect(handle.peer.signal.aborted).toBe(true) }, { timeout: 2000 })
    await fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(fixture.registry.reservedPeers).toBe(0)
    const freshB = await fixture.auth.authenticate(authRequest(fixture.cookieB), requestId)
    const b = await acquire(fixture, freshB, fixture.bindingB)
    fixture.registry.assertCurrent(b, requestId)
  })

  it.each(['http', 'upgrade'] as const)('settles an expired-session %s read whose real deletion hook invalidates its own Peer', async (carrier) => {
    // Completion must precede both product deadlines; no timeout is used to break a callback cycle.
    const fixture = await setup({ authCheckTimeoutMs: 10_000, peerCloseTimeoutMs: 10_000 })
    const handle = await acquire(fixture)
    await fixture.expireA()
    const result = carrier === 'http' ? memoryHttp(fixture, handle) : memoryWebsocket(fixture, handle)
    await expect(result).rejects.toThrow()
    await vi.waitFor(() => {
      expect(fixture.invalidations).toEqual([{ id: fixture.a.authSessionId, returned: true }])
      expect(fixture.auth.pendingOperations).toBe(0)
      expect(fixture.registry.reservedCarriers).toBe(0)
      expect(fixture.registry.reservedPeers).toBe(0)
    }, { timeout: 2000 })
    expect(handle.peer.signal.aborted).toBe(true)
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(fixture.failures).toHaveLength(0)
  })

  it('joins a due original-login DB recheck and refuses dispatch until freshness is confirmed', async () => {
    const fixture = await setup({ sessionRecheckMs: 300 })
    const handle = await acquire(fixture)
    const started = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const realRecheck = fixture.auth.recheckLogin.bind(fixture.auth)
    const recheck = vi.spyOn(fixture.auth, 'recheckLogin').mockImplementation(async (principal, id) => {
      started.resolve(undefined)
      await gate.promise
      await realRecheck(principal, id)
    })
    await started.promise
    expect(() => { fixture.registry.assertCurrent(handle, requestId) }).toThrow()
    expect(() => { fixture.registry.assertCurrent(handle, requestId) }).toThrow()
    expect(handle.peer.signal.aborted).toBe(false)
    expect(fixture.releases.size).toBe(0)
    expect(recheck).toHaveBeenCalledOnce()
    gate.resolve(undefined)
    await vi.waitFor(() => { expect(() => { fixture.registry.assertCurrent(handle, requestId) }).not.toThrow() })
    expect(recheck).toHaveBeenCalledWith(handle.principal, expect.any(String))
    expect(handle.peer.signal.aborted).toBe(false)
  })

  it('counts preparing epochs against the account limit before real borrow settles', async () => {
    const gate = Promise.withResolvers<undefined>()
    const fixture = await setup({ maxPeersPerAccount: 1 }, gate.promise)
    const preparing = acquire(fixture)
    const otherEpoch = { ...fixture.bindingA, epoch: '91003' as OwnerEpoch }
    await expect(acquire(fixture, fixture.a, otherEpoch)).rejects.toMatchObject({ code: 'cloud/capacity' })
    gate.resolve(undefined)
    const handle = await preparing
    expect(handle.binding).toBe(fixture.bindingA)
    expect(fixture.borrows.get(fixture.a.accountId)).toBe(1)
  })

  it('retains capacity and Use when real native close completes but its result becomes unknown', async () => {
    const fixture = await setup({ maxPeers: 1, maxPeersPerAccount: 1 })
    const handle = await acquire(fixture)
    const nativeDispose = handle.peer.dispose.bind(handle.peer)
    vi.spyOn(handle.peer, 'dispose').mockImplementation(async () => { await nativeDispose(); throw new Error('Injected uncertain completion') })
    await expect(fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(handle.peer.signal.aborted).toBe(true)
    expect(fixture.registry.reservedPeers).toBe(1)
    expect(fixture.releases.size).toBe(0)
    expect(fixture.failures).toHaveLength(1)
    await expect(acquire(fixture)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(acquire(fixture, fixture.b, fixture.bindingB)).rejects.toMatchObject({ code: 'cloud/capacity' })
  })

  it('observes a real Cordis Peer disposer error even though native Peer.dispose fulfills', async () => {
    const fixture = await setup({ maxPeers: 1, maxPeersPerAccount: 1 })
    const handle = await acquire(fixture)
    handle.peer.ctx.effect(() => () => { throw new Error('Fixture native disposer failure') }, 'fixture: contained cleanup error')
    // Native Cordis reports and contains this failure. The registry must reject its own clean receipt.
    await expect(fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000))
      .rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    await expect(handle.peer.dispose()).resolves.toBeUndefined()
    expect(fixture.failures).toHaveLength(1)
    expect(fixture.registry.reservedPeers).toBe(1)
    expect(fixture.releases.size).toBe(0)
    await expect(acquire(fixture, fixture.b, fixture.bindingB)).rejects.toMatchObject({ code: 'cloud/capacity' })
  })

  it('bounds live native carriers while socket closure leaves the login Peer reusable', async () => {
    const fixture = await setup({ maxPeerCarriersPerLogin: 1 })
    const handle = await acquire(fixture)
    const ws = await memoryWebsocket(fixture, handle)
    expect(fixture.registry.reservedCarriers).toBe(1)
    const [extra] = pair()
    const request = authRequest(fixture.cookieA)
    request.headers.origin = config().publicOrigin
    request.rawHeaders.push('Origin', config().publicOrigin)
    await expect(Promise.resolve().then(() => fixture.registry.handleUpgrade(
      handle, request, extra, Buffer.alloc(0), requestId,
    ))).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(fixture.registry.reservedCarriers).toBe(1)
    ws.socket.destroy()
    await vi.waitFor(() => { expect(fixture.registry.reservedCarriers).toBe(0) })
    expect(await acquire(fixture)).toBe(handle)
    expect(fixture.releases.size).toBe(0)
  })

  it('keeps actual native cleanup after a deadline and confirms release only when it settles', async () => {
    const fixture = await setup({ peerCloseTimeoutMs: 10 })
    const handle = await acquire(fixture)
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const nativeDispose = handle.peer.dispose.bind(handle.peer)
    const dispose = vi.spyOn(handle.peer, 'dispose').mockImplementation(async () => {
      await nativeDispose()
      started.resolve(undefined)
      await gate.promise
    })
    const deadline = fixture.registry.closeBinding(fixture.bindingA, Date.now() + 30)
    await started.promise
    expect(handle.peer.signal.aborted).toBe(true)
    expect(fixture.releases.size).toBe(0)
    await expect(deadline).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(fixture.registry.reservedPeers).toBe(1)
    expect(fixture.failures).toHaveLength(1)
    gate.resolve(undefined)
    await fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000)
    expect(dispose).toHaveBeenCalledOnce()
    expect(fixture.releases.get(fixture.a.accountId)).toBe(1)
    expect(fixture.registry.reservedPeers).toBe(0)
  })

  it('checks exposure and freshness before each logical WS open, preserving native failure envelopes', async () => {
    let allowed = true
    const seen: string[] = []
    const fixture = await setup({}, undefined, ports => ({ ...ports, beforeStream: (endpoint) => {
      seen.push(endpoint)
      if (!allowed) throw new RemoteError('cloud/forbidden', 'Stream not permitted.', {
        code: 'cloud/forbidden', message: 'Stream not permitted.', requestId, retry: 'never',
      })
    } }))
    const handle = await acquire(fixture)
    const ws = await memoryWebsocket(fixture, handle)
    openStream(ws.socket, 'allowed')
    await vi.waitFor(() => { expect(ws.frames).toContainEqual({ type: 'item', streamId: 'allowed', value: { peer: handle.peer.id } }) })
    allowed = false
    openStream(ws.socket, 'denied')
    await vi.waitFor(() => {
      expect(ws.frames.find(frame => typeof frame === 'object' && frame !== null
        && 'type' in frame && frame.type === 'error' && 'streamId' in frame && frame.streamId === 'denied'))
        .toMatchObject({ error: { code: 'cloud/forbidden' } })
    })
    expect(seen).toHaveLength(2)
    expect(fixture.contexts.get(fixture.a.accountId)?.get('accessPeerFixture')?.peers).toHaveLength(1)
    fixture.lifetimeA.abort()
    await fixture.registry.closeBinding(fixture.bindingA, Date.now() + 2000)
    expect(handle.peer.signal.aborted).toBe(true)
  })
})
