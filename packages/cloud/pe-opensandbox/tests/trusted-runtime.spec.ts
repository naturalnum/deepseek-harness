/** Root registry units exercise actual ownership and projection; transports and bootstrap are component fakes. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AllocationCreateIntent } from '../src/allocation-types.ts'
import type { NativeRegisteredService } from '../src/native-command-account.ts'
import type { AgentSelection } from '../src/lifecycle-types.ts'
import { TrustedRuntimeRegistry, type ApplicationHttpFactory } from '../src/trusted-runtime.ts'
import { AGENT_SOURCE_SHA256, BWRAP_SHA256, PROTOCOL, SLICE_LIMITS, expectedWorldHash } from '../src/agent-data/index.ts'
import type { AgentDataClient, ClientOptions, Handshake, OperationSnapshot, PreparedRequest, Responsibility } from '../src/agent-data/types.ts'

function selection(): AgentSelection {
  const intent: AllocationCreateIntent = { allocationId: brandString<AllocationCreateIntent['allocationId']>('allocation-1'),
    accountId: brandString<AllocationCreateIntent['accountId']>('account-1'), epoch: brandString<AllocationCreateIntent['epoch']>('1'),
    sessionId: brandString<AllocationCreateIntent['sessionId']>('session-1'), workspaceId: brandString<AllocationCreateIntent['workspaceId']>('workspace-1'),
    environmentVersion: 'env-v1', provider: 'unit', projectMountVersion: 'mount-v1',
    requestedAt: new Date().toISOString(), createDeadlineAt: new Date(Date.now() + 10000).toISOString() }
  const quota = { device: '5', mountId: '10', maximumBytes: '8388608', maximumInodes: '128' }
  return { intent, sandboxId: 'sandbox-1', payloadSha256: AGENT_SOURCE_SHA256, imageDigest: `sha256:${'1'.repeat(64)}`,
    deploymentIdentity: 'selected-deployment', mount: { assertCurrent() {},
      exports: { project: '/export/project', protectedProject: '/export/project/.pe', environment: '/export/env' },
      grant: { binding: { accountId: intent.accountId, epoch: intent.epoch, recipeVersion: 'v1', lifetime: new AbortController().signal },
        sessionId: intent.sessionId, workspaceId: intent.workspaceId,
        project: { rootPath: '/project', rootDevice: '5', rootInode: '11', rootMountId: '10', quota,
          mountVersion: 'mount-v1', readOnlyPaths: ['.pe'], metadataDirectory: {
            relativePath: '.pe', device: '5', inode: '13', mountId: '10', uid: 2000, gid: 2000, mode: 0o40700 } },
        environment: { rootPath: '/bank/env', rootDevice: '6', rootInode: '12', rootMountId: '20',
          quota: { ...quota, device: '6', mountId: '20' }, targetPath: '/opt/session-env', bankId: 'bank', slotId: 'slot',
          slotGeneration: 1, environmentVersion: 'env-v1', rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
          layout: { home: { device: '6', inode: '14', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
            venv: { device: '6', inode: '15', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
            tmp: { device: '6', inode: '16', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 } } } } } }
}

function fixture(applicationFactory?: ApplicationHttpFactory) {
  const selected = selection(), runtimeIdentity = '2'.repeat(64)
  const options: ClientOptions = { host: '127.0.0.1', port: 39001, token: '3'.repeat(64), expected: {
    physicalSandboxId: selected.sandboxId, runtimeIdentity, projectRoot: '/project', declaredImageId: selected.imageDigest,
    pins: { agentSourceSha256: AGENT_SOURCE_SHA256, bwrapSha256: BWRAP_SHA256, userWorldArgvSha256: expectedWorldHash('/project') },
    roots: { project: { device: '5', inode: '11', maximumBytes: '8388608', maximumInodes: '128' },
      environment: { device: '6', inode: '12', maximumBytes: '8388608', maximumInodes: '128' } } } }
  const handshake: Handshake = { protocolVersion: PROTOCOL, runtimeIdentity, capabilities: ['argv', 'stdin-ignore', 'stdin-batch', 'collect'],
    pins: options.expected.pins, declaredImageId: selected.imageDigest, mounts: {}, limits: SLICE_LIMITS,
    newOperationsAccepted: true, recordCount: 0, activeRangeCount: 0, rangeRoles: { foreground: 0, service: 0 },
    sealed: false, sealReason: null, physicalStopRequired: false }
  const tail = { requestedOffset: 0 as const, startOffset: 0, endOffset: 0, observedBytes: 0,
    base64: '', bytes: new Uint8Array(), lossy: false, eof: false }
  const facts: OperationSnapshot = { operationId: 'unused-fake', specHash: '4'.repeat(64), role: 'foreground', registrationId: null,
    primitiveStarted: true, prepared: true,
    commitAttempted: false, commitClosed: false, submitted: false, firstCause: null, direct: null, directNotObserved: true,
    rangeEmpty: false, ioClosed: false, physicalStopRequired: false, failure: null, cleanupFailure: null, providerFailure: false,
    streams: { stdout: tail, stderr: tail } }
  const responsibility: Responsibility = { fenced: true, closing: true, inFlight: 0, dispatcherClosed: true, localSettled: true,
    closeMethodsPending: 0, cleanupFailure: false, attempts: 0, sentBodyBytes: 0, replyBodyAllowance: 0, bufferedReplyBytes: 0,
    replyBuffersReservedBytes: 0, inFlightRequestBodyBytes: 0, receivedReplyBodyBytes: 0,
    remoteUnresolved: [], physicalStopAcknowledged: false, physicalStopRequired: false }
  const client = {
    handshake: vi.fn(async () => handshake), prepare: vi.fn(async (_request: PreparedRequest) => facts), commit: vi.fn(async () => facts),
    poll: vi.fn(async () => facts), cancel: vi.fn(async () => facts), stop: vi.fn(async () => facts),
    seal: vi.fn(async () => handshake), fence: vi.fn(async () => {}), release: vi.fn(async () => responsibility),
    whenLocallySettled: vi.fn(async () => {}), responsibility: () => responsibility, notePhysicalStop: vi.fn(),
  } satisfies AgentDataClient
  const bootstrap = { bootstrap: vi.fn(async () => options), fence: vi.fn(() => ({
    whenJoined: Promise.resolve(), assertDeploymentCurrent: vi.fn() })) }
  const factory = vi.fn(() => client), registry = new TrustedRuntimeRegistry(bootstrap, 2, factory, applicationFactory)
  return { selected, options, handshake, facts, client, bootstrap, factory, registry }
}

function registeredService(selected: AgentSelection) {
  const { intent, mount: { grant } } = selected
  const project: Workspace = { id: intent.workspaceId, path: grant.project.rootPath, sessionIds: [intent.sessionId], title: 'component',
    createdAt: intent.requestedAt, updatedAt: intent.requestedAt, setTitle: async () => {}, attachSession: async () => {},
    detachSession: async () => {}, insertSessionBefore: async () => {}, status: async () => 'ok' }
  // Agent methods are outside this registry test; the original account owns scope issuance.
  const agent = { id: intent.sessionId, session: Session.create(intent.sessionId) } as Agent
  let current = true
  const bindAllocation = vi.fn<NativeRegisteredService['bindAllocation']>()
  const registrationId = brandString<NativeRegisteredService['registrationId']>('service-component')
  const registration: NativeRegisteredService = {
    registrationId,
    scope: { binding: grant.binding, agent, sessionId: intent.sessionId, project, consumerId: 'dev_service',
      purpose: 'service', capabilities: ['argv-collect'], lifetime: grant.binding.lifetime },
    assertCurrent() { if (!current) throw new Error('Original service registration was revoked.') },
    bindAllocation,
    projectIdentity: allocationId => ({ accountId: intent.accountId, epoch: intent.epoch, sessionId: intent.sessionId,
      allocationId, serviceId: registrationId }),
  }
  return { registration, bindAllocation, revoke: () => { current = false } }
}

describe('Root original trusted runtime registry', () => {
  it('captures the original application target and rechecks registration and fencing without command or allocation mutation', async () => {
    const transport = { withResponse: vi.fn(async () => {}) }
    const http = vi.fn<ApplicationHttpFactory>(() => transport), f = fixture(http), signal = new AbortController().signal
    const held = registeredService(f.selected), identity = held.registration.projectIdentity(f.selected.intent.allocationId)
    const limits = { readBufferBytes: 64, prefetchBytes: 128, maxWireBytes: 4096, maxRequestHeaderBytes: 1024,
      maxPathBytes: 1024, timeoutMs: 1000, maxBufferPoolBytes: 8192 }
    const owner = { retainRequest() { throw new Error('No HTTP send is expected') } }
    expect(() => f.registry.application(held.registration, identity, limits, owner)).toThrow('unconfirmed')
    const prepared = f.registry.bindPrepared({ ...await f.registry.handshake(f.selected, signal) })
    f.registry.service(prepared, held.registration)
    expect(f.registry.application(held.registration, identity, limits, owner)).toBe(transport)
    expect(http).toHaveBeenCalledTimes(1)
    const target = http.mock.calls[0]![0]
    expect(target.sandboxId).toBe(f.selected.sandboxId); expect(target.port).toBe(8000)
    expect(http.mock.calls[0]!.slice(1)).toEqual([limits, owner]); target.assertCurrent()
    expect(f.bootstrap.bootstrap).toHaveBeenCalledTimes(1); expect(f.client.prepare).not.toHaveBeenCalled()
    expect(transport.withResponse).not.toHaveBeenCalled()
    held.revoke(); expect(() => { target.assertCurrent() }).toThrow('revoked')
    await f.registry.fenceRequests(f.selected, undefined, signal).whenJoined
    expect(() => f.registry.application(held.registration, identity, limits, owner)).toThrow('unconfirmed')
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('refuses absent HTTP authority and mismatched account, epoch, Session, allocation or service before target construction', async () => {
    const http = vi.fn<ApplicationHttpFactory>(() => ({ withResponse: async () => {} }))
    const f = fixture(http), closed = fixture(), signal = new AbortController().signal
    const limits = { readBufferBytes: 64, prefetchBytes: 128, maxWireBytes: 4096, maxRequestHeaderBytes: 1024,
      maxPathBytes: 1024, timeoutMs: 1000, maxBufferPoolBytes: 8192 }
    const owner = { retainRequest() { throw new Error('No HTTP send is expected') } }
    for (const item of [f, closed]) {
      const prepared = item.registry.bindPrepared({ ...await item.registry.handshake(item.selected, signal) })
      const held = registeredService(item.selected), identity = held.registration.projectIdentity(item.selected.intent.allocationId)
      item.registry.service(prepared, held.registration)
      if (item === closed) expect(() => item.registry.application(held.registration, identity, limits, owner)).toThrow('unconfirmed')
      else {
        const variants = [
          { ...identity, accountId: brandString<typeof identity.accountId>('other-account') },
          { ...identity, epoch: brandString<typeof identity.epoch>('other-epoch') },
          { ...identity, sessionId: brandString<typeof identity.sessionId>('other-session') },
          { ...identity, allocationId: brandString<typeof identity.allocationId>('other-allocation') },
          { ...identity, serviceId: brandString<typeof identity.serviceId>('other-service') },
        ]
        for (const wrong of variants) expect(() => item.registry.application(held.registration, wrong, limits, owner)).toThrow('unconfirmed')
      }
      expect(item.client.prepare).not.toHaveBeenCalled()
      await item.registry.fenceRequests(item.selected, undefined, signal).whenJoined
    }
    expect(http).not.toHaveBeenCalled()
  })

  it('signs the service role only from its current original registration and retains old control refs after revocation', async () => {
    const f = fixture(), signal = new AbortController().signal
    const prepared = f.registry.bindPrepared({ ...await f.registry.handshake(f.selected, signal) })
    const held = registeredService(f.selected)
    const service = f.registry.service(prepared, held.registration), foreground = f.registry.command(prepared)
    expect(held.bindAllocation).toHaveBeenCalledExactlyOnceWith(f.selected.intent.allocationId)
    expect(f.client.prepare).not.toHaveBeenCalled()
    const spec = { argv: ['/bin/true'], cwd: '/project', stdin: { mode: 'ignore' as const } }
    await service.prepare(spec); await foreground.prepare(spec)
    const requests = f.client.prepare.mock.calls.map(([request]) => request)
    expect(requests[0]!.ref.authorization).toMatchObject({ role: 'service', registrationId: held.registration.registrationId })
    expect(requests[1]!.ref.authorization).toMatchObject({ role: 'foreground', registrationId: null })
    const awaiting = f.registry.service(prepared, held.registration)
    held.revoke()
    expect(() => f.registry.service(prepared, held.registration)).toThrow('revoked')
    await expect(awaiting.prepare(spec)).rejects.toThrow('unconfirmed')
    expect(f.client.prepare).toHaveBeenCalledTimes(2)
    await service.poll(); await service.stop()
    expect(f.client.poll).toHaveBeenLastCalledWith(requests[0]!.ref)
    expect(f.client.stop).toHaveBeenLastCalledWith(requests[0]!.ref)
    await f.registry.fenceRequests(f.selected, undefined, signal).whenJoined
  })

  it('rejects a service from a different binding, Session, project or purpose before any remote mutation', async () => {
    const f = fixture(), signal = new AbortController().signal
    const prepared = f.registry.bindPrepared({ ...await f.registry.handshake(f.selected, signal) })
    const { registration, bindAllocation } = registeredService(f.selected), scope = registration.scope
    const stale = [
      { ...scope, binding: { ...scope.binding } },
      { ...scope, sessionId: brandString<typeof scope.sessionId>('another-session') },
      { ...scope, project: { ...scope.project, id: brandString<typeof scope.project.id>('another-workspace') } },
      { ...scope, project: { ...scope.project, path: '/another-project' } },
      { ...scope, purpose: 'command' as const },
    ]
    for (const wrong of stale) expect(() => f.registry.service(prepared, { ...registration, scope: wrong })).toThrow('unconfirmed')
    expect(bindAllocation).not.toHaveBeenCalled()
    expect(f.client.prepare).not.toHaveBeenCalled()
    const service = f.registry.service(prepared, registration)
    f.registry.fenceRequests(f.selected, undefined, signal)
    await expect(service.prepare({ argv: ['/bin/true'], cwd: '/project', stdin: { mode: 'ignore' } })).rejects.toThrow('unconfirmed')
    expect(f.client.prepare).not.toHaveBeenCalled()
    await f.registry.fenceRequests(f.selected, undefined, signal).whenJoined
  })

  it('shares one startup/client and projects raw bytes and Linux signals through distinct command references', async () => {
    const f = fixture(), signal = new AbortController().signal
    const startup = f.registry.handshake(f.selected, signal)
    expect(f.registry.handshake({ ...f.selected }, signal)).toBe(startup)
    const prepared = f.registry.bindPrepared({ ...await startup })
    const a = f.registry.command(prepared), b = f.registry.command(prepared)
    await a.prepare({ argv: ['/bin/true'], cwd: '/project', stdin: { mode: 'ignore' } })
    await b.prepare({ argv: ['/bin/true'], cwd: '/project', stdin: { mode: 'ignore' } })
    const prepare = vi.mocked(f.client.prepare)
    expect(prepare.mock.calls[0]![0].ref.operationId).not.toBe(prepare.mock.calls[1]![0].ref.operationId)
    expect(f.bootstrap.bootstrap).toHaveBeenCalledTimes(1); expect(f.factory).toHaveBeenCalledTimes(1)
    vi.mocked(f.client.poll).mockResolvedValueOnce({ ...f.facts, direct: { waitStatus: 7, returncode: -7 },
      streams: { stdout: { ...f.facts.streams.stdout, bytes: new Uint8Array([0, 255]), base64: 'AP8=', endOffset: 2, observedBytes: 2 },
        stderr: f.facts.streams.stderr } })
    const observed = await a.poll()
    expect(observed.direct).toEqual({ exitCode: null, signal: 'SIGBUS' })
    expect(observed.stdout.bytes).toEqual(new Uint8Array([0, 255]))
    expect(() => f.registry.command({ ...prepared })).toThrow('unconfirmed')
    const stopped = f.registry.fenceRequests(f.selected, await startup, signal)
    f.registry.acknowledgePhysicalStop(f.selected, await startup)
    await stopped.whenJoined
  })

  it('closes privileged admission during late bootstrap and never creates a late data client', async () => {
    const f = fixture(), late = Promise.withResolvers<ClientOptions>(), privileged = Promise.withResolvers<undefined>()
    f.bootstrap.bootstrap.mockReturnValueOnce(late.promise)
    f.bootstrap.fence.mockReturnValueOnce({ whenJoined: privileged.promise, assertDeploymentCurrent: vi.fn() })
    const startup = f.registry.handshake(f.selected, new AbortController().signal)
    const refusal = expect(startup).rejects.toThrow('unconfirmed')
    const stopped = f.registry.fenceRequests(f.selected, undefined, new AbortController().signal)
    expect(() => f.registry.handshake(f.selected, new AbortController().signal)).toThrow('unconfirmed')
    let joined = false
    void stopped.whenPrivilegedStartsJoined.then(() => { joined = true })
    await Promise.resolve(); expect(joined).toBe(false)
    late.resolve(f.options); await refusal
    expect(f.factory).not.toHaveBeenCalled(); await stopped.whenJoined
    privileged.resolve(undefined); await stopped.whenPrivilegedStartsJoined
  })

  it('notes physical deletion while retaining the independent actual local cleanup join', async () => {
    const f = fixture(), local = Promise.withResolvers<undefined>(), signal = new AbortController().signal
    vi.mocked(f.client.whenLocallySettled).mockReturnValueOnce(local.promise)
    const original = await f.registry.handshake(f.selected, signal)
    const prepared = f.registry.bindPrepared({ ...original })
    f.registry.command(prepared)
    const stopped = f.registry.fenceRequests({ ...f.selected }, { ...original }, signal)
    expect(f.client.release).toHaveBeenCalledTimes(1)
    await stopped.whenPrivilegedStartsJoined
    let joined = false
    void stopped.whenJoined.then(() => { joined = true })
    f.registry.acknowledgePhysicalStop(f.selected, original)
    f.registry.acknowledgePhysicalStop(f.selected, original)
    expect(f.client.notePhysicalStop).toHaveBeenCalledTimes(1)
    await Promise.resolve(); expect(joined).toBe(false)
    local.resolve(undefined); await stopped.whenJoined
  })

  it('checks original mount facts before a data client exists and keeps transport failure details private', async () => {
    const f = fixture(), signal = new AbortController().signal
    f.bootstrap.bootstrap.mockResolvedValueOnce({ ...f.options, expected: { ...f.options.expected,
      roots: { ...f.options.expected.roots, project: { ...f.options.expected.roots.project, inode: '999' } } } })
    await expect(f.registry.handshake(f.selected, signal)).rejects.toThrow('unconfirmed')
    expect(f.factory).not.toHaveBeenCalled()
    await f.registry.fenceRequests(f.selected, undefined, signal).whenJoined
    const good = fixture(), ready = good.registry.bindPrepared({ ...await good.registry.handshake(good.selected, signal) })
    const channel = good.registry.command(ready)
    vi.mocked(good.client.prepare).mockRejectedValueOnce(new Error('private-token-must-never-escape'))
    await expect(channel.prepare({ argv: ['/bin/true'], cwd: '/project', stdin: { mode: 'ignore' } })).rejects.toThrow('unconfirmed')
    expect(good.client.prepare).toHaveBeenCalledTimes(1)
    await good.registry.fenceRequests(good.selected, undefined, signal).whenJoined
  })
})

it('projects resident expiry from before bootstrap without refreshing it on delayed handshake or application borrowing', async () => {
  let now = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const http = vi.fn<ApplicationHttpFactory>(() => ({ withResponse: async () => {} })), f = fixture(http)
  try {
    f.bootstrap.bootstrap.mockImplementation(async () => { now = 5100; return f.options })
    await f.registry.handshake(f.selected, new AbortController().signal)
    const held = registeredService(f.selected), identity = held.registration.projectIdentity(f.selected.intent.allocationId)
    const limits = { readBufferBytes: 64, prefetchBytes: 128, maxWireBytes: 4096, maxRequestHeaderBytes: 1024,
      maxPathBytes: 1024, timeoutMs: 1000, maxBufferPoolBytes: 8192 }
    const owner = { retainRequest(): never { throw new Error('No HTTP I/O in resident projection') } }
    f.registry.application(held.registration, identity, limits, owner)
    expect(http.mock.calls[0]![0].deadlineAtMs).toBe(300100)
    now = 300099; f.registry.application(held.registration, identity, limits, owner)
    expect(http.mock.calls[1]![0].deadlineAtMs).toBe(300100)
    now = 300100
    expect(() => f.registry.application(held.registration, identity, limits, owner)).toThrow('unconfirmed')
    expect(() => { http.mock.calls[0]![0].assertCurrent() }).toThrow('unconfirmed')
    expect(http).toHaveBeenCalledTimes(2); expect(f.bootstrap.bootstrap).toHaveBeenCalledTimes(1)
    expect(f.client.prepare).not.toHaveBeenCalled(); expect(f.client.commit).not.toHaveBeenCalled()
    await f.registry.fenceRequests(f.selected, undefined, new AbortController().signal).whenJoined
  } finally { clock.mockRestore() }
})


it('reports only known quiescent lifetime boundaries without opening another channel or renewing time', async () => {
  let now = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now), f = fixture()
  vi.spyOn(f.client, 'responsibility').mockImplementation(() => ({
    fenced: false, closing: false, inFlight: 0, dispatcherClosed: false, localSettled: true,
    closeMethodsPending: 0, cleanupFailure: false, attempts: 0, sentBodyBytes: 0, replyBodyAllowance: 0,
    bufferedReplyBytes: 0, replyBuffersReservedBytes: 0, inFlightRequestBodyBytes: 0, receivedReplyBodyBytes: 0,
    remoteUnresolved: [], physicalStopAcknowledged: false, physicalStopRequired: false,
  }))
  try {
    const ready = f.registry.bindPrepared(await f.registry.handshake(f.selected, new AbortController().signal))
    expect(f.registry.needsContinuation(ready)).toBe(false)
    for (let i = 0; i < 4; i++) f.registry.command(ready)
    expect(f.registry.needsContinuation(ready)).toBe(true)
    expect(f.client.prepare).not.toHaveBeenCalled(); expect(f.bootstrap.bootstrap).toHaveBeenCalledTimes(1)
    const healthy = f.client.responsibility()
    for (const changed of [{ ...healthy, inFlight: 1 }, { ...healthy, cleanupFailure: true },
      { ...healthy, physicalStopRequired: true }, { ...healthy, remoteUnresolved: [{
        runtimeIdentity: f.options.expected.runtimeIdentity, operationId: 'original', specHash: '4'.repeat(64),
        authorization: { role: 'foreground' as const, registrationId: null, signature: '5'.repeat(64) },
      }] }]) {
      vi.mocked(f.client.responsibility).mockReturnValue(changed)
      expect(() => f.registry.needsContinuation(ready)).toThrow('unconfirmed')
    }
    vi.mocked(f.client.responsibility).mockReturnValue(healthy)
    await f.registry.fenceRequests(f.selected, undefined, new AbortController().signal).whenJoined
    expect(() => f.registry.needsContinuation(ready)).toThrow('unconfirmed')
    const expired = fixture()
    vi.spyOn(expired.client, 'responsibility').mockReturnValue(healthy)
    const original = expired.registry.bindPrepared(await expired.registry.handshake(expired.selected, new AbortController().signal))
    now = 300100
    expect(expired.registry.needsContinuation(original)).toBe(true)
    expect(expired.client.prepare).not.toHaveBeenCalled()
    await expired.registry.fenceRequests(expired.selected, undefined, new AbortController().signal).whenJoined
  } finally { clock.mockRestore() }
})


it('retires only the exact stopped and locally joined runtime and permanently revokes the original intent', async () => {
  const f = fixture(), signal = new AbortController().signal
  const retire = vi.fn(), bootstrap = { ...f.bootstrap, retireStopped: retire }
  const registry = new TrustedRuntimeRegistry(bootstrap, 1, () => f.client)
  const prepared = registry.bindPrepared(await registry.handshake(f.selected, signal))
  expect(() =>{  registry.retireStopped(prepared, f.selected) }).toThrow('unconfirmed')
  const fenced = registry.fenceRequests(f.selected, undefined, signal)
  await fenced.whenJoined; await fenced.whenPrivilegedStartsJoined
  expect(() =>{  registry.retireStopped(prepared, f.selected) }).toThrow('unconfirmed')
  registry.acknowledgePhysicalStop(f.selected, undefined)
  const settled = { ...f.client.responsibility(), physicalStopAcknowledged: true }
  const responsibility = vi.spyOn(f.client, 'responsibility').mockReturnValue(settled)
  expect(() =>{  registry.retireStopped({ ...prepared }, f.selected) }).toThrow('unconfirmed')
  responsibility.mockReturnValue({ ...settled, cleanupFailure: true })
  expect(() =>{  registry.retireStopped(prepared, f.selected) }).toThrow('unconfirmed')
  responsibility.mockReturnValue(settled)
  registry.retireStopped(prepared, f.selected)
  expect(retire).toHaveBeenCalledExactlyOnceWith(f.selected)
  expect(() => registry.handshake(f.selected, signal)).toThrow('unconfirmed')
  expect(() => registry.command(prepared)).toThrow('unconfirmed')
  expect(() =>{  registry.retireStopped(prepared, f.selected) }).toThrow('unconfirmed')
  const fresh = { ...f.selected, intent: { ...f.selected.intent, allocationId: brandString<AllocationCreateIntent['allocationId']>('allocation-fresh') } }
  // The synthetic client returns the same physical facts; this only proves reclaimed record admission, not a real new sandbox.
  await expect(registry.handshake(fresh, signal)).resolves.toMatchObject({ sandboxId: fresh.sandboxId })
  await registry.fenceRequests(fresh, undefined, signal).whenJoined
})
