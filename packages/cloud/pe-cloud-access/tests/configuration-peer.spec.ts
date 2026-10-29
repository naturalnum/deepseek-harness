/** Original native Loader/Gateway/login registry/carrier handoff;
 * M1 database results and runtime Use issuance are explicit external fixtures. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import type { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Deque } from '../../../util/deque/src/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Gateway, { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { bindTypertRemote, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { apply as connectionApply, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import type { AccountBinding, AccountId, AccountUse, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Auth } from 'better-auth'
import pg from 'pg'
import { expect, it, onTestFinished, vi } from 'vitest'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { ConfigSaveCoordinator } from '@deepseek-ai/dsh-pe-cloud-api'
import { bindNativeConfigSaveHook } from '../../pe-cloud-api/src/native-save-hook.ts'
import z from '@deepseek-ai/schemastery'
import { BetterAuthAccess } from '../src/auth.ts'
import { LoginPeerRegistry, type ConfigurationPeerOperation, type LoginPeer } from '../src/peers.ts'
import { accessConfig, carrier } from './ingress-fixture.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionHistoryController } from '../../../api/session-controller/src/history.ts'
import { installSessionReadTestServices, testSessionPersistence } from '../../../api/session-controller/tests/test-remote.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { generationLogPath, toHeaderLine } from '../../../session/session-persistence-jsonl/src/format.ts'

const jsonlCloseFault = vi.hoisted(() => ({ path: '', entered: undefined as (() => void) | undefined,
  release: undefined as Promise<unknown> | undefined, failure: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, open: (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (args[0] !== jsonlCloseFault.path || args[1] !== 'r' || jsonlCloseFault.failure === undefined) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'close') return async () => {
        jsonlCloseFault.entered?.()
        await jsonlCloseFault.release
        await target.close()
        throw jsonlCloseFault.failure
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }) as typeof actual.open }
})

declare module '@deepseek-ai/cordis' { interface Context { configurationPeerOperation: Service } }
const requestId = brandString<Parameters<BetterAuthAccess['authenticate']>[1]>('configuration-peer-component')
interface NativeWebSocket extends EventEmitter {
  readonly readyState: number
  send(value: string): void
  terminate(): void
}
// The Gateway's declared ws dependency supplies the real client and server protocol implementation.
const gatewayRequire = createRequire(new URL('../../../api/gateway/package.json', import.meta.url))
const NativeWebSocketClient = gatewayRequire('ws') as new (
  url: string, options: { headers: Record<string, string> }
) => NativeWebSocket

async function fixture(peerCloseTimeoutMs = 1000) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'configuration-peer-'))), dir = join(home, 'profile')
  mkdirSync(dir); initProfile(dir, [])
  const anchor = join(home, 'package.json'); writeFileSync(anchor, '{"name":"configuration-peer-owned","dependencies":{}}')
  const profile: ProfileContext = { name: 'peer', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: anchor, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>('account'),
    epoch: brandString<OwnerEpoch>('original-epoch'), recipeVersion: 'peer-component', lifetime: new AbortController().signal })
  const saveOwner = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 4, maxWaitersPerAccount: 2 })
  const saves = saveOwner.createAccount(binding)
  let registry: LoginPeerRegistry | undefined = undefined
  let auth: BetterAuthAccess | undefined = undefined, ctx: Context | undefined = undefined
  let expectedCleanupFailure = false
  const gates: Array<() => void | Promise<void>> = [], cleanupFailures: unknown[] = []
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 30 })
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('No physical M1 connection in this component') })
  const query = vi.spyOn(pool, 'query')
  let borrowed = 0, released = 0, inUse = 0, calls = 0
  let consume: ConfigurationPeerOperation<unknown> = async () => { throw new Error('No admitted test operation') }
  onTestFinished(async () => {
    for (const finish of gates) await finish()
    try {
      if (expectedCleanupFailure) await registry?.closeActual().catch(() => {})
      else await registry?.closeActual()
      await auth?.close()
      await saves.stopConfigSaves(Date.now() + 1000)
      await ctx?.fiber.dispose()
      saveOwner.releaseAccount(saves); saveOwner.close()
    }
    finally { await pool.end(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) }
  })
  const config = { ...accessConfig(), sessionRecheckMs: 60000, peerCloseTimeoutMs }
  auth = await BetterAuthAccess.create(config, pool, 'configuration-peer-component-secret-0123456789',
    async (login) => { await registry?.invalidateLogin(login) })
  const library = Reflect.get(auth, 'auth') as Auth
  const now = new Date(), expiresAt = new Date(Date.now() + 60000)
  vi.spyOn(library.api, 'getSession').mockImplementation(async (input) => {
    const cookie = new Headers(input?.headers).get('cookie') ?? 'login=a'
    return { user: { id: 'account', name: 'account', email: 'account@example.test', emailVerified: false, createdAt: now, updatedAt: now },
      session: { id: cookie, userId: 'account', token: cookie, expiresAt, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null } }
  })
  const originalAuth = auth
  class NativePeerOperation extends Service {
    readonly typertRemote = bindTypertRemote(this, 'configurationPeerOperation')
    constructor(owner: Context) { super(owner, 'configurationPeerOperation') }
    @Remote
    operate(mode: 'if-idle' | 'stop-and-apply'): Promise<unknown> {
      const peer = this.ctx.invocation?.peer
      if (peer === undefined || registry === undefined) throw new Error('Original native Peer absent')
      return registry.withConfigurationPeer(peer, () => {}, async (...args) => { calls++; return consume(...args) }, mode)
    }
  }
  class NativeEditor extends ConfigEditor {
    constructor(owner: Context) { super(owner); bindNativeConfigSaveHook(owner, saves, this) }
  }
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([{ id: 'dependencies', name: 'cordis:dependencies' },
    { id: 'connection', name: 'cordis:connection' }, { id: 'operation', name: 'cordis:operation' },
    { id: 'editor', name: 'cordis:editor' }, { id: 'transport-probe', name: 'cordis:transport-probe', config: { value: 1 } }]))
  ctx = await boot('dsh', configPath, [], (owner) => {
    owner.provide('profileContext', profile); owner.provide('peAccount', binding)
    Object.assign(owner.loader.builtins, { dependencies: { async apply(scope: Context) {
      await scope.plugin(Typert); await scope.plugin(RemoteAccess); await scope.plugin(LocalCredentials, { path: join(home, 'credentials.json'), watch: false }); await scope.plugin(Gateway)
    } }, connection: { apply: connectionApply, inject: [...connectionInject] }, operation: NativePeerOperation,
    editor: NativeEditor, 'transport-probe': { Config: z.object({ value: z.number().default(1).volatile() }), apply() {} } })
  })
  const native = ctx
  const issueUse = (actual: AccountBinding): AccountUse => {
    if (actual !== binding) throw new Error('Fixture generation differs')
    borrowed++; inUse++
    let done = false
    return { binding, context: native, assertCurrent() {
      if (done) throw new Error('Actually released original fixture Use')
      native.fiber.assertActive(); binding.lifetime.throwIfAborted()
    }, release() { if (!done) { done = true; released++; inUse-- } } }
  }
  registry = new LoginPeerRegistry({ ...config, sessionRecheckLeadMs: 0 }, originalAuth, {
    borrow: async actual => issueUse(actual), beforeHttp() {}, beforeStream() {}, cleanupFailed(value) { cleanupFailures.push(value) },
    streams: { maxFrameBytes: 16384, maxLogicalStreams: 8, maxLogicalStreamsPerAccount: 4, maxLogicalStreamsPerPeer: 2 },
  })
  const peers = registry
  const acquire = async (cookie: string): Promise<LoginPeer> => {
    const c = carrier('/api/configurationPeerOperation/operate', 'POST', ['Cookie', cookie])
    gates.push(() => { c.request.destroy(); c.socket.destroy() })
    const principal = await originalAuth.authenticate(c.request, requestId)
    return peers.acquire(principal, binding, Date.now() + 1000, undefined, requestId)
  }
  const run = (handle: LoginPeer, mode: 'if-idle' | 'stop-and-apply') => {
    const c = carrier('/api/configurationPeerOperation/operate', 'POST', ['Cookie', handle.principal.authSessionId])
    const actual = Promise.withResolvers<undefined>()
    gates.push(() => { actual.resolve(undefined); c.request.destroy(); c.socket.destroy() })
    let value: unknown
    const body = peers.runCarrier(handle, c.request, requestId, {
      authenticate: () => originalAuth.authenticate(c.request, requestId), actual: actual.promise,
      destroy: () => { c.request.destroy(); c.socket.destroy() },
      consume: async () => { value = await native.typertGateway.invoke({ namespace: 'configurationPeerOperation', method: 'operate', args: { mode }, peer: handle.peer }) },
    })
    void body.catch((_cause: unknown) => {})
    return { body, finish: () => { actual.resolve(undefined) }, value: () => value }
  }
  const writeNativeValue = async (value: number, current: () => void): Promise<void> => {
    current()
    const entry = native.configEditor.entries().find(row => row.options.id === 'transport-probe')
    if (entry === undefined) throw new Error('Original native configuration target missing')
    expect((await saves.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
    await saves.withPausedPluginChange(() => native.configEditor.edit(entry, () => ({ value }), { assertCurrent: current }))
    await native.loader.await(); current(); saves.resumeAccountChanges()
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('value: ' + String(value))
  }
  // Loopback transports exercise Node's actual HTTP/WS sockets and close events.
  const http = async (handle: LoginPeer, releaseRequestUse: () => void) => {
    const bridged = Promise.withResolvers<undefined>()
    void bridged.promise.catch((_cause: unknown) => {})
    const server = createServer((request, response) => {
      void peers.handleNodeRequest(handle, request, response, 4096, requestId, releaseRequestUse).then(
        () => { bridged.resolve(undefined) }, (error: unknown) => { response.destroy(); bridged.reject(error) },
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Owned HTTP listener unavailable')
    let answer: unknown
    const request = httpRequest(`http://127.0.0.1:${String(address.port)}/api/configurationPeerOperation/operate`, {
      method: 'POST', headers: { cookie: handle.principal.authSessionId, origin: config.publicOrigin,
        host: new URL(config.publicOrigin).host, 'content-type': 'application/json', connection: 'close' },
    })
    const returned = new Promise<void>((resolve, reject) => {
      request.once('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.on('end', () => {
          try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve() } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error('Invalid native HTTP response', { cause: error }))
          }
        })
        response.on('error', reject)
      })
      request.on('error', reject)
    })
    gates.push(async () => {
      request.destroy(); server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    })
    request.end(JSON.stringify({ type: 'client-request', rpcId: '11111111-1111-4111-8111-111111111111',
      method: 'configurationPeerOperation/operate', payload: { args: { mode: 'if-idle' } } }))
    const body = Promise.all([returned, bridged.promise]).then(() => {})
    void body.catch((_cause: unknown) => {})
    return { body, actual: bridged.promise, disconnect: () => { request.destroy() }, result: (): unknown => answer }
  }
  const websocket = async (handle: LoginPeer, endpoint = '$events', waitForReady = true) => {
    // External event producer is idle; ready, framing and close come from the original Gateway.
    const unregister = native.typertGateway.registerRemoteEvents(async function *(signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }, { home })
    gates.push(unregister)
    const server = createServer()
    const sockets = new Set<import('node:stream').Duplex>()
    const upgraded = Promise.withResolvers<undefined>()
    void upgraded.promise.catch((_cause: unknown) => {})
    server.on('upgrade', (request, socket, head) => {
      sockets.add(socket); socket.once('close', () => { sockets.delete(socket) })
      void peers.handleUpgrade(handle, request, socket, head, requestId).then(() => { upgraded.resolve(undefined) }, (error: unknown) => {
        upgraded.reject(error); socket.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Owned WS listener unavailable')
    const client = new NativeWebSocketClient(`ws://127.0.0.1:${String(address.port)}/api/remote.mux`, {
      headers: { cookie: handle.principal.authSessionId, origin: config.publicOrigin, host: new URL(config.publicOrigin).host },
    })
    const opened = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
    const ready = Promise.withResolvers<undefined>()
    void ready.promise.catch(() => {})
    let didClose = false
    const frames: unknown[] = []
    client.once('open', () => { opened.resolve(undefined) })
    client.once('error', (error) => { opened.reject(error); ready.reject(error) })
    client.once('close', () => { didClose = true; closed.resolve(undefined) })
    client.on('message', (data: Buffer) => {
      const frame: unknown = JSON.parse(data.toString('utf8')); frames.push(frame)
      if (frame !== null && typeof frame === 'object' && Reflect.get(frame, 'type') === 'error') {
        ready.reject(new Error(JSON.stringify(frame)))
      }
      if (frame !== null && typeof frame === 'object' && Reflect.get(frame, 'type') === 'item') {
        const value: unknown = Reflect.get(frame, 'value')
        if (value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'ready') ready.resolve(undefined)
      }
    })
    gates.push(async () => {
      client.terminate(); for (const socket of sockets) socket.destroy(); server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    })
    await Promise.all([opened.promise, upgraded.promise])
    client.send(JSON.stringify({ type: 'open', streamId: 'original-observation', endpoint, payload: { args: {} } }))
    if (waitForReady) await ready.promise
    return { frames, client, closed: closed.promise, didClose: () => didClose }
  }
  return { ctx: native, registry: peers, binding, acquire, run, http, websocket, query, cleanupFailures,
    writeNativeValue, patch: () => readFileSync(profile.patchPath, 'utf8'), saves,
    issueUse: () => issueUse(binding), observe: () => ({ borrowed, released, inUse, calls }),
    setOperation: (next: ConfigurationPeerOperation<unknown>) => { consume = next },
    expectCleanupFailure: () => { expectedCleanupFailure = true } }
}

it('retains a real JSONL header close failure after follow cancellation in the original Peer and mux', async () => {
  const f = await fixture(1000)
  const closeEntered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-jsonl-observation-')))
  onTestFinished(() => { release.resolve(undefined); jsonlCloseFault.path = ''; jsonlCloseFault.failure = undefined
    jsonlCloseFault.entered = undefined; jsonlCloseFault.release = undefined; rmSync(root, { recursive: true, force: true }) })
  await f.ctx.plugin(SessionStore)
  await f.ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  installSessionReadTestServices(f.ctx)
  const id = SessionId('peer-jsonl-close-failure')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const path = generationLogPath(root, header.cwd, id, SESSION_FORMAT_VERSION, 'none')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(toHeaderLine(header)) + '\n')
  const failure = new Error('actual JSONL header close failed')
  jsonlCloseFault.path = path; jsonlCloseFault.entered = () => { closeEntered.resolve(undefined) }
  jsonlCloseFault.release = release.promise; jsonlCloseFault.failure = failure
  const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation((sessionId, options) => {
    options?.signal?.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    return observe(sessionId, options)
  })
  const history = new SessionHistoryController(f.ctx, () => { throw new Error('No promotion expected') })
  class FollowFixture extends TypertRemoteService {
    constructor(owner: Context) { super(owner, 'session') }
    @Remote({ mode: 'stream' })
    follow(signal: AbortSignal) { return history.follow({ address: { kind: 'session', sessionId: id } }, signal) }
  }
  await f.ctx.plugin(FollowFixture)
  const handle = await f.acquire('login=a'), socket = await f.websocket(handle, 'session/follow', false)
  await closeEntered.promise
  const entries = Reflect.get(f.registry, 'entries') as Map<string, {
    phase: string
    streamCount: number
    mux: { close(): Promise<void> }
  }>
  const entry = [...entries.values()][0]
  if (entry === undefined) throw new Error('Expected retained Peer entry')
  const mux = entry.mux
  f.expectCleanupFailure()
  socket.client.send(JSON.stringify({ type: 'cancel', streamId: 'original-observation' }))
  await cancelled.promise
  expect(entry.streamCount).toBe(1); expect(f.observe().inUse).toBe(1)
  release.resolve(undefined)
  await vi.waitFor(() => { expect(entry.phase).toBe('blocked') })
  expect(entry.streamCount).toBe(1); expect(f.observe().inUse).toBe(1)
  await expect(mux.close()).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    cause: { name: 'JsonlReadCleanupError', cause: failure } })
  await expect(f.registry.closeActual()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
})

it('detaches the cancelled follow while the actual Peer and mux still await its opening read', async () => {
  const f = await fixture(1000)
  const entered = Promise.withResolvers<undefined>(), cancelled = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  await f.ctx.plugin(SessionStore)
  installSessionReadTestServices(f.ctx)
  f.ctx.provide('sessionPersistence', testSessionPersistence(f.ctx, {
    async stat(_id, options) {
      const signal = options?.signal
      if (signal === undefined) throw new Error('Expected the opening cancellation signal')
      signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      await release.promise
      return undefined
    },
  }) as never)
  const id = SessionId('peer-follow-buffer')
  const history = new SessionHistoryController(f.ctx, () => { throw new Error('No promotion expected') })
  class FollowFixture extends TypertRemoteService {
    constructor(owner: Context) { super(owner, 'session') }
    @Remote({ mode: 'stream' })
    follow(signal: AbortSignal) { return history.follow({ address: { kind: 'session', sessionId: id } }, signal) }
  }
  await f.ctx.plugin(FollowFixture)
  const handle = await f.acquire('login=a')
  const socket = await f.websocket(handle, 'session/follow', false)
  await entered.promise
  const push = vi.spyOn(Deque.prototype, 'pushBack')
  const event = { type: 'turn/start', seq: 0 }
  f.ctx.emit('session/event', { id } as never, event as never)
  const index = push.mock.calls.findIndex(([value]) => typeof value === 'object' && value !== null && Reflect.get(value, 'event') === event)
  if (index < 0) throw new Error('Expected the real follow buffer to receive an event')
  const buffer = push.mock.instances[index] as Deque<unknown>
  expect(buffer.size).toBe(1)
  f.expectCleanupFailure()
  socket.client.send(JSON.stringify({ type: 'cancel', streamId: 'original-observation' }))
  await cancelled.promise
  expect(buffer.size).toBe(0)
  for (let i = 0; i < 10; i += 1) f.ctx.emit('session/event', { id } as never, event as never)
  expect(buffer.size).toBe(0)
  const entries = Reflect.get(f.registry, 'entries') as Map<string, { phase: string; streamCount: number }>
  const entry = [...entries.values()][0]
  if (entry === undefined) throw new Error('Expected retained Peer entry')
  expect(entry.streamCount).toBe(1)
  expect(f.observe().inUse).toBe(1)
  release.resolve(undefined)
  await vi.waitFor(() => { expect(entry.phase).toBe('blocked') })
  await expect(f.registry.closeActual()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
})

it('releases actual original Uses, joins the pure observer Peer and restores one new Use with the same native root and epoch', async () => {
  const f = await fixture(), active = await f.acquire('login=a'), observer = await f.acquire('login=b')
  expect(f.observe()).toMatchObject({ borrowed: 2, released: 0, inUse: 2 })
  f.setOperation(async (binding, context, current, close) => {
    current(); expect(binding).toBe(f.binding); expect(context.root).toBe(f.ctx.root)
    expect(f.observe().inUse).toBe(1)
    await close()
    expect(f.observe().inUse).toBe(0)
    expect(() =>{  f.registry.assertCurrent(observer, requestId) }).toThrow()
    current(); return { nativeOperation: 'settled' }
  })
  const request = f.run(active, 'if-idle')
  await request.body; request.finish()
  expect(request.value()).toEqual({ nativeOperation: 'settled' })
  expect(f.observe()).toMatchObject({ borrowed: 3, released: 2, inUse: 1, calls: 1 })
  f.registry.assertCurrent(active, requestId)
  expect(f.query).not.toHaveBeenCalled(); expect(f.cleanupFailures).toEqual([])
})

it('rejects a second actual carrier before releasing Uses or calling the configuration consumer', async () => {
  const f = await fixture(), peer = await f.acquire('login=a')
  const hold = carrier('/held', 'POST', ['Cookie', 'login=a']), completed = Promise.withResolvers<undefined>()
  const pending = f.registry.runCarrier(peer, hold.request, requestId, {
    authenticate: async () => peer.principal, actual: completed.promise, destroy() {}, consume: async () => {},
  })
  await pending
  try {
    const request = f.run(peer, 'if-idle')
    await expect(request.body).rejects.toMatchObject({ code: 'cloud/config-busy' }); request.finish()
    expect(f.observe()).toMatchObject({ borrowed: 1, released: 0, inUse: 1, calls: 0 })
  } finally { completed.resolve(undefined); hold.request.destroy(); hold.socket.destroy() }
})

it('waits the initiating original carrier after terminal acceptance, then closes it without waiting on its own RPC', async () => {
  const f = await fixture(), peer = await f.acquire('login=a'), settled = Promise.withResolvers<undefined>()
  let requestEnded = false
  let terminal: Promise<void> | undefined
  f.setOperation(async (_binding, _context, current, _close, handoff) => {
    current(); expect(f.observe().released).toBe(0)
    terminal = (async () => {
      await handoff.afterRequest(); requestEnded = true
      handoff.assertPrincipal(); await handoff.closeAll(Date.now() + 1000); settled.resolve(undefined)
    })()
    return { kind: 'accepted-only' }
  })
  const request = f.run(peer, 'stop-and-apply')
  await request.body
  expect(request.value()).toEqual({ kind: 'accepted-only' }); expect(requestEnded).toBe(false)
  request.finish(); await settled.promise; await terminal
  expect(requestEnded).toBe(true); expect(f.observe()).toMatchObject({ borrowed: 1, released: 1, inUse: 0 })
  expect(f.cleanupFailures).toEqual([])
})


it.each(['related-peer', 'initiating-mux'] as const)('bounds %s closure on the original native Peer and never publishes after timeout', async (variant) => {
  const f = await fixture(30), gate = Promise.withResolvers<undefined>()
  let writes = 0, login: (() => void) | undefined
  if (variant === 'initiating-mux') {
    const gateway = f.ctx.get('typertGateway')
    if (!(gateway instanceof TypertGatewayService)) throw new Error('Original native Gateway is unavailable')
    const create = gateway.createNodeStreamTransport.bind(gateway)
    vi.spyOn(gateway, 'createNodeStreamTransport').mockImplementation((...args) => {
      const mux = create(...args)
      return { ...mux, close: async () => { await gate.promise; await mux.close() } }
    })
  }
  const active = await f.acquire('login=a')
  if (variant === 'related-peer') {
    const observer = await f.acquire('login=b'), dispose = observer.peer.dispose.bind(observer.peer)
    vi.spyOn(observer.peer, 'dispose').mockImplementation(async () => { await gate.promise; await dispose() })
  }
  f.setOperation(async (_binding, _context, current, close) => {
    login = current
    await close()
    current(); writes++
  })
  const request = f.run(active, 'if-idle')
  try {
    await expect(request.body).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(writes).toBe(0)
    expect(() => { login?.() }).toThrow()
    if (variant === 'related-peer') expect(f.observe().inUse).toBe(1)
    expect(f.registry.reservedPeers).toBeGreaterThan(0)
  } finally { request.finish(); gate.resolve(undefined) }
  await f.registry.closeActual()
  expect(f.observe().inUse).toBe(0)
  expect(writes).toBe(0)
  expect(f.query).not.toHaveBeenCalled()
})


it('reports only bounded current-account Peer busy counts while a real other carrier remains retained', async () => {
  const f = await fixture(), peer = await f.acquire('login=private-counter-fixture')
  const held = carrier('/retained-private-request', 'POST', ['Cookie', 'private-counter-cookie'])
  const completed = Promise.withResolvers<undefined>()
  const pending = f.registry.runCarrier(peer, held.request, requestId, {
    authenticate: async () => peer.principal, actual: completed.promise, destroy() {}, consume: async () => {},
  })
  await pending
  try {
    const request = f.run(peer, 'if-idle')
    const error: unknown = await request.body.then(() => { throw new Error('Concurrent carrier was admitted') }, (error: unknown) => error)
    request.finish()
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'cloud/config-busy', message: 'The original account still owns non-observation Peer work.',
      details: { peerWork: { nonReadyPeers: 0, preparingPeers: 0, recheckingPeers: 0,
        cleanupFaultPeers: 0, businessStreamPeers: 0, otherTaskPeers: 1 } } })
    const details: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'details') : undefined
    expect(JSON.stringify(details)).not.toMatch(/private-counter|retained-private-request|cookie|account|epoch|requestId|peerId/i)
    expect(f.observe()).toMatchObject({ borrowed: 1, released: 0, inUse: 1, calls: 0 })
  } finally { completed.resolve(undefined); held.request.destroy(); held.socket.destroy() }
})


it('releases exactly the actual HTTP-owned reference after Peer admission before the original configuration consumer', async () => {
  const f = await fixture(), peer = await f.acquire('login=http-handoff')
  const ingressUse = f.issueUse()
  expect(f.observe()).toMatchObject({ borrowed: 2, released: 0, inUse: 2 })
  let handoffs = 0, entered = false
  f.setOperation(async (binding, context, current, close) => {
    entered = true; current(); expect(binding).toBe(f.binding); expect(context.root).toBe(f.ctx.root)
    expect(f.observe().inUse).toBe(0)
    await close(); current(); return { originalConsumer: 'settled' }
  })
  const request = await f.http(peer, () => { ingressUse.assertCurrent(); ingressUse.release(); handoffs++ })
  try {
    await request.body
    expect(handoffs).toBe(1); expect(entered).toBe(true)
    expect(request.result()).toMatchObject({ type: 'server-response', result: { ok: true, value: { originalConsumer: 'settled' } } })
    expect(f.observe()).toMatchObject({ borrowed: 3, released: 2, inUse: 1, calls: 1 })
    f.registry.assertCurrent(peer, requestId)
  } finally { ingressUse.release() }
})

it('does not consume the HTTP release capability when another real carrier triggers the original busy guard', async () => {
  const f = await fixture(), peer = await f.acquire('login=http-busy'), ingressUse = f.issueUse()
  const held = carrier('/held-http-work', 'POST', ['Cookie', 'login=http-busy']), completed = Promise.withResolvers<undefined>()
  await f.registry.runCarrier(peer, held.request, requestId, {
    authenticate: async () => peer.principal, actual: completed.promise, destroy() {}, consume: async () => {},
  })
  let handoffs = 0
  const request = await f.http(peer, () => { ingressUse.release(); handoffs++ })
  try {
    await request.body
    expect(request.result()).toMatchObject({ result: { ok: false, error: { code: 'cloud/config-busy',
      details: { peerWork: { otherTaskPeers: 1 } } } } })
    expect(handoffs).toBe(0); ingressUse.assertCurrent()
    expect(f.observe()).toMatchObject({ borrowed: 2, released: 0, inUse: 2, calls: 0 })
  } finally { completed.resolve(undefined); ingressUse.release(); held.request.destroy(); held.socket.destroy() }
})


it('joins a real native WebSocket observation before the same HTTP configuration result is returned', async () => {
  const f = await fixture(), peer = await f.acquire('login=actual-http-ws')
  const ws = await f.websocket(peer), ingressUse = f.issueUse()
  expect(ws.didClose()).toBe(false)
  const ready: unknown = expect.objectContaining({ type: 'ready' })
  expect(ws.frames).toContainEqual(expect.objectContaining({ type: 'item', value: ready }))
  let applied = false
  f.setOperation(async (_binding, _context, current, close) => {
    current(); expect(f.observe().inUse).toBe(0)
    await close(); await ws.closed; current()
    await f.writeNativeValue(2, current)
    applied = true
    return { originalConsumer: 'settled-after-native-ws-close' }
  })
  const request = await f.http(peer, () => { ingressUse.assertCurrent(); ingressUse.release() })
  try {
    await request.body
    expect(request.result()).toMatchObject({ result: { ok: true, value: { originalConsumer: 'settled-after-native-ws-close' } } })
    expect(applied).toBe(true); expect(ws.didClose()).toBe(true)
    f.registry.assertCurrent(peer, requestId)
    expect(f.observe()).toMatchObject({ borrowed: 3, released: 2, inUse: 1, calls: 1 })
  } finally { ingressUse.release() }
})


it('retains an actual native write and its pending HTTP task after the response carrier is lost', async () => {
  const f = await fixture(), peer = await f.acquire('login=native-write-reply-loss')
  const ws = await f.websocket(peer), ingressUse = f.issueUse()
  const committed = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  onTestFinished(() => { finish.resolve(undefined) })
  let returns = 0
  f.setOperation(async (_binding, _context, current, close) => {
    current(); await close(); await ws.closed; current()
    await f.writeNativeValue(2, current)
    committed.resolve(undefined)
    await finish.promise
    current(); returns++
    return { originalConsumer: 'native-write-settled' }
  })
  const request = await f.http(peer, () => { ingressUse.assertCurrent(); ingressUse.release() })
  try {
    await Promise.race([committed.promise, request.body.then(() => { throw new Error('HTTP settled before native write') })])
    expect(f.patch()).toContain('value: 2')
    expect(f.registry.reservedCarriers).toBeGreaterThan(0)
    request.disconnect()
    await expect(request.body).rejects.toBeInstanceOf(Error)
    expect(returns).toBe(0); expect(request.result()).toBeUndefined()
    expect(f.registry.reservedCarriers).toBeGreaterThan(0)
    finish.resolve(undefined)
    await Promise.allSettled([request.actual])
    expect(returns).toBe(1); expect(request.result()).toBeUndefined()
    expect(f.patch()).toContain('value: 2')
    expect(f.saves.snapshot()).toMatchObject({ pending: [], failures: [] })
  } finally { finish.resolve(undefined); ingressUse.release() }
})
