/** Real Gateway/history/JSONL flows; only unrelated recipe services and graph authority use fixtures. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as NativeStreamServer from '@deepseek-ai/dsh-api-gateway/src/stream-server.ts'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, AccountUse, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { BetterAuthAccess } from '@deepseek-ai/dsh-pe-cloud-access/src/auth.ts'
import { LoginPeerRegistry } from '@deepseek-ai/dsh-pe-cloud-access/src/peers.ts'
import type { AccessConfig, AuthenticatedPrincipal } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { CloudApiError } from '../src/errors.ts'
import { createNativeController, type NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Unused full-text search.')) }
}

afterEach(() => { vi.restoreAllMocks() })

async function fixture(exposure: 'history' | 'closed' | 'rpc-follow' = 'history') {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'native-history-')))
  const project = join(home, 'project')
  mkdirSync(project)
  const ctx = new Context()
  const streams: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    try { for (const close of streams) await close() }
    finally { try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } }
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Jsonl, { root: join(home, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'history', model: 'fixture' })
  new ExactQuery(ctx)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1_024, maxImagesPerMessage: 1, maxMessageImageBytes: 1_024,
      maxImagePixels: 1_024, maxImageDimension: 32, mediaTypes: ['image/png'],
    },
  })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('history'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m5-history', lifetime: lifetime.signal,
  })
  ctx.provide('peAccount', binding)
  const denied = new CloudApiError('cloud/account-unavailable', 'Fixture scope is not approved.')
  let admitted = true
  const assertCurrent = vi.fn((actual: AccountBinding): void => {
    expect(actual).toBe(binding)
    if (!admitted) throw denied
  })
  const guards = {
    projectDirectory: { binding, prepare: async () => { throw denied } },
    assertHandlerEnabled: vi.fn<NativeSessionGuards['assertHandlerEnabled']>(),
    resolveCreate: vi.fn<NativeSessionGuards['resolveCreate']>(async () => { throw denied }),
    assertActiveScope: vi.fn<NativeSessionGuards['assertActiveScope']>(() => { throw denied }),
    assertSessionProject: vi.fn<NativeSessionGuards['assertSessionProject']>(async (id) => {
      using observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      if (observed.header.cwd !== project) throw denied
    }),
  }
  const row = (endpoint: string) => ({ endpoint, handlerId: 'native-history', guard: 'account-session' as const })
  const manifest = {
    recipeVersion: binding.recipeVersion,
    rpcEndpoints: exposure === 'closed' ? [] : [row('session/page'), ...exposure === 'rpc-follow' ? [row('session/follow')] : []],
    streamEndpoints: exposure === 'history' ? [row('session/follow')] : [],
    exactFetchRoutes: [], allowedSettings: [],
  }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let controller: SessionController | undefined
  await ctx.plugin({
    inject: [...SessionController.inject, 'peAccount'],
    apply(scope) { controller = createNativeController(scope, binding, assertCurrent, policy, guards, { nativeOpen: false }) },
  })
  if (controller === undefined) throw new Error('Fixture Controller did not mount.')
  const peer: PeerScope = {
    id: brandString<PeerId>('native-history'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {},
  }
  const cold = async (name = 'cold-history'): Promise<SessionAddress & { kind: 'session' }> => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(name), meta: { cwd: project }, agentOptions: { provider: 'history', model: 'fixture' },
    })
    // JSONL must materialize before release: closing an unwritten empty Session erases it.
    await ctx.sessionPersistence.flush()
    await handle.dispose()
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    return { kind: 'session', sessionId: handle.agent.id }
  }
  const page = (address: SessionAddress, throughSeq = -1, signal?: AbortSignal): Promise<unknown> => ctx.typertGateway.invoke({
    namespace: 'session', method: 'page', args: { request: { address, throughSeq } }, peer,
    ...signal === undefined ? {} : { signal },
  })
  const follow = async (address: SessionAddress) => {
    const cancel = new AbortController()
    const source = await ctx.typertGateway.stream({
      namespace: 'session', method: 'follow', args: { request: { address, assistantStream: true } }, peer, signal: cancel.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    streams.push(async () => { cancel.abort(); await iterator.return?.() })
    return { iterator, cancel }
  }
  const listeners = () => ['session/event', 'session/created', 'agent/assistant-stream']
    .map(name => ctx.events.dispatch('emit', [name]).length)
  return {
    ctx, controller, project, binding, lifetime, denied, guards, assertCurrent, policy, cold, page, follow, listeners,
    stopAdmission: () => { admitted = false },
  }
}

it.each(['page', 'follow'] as const)('rejects %s scope before any native read or activation', async (method) => {
  const f = await fixture()
  const address = { kind: 'session' as const, sessionId: SessionId('denied-history') }
  f.guards.assertSessionProject.mockRejectedValueOnce(f.denied)
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const native = vi.spyOn(SessionController.prototype, method)
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  await expect(work).rejects.toBe(f.denied)
  expect(native).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(resume).not.toHaveBeenCalled()
})

it.each(['page', 'follow'] as const)('rechecks the binding after awaited %s project admission', async (method) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.guards.assertSessionProject.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const native = vi.spyOn(SessionController.prototype, method)
  const address = { kind: 'session' as const, sessionId: SessionId('stale-history') }
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  const rejected = expect(work).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  f.ctx.set('peAccount', { ...f.binding, epoch: brandString<OwnerEpoch>('2') })
  release.resolve(undefined)
  await rejected
  expect(native).not.toHaveBeenCalled()
})

it.each(['page', 'follow'] as const)('honors caller cancellation during awaited %s admission before native entry', async (method) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.guards.assertSessionProject.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const address = { kind: 'session' as const, sessionId: SessionId('cancel-during-guard') }
  const stream = method === 'follow' ? await f.follow(address) : undefined
  const cancel = stream?.cancel ?? new AbortController()
  const native = vi.spyOn(SessionController.prototype, method)
  const work = stream === undefined ? f.page(address, -1, cancel.signal) : stream.iterator.next()
  const rejected = expect(work).rejects.toMatchObject({ code: 'gateway/cancelled' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  cancel.abort()
  release.resolve(undefined)
  await rejected
  expect(native).not.toHaveBeenCalled()
})

it('uses native page on real cold JSONL without activating and preserves its validation error', async () => {
  const f = await fixture()
  const address = await f.cold()
  const native = vi.spyOn(SessionController.prototype, 'page')
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  await expect(f.page(address)).resolves.toEqual({ records: [], hasMore: false })
  expect(native).toHaveBeenCalledOnce()
  expect(f.guards.assertSessionProject).toHaveBeenCalledWith(address.sessionId)
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.sessions.get(address.sessionId)).toBeUndefined()
  await expect(f.page(address, 1)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(resume).not.toHaveBeenCalled()
})

it('refuses a page result when graph admission closes during the real native read', async () => {
  const f = await fixture()
  const address = await f.cold()
  f.guards.assertSessionProject.mockResolvedValueOnce(undefined)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
  vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    const observed = await observe(...args)
    entered.resolve(undefined)
    await release.promise
    return observed
  })
  const work = f.page(address)
  const rejected = expect(work).rejects.toBe(f.denied)
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([work]) })
  await entered.promise
  f.stopAdmission()
  release.resolve(undefined)
  await rejected
})

it('retains inherited Remote markers and native follow snapshot, delayed cold promotion and event delivery', async () => {
  const f = await fixture()
  for (const name of ['page', 'follow']) {
    expect(remoteMethods(f.controller).filter(marker => (marker.exportName ?? marker.method) === name)).toHaveLength(1)
  }
  const address = await f.cold()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const requireStream = vi.spyOn(f.policy, 'requireStream')
  const baseline = f.listeners()
  const { iterator } = await f.follow(address)
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot', cursor: -1, records: [] } })
  expect(resume).not.toHaveBeenCalled()
  expect(f.listeners()).toEqual(baseline.map(count => count + 1))
  const next = iterator.next()
  void next.catch(() => {})
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  expect(resume).toHaveBeenCalledOnce()
  await expect(next).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed', seq: 0 } } })
  const event = iterator.next()
  const agent = f.ctx.agents.get(address.sessionId)!
  agent.session.append('model/selection', { provider: 'history', model: 'fixture' })
  await expect(event).resolves.toMatchObject({ value: { type: 'event', event: { type: 'model/selection', seq: 1 } } })
  expect(requireStream).toHaveBeenCalledWith('session/follow')
  const withAgent = f.listeners()
  await iterator.return?.()
  // The resumed Agent retains its own persistence listener; only the three follower listeners leave.
  expect(f.listeners()).toEqual(withAgent.map(count => count - 1))
})

it.each(['gateway', 'controller'] as const)('does not promote when the caller aborts after the %s snapshot', async (entry) => {
  const f = await fixture()
  const address = await f.cold()
  const baseline = f.listeners()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const stream = entry === 'gateway' ? await f.follow(address) : undefined
  const cancel = stream?.cancel ?? new AbortController()
  const iterator = stream?.iterator ?? f.controller.follow({ address, assistantStream: true }, cancel.signal)[Symbol.asyncIterator]()
  if (stream === undefined) onTestFinished(async () => { cancel.abort(); await iterator.return?.() })
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
  cancel.abort()
  await expect(iterator.next()).rejects.toMatchObject(entry === 'gateway' ? { code: 'gateway/cancelled' } : { name: 'AbortError' })
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(address.sessionId)).toBeUndefined()
  expect(f.listeners()).toEqual(baseline)
})

it('checks before the next native advance so a closed graph cannot begin post-snapshot promotion', async () => {
  const f = await fixture()
  const address = await f.cold()
  const baseline = f.listeners()
  const resume = vi.spyOn(f.ctx.agents, 'resume')
  const { iterator } = await f.follow(address)
  await iterator.next()
  f.stopAdmission()
  await expect(iterator.next()).rejects.toBe(f.denied)
  expect(resume).not.toHaveBeenCalled()
  expect(f.ctx.agents.get(address.sessionId)).toBeUndefined()
  expect(f.listeners()).toEqual(baseline)
})

it('checks again after an awaited native frame before delivering data', async () => {
  const f = await fixture()
  const address = await f.cold()
  const { iterator } = await f.follow(address)
  await iterator.next()
  // A real empty-history resume announces its native end-seed suffix before waiting for new events.
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed' } } })
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  const next = iterator.next()
  void next.catch(() => {})
  f.stopAdmission()
  f.ctx.agents.get(address.sessionId)!.session.append('model/selection', { provider: 'history', model: 'fixture' })
  await expect(next).rejects.toBe(f.denied)
})

it.each(['caller', 'graph'] as const)('propagates %s cancellation into a waiting native iterator and cleans listeners', async (kind) => {
  const f = await fixture()
  const address = await f.cold()
  const { iterator, cancel } = await f.follow(address)
  await iterator.next()
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { type: 'session/end-seed' } } })
  await vi.waitFor(() => { expect(f.ctx.agents.get(address.sessionId)).toBeDefined() })
  const next = iterator.next()
  void next.catch(() => {})
  const withAgent = f.listeners()
  if (kind === 'caller') cancel.abort()
  else f.lifetime.abort()
  await expect(next).rejects.toMatchObject({ code: kind === 'caller' ? 'gateway/cancelled' : 'cloud/stale-generation' })
  expect(f.listeners()).toEqual(withAgent.map(count => count - 1))
})

it.each([
  { outcome: 'returns the login Peer Use', failReturn: false },
  { outcome: 'retains the login Peer Use on real native return failure', failReturn: true },
])('$outcome after graph cancellation races a native Session follow carrier', async ({ failReturn }) => {
  const f = await fixture()
  await f.ctx.plugin(LocalCredentials, { dshHome: f.project, path: join(f.project, 'peer-credentials.yaml'), watch: false })
  await f.ctx.plugin({ apply: applyConnection, inject: [...connectionInject] })
  const address = await f.cold('graph-carrier-cancellation')
  const returnFailure = new Error('Native follow return failed after actual cleanup')
  const returned = vi.fn()
  if (failReturn) {
    // oxlint-disable-next-line typescript/unbound-method -- Delegate with each invocation's actual receiver below.
    const follow = SessionController.prototype.follow
    vi.spyOn(SessionController.prototype, 'follow').mockImplementation(function (this: SessionController, request, signal) {
      const source = follow.call(this, request, signal)
      const iterator = source[Symbol.asyncIterator]()
      if (iterator.return === undefined) throw new Error('Actual native iterator return required')
      const actualReturn = iterator.return.bind(iterator)
      vi.spyOn(iterator, 'return').mockImplementation(async (value) => {
        await actualReturn(value)
        returned()
        throw returnFailure
      })
      return source
    })
  }
  const principal: AuthenticatedPrincipal = {
    accountId: f.binding.accountId,
    authSessionId: brandString<AuthenticatedPrincipal['authSessionId']>('history-login'),
  }
  const requestId = brandString<Branded<'pe-request-id'>>('history-graph-carrier')
  // Authentication and runtime authority stay outside this keyless component test.
  const auth = Object.create(BetterAuthAccess.prototype) as BetterAuthAccess
  vi.spyOn(auth, 'assertLoginCurrent').mockImplementation(() => {})
  vi.spyOn(auth, 'recheckLogin').mockResolvedValue(undefined)
  vi.spyOn(auth, 'authenticate').mockResolvedValue(principal)
  const release = vi.fn()
  const use: AccountUse = {
    binding: f.binding, context: f.ctx, assertCurrent: () => { f.lifetime.signal.throwIfAborted() }, release,
  }
  const settings: AccessConfig = {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'test-only',
    sessionRecheckMs: 60_000, authCheckTimeoutMs: 1000, maxPeers: 1, maxPeersPerAccount: 1,
    maxPeerWaiters: 1, maxPeerWaitersPerAccount: 1, maxPeerCarriers: 1, maxPeerCarriersPerAccount: 1,
    maxPeerCarriersPerLogin: 1, peerCloseTimeoutMs: 1000,
    maxAuthOperations: 1, maxTrackedLogins: 1, maxTrackedLoginsPerAccount: 1, maxAuthInvalidations: 1,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
  const failures: unknown[] = []
  const gatewayCancellationChecks: { aborted: boolean; sameReason: boolean; errorCode: unknown; cancelled: boolean }[] = []
  const isCancellation = NativeStreamServer.isStreamCancellation
  vi.spyOn(NativeStreamServer, 'isStreamCancellation').mockImplementation((error: unknown, signal) => {
    const cancelled = isCancellation(error, signal)
    gatewayCancellationChecks.push({
      aborted: signal.aborted, sameReason: error === signal.reason,
      errorCode: error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined, cancelled,
    })
    return cancelled
  })
  const transportCreation = vi.spyOn(Gateway.prototype, 'createNodeStreamTransport')
  const registry = new LoginPeerRegistry({ ...settings, sessionRecheckLeadMs: 0 }, auth, {
    borrow: async (binding) => { expect(binding).toBe(f.binding); return use },
    beforeHttp: () => {}, beforeStream: () => {}, cleanupFailed: (failure) => { failures.push(failure) },
    streams: { maxFrameBytes: 65536, maxLogicalStreams: 1, maxLogicalStreamsPerAccount: 1, maxLogicalStreamsPerPeer: 1 },
  })
  // Same memory-only socket behavior as the access owner's carrier tests; no TCP listener.
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
      process.nextTick(() => { this.emit('close', error !== null) })
    }
  }
  const client = new MemorySocket(), incoming = new MemorySocket()
  client.other = incoming
  incoming.other = client
  const server = createServer()
  const handshake = Promise.withResolvers<undefined>()
  client.on('error', (error) => { handshake.reject(error) })
  incoming.on('error', (error) => { handshake.reject(error) })
  let bytes = Buffer.alloc(0), upgraded = false
  const frames: unknown[] = []
  client.on('data', (data: Buffer) => {
    bytes = Buffer.concat([bytes, data])
    if (!upgraded) {
      const end = bytes.indexOf('\r\n\r\n')
      if (end < 0) return
      expect(bytes.subarray(0, end).toString('utf8')).toContain('101 Switching Protocols')
      bytes = bytes.subarray(end + 4)
      upgraded = true
      handshake.resolve(undefined)
    }
    while (bytes.length >= 2) {
      const opcode = bytes[0]! & 15
      let length = bytes[1]! & 127, offset = 2
      if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4 }
      if (length === 127) throw new Error('Bounded fixture frame required')
      if (bytes.length < offset + length) return
      if (opcode === 1) frames.push(JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')))
      bytes = bytes.subarray(offset + length)
    }
  })
  try {
    const handle = await registry.acquire(principal, f.binding, Date.now() + 1000, undefined, requestId)
    const created = transportCreation.mock.results[0]
    if (created?.type !== 'return') throw new Error('Actual Peer transport required')
    const transport = created.value, actualClose = transport.close.bind(transport)
    let transportFailure: unknown
    vi.spyOn(transport, 'close').mockImplementation(() => {
      const actual = actualClose()
      void actual.catch((error: unknown) => { transportFailure = error })
      return actual
    })
    server.on('upgrade', (request, socket, head) => {
      void registry.handleUpgrade(handle, request, socket, head, requestId).catch((error: unknown) => {
        handshake.reject(error)
        socket.destroy()
      })
    })
    server.emit('connection', incoming)
    client.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nOrigin: http://127.0.0.1:4100\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    await handshake.promise
    const body = Buffer.from(JSON.stringify({
      type: 'open', streamId: 'history', endpoint: 'session/follow', payload: { args: { request: { address, assistantStream: true } } },
    }))
    expect(body.length).toBeLessThan(65536)
    const header = Buffer.alloc(8)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
    header.set([1, 2, 3, 4], 4)
    const masked = Buffer.from(body.map((value, index) => value ^ header[4 + index % 4]!))
    client.write(Buffer.concat([header, masked]))
    const event: unknown = expect.objectContaining({ type: 'session/end-seed' })
    const value: unknown = expect.objectContaining({ type: 'event', event })
    await vi.waitFor(() => {
      expect(frames).toContainEqual(expect.objectContaining({ type: 'item', value }))
    })
    const withAgent = f.listeners()
    f.lifetime.abort()
    let closeFailure: unknown
    await registry.closeBinding(f.binding, Date.now() + 1000).catch((error: unknown) => { closeFailure = error })
    expect(handle.peer.signal.aborted).toBe(true)
    if (failReturn) {
      expect(returned).toHaveBeenCalledOnce()
      expect(transportFailure).toBe(returnFailure)
      expect(closeFailure).toMatchObject({ code: 'cloud/stop-unconfirmed' })
      expect(failures).toHaveLength(1)
      expect(release).not.toHaveBeenCalled()
      expect(registry.reservedPeers).toBe(1)
    } else {
      expect.soft(transportFailure).toBeUndefined()
      expect.soft(closeFailure).toBeUndefined()
      expect.soft(failures).toEqual([])
      expect.soft(release, JSON.stringify({ gatewayCancellationChecks })).toHaveBeenCalledOnce()
      expect.soft(registry.reservedPeers).toBe(0)
    }
    expect.soft(f.listeners()).toEqual(withAgent.map(count => count - 1))
  } finally {
    client.destroy()
    incoming.destroy()
    await registry.close(Date.now() + 1000).catch((_error: unknown) => {
      // Retained component cleanup failure is asserted above; no runtime/PG owner is released here.
    })
  }
}, 5000)

it.each(['page', 'follow'] as const)('keeps undeclared %s closed before scope or native reads', async (method) => {
  const f = await fixture('closed')
  const address = { kind: 'session' as const, sessionId: SessionId('unexposed') }
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  const work = method === 'page' ? f.page(address) : (await f.follow(address)).iterator.next()
  await expect(work).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('does not accept a unary declaration as follow stream authority', async () => {
  const f = await fixture('rpc-follow')
  const { iterator } = await f.follow({ kind: 'session', sessionId: SessionId('wrong-mode') })
  await expect(iterator.next()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
})

it.each(['one-shot', 'continuable', 'unknown'] as const)('explicitly denies the unaudited subagent history mode %s', async (mode) => {
  const f = await fixture()
  const address: SessionAddress = {
    kind: 'subagent', parentSessionId: SessionId('parent'), childSessionId: SessionId('child'), mode,
  }
  const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
  await expect(f.page(address)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect((await f.follow(address)).iterator.next()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.guards.assertSessionProject).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})
