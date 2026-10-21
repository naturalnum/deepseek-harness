/** Local units use the actual pinned public SDK over a synthetic transport; no network/backend resource is accessed. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { CreateSandboxRequest } from '@alibaba-group/opensandbox'
import type { AllocationCreateIntent } from '../src/allocation-types.ts'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import { SdkAllocationBackend } from '../src/sdk-lifecycle.ts'
import { SdkLifecycleFailure, type AgentHandshake, type OwnedSdkTransport, type SdkLifecycleConfig,
  type TrustedAgentLifecycle, type VerifiedExecutionMount } from '../src/lifecycle-types.ts'

const config: SdkLifecycleConfig = { lifecycleBaseUrl: 'https://selected.example.invalid/v1', apiKey: 'unit-private-only',
  deploymentIdentity: 'root-verified-selected-deployment', environmentVersion: 'env-v1', provider: 'selected-docker',
  imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64), entrypoint: ['/trusted/root-agent'], platform: 'arm64',
  cpuCores: 0.5, memoryMiB: 192, ttlSeconds: 120, requestTimeoutMs: 1000, stopBudgetMs: 1000,
  readyPollIntervalMs: 1, maxReadyPolls: 3, pageSize: 1, maxPages: 2, maxItems: 2, maxRecords: 4,
  maxInflightOperations: 8, maxRequestBytes: 8192, maxResponseBytes: 8192, maxOperationBytes: 16384, maxFieldBytes: 512 }

function selection(): { intent: AllocationCreateIntent; mount: VerifiedExecutionMount } {
  const intent: AllocationCreateIntent = { allocationId: 'allocation-one' as AllocationCreateIntent['allocationId'],
    accountId: 'account-one' as AllocationCreateIntent['accountId'], epoch: 'epoch-one' as AllocationCreateIntent['epoch'],
    sessionId: 'session-one' as AllocationCreateIntent['sessionId'], workspaceId: 'workspace-one' as AllocationCreateIntent['workspaceId'],
    projectMountVersion: 'device:inode:mount', environmentVersion: config.environmentVersion, provider: config.provider,
    requestedAt: new Date().toISOString(), createDeadlineAt: new Date(Date.now() + 10000).toISOString() }
  const quota = { device: '5', mountId: '10', maximumBytes: '8388608', maximumInodes: '128' }
  const grant: ExecutionMountGrant = { binding: { accountId: intent.accountId, epoch: intent.epoch, recipeVersion: 'v1', lifetime: new AbortController().signal },
    sessionId: intent.sessionId, workspaceId: intent.workspaceId,
    project: { rootPath: '/approved/native/project', rootDevice: '5', rootInode: '11', rootMountId: '10',
      mountVersion: intent.projectMountVersion, quota, readOnlyPaths: ['.pe'],
      metadataDirectory: { relativePath: '.pe', device: '5', inode: '13', mountId: '10', uid: 2000, gid: 2000, mode: 0o40700 } },
    environment: { rootPath: '/approved/private/environment', rootDevice: '6', rootInode: '12', rootMountId: '20',
      quota: { ...quota, device: '6', mountId: '20' }, targetPath: '/opt/session-env', bankId: 'bank', slotId: 'slot',
      slotGeneration: 1, environmentVersion: config.environmentVersion, rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
      layout: { home: { device: '6', inode: '14', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
        venv: { device: '6', inode: '15', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 },
        tmp: { device: '6', inode: '16', mountId: '20', uid: 2000, gid: 2000, mode: 0o40700 } } } }
  const mount: VerifiedExecutionMount = { grant, exports: { project: '/root-verified-export/project',
    protectedProject: '/root-verified-export/project/.pe', environment: '/root-verified-export/environment' }, assertCurrent() {} }
  return { intent, mount }
}

class FakeTransport implements OwnedSdkTransport {
  readonly calls: { method: string; url: URL }[] = []
  readonly phases: string[] = []
  body: CreateSandboxRequest | undefined
  deleteStatus = 204
  postFailure = false
  deleteFailure = false
  closeFailure = false
  closed = false
  postGate: Promise<void> | undefined
  closeGate: Promise<void> | undefined
  getGate: Promise<void> | undefined
  deleteGate: Promise<void> | undefined
  deleteEntered = Promise.withResolvers<undefined>()
  onDelete: (() => void) | undefined
  postEntered = Promise.withResolvers<undefined>()
  closeEntered = Promise.withResolvers<undefined>()
  getState = 'Running'
  list: ((url: URL) => Response) | undefined
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    this.calls.push({ method: request.method, url }); this.phases.push(request.method)
    if (request.method === 'POST') {
      this.body = JSON.parse(await request.text()) as CreateSandboxRequest
      this.postEntered.resolve(undefined); await this.postGate
      if (this.postFailure) throw new Error('synthetic lost create reply')
      return Response.json(this.info('sandbox-one'), { status: 202 })
    }
    if (request.method === 'DELETE') {
      this.deleteEntered.resolve(undefined); await this.deleteGate; this.onDelete?.()
      if (this.deleteFailure) throw new Error('synthetic lost DELETE reply')
      return this.deleteStatus === 204 ? new Response(null, { status: 204 })
        : Response.json({ code: 'SYNTHETIC_DELETE', message: 'Synthetic unconfirmed deletion' }, { status: this.deleteStatus })
    }
    await this.getGate
    if (url.pathname.endsWith('/sandboxes')) return this.list?.(url)
      ?? Response.json({ items: [], pagination: { page: 1, pageSize: 1, totalItems: 0, totalPages: 0, hasNextPage: false } })
    return Response.json(this.info('sandbox-one'))
  }
  info(id: string): object {
    return { id, image: { uri: 'python:display-tag-only' }, metadata: this.body?.metadata, status: { state: this.getState },
      entrypoint: [...config.entrypoint], createdAt: new Date(), expiresAt: new Date(Date.now() + 120000) }
  }
  async close(): Promise<void> { this.closeEntered.resolve(undefined); await this.closeGate; if (this.closeFailure) throw new Error('synthetic actual close failure'); this.closed = true }
}

function agent(transport: FakeTransport): TrustedAgentLifecycle {
  return { async handshake(value): Promise<AgentHandshake> { transport.phases.push('handshake'); return {
    sandboxId: value.sandboxId, runtimeIdentity: 'authenticated-full-physical-identity', protocolVersion: 'agent-v1', capabilities: [],
    payloadSha256: value.payloadSha256, imageDigest: value.imageDigest, deploymentIdentity: value.deploymentIdentity } },
  fenceRequests(value) { transport.phases.push('requests-fenced'); return {
    sandboxId: value.sandboxId, deploymentIdentity: value.deploymentIdentity,
    whenPrivilegedStartsJoined: Promise.resolve(), whenJoined: Promise.resolve(),
    assertDeploymentCurrent() { transport.phases.push('selected-deployment-current') } } },
  acknowledgePhysicalStop() { transport.phases.push('physical-stop-ack'); return undefined } }
}

test('actual public SDK keeps one create, fixed payload/resources/exports and synchronous fence before positive204 and ack', async () => {
  const transport = new FakeTransport(), selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  const original = backend.create(selected.intent, selected.mount)
  assert.equal(backend.create(selected.intent, selected.mount), original)
  const created = await original, prepared = await backend.prepare(created, selected.mount, Date.now() + 5000)
  assert.deepEqual(transport.body?.extensions, { 'bootstrap.execd.isolation': 'enable' })
  assert.deepEqual(transport.body?.resourceLimits, { cpu: '0.5', memory: '192Mi' })
  assert.deepEqual(transport.body?.env, {}); assert.equal(transport.body?.timeout, 120)
  assert.deepEqual(transport.body?.volumes?.map(value => [value.host?.path, value.mountPath, value.readOnly]), [
    [selected.mount.exports.project, selected.mount.grant.project.rootPath, false],
    [selected.mount.exports.protectedProject, `${selected.mount.grant.project.rootPath}/.pe`, true],
    [selected.mount.exports.environment, '/opt/session-env', false] ])
  for (const value of Object.values(transport.body?.metadata ?? {})) assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{1,61}[A-Za-z0-9]$/)
  assert.throws(() => backend.stop({ ...created }, prepared), SdkLifecycleFailure)
  const stopped = backend.stop(created, prepared); assert.equal(backend.stop(created, prepared), stopped); await stopped
  assert(transport.phases.indexOf('requests-fenced') < transport.phases.indexOf('DELETE'))
  assert(transport.phases.indexOf('DELETE') < transport.phases.indexOf('physical-stop-ack'))
  assert.equal(transport.phases.filter(value => value === 'physical-stop-ack').length, 1)
  assert.equal(transport.calls.filter(value => value.method === 'POST').length, 1)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  await backend.closeRoot(Date.now() + 1000); assert.equal(transport.closed, true)
})

test('lost create is retained; empty metadata-filtered pages never authorize replay or stop', async () => {
  const transport = new FakeTransport(); transport.postFailure = true
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  const original = backend.create(selected.intent, selected.mount)
  await assert.rejects(original, { code: 'sdk/create-unknown' }); assert.equal(backend.create(selected.intent, selected.mount), original)
  const recoveryRecord = { ...selected.intent, state: 'uncertain', sandboxId: null, runtimeIdentity: null }
  const observed = await backend.findOriginal(recoveryRecord, Date.now() + 1000)
  assert.deepEqual(observed, { kind: 'unknown', pages: 1, candidates: [], scanComplete: true })
  const query = transport.calls.find(value => value.method === 'GET')?.url
  assert(query !== undefined); assert(query.searchParams.has('metadata')); assert.equal(query.searchParams.has('state'), false)
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'POST').length, 1)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 0)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
})

for (const status of [200, 404, 421, 500]) test(`DELETE ${status} remains unknown and is never repeated`, async () => {
  const transport = new FakeTransport(); transport.deleteStatus = status
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  const created = await backend.create(selected.intent, selected.mount)
  const original = backend.stop(created, undefined)
  await assert.rejects(original, { code: 'sdk/stop-unknown' }); assert.equal(backend.stop(created, undefined), original)
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
})

test('lost DELETE response remains sticky unknown without resubmission', async () => {
  const transport = new FakeTransport(); transport.deleteFailure = true
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  const created = await backend.create(selected.intent, selected.mount), stopping = backend.stop(created, undefined)
  await assert.rejects(stopping, { code: 'sdk/stop-unknown' }); assert.equal(backend.stop(created, undefined), stopping)
  assert.equal((await backend.findOriginal(selected.intent, Date.now() + 1000)).kind, 'unknown')
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
})

test('failed local join retains failure after physical DELETE and ack without resubmission', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const originalFence = callbacks.fenceRequests
  callbacks.fenceRequests = (value, prepared, signal) => ({ ...originalFence(value, prepared, signal), whenJoined: Promise.reject(new Error('synthetic local join failure')) })
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.stop(created, undefined), { code: 'sdk/stop-unknown' })
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  assert.equal(transport.phases.includes('physical-stop-ack'), true)
})

test('Root-close observer cancellation keeps late create and actual connection close owned', async () => {
  const transport = new FakeTransport(), selected = selection()
  const post = Promise.withResolvers<undefined>(), close = Promise.withResolvers<undefined>()
  transport.postGate = post.promise; transport.closeGate = close.promise
  const backend = new SdkAllocationBackend(config, agent(transport), transport), creating = backend.create(selected.intent, selected.mount)
  await transport.postEntered.promise
  const controller = new AbortController(), observation = backend.closeRoot(Date.now() + 1000, controller.signal)
  const actual = backend.closeRootActual()
  assert.equal(backend.closeRootActual(), actual)
  let actualSettled = false
  void actual.then(() => { actualSettled = true })
  controller.abort(); await assert.rejects(observation, { code: 'sdk/close-unconfirmed' })
  assert.equal(actualSettled, false)
  assert.equal(transport.closed, false); assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 0)
  post.resolve(undefined); await creating; await transport.closeEntered.promise
  assert.equal(transport.closed, false)
  close.resolve(undefined); await actual; await backend.closeRoot(Date.now() + 1000)
  assert.equal(transport.closed, true); assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
})

test('bounded ready polls do not repeat startup or create; unpublished startup still drains', async () => {
  const transport = new FakeTransport(); transport.getState = 'Creating'
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  transport.getState = 'Running'; const created = await backend.create(selected.intent, selected.mount); transport.getState = 'Creating'
  const preparing = backend.prepare(created, selected.mount, Date.now() + 1000)
  await assert.rejects(preparing, { code: 'sdk/ready-unconfirmed' })
  assert.equal(backend.prepare(created, selected.mount, Date.now() + 1000), preparing)
  assert.equal(transport.calls.filter(value => value.method === 'GET').length, config.maxReadyPolls)
  assert.equal(transport.phases.includes('handshake'), false)
  await backend.closeRoot(Date.now() + 1000); assert.equal(transport.calls.filter(value => value.method === 'POST').length, 1)
})

test('Root close fences while handshake is pending, physically stops before handshake settlement and still joins it', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const actualJoined = Promise.withResolvers<undefined>()
  const original = callbacks.handshake, originalJoin = callbacks.fenceRequests
  const acked = Promise.withResolvers<undefined>(), originalAck = callbacks.acknowledgePhysicalStop
  callbacks.acknowledgePhysicalStop = (value, prepared) => { originalAck(value, prepared); acked.resolve(undefined); return undefined }
  callbacks.handshake = async (value, signal) => {
    entered.resolve(undefined)
    try { await release.promise; return await original(value, signal) } finally { actualJoined.resolve(undefined) }
  }
  callbacks.fenceRequests = (value, prepared, signal) => {
    const fenced = originalJoin(value, prepared, signal)
    return { ...fenced, whenJoined: actualJoined.promise.then(() => fenced.whenJoined) }
  }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const preparing = backend.prepare(created, selected.mount, Date.now() + 1000)
  await entered.promise
  const controller = new AbortController(), closing = backend.closeRoot(Date.now() + 1000, controller.signal)
  await acked.promise
  controller.abort(); await assert.rejects(closing, { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.phases.includes('requests-fenced'), true)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  assert.equal(transport.phases.includes('physical-stop-ack'), true)
  release.resolve(undefined); await assert.rejects(preparing, { code: 'sdk/closed' })
  await backend.closeRoot(Date.now() + 1000)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
})

test('readiness responses share an aggregate byte limit across polls', async () => {
  const transport = new FakeTransport(), selected = selection()
  const backend = new SdkAllocationBackend({ ...config, maxResponseBytes: 750, maxOperationBytes: 1100 }, agent(transport), transport)
  const created = await backend.create(selected.intent, selected.mount); transport.getState = 'Creating'
  await assert.rejects(backend.prepare(created, selected.mount, Date.now() + 1000), { code: 'sdk/bounds' })
  assert(transport.calls.filter(value => value.method === 'GET').length <= config.maxReadyPolls)
  await backend.closeRoot(Date.now() + 1000)
})

test('pagination keeps the full allocation scope and reports observations without adoption', async () => {
  const transport = new FakeTransport(), selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  await backend.create(selected.intent, selected.mount)
  transport.list = (url) => { const page = Number(url.searchParams.get('page')); return Response.json({ items: [transport.info(`candidate-${page}`)],
    pagination: { page, pageSize: 1, totalItems: 2, totalPages: 2, hasNextPage: page === 1 } }) }
  const result = await backend.findOriginal(selected.intent, Date.now() + 1000)
  assert.equal(result.kind, 'unknown'); assert.equal(result.pages, 2); assert.equal(result.candidates.length, 2)
  const reads = transport.calls.filter(value => value.method === 'GET')
  assert.equal(reads[0]?.url.searchParams.get('metadata'), reads[1]?.url.searchParams.get('metadata'))
  await backend.closeRoot(Date.now() + 1000)
})

test('response bytes and original mount authority are enforced before any clean result', async () => {
  const transport = new FakeTransport(), selected = selection()
  const backend = new SdkAllocationBackend({ ...config, maxResponseBytes: 16 }, agent(transport), transport)
  await assert.rejects(backend.create(selected.intent, selected.mount), { code: 'sdk/create-unknown' })
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  const denied = new FakeTransport(), other = new SdkAllocationBackend(config, agent(denied), denied)
  const deniedMount = { ...selected.mount, assertCurrent() { throw new Error('synthetic original files grant revoked') } }
  assert.throws(() => other.create(selected.intent, deniedMount)); assert.equal(denied.calls.length, 0)
  await other.closeRoot(Date.now() + 1000)
})

test('dispatcher close rejection is retained after physical204 rather than swallowed', async () => {
  const transport = new FakeTransport(); transport.closeFailure = true
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.closed, false); assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
})

test('an already expired close observer still retains the actual failed shutdown', async () => {
  const transport = new FakeTransport(); transport.closeFailure = true
  const selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.closeRoot(Date.now() - 1), { code: 'sdk/close-unconfirmed' })
  await transport.closeEntered.promise
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
})

test('a server listing cannot expand the original allocation metadata scope', async () => {
  const transport = new FakeTransport(), selected = selection(), backend = new SdkAllocationBackend(config, agent(transport), transport)
  await backend.create(selected.intent, selected.mount)
  transport.list = () => Response.json({ items: [{ ...transport.info('foreign-one'), metadata: { 'pe-allocation': 'foreign' } }],
    pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1, hasNextPage: false } })
  await assert.rejects(backend.findOriginal(selected.intent, Date.now() + 1000), { code: 'sdk/selection' })
  await backend.closeRoot(Date.now() + 1000)
})

test('failed authenticated handshake does not block known physical DELETE after actual local join', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const originalHandshake = callbacks.handshake
  callbacks.handshake = async (value, signal) => ({ ...await originalHandshake(value, signal), imageDigest: `sha256:${'3'.repeat(64)}` })
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.prepare(created, selected.mount, Date.now() + 1000), { code: 'sdk/selection' })
  await backend.stop(created, undefined); await backend.closeRoot(Date.now() + 1000)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  assert.equal(transport.phases.filter(value => value === 'physical-stop-ack').length, 1)
})

test('bounded read capacity cannot consume the reserved stop admission', async () => {
  const transport = new FakeTransport(), selected = selection(), gate = Promise.withResolvers<undefined>()
  const backend = new SdkAllocationBackend(config, agent(transport), transport)
  const created = await backend.create(selected.intent, selected.mount)
  transport.getGate = gate.promise
  const reads = Array.from({ length: config.maxInflightOperations }, () => backend.findOriginal(selected.intent, Date.now() + 1000))
  const stopping = backend.stop(created, undefined)
  gate.resolve(undefined); await Promise.all(reads); await stopping
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  await backend.closeRoot(Date.now() + 1000)
})

test('dead agent channel needs no invented handshake or empty remote range before physical204', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const range = Promise.withResolvers<undefined>(); let rangeStopped = false
  callbacks.handshake = async () => { throw new Error('synthetic dead agent channel') }
  const originalJoin = callbacks.fenceRequests
  callbacks.fenceRequests = (value, prepared, signal) => {
    assert.equal(prepared, undefined)
    const joined = originalJoin(value, prepared, signal)
    assert.equal(Object.hasOwn(joined, 'runtimeIdentity'), false)
    assert.equal(Object.hasOwn(joined, 'processesJoined'), false)
    return joined
  }
  transport.onDelete = () => { assert.equal(rangeStopped, false) }
  callbacks.acknowledgePhysicalStop = (value, prepared) => {
    assert.equal(value.sandboxId, 'sandbox-one'); assert.equal(prepared, undefined)
    rangeStopped = true; range.resolve(undefined); transport.phases.push('physical-stop-ack'); return undefined
  }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.prepare(created, selected.mount, Date.now() + 1000), /dead agent channel/)
  await backend.stop(created, undefined); await range.promise
  assert.equal(rangeStopped, true)
  await backend.closeRoot(Date.now() + 1000)
})

test('pending local join permits DELETE and ack but stop fulfills only after late local settlement', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const acked = Promise.withResolvers<undefined>(), late = Promise.withResolvers<undefined>()
  let fenced = false, settled = false, fulfilled = false
  const originalFence = callbacks.fenceRequests, originalAck = callbacks.acknowledgePhysicalStop
  callbacks.fenceRequests = (value, prepared, signal) => {
    fenced = true
    return { ...originalFence(value, prepared, signal), whenJoined: late.promise.then(() => { settled = true }) }
  }
  callbacks.acknowledgePhysicalStop = (value, prepared) => { originalAck(value, prepared); acked.resolve(undefined); return undefined }
  const start = (): void => { if (fenced) throw new Error('synthetic start rejected') }
  transport.onDelete = () => { assert.equal(fenced, true); assert.equal(settled, false) }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined); void stopping.then(() => { fulfilled = true })
  await acked.promise
  assert.throws(start, /start rejected/); assert.equal(fulfilled, false)
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
  late.resolve(undefined); await stopping; assert.equal(settled, true); assert.equal(fulfilled, true)
  await backend.closeRoot(Date.now() + 1000)
})

test('no physical-stop acknowledgement while the original DELETE response remains unsettled', async () => {
  const transport = new FakeTransport(), selected = selection(), gate = Promise.withResolvers<undefined>()
  transport.deleteGate = gate.promise
  const backend = new SdkAllocationBackend(config, agent(transport), transport)
  const created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined); await transport.deleteEntered.promise
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
  gate.resolve(undefined); await stopping; await backend.stop(created, undefined); await backend.closeRoot(Date.now() + 1000)
  assert.equal(transport.phases.filter(value => value === 'physical-stop-ack').length, 1)
})

for (const when of ['before', 'after']) test(`selected deployment continuity fails ${when} DELETE without acknowledgement`, async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const originalJoin = callbacks.fenceRequests
  let current = when !== 'before'
  callbacks.fenceRequests = (value, prepared, signal) => ({ ...originalJoin(value, prepared, signal),
    assertDeploymentCurrent() { if (!current) throw new Error('synthetic selected lease changed') } })
  if (when === 'after') transport.onDelete = () => { current = false }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  await assert.rejects(backend.stop(created, undefined), { code: 'sdk/stop-unknown' })
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, when === 'before' ? 0 : 1)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
})

test('acknowledgement defect cannot replay a physically completed DELETE or report clean', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  let attempts = 0
  callbacks.acknowledgePhysicalStop = () => { attempts++; throw new Error('synthetic latch acknowledgement defect') }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined)
  await assert.rejects(stopping, { code: 'sdk/stop-unknown' }); assert.equal(backend.stop(created, undefined), stopping)
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1); assert.equal(attempts, 1)
})

test('failed DELETE still retains pending actual local join before stop and close settle', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const joined = Promise.withResolvers<undefined>(), originalFence = callbacks.fenceRequests
  transport.deleteStatus = 404
  callbacks.fenceRequests = (value, prepared, signal) => ({ ...originalFence(value, prepared, signal), whenJoined: joined.promise })
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined); let settled = false
  void stopping.then(() => { settled = true }, () => { settled = true })
  await transport.deleteEntered.promise
  await assert.rejects(backend.closeRoot(Date.now() + 25), { code: 'sdk/close-unconfirmed' })
  assert.equal(settled, false); assert.equal(transport.closed, false)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
  joined.resolve(undefined); await assert.rejects(stopping, { code: 'sdk/stop-unknown' })
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1)
})

test('privileged lane gates DELETE; its success permits physical ack while ordinary join still retains stop', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const privileged = Promise.withResolvers<undefined>(), ordinary = Promise.withResolvers<undefined>()
  const acked = Promise.withResolvers<undefined>()
  const originalFence = callbacks.fenceRequests, originalAck = callbacks.acknowledgePhysicalStop
  callbacks.fenceRequests = (value, prepared, signal) => ({ ...originalFence(value, prepared, signal),
    whenPrivilegedStartsJoined: privileged.promise, whenJoined: ordinary.promise })
  callbacks.acknowledgePhysicalStop = (value, prepared) => { originalAck(value, prepared); acked.resolve(undefined); return undefined }
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined); let fulfilled = false
  void stopping.then(() => { fulfilled = true })
  await assert.rejects(backend.closeRoot(Date.now() + 25), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 0)
  assert.equal(transport.phases.includes('physical-stop-ack'), false); assert.equal(fulfilled, false)
  privileged.resolve(undefined); await acked.promise
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 1); assert.equal(fulfilled, false)
  ordinary.resolve(undefined); await stopping; assert.equal(fulfilled, true)
  await backend.closeRoot(Date.now() + 1000)
})

test('failed privileged lane still joins original locals and retains unknown without DELETE or replay', async () => {
  const transport = new FakeTransport(), selected = selection(), callbacks = agent(transport)
  const ordinary = Promise.withResolvers<undefined>(), originalFence = callbacks.fenceRequests
  callbacks.fenceRequests = (value, prepared, signal) => ({ ...originalFence(value, prepared, signal),
    whenPrivilegedStartsJoined: Promise.reject(new Error('synthetic privileged submission unknown')), whenJoined: ordinary.promise })
  const backend = new SdkAllocationBackend(config, callbacks, transport), created = await backend.create(selected.intent, selected.mount)
  const stopping = backend.stop(created, undefined); let settled = false
  void stopping.then(() => { settled = true }, () => { settled = true })
  await assert.rejects(backend.closeRoot(Date.now() + 25), { code: 'sdk/close-unconfirmed' })
  assert.equal(settled, false); assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 0)
  assert.equal(transport.phases.includes('physical-stop-ack'), false)
  ordinary.resolve(undefined); await assert.rejects(stopping, { code: 'sdk/stop-unknown' })
  assert.equal(backend.stop(created, undefined), stopping)
  await assert.rejects(backend.closeRoot(Date.now() + 1000), { code: 'sdk/close-unconfirmed' })
  assert.equal(transport.calls.filter(value => value.method === 'DELETE').length, 0)
  assert.equal(transport.calls.filter(value => value.method === 'POST').length, 1)
})
