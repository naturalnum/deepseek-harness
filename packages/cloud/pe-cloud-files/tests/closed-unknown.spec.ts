/** Actual public skills/pool/client composition with scripted frames; no native or account readiness proof. */
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import { FdSkillFailure, FdWorkerClient } from '../src/worker-client.ts'
import type { FdSkillPrepareRequest } from '../src/skill-versions.ts'
import { staticStorageProtocol } from './fixtures/static-storage-lifetime.ts'

it.each(['normal', 'cancelled'] as const)('delivers the original closed unknown through installed skills and reuses the same worker: %s', async (mode) => {
  const protocol = staticStorageProtocol(), counters = new SharedArrayBuffer(8)
  const nativeFailure = Promise.withResolvers<unknown>(), notified = Promise.withResolvers<undefined>()
  const originalPrepare = FdWorkerClient.prototype.prepareSkillVersion
  const prepareObservation = vi.spyOn(FdWorkerClient.prototype, 'prepareSkillVersion').mockImplementation(function (
    this: FdWorkerClient, ...args: Parameters<FdWorkerClient['prepareSkillVersion']>
  ) {
    return originalPrepare.call(this, ...args).catch((error: unknown) => { nativeFailure.resolve(error); throw error })
  })
  let worker: Worker | undefined
  let exited: Promise<number> | undefined
  const pool = new LinuxFilesPool({
    maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
    maxResidentBytes: 8 * 1048576, maxResidentBytesPerLane: 2 * 1048576, waitTimeoutMs: 5000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 2000, drainTimeoutMs: 20, helperPath: '/not-loaded/component-only.node',
    maxReadBytes: 1024, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 },
    staticStorage: { ...protocol.config, rootProbeReservationBytes: 2 * 1048576 },
  }, () => {
    worker = new Worker(new URL('./fixtures/closed-unknown-worker.mjs', import.meta.url), {
      workerData: { record: protocol.record, facts: protocol.facts, mounts: protocol.mounts, status: protocol.status, counters, mode },
    })
    const created = worker
    exited = new Promise(resolve => created.once('exit', resolve))
    return created
  })
  onTestFinished(async () => {
    // This only closes the script fixture on failed assertions; it supplies no product settlement or release.
    worker?.postMessage({ kind: 'fixture-close' })
    await exited
    await pool.stop(Date.now())
    prepareObservation.mockRestore()
  })
  await pool.start()
  if (worker === undefined) throw new Error('Missing original worker')
  const owner = pool.requireStorageOwner(), notifications = [vi.fn(() => { notified.resolve(undefined) }), vi.fn()]
  const inputs: AccountMountInput[] = protocol.plan.accounts.map((account) => {
    const home = account.private.rootPath
    return { binding: { accountId: account.accountId, epoch: '1' as AccountMountInput['binding']['epoch'],
      recipeVersion: protocol.plan.recipeVersion, lifetime: new AbortController().signal },
    instanceId: 'component-fixture-instance' as AccountMountInput['instanceId'],
    layout: { storageKey: account.storageKey, accountRoot: account.accountRoot, privateRoot: home,
      projectsRoot: account.projects.rootPath, profileRoot: home + '/profile', patchPath: home + '/profile/cordis.patch.yml',
      credentialsRoot: home + '/credentials', sessionsRoot: home + '/sessions', storageRoot: home + '/storage',
      attachmentsRoot: home + '/attachments', skillsRoot: home + '/skills', instructionsRoot: home + '/instructions',
      environmentsRoot: account.accountRoot + '/environments', localIndexRoot: '/cache/' + account.storageKey },
    environment: { get: () => undefined, getFrom: () => undefined } }
  })
  const preparations = []
  for (const [index, input] of inputs.entries()) {
    const lease = await owner.prepareAccount(input), notify = notifications[index]
    if (notify === undefined) throw new Error('Missing same-generation notification')
    preparations.push(lease.bindInstalled(input.binding, () => {}, () => {}, async () => {
      throw new Error('No project resolution belongs to this fixture')
    }, notify))
  }
  const a = preparations[0]?.skillVersions?.(), b = preparations[1]?.skillVersions?.(), binding = inputs[0]?.binding
  if (a === undefined || b === undefined || binding === undefined) throw new Error('Missing installed skills ports')
  const caller = new AbortController(), cancelled = new Error('public caller cancellation')
  const answer = a.prepare({ skillMarkdown: 'one', resource: new Uint8Array(0) }, caller.signal).catch((error: unknown) => error)
  if (mode === 'cancelled') {
    await Atomics.waitAsync(new Int32Array(counters), 0, 0).value
    caller.abort(cancelled)
    expect(await answer).toBe(cancelled)
    worker.postMessage({ kind: 'fixture-release-prepare' })
  }
  const failure = await nativeFailure.promise
  await notified.promise
  if (mode === 'normal') expect(await answer).toBe(failure)
  else expect(await answer).toBe(cancelled)
  expect(failure).toBeInstanceOf(FdSkillFailure)
  if (!(failure instanceof FdSkillFailure)) throw new Error('Missing actual decoder failure')
  expect(failure).toMatchObject({ outcome: 'unknown', facts: { outcome: 'unknown', closed: true },
    intent: { kind: 'prepare', root: { rootPath: protocol.plan.accounts[0]?.private.rootPath } } })
  expect(notifications[0]).toHaveBeenCalledTimes(1)
  expect(notifications[1]).not.toHaveBeenCalled()
  // A's own second mutation cannot post another native request, even without a Runtime composition.
  await expect(a.prepare({ skillMarkdown: 'two', resource: new Uint8Array(0) }, new AbortController().signal))
    .rejects.toMatchObject({ outcome: 'unknown' })
  const other = await b.current(new AbortController().signal)
  expect(other.value).toBeUndefined()
  expect(pool.inspect()).toMatchObject({ workers: 1, busy: 0, work: { running: 0, queued: 0, pending: 2, residentBytes: 2 * 1048576 } })
  other.release()
  const first = await pool.stopEpoch(binding, Date.now()), second = await pool.stopEpoch(binding, Date.now())
  expect(first).toMatchObject({ status: 'unknown', reason: 'actual-file-work-unsettled' })
  expect(first.pendingOperationIds).toHaveLength(1)
  expect(second.pendingOperationIds).toEqual(first.pendingOperationIds)
  expect(first.pendingOperationIds).not.toContain(failure.intent?.operationId)
  expect(pool.inspect().work).toMatchObject({ running: 0, residentBytes: 1048576, pending: 1, lanes: 2 })
  expect(new Int32Array(counters)).toEqual(new Int32Array([1, 1]))
  expect(await exited).toBe(0)
  expect((await pool.stop(Date.now())).status).toBe('unknown')
})

function request(): Omit<FdSkillPrepareRequest, 'id' | 'cancel'> {
  return { kind: 'skill-prepare', root: { rootPath: '/not-opened/private', rootDevice: '1', rootInode: '2', rootMountId: '3' },
    uid: 1000, gid: 1000, version: '00000000-0000-4000-8000-000000000000' as FdSkillPrepareRequest['version'],
    skill: new Uint8Array(0), resource: new Uint8Array(0),
    limits: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 } }
}

/** In-memory transport observes decoder decisions without spawning or terminating a worker. */
class MemoryWorker extends EventEmitter {
  posted?: { id: string }
  terminations = 0
  postMessage(message: { id: string }): void { this.posted = message }
  async terminate(): Promise<number> { this.terminations++; return 0 }
}

it.each(['closed-false', 'no-frame', 'wrong-id', 'wrong-kind', 'transport-loss'] as const)(
  'does not capture a closed receipt for %s', async (mode) => {
    const transport = new MemoryWorker(), client = new FdWorkerClient(transport), capture = vi.fn()
    transport.emit('message', { kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
    await client.ready
    const actual = client.prepareSkillVersion(request(), new AbortController().signal, capture)
      .catch((error: unknown) => error)
    const id = transport.posted?.id
    if (id === undefined) throw new Error('Missing original pending request')
    const frame = new Uint8Array(128), view = new DataView(frame.buffer)
    frame.set([68, 83, 86, 49, 1, 3, mode === 'closed-false' ? 2 : 3]); view.setUint32(8, 5, true)
    view.setBigUint64(32, 1n, true); view.setBigUint64(40, 2n, true); view.setBigUint64(48, 3n, true)
    if (mode !== 'transport-loss') transport.emit('message', { kind: mode === 'wrong-kind' ? 'skill-retire-reply' : 'skill-prepare-reply',
      id: mode === 'wrong-id' ? 'different' : id, ...mode === 'no-frame' ? {} : { frame } })
    transport.emit('exit', 0)
    const failure = await actual
    expect(failure).toMatchObject({ outcome: 'unknown' })
    expect(capture).not.toHaveBeenCalled()
    expect(client.available).toBe(false)
    await client.exited
  },
)

function unknownFrame(closed = true): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(128), view = new DataView(frame.buffer)
  frame.set([68, 83, 86, 49, 1, 3, closed ? 3 : 2])
  view.setUint32(8, 5, true)
  view.setBigUint64(32, 1n, true); view.setBigUint64(40, 2n, true); view.setBigUint64(48, 3n, true)
  return frame
}

it('captures the matching pending failure by identity and does not infer it from error fields', async () => {
  const transport = new MemoryWorker(), client = new FdWorkerClient(transport), capture = vi.fn()
  transport.emit('message', { kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
  await client.ready
  const actual = client.prepareSkillVersion(request(), new AbortController().signal, capture).catch((error: unknown) => error)
  const id = transport.posted?.id
  const fake = new FdSkillFailure('unknown', 'FS_IO_ERROR', { outcome: 'unknown', closed: true, flags: 3, errno: 5,
    versions: 0, chargedBytes: 0, chargedInodes: 0, skillBytes: 0, resourceBytes: 0, versionRoot: request().root })
  expect(capture).not.toHaveBeenCalled()
  expect(client.available).toBe(true)
  transport.emit('message', { kind: 'skill-prepare-reply', id, frame: unknownFrame() })
  const failure = await actual
  expect(failure).not.toBe(fake)
  expect(capture).toHaveBeenCalledExactlyOnceWith(failure)
  expect(failure).toMatchObject({ outcome: 'unknown', intent: { operationId: id, kind: 'prepare', version: request().version } })
  expect(client.available).toBe(true)
  expect(transport.terminations).toBe(0)
  // A duplicate no longer matches any pending request and cannot create a second closure fact.
  transport.emit('message', { kind: 'skill-prepare-reply', id, frame: unknownFrame() })
  expect(capture).toHaveBeenCalledTimes(1)
  expect(client.available).toBe(false)
  transport.emit('exit', 0)
  await client.exited
})

it('contains failed closure capture and diagnostics without terminating or declaring the client healthy', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('public diagnostic failure') })
  const transport = new MemoryWorker(), client = new FdWorkerClient(transport)
  try {
    transport.emit('message', { kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
    await client.ready
    const actual = client.prepareSkillVersion(request(), new AbortController().signal, () => {
      throw new Error('public closure capture failure')
    }).catch((error: unknown) => error)
    transport.emit('message', { kind: 'skill-prepare-reply', id: transport.posted?.id, frame: unknownFrame() })
    expect(await actual).toMatchObject({ outcome: 'unknown', facts: { closed: true } })
    expect(client.available).toBe(false)
    expect(transport.terminations).toBe(0)
    expect(warning).toHaveBeenCalledExactlyOnceWith('Cloud file closure handoff is unconfirmed: %j', { event: 'skill-prepare-closed-unknown' })
  } finally { warning.mockRestore(); transport.emit('exit', 0); await client.exited }
})

it('does not turn a locally thrown error with closed fields into a native closure callback', async () => {
  const transport = new MemoryWorker(), client = new FdWorkerClient(transport), capture = vi.fn()
  transport.emit('message', { kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
  await client.ready
  const local = Object.assign(new Error('public local throw'), { outcome: 'unknown', facts: { closed: true } })
  transport.postMessage = () => { throw local }
  const actual = client.prepareSkillVersion(request(), new AbortController().signal, capture).catch((error: unknown) => error)
  transport.emit('exit', 0)
  expect(await actual).toMatchObject({ outcome: 'unknown', facts: undefined })
  expect(capture).not.toHaveBeenCalled()
  await client.exited
})

it.each(['prepared', 'not-prepared'] as const)('preserves the ordinary matched %s reply without retaining unknown', async (outcome) => {
  const transport = new MemoryWorker(), client = new FdWorkerClient(transport), capture = vi.fn()
  transport.emit('message', { kind: 'ready', abiVersion: 8, skillVersionsVersion: 1 })
  await client.ready
  const actual = client.prepareSkillVersion(request(), new AbortController().signal, capture).catch((error: unknown) => error)
  const frame = unknownFrame(), view = new DataView(frame.buffer)
  frame[5] = outcome === 'prepared' ? 1 : 2
  frame[6] = outcome === 'prepared' ? 251 : 3
  view.setUint32(8, outcome === 'prepared' ? 0 : 13, true)
  if (outcome === 'prepared') {
    view.setUint32(12, 1, true); view.setBigUint64(16, 1024n, true); view.setBigUint64(24, 6n, true)
    view.setBigUint64(56, 1n, true); view.setBigUint64(64, 4n, true); view.setBigUint64(72, 3n, true)
  }
  transport.emit('message', { kind: 'skill-prepare-reply', id: transport.posted?.id, frame })
  expect(await actual).toMatchObject(outcome === 'prepared' ? { outcome: 'prepared', closed: true }
    : { outcome: 'not-published', code: 'FS_PERMISSION_DENIED' })
  expect(capture).not.toHaveBeenCalled()
  expect(client.available).toBe(true)
  expect(transport.terminations).toBe(0)
  transport.emit('exit', 0)
  await client.exited
})
