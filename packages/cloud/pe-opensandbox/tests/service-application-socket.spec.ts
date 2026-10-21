/** Original native service row and selected-server adapter over owned loopback sockets; no OpenSandbox or Linux acceptance. */
import { afterEach, expect, it, vi } from 'vitest'
import { channel, unsubscribe as unsubscribeDiagnostic } from 'node:diagnostics_channel'
import { ClientRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { NativeCommandAccount, type NativeCommandRoot, type NativeRegisteredService,
  type NativeServiceAccountConfig } from '../src/native-command-account.ts'
import { CloudSubprocessRuntime } from '../src/native-providers.ts'
import type { CommandChannel, CommandSnapshot, ManagedCommandOperation } from '../src/command-operation.ts'
import { registerDevServiceConsumer, type DevServiceProfile, type OriginalDevServiceWork } from '../src/dev-service-consumer.ts'
import { createSelectedServerHttp, PreviewHttpError, type PreviewHttpOwner, type HttpRequestCharge } from '../src/application-http.ts'
import type { ApplicationReadResponse, RegisteredApplicationService } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
interface Result {
  name: string
  events: string[]
  releaseProof: object[]
  requestCount: number
  connections: number
  beforeCleanup: object
  afterCleanup: object
}
const results: Result[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks() })
const request = { method: 'GET', resourcePath: '/', headers: [['accept', 'application/json']] } as const
const responseLimits = { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 8, maxHeaderCount: 16, maxHeaderBytes: 512 }
function observed(actual: Promise<void>) {
  const state: { settled: boolean; cause?: unknown } = { settled: false }
  const joined = actual.then(() => { state.settled = true }, (cause: unknown) => { state.settled = true; state.cause = cause })
  return { state, joined }
}
function command() {
  const prepared: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
    physicalStopRequired: false, providerFailure: false, direct: undefined,
    stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
  let current = prepared
  const polls: ReturnType<typeof Promise.withResolvers<CommandSnapshot>>[] = []
  const advance = (): void => { for (const poll of polls.splice(0)) poll.resolve(current) }
  const value: CommandChannel = { prepare: async () => prepared,
    commit: async () => { current = { ...prepared, submitted: true }; return current },
    poll: () => {
      if (current.rangeEmpty) return Promise.resolve(current)
      const poll = Promise.withResolvers<CommandSnapshot>(); polls.push(poll); return poll.promise
    },
    stop: async () => { current = { ...current, commitClosed: true }; return current },
  }
  return { value, empty() {
    current = { ...current, rangeEmpty: true, ioClosed: true, commitClosed: true,
      stdout: { ...current.stdout, eof: true }, stderr: { ...current.stderr, eof: true } }; advance()
  } }
}

async function fixture(name: string, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const residentDeadlineAtMs = performance.now() + 300000
  const events: string[] = [], serverSockets = new Set<Socket>(), serverTerminals = new Set<Promise<undefined>>()
  const clientSockets = new Set<Socket>(), clientTerminals = new Set<Promise<undefined>>()
  const gates = new Set<() => void>(), operationsToJoin = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  const controller = (): AbortController => { const owned = new AbortController(); controllers.add(owned); return owned }
  const releaseProof: { phase: string; reqClosed: boolean; messageClosed: boolean; socketClosed: boolean; consumerFinished: boolean }[] = []
  let closeGraph: () => Promise<void> = async () => {}, unsubscribe = (): void => {}, diagnosticRemoved = false
  let nativeProviderClose = 'not-started'
  let snapshot: () => object = () => ({ setupIncomplete: true })
  let requestCount = 0, connections = 0
  const server = createServer((req, res) => {
    requestCount++; events.push('server:request')
    expect(req.url).toBe('/v1/sandboxes/worker6-loopback/proxy/8000/')
    expect(req.headers['open-sandbox-api-key']).toBe('worker6-loopback-only')
    expect(req.headers.cookie).toBeUndefined(); expect(req.headers.authorization).toBeUndefined()
    handler(req, res)
  })
  server.maxConnections = 2
  server.on('connection', (socket) => {
    connections++; serverSockets.add(socket); events.push('server:socket:connected')
    const terminal = Promise.withResolvers<undefined>(); serverTerminals.add(terminal.promise)
    socket.on('error', (_cause: Error) => { /* The fixture still waits the actual close event. */ })
    socket.once('close', () => {
      serverSockets.delete(socket); serverTerminals.delete(terminal.promise)
      events.push('server:socket:close'); terminal.resolve(undefined)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an owned loopback listener')
  const origin = `127.0.0.1:${address.port}`
  cleanups.push(async () => {
    const beforeCleanup = snapshot()
    for (const release of gates) release()
    try { await closeGraph() }
    finally {
      unsubscribe()
      for (const owned of controllers) owned.abort(new Error('fixture cleanup'))
      for (const socket of clientSockets) socket.destroy()
      for (const socket of serverSockets) socket.destroy()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      await Promise.all([...serverTerminals, ...clientTerminals])
      expect(serverSockets.size).toBe(0); expect(clientSockets.size).toBe(0); expect(server.listening).toBe(false)
      expect(diagnosticRemoved).toBe(true)
      results.push({ name, events, releaseProof, requestCount, connections, beforeCleanup,
        afterCleanup: { serverListening: server.listening, openServerSockets: serverSockets.size, openClientSockets: clientSockets.size,
          pendingServerCloses: serverTerminals.size, pendingClientCloses: clientTerminals.size,
          diagnosticSubscriptionRemoved: diagnosticRemoved,
          ownedControllersAborted: [...controllers].every(owned => owned.signal.aborted), nativeProviderClose } })
      if (process.env.WORKER6_SOCKET_EVIDENCE !== undefined) {
        writeFileSync(process.env.WORKER6_SOCKET_EVIDENCE, JSON.stringify(results, null, 2) + '\n')
      }
    }
  })
  const localClosed = Promise.withResolvers<undefined>()
  let reqClosed = false, messageSeen = false, messageClosed = false, socketClosed = false
  let clientRequests = 0, consumerFinished = false, hookReturned = false
  const checkClosed = (): void => {
    if (reqClosed && socketClosed && (!messageSeen || messageClosed)) localClosed.resolve(undefined)
  }
  const created = channel('http.client.request.created')
  const observeRequest = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || !('request' in value) || !(value.request instanceof ClientRequest)) return
    const req = value.request
    if (req.getHeader('host') !== origin) return
    clientRequests++; events.push('client:request:created')
    req.once('close', () => { reqClosed = true; events.push('client:request:close'); checkClosed() })
    req.once('response', (message) => {
      messageSeen = true; events.push('client:response:headers')
      message.once('close', () => { messageClosed = true; events.push('client:response:close'); checkClosed() })
    })
    const captureSocket = (socket: Socket): void => {
      if (clientSockets.has(socket)) return
      clientSockets.add(socket); const terminal = Promise.withResolvers<undefined>(); clientTerminals.add(terminal.promise)
      socket.once('close', () => {
        socketClosed = true; clientSockets.delete(socket); clientTerminals.delete(terminal.promise)
        events.push('client:socket:close'); terminal.resolve(undefined); checkClosed()
      })
    }
    req.once('socket', captureSocket)
    if (req.socket !== null) captureSocket(req.socket)
  }
  created.subscribe(observeRequest)
  unsubscribe = () => { diagnosticRemoved = unsubscribeDiagnostic('http.client.request.created', observeRequest) }
  const ctx = new Context(), generation = controller(), caller = controller(), startCaller = controller(), stopCaller = controller()
  closeGraph = () => ctx.fiber.dispose()
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('worker6-loopback-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'loopback-only', lifetime: generation.signal }
  ctx.provide('peAccount', binding); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const id = SessionId('worker6-loopback-session')
  const workspace: Workspace = { id: brandString<Workspace['id']>('worker6-loopback-project'), path: '/project', sessionIds: [id],
    title: 'component', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    setTitle: async () => {}, attachSession: async () => {}, detachSession: async () => {}, insertSessionBefore: async () => {},
    status: async () => 'ok' }
  const agent = { id, ctx, session: Session.create(id) } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { Object.assign(agent, { ctx: inner }) }, { inject: ['tools', 'systemPrompt'] }))
  const profile: DevServiceProfile = { kind: 'python-http-v1', port: 8000, startWaitMs: 1000, runMs: 10000,
    stopWaitMs: 2000, maxLogReadBytes: 64, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 4, maxArgBytes: 128, maxArgsBytes: 256 }
  const limits = { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 64,
    maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 4, maxLifetimeMs: 10000, stopWaitMs: 3000 }
  const processReservation = { active: vi.fn(), resident: vi.fn() }, physical = Promise.withResolvers<undefined>()
  const entries: { command: ReturnType<typeof command>; registration?: NativeRegisteredService }[] = []
  const workRows: OriginalDevServiceWork<Workspace>[] = [], originalOperations: ManagedCommandOperation[] = []
  let count = 0, chargedBytes = 0, reserveHook: (() => void) | undefined
  let input: Parameters<PreviewHttpOwner['retainRequest']>[0] | undefined, terminalState: 'none' | 'pending' | 'resolved' | 'rejected' = 'none'
  const reserve = vi.fn<NonNullable<NativeServiceAccountConfig['application']>['reserve']>((scope, charge: HttpRequestCharge) => {
    expect(scope.sessionId).toBe(id); count++; chargedBytes += charge.retainedPayloadBytes; events.push('root:reserve')
    reserveHook?.()
    let released = false
    return { release() {
      expect(released).toBe(false); released = true
      const proof = { phase: hookReturned ? 'actual-terminal' : 'known-unstarted', reqClosed, messageClosed, socketClosed, consumerFinished }
      releaseProof.push(proof); events.push('root:release')
      if (hookReturned) {
        expect(reqClosed && socketClosed && (!messageSeen || messageClosed) && consumerFinished).toBe(true)
      } else expect(clientRequests).toBe(0)
      count--; chargedBytes -= charge.retainedPayloadBytes
    } }
  })
  const transport = vi.fn<NonNullable<NativeServiceAccountConfig['application']>['transport']>((registration, identity, owner) => {
    expect(identity).toEqual(registration.projectIdentity(brandString<typeof identity.allocationId>('worker6-loopback-allocation')))
    const observer: PreviewHttpOwner = { retainRequest(value) {
      input = value; terminalState = 'pending'; events.push('http:retain')
      void value.settled.then(() => { terminalState = 'resolved'; events.push('http:terminal:resolved') },
        (_cause: unknown) => { terminalState = 'rejected'; events.push('http:terminal:rejected') })
      const retained = owner.retainRequest(value); hookReturned = true; return retained
    } }
    const actual = createSelectedServerHttp({ lifecycleBaseUrl: `http://${origin}/v1`, apiKey: 'worker6-loopback-only',
      limits: { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 4096, maxRequestHeaderBytes: 1024,
        maxPathBytes: 2048, timeoutMs: 2000, maxBufferPoolBytes: 8192 }, assertCurrent() { generation.signal.throwIfAborted() } },
    { sandboxId: 'worker6-loopback', port: profile.port, deadlineAtMs: residentDeadlineAtMs, assertCurrent() { registration.assertCurrent() } }, observer)
    return { withResponse: (readRequest, bounds, signal, consume) => actual.withResponse(readRequest, bounds, signal, async (response) => {
      events.push('consumer:entered')
      try { await consume(response) }
      finally { consumerFinished = true; events.push('consumer:finished') }
    }) }
  })
  const unknown = vi.fn<NativeCommandRoot['unknown']>((_scope, operation, cause) => { operation.requestStop(cause) })
  const owner = new NativeCommandAccount(ctx, binding, { assertBusinessCurrent() {},
    getAgent: selected => selected === id ? agent : undefined,
    projectForAgent: () => workspace, projectForSession: () => workspace, files() { throw new Error('not used') } },
  { allowedTools: ['dev_service'], maxScopes: 8, commandLimits: limits,
    services: { profile, operationLimits: limits, application: { maxRequestsPerService: 1, reserve, transport },
      assertQualified(value) { expect(value).toBe(profile) },
      serviceSpec(scope, _profile, start) { return { argv: ['/opt/session-env/venv/bin/python', '-B', '/project/' + start.script], cwd: '/project',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } }, graceMs: 100, signal: scope.lifetime } } } },
  { acquire: async (_scope, _signal, registration) => {
    registration?.bindAllocation(brandString<RegisteredApplicationService['scope']['allocationId']>('worker6-loopback-allocation'))
    const item = command(); entries.push({ command: item, ...(registration === undefined ? {} : { registration }) }); return item.value
  }, unknown, reserve: () => ({ releaseActive: processReservation.active, releaseResident: processReservation.resident }),
  async close() { await physical.promise; for (const entry of entries) entry.command.empty() } })
  snapshot = () => ({ count, chargedBytes, terminalState, clientRequests, reqClosed, messageClosed, socketClosed, consumerFinished,
    rootUnknownCalls: unknown.mock.calls.length, activeReleases: processReservation.active.mock.calls.length,
    residentReleases: processReservation.resident.mock.calls.length,
    openClientSockets: clientSockets.size, openServerSockets: serverSockets.size })
  closeGraph = async () => {
    caller.abort(new Error('fixture cleanup')); input?.controller.abort(new Error('fixture cleanup'))
    // Assertions precede teardown; destroy here only guarantees cleanup after a failed test.
    for (const socket of clientSockets) socket.destroy()
    for (const socket of serverSockets) socket.destroy()
    await Promise.all(operationsToJoin)
    physical.resolve(undefined); for (const entry of entries) entry.command.empty()
    try { await owner.closeProvider(); nativeProviderClose = 'resolved' }
    catch (cause) {
      nativeProviderClose = 'rejected'
      if (terminalState !== 'rejected') throw cause
      expect(cause).toMatchObject({ code: 'cloud/stop-unconfirmed' }); nativeProviderClose = 'expected-unknown-retained'
    } finally { generation.abort(); startCaller.abort(); await ctx.fiber.dispose() }
  }
  const attach = owner.attachOriginal.bind(owner), create = owner.create.bind(owner)
  vi.spyOn(owner, 'attachOriginal').mockImplementation((...args) => { const work = attach(...args); workRows.push(work); return work })
  vi.spyOn(owner, 'create').mockImplementation((...args) => { const operation = create(...args); originalOperations.push(operation); return operation })
  const runtime = new CloudSubprocessRuntime(ctx, owner); registerDevServiceConsumer(ctx, owner.calls, runtime, owner, profile)
  const started = await ctx.tools.execute({ callId: ToolCallId('worker6-loopback-start'), name: 'dev_service',
    arguments: { action: 'start', script: 'server.py' }, agent, signal: startCaller.signal })
  expect(started.isError).toBe(false)
  const work = workRows[0], operation = originalOperations[0]
  if (work === undefined || operation === undefined) throw new Error('Expected original native service row')
  const gate = () => {
    const pending = Promise.withResolvers<undefined>(); gates.add(() => { pending.resolve(undefined) }); return pending
  }
  const borrow = (consume: (response: ApplicationReadResponse) => Promise<void>, responseSignal = caller.signal,
    deadlineAtMs = Date.now() + 4000) => {
    const actual = owner.withApplicationService({ sessionId: id, serviceId: work.handle }, caller.signal, deadlineAtMs,
      service => service.withResponse(request, responseLimits, responseSignal, consume))
    const watching = observed(actual); operationsToJoin.add(watching.joined); return watching
  }
  const assertPeerClosed = async (): Promise<void> => {
    await vi.waitFor(() => { expect(serverSockets.size).toBe(0) }, { timeout: 1000, interval: 5 })
  }
  return { work, owner, operation, entries, caller, stopCaller, controller, reserve, transport,
    processReservation, unknown, physical, events, releaseProof,
    gate, borrow, localClosed: localClosed.promise, assertPeerClosed,
    state: () => ({ count, chargedBytes, terminalState, clientRequests, requestCount, connections, reqClosed,
      messageClosed, socketClosed, consumerFinished, controller: input?.controller }),
    onReserve(value: () => void) { reserveHook = value } }
}

it('releases one finite GET only after actual client close and consumer completion', async () => {
  const f = await fixture('finite-get', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"hello":true}') })
  const bodyRead = f.gate(), consumerMayFinish = f.gate()
  const read = f.borrow(async (response) => {
    let text = ''
    for (;;) {
      const chunk = await response.read(16)
      if (chunk === null) break
      text += Buffer.from(chunk).toString('utf8')
    }
    expect(text).toBe('{"hello":true}'); await response.close(); bodyRead.resolve(undefined)
    await consumerMayFinish.promise
  })
  await bodyRead.promise; await f.localClosed; await f.assertPeerClosed()
  expect(f.state()).toMatchObject({ count: 1, terminalState: 'pending', consumerFinished: false, socketClosed: true })
  expect(f.state().chargedBytes).toBeGreaterThan(0); expect(f.releaseProof).toHaveLength(0)
  consumerMayFinish.resolve(undefined); await read.joined
  expect(read.state.cause).toBeUndefined()
  expect(f.state()).toMatchObject({ count: 0, chargedBytes: 0, terminalState: 'resolved', clientRequests: 1, requestCount: 1 })
  expect(f.releaseProof).toHaveLength(1); expect(f.unknown.mock.calls.length).toBe(0)
  expect(f.events.indexOf('root:release')).toBeGreaterThan(f.events.indexOf('client:socket:close'))
  expect(f.events.indexOf('root:release')).toBeGreaterThan(f.events.indexOf('consumer:finished'))
})

it.each(['headers-blocked', 'pending-read'] as const)('service stop joins real close and the %s consumer before confirming or releasing', async (mode) => {
  const f = await fixture(mode, (_req, res) => { res.writeHead(200); res.flushHeaders() })
  const entered = f.gate(), consumerMayFinish = f.gate(), readSettled = f.gate()
  const read = f.borrow(async (response) => {
    if (mode === 'headers-blocked') { entered.resolve(undefined); await consumerMayFinish.promise }
    const reading = response.read(1)
    if (mode === 'pending-read') entered.resolve(undefined)
    try { await reading }
    catch (_cause: unknown) { readSettled.resolve(undefined) }
    if (mode === 'pending-read') await consumerMayFinish.promise
  })
  await entered.promise
  const stopped = observed(f.work.stop(f.stopCaller.signal).then((value) => {
    expect(value).toEqual({ confirmed: true }); f.events.push('service:stop:confirmed')
  }))
  expect(f.state().controller?.signal.aborted).toBe(true)
  expect(f.state().count).toBe(1); expect(f.releaseProof).toHaveLength(0)
  f.entries[0]!.command.empty(); await f.operation.whenEmpty
  await f.localClosed; await f.assertPeerClosed()
  expect(stopped.state.settled).toBe(false); expect(f.state().terminalState).toBe('pending')
  expect(f.processReservation.active).not.toHaveBeenCalled(); expect(f.processReservation.resident).not.toHaveBeenCalled()
  if (mode === 'pending-read') await readSettled.promise
  consumerMayFinish.resolve(undefined); await read.joined; await stopped.joined
  expect(stopped.state.cause).toBeUndefined(); expect(read.state.cause).toBeDefined()
  expect(f.state().count).toBe(0); expect(f.releaseProof).toHaveLength(1)
  expect(f.processReservation.active).toHaveBeenCalledTimes(1); expect(f.processReservation.resident).not.toHaveBeenCalled()
  expect(f.unknown.mock.calls.length).toBe(0)
  expect(f.events.indexOf('service:stop:confirmed')).toBeGreaterThan(f.events.indexOf('client:socket:close'))
})

it.each(['return', 'throw'] as const)('consumer early %s precedes late actual socket close; known cleanup releases once', async (mode) => {
  const f = await fixture('consumer-' + mode, (_req, res) => { res.writeHead(200); res.flushHeaders() })
  const failure = new Error('worker6 original consumer failure')
  const read = f.borrow(async () => {
    expect(f.state().socketClosed).toBe(false); expect(f.state().count).toBe(1); expect(f.releaseProof).toHaveLength(0)
    if (mode === 'throw') throw failure
  })
  await read.joined; await f.localClosed; await f.assertPeerClosed()
  expect(read.state.cause).toBeDefined()
  if (mode === 'throw') expect(read.state.cause).toBe(failure)
  expect(f.events.indexOf('client:socket:close')).toBeGreaterThan(f.events.indexOf('consumer:finished'))
  expect(f.state()).toMatchObject({ count: 0, chargedBytes: 0, terminalState: 'resolved', reqClosed: true, messageClosed: true, socketClosed: true })
  expect(f.releaseProof).toHaveLength(1); expect(f.unknown.mock.calls.length).toBe(0)
})

it('fresh withResponse signal cannot replace original borrow cancellation during a real pending read', async () => {
  const f = await fixture('original-signal', (_req, res) => { res.writeHead(200); res.flushHeaders() })
  const entered = f.gate(), replacement = f.controller(), failure = new Error('worker6 original caller abort')
  const read = f.borrow(async (response) => {
    const reading = response.read(1); entered.resolve(undefined); await reading
  }, replacement.signal)
  await entered.promise; f.caller.abort(failure)
  expect(replacement.signal.aborted).toBe(false); expect(f.state().controller?.signal.aborted).toBe(true)
  expect(f.state().count).toBe(1); expect(f.releaseProof).toHaveLength(0)
  await read.joined; await f.localClosed; await f.assertPeerClosed()
  expect(read.state.cause).toBe(failure); expect(f.state().count).toBe(0); expect(f.releaseProof).toHaveLength(1)
  expect(f.processReservation.active).not.toHaveBeenCalled(); expect(f.unknown.mock.calls.length).toBe(0)
})

it.each(['before-borrow', 'during-reserve'] as const)('expired deadline %s has zero actual HTTP requests or connections', async (mode) => {
  const f = await fixture('deadline-' + mode, (_req, res) => { res.end('unexpected wire') })
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  if (mode === 'during-reserve') f.onReserve(() => { clock.mockReturnValue(now + 101) })
  const read = f.borrow(async () => {}, f.caller.signal, mode === 'before-borrow' ? now - 1 : now + 100)
  await read.joined; clock.mockRestore()
  expect(read.state.cause).toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.state()).toMatchObject({ count: 0, chargedBytes: 0, clientRequests: 0, requestCount: 0, connections: 0 })
  if (mode === 'before-borrow') { expect(f.reserve.mock.calls.length).toBe(0); expect(f.transport.mock.calls.length).toBe(0) }
  else { expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.releaseProof).toEqual([expect.objectContaining({ phase: 'known-unstarted' })]) }
})

it('real adapter rejects an unknown consumer terminal and original row/capacity remain held despite known socket and physical close', async () => {
  const f = await fixture('unknown-consumer-terminal', (_req, res) => { res.end('x') })
  const failure = new PreviewHttpError('cloud/stop-unconfirmed')
  const read = f.borrow(async (response) => {
    while (await response.read(16) !== null) { /* Read this finite one-byte response through actual EOF. */ }
    await response.close(); throw failure
  })
  await read.joined; await f.localClosed; await f.assertPeerClosed()
  expect(read.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.state()).toMatchObject({ count: 1, terminalState: 'rejected', reqClosed: true, messageClosed: true, socketClosed: true })
  expect(f.state().chargedBytes).toBeGreaterThan(0); expect(f.releaseProof).toHaveLength(0)
  expect(f.unknown.mock.calls.length).toBe(1); expect(f.unknown.mock.calls[0]![1]).toBe(f.operation)
  f.work.lease.release(); const closing = observed(f.owner.closeProvider()); f.physical.resolve(undefined)
  f.entries[0]!.command.empty(); await closing.joined
  expect(closing.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  expect(f.processReservation.active).not.toHaveBeenCalled(); expect(f.processReservation.resident).not.toHaveBeenCalled()
  expect(f.state().count).toBe(1); expect(f.releaseProof).toHaveLength(0)
})
