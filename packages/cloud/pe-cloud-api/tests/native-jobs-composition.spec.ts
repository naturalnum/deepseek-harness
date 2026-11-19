/** The protected recipe mounts the original Job Controller through Loader and dispatches through Native Gateway. */
import { FiberState } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-job-controller/typert'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { SessionId } from '@deepseek-ai/dsh-session'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { expect, it, onTestFinished } from 'vitest'
import { startJob } from '../../../api/job-controller/tests/host-harness.ts'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { ACCOUNT_NATIVE_ENTRIES } from '../../pe-cloud-runtime/src/account-native-integration.ts'
import { JOB_CONTROLLER_ENDPOINTS } from '../src/job-endpoints.ts'
import { ExposurePolicy } from '../src/exposure.ts'

const rpc = JOB_CONTROLLER_ENDPOINTS.filter(row => row.mode === 'rpc')
const streams = JOB_CONTROLLER_ENDPOINTS.filter(row => row.mode === 'stream')
const manifest = { recipeVersion: 'jobs-review', rpcEndpoints: rpc, streamEndpoints: streams,
  exactFetchRoutes: [], allowedSettings: [] }
const bounds = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 131072 }
const jobContract = validateTypertManifest('@deepseek-ai/dsh-api-job-controller', TYPERT)

async function fixture(account: string, selected = true) {
  const graph = await policyFixture(selected ? rpc : [], bounds, account,
    undefined, undefined, selected ? jobContract : undefined, undefined, undefined, selected ? streams : []).start()
  const sessionId = SessionId('job-owner')
  await graph.ctx.sessionController.create({ sessionId })
  const peer = new Peer(graph.ctx, { principal: { kind: 'owner' } })
  const controls: AbortController[] = [], readers: AsyncIterator<unknown>[] = []
  onTestFinished(async () => {
    for (const control of controls) control.abort()
    await Promise.allSettled(readers.map(async (reader) => { await reader.return?.() }))
    await peer.dispose()
    await graph.close()
  })
  const open = async (method: 'list' | 'follow', request: object, caller = peer) => {
    const control = new AbortController()
    controls.push(control)
    graph.api.requireStream('job/' + method)
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(3000)])
    const frames = await graph.ctx.typertGateway.wireStream.open('job/' + method, { args: { request } },
      (async function* () {})(), caller, signal)
    const reader = frames[Symbol.asyncIterator]()
    readers.push(reader)
    return reader
  }
  const kill = (request: object, caller = peer) => {
    graph.api.requireRpc('job/kill')
    return graph.ctx.typertGateway.invoke({ namespace: 'job', method: 'kill', args: { request }, peer: caller })
  }
  if (selected) graph.ctx.jobs.attachController('cloud-jobs-fixture')
  return { ...graph, sessionId, peer, open, kill }
}

it('mounts the original three methods and carries a waiting row, cancellation, bytes and a real terminal projection', async () => {
  const { ctx, sessionId, open, kill } = await fixture('job-positive')
  const owner = [...ctx.loader.entries()].find(entry => entry.options.id === 'job-controller')
  expect(owner?.options.name).toBe('cordis:' + ACCOUNT_NATIVE_ENTRIES.jobs)
  expect(owner?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ctx.jobController instanceof JobController).toBe(true)
  const gateway = ctx.typertGateway
  if (!(gateway instanceof Gateway)) throw new Error('Original Gateway absent')
  for (const row of JOB_CONTROLLER_ENDPOINTS) {
    expect(ctx.typert.local.get(row.endpoint)).toBeDefined()
    expect(gateway.inspectInvocation('job', row.method)).toMatchObject({
      service: 'jobController', namespace: 'job', method: row.method,
    })
  }
  const queued = startJob(ctx, { owner: sessionId, label: 'waiting-owner' })
  const successor = startJob(ctx, { owner: sessionId, label: 'waiting-successor' })
  startJob(ctx, { label: 'unowned' })
  const markWaiting = ctx.jobs.markCapacityWaiting?.bind(ctx.jobs)
  if (markWaiting === undefined) throw new Error('Original registry waiting projection absent')
  markWaiting(queued.id, true, sessionId)
  markWaiting(successor.id, true, sessionId)
  const roster = await open('list', { sessionId })
  const first = await roster.next()
  expect(first).toHaveProperty('value.jobs.length', 2)
  expect(first).toMatchObject({ done: false, value: { type: 'rows' } })
  expect(first).toHaveProperty('value.jobs', expect.arrayContaining([queued, successor].map((job): unknown =>
    expect.objectContaining({ id: job.id, owner: sessionId, waitingForCapacity: true }))))
  const cancelled = await open('follow', { sessionId, jobId: queued.id })
  await expect(cancelled.next()).resolves.toMatchObject({ value: { type: 'opened', job: { id: queued.id, waitingForCapacity: true } } })
  await expect(kill({ sessionId, jobId: queued.id })).resolves.toEqual({ outcome: 'requested' })
  await expect(cancelled.next()).resolves.toMatchObject({ value: { type: 'status', job: { id: queued.id, status: 'killed' } } })
  const output = await open('follow', { sessionId, jobId: successor.id })
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'opened', from: 0 } })
  markWaiting(successor.id, false, sessionId)
  successor.append('successor-output', { channel: 'stdout' })
  await successor.settle({ status: 'failed', detail: 'exit code: 23' })
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'output', chunks: [{ at: 0, text: 'successor-output' }], next: 16 } })
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'status', job: { id: successor.id, status: 'failed', detail: 'exit code: 23' } } })
  await expect(output.next()).resolves.toMatchObject({ done: true })
})

it('rejects missing Session scope, unowned or foreign jobs, and a Peer from another account with the same Session ID', async () => {
  const a = await fixture('job-a'), b = await fixture('job-b')
  const anotherSession = SessionId('job-other-session')
  await a.ctx.sessionController.create({ sessionId: anotherSession })
  const mine = startJob(a.ctx, { owner: a.sessionId })
  const other = startJob(a.ctx, { owner: anotherSession })
  const unowned = startJob(a.ctx)
  const foreign = startJob(b.ctx, { owner: b.sessionId })
  expect(a.sessionId).toBe(b.sessionId)
  for (const item of [other, unowned, foreign]) {
    await expect(a.open('follow', { sessionId: a.sessionId, jobId: item.id })).rejects.toMatchObject({ code: 'job/not-found' })
    await expect(a.kill({ sessionId: a.sessionId, jobId: item.id })).rejects.toMatchObject({ code: 'job/not-found' })
  }
  await expect(a.open('follow', { jobId: unowned.id })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.open('list', { sessionId: SessionId('missing-session') })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.open('list', { sessionId: a.sessionId }, b.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.open('follow', { sessionId: a.sessionId, jobId: mine.id }, b.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(a.kill({ sessionId: a.sessionId, jobId: mine.id }, b.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(a.ctx.jobs.get(mine.id, a.sessionId).status).toBe('running')
  expect(b.ctx.jobs.get(foreign.id, b.sessionId).status).toBe('running')
})

it('revokes attached streams and kill when the original Session loses its Project membership', async () => {
  const f = await fixture('job-project-revoked'), job = startJob(f.ctx, { owner: f.sessionId })
  const roster = await f.open('list', { sessionId: f.sessionId })
  const output = await f.open('follow', { sessionId: f.sessionId, jobId: job.id })
  await roster.next()
  await output.next()
  const pendingRows = roster.next(), pendingOutput = output.next()
  void pendingRows.catch(() => {})
  void pendingOutput.catch(() => {})
  const workspace = f.guards.projectForSession(f.ctx.sessions.get(f.sessionId)!)
  await workspace.detachSession(f.sessionId)
  job.progress('must not reach revoked roster')
  job.append('must not reach revoked output')
  await expect(pendingRows).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(pendingOutput).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.kill({ sessionId: f.sessionId, jobId: job.id })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.ctx.jobs.get(job.id, f.sessionId).status).toBe('running')
})

it('reconnects the original Session to a still-running Job and resumes both output streams from its byte cursor', async () => {
  const f = await fixture('job-live-reconnect')
  const job = startJob(f.ctx, { owner: f.sessionId })
  const target = { sessionId: f.sessionId, jobId: job.id }
  const first = await f.open('follow', target)
  await expect(first.next()).resolves.toMatchObject({ value: { type: 'opened', from: 0, job: { id: job.id, status: 'running' } } })
  const prefix = '编译中\n'
  const cursor = Buffer.byteLength(prefix, 'utf8')
  job.append(prefix, { channel: 'stdout' })
  await expect(first.next()).resolves.toMatchObject({ value: { type: 'output', next: cursor,
    chunks: [{ at: 0, channel: 'stdout', text: prefix }] } })

  const interrupted = first.next()
  void interrupted.catch(() => {})
  await f.peer.dispose()
  await expect(interrupted).rejects.toBeDefined()
  await expect(first.next()).resolves.toMatchObject({ done: true })
  await expect(f.open('follow', { ...target, from: cursor })).rejects.toBeDefined()
  await expect(f.kill(target)).rejects.toBeDefined()
  expect(f.ctx.jobs.get(job.id, f.sessionId).status).toBe('running')
  const between = 'warning while offline\n'
  const after = 'compiled\n'
  job.append(between, { channel: 'stderr' })

  const other = await fixture('job-reconnect-other')
  expect(other.sessionId).toBe(f.sessionId)
  await expect(f.open('follow', { ...target, from: cursor }, other.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.kill(target, other.peer)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.ctx.jobs.get(job.id, f.sessionId).status).toBe('running')

  const reconnected = new Peer(f.ctx, { principal: { kind: 'owner' } })
  onTestFinished(async () => { await reconnected.dispose() })
  const roster = await f.open('list', { sessionId: f.sessionId }, reconnected)
  await expect(roster.next()).resolves.toMatchObject({ value: { type: 'rows',
    jobs: [{ id: job.id, status: 'running' }] } })
  await roster.return?.()
  const output = await f.open('follow', { ...target, from: cursor }, reconnected)
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'opened', from: cursor, job: { id: job.id, status: 'running' } } })
  const secondOffset = cursor + Buffer.byteLength(between)
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'output', next: secondOffset,
    chunks: [{ at: cursor, channel: 'stderr', text: between }] } })
  job.append(after, { channel: 'stdout' })
  await job.settle({ status: 'failed', detail: 'exit code: 23' })
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'output', next: secondOffset + Buffer.byteLength(after),
    chunks: [{ at: secondOffset, channel: 'stdout', text: after }] } })
  await expect(output.next()).resolves.toMatchObject({ value: { type: 'status', job: { id: job.id, status: 'failed', detail: 'exit code: 23' } } })
  await expect(output.next()).resolves.toMatchObject({ done: true })
})

it.each(['peer', 'generation', 'loader'] as const)('joins a quiet native follow after %s withdrawal', async (reason) => {
  const f = await fixture('job-revoke-' + reason), job = startJob(f.ctx, { owner: f.sessionId })
  const output = await f.open('follow', { sessionId: f.sessionId, jobId: job.id })
  await output.next()
  const pending = output.next()
  void pending.catch(() => {})
  if (reason === 'peer') await f.peer.dispose()
  else if (reason === 'generation') f.lifetime.abort(new Error('test generation withdrawal'))
  else await [...f.ctx.loader.entries()].find(entry => entry.options.id === 'job-controller')?.fiber?.dispose()
  await expect(pending).rejects.toBeDefined()
  await expect(output.next()).resolves.toMatchObject({ done: true })
  expect(f.ctx.jobs.get(job.id, f.sessionId).status).toBe('running')
})

it('starts the ordinary recipe without a job builtin, owner or permitted method', async () => {
  const f = await fixture('job-default', false)
  expect(f.ctx.loader.builtins).not.toHaveProperty(ACCOUNT_NATIVE_ENTRIES.jobs)
  expect(f.ctx.get('jobController')).toBeUndefined()
  expect(() => f.api.requireRpc('job/kill')).toThrow()
  for (const row of streams) expect(() => f.api.requireStream(row.endpoint)).toThrow()
  await expect(f.invoke('page', { address: { kind: 'session', sessionId: f.sessionId }, throughSeq: -1 })).resolves.toBeDefined()
})

it.each([
  { ...manifest, rpcEndpoints: [] },
  { ...manifest, streamEndpoints: [] },
  { ...manifest, streamEndpoints: [streams[0]!, { ...streams[1]!, endpoint: 'job/other' }] },
  { ...manifest, rpcEndpoints: [{ ...rpc[0]!, guard: 'authenticated-account' as const }] },
  { ...manifest, rpcEndpoints: [{ ...rpc[0]!, handlerId: 'native:fakeController' }] },
  { ...manifest, rpcEndpoints: [...rpc, ...streams], streamEndpoints: [] },
])('refuses partial, foreign or incorrectly carried Job manifests', (selection) => {
  expect(() => new ExposurePolicy(selection)).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
})
