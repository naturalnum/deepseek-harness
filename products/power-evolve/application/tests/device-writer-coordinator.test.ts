/** Real private files/native flock/OS children; Docker and Platform receipts below are synthetic DTOs. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { z } from 'zod'
import { deviceFinishReceipt, deviceFinishRequest, deviceStopObservation, ownedContainerReceipt,
  deviceClaimClosureReceipt } from '@power-evolve/contracts/device-execution'
import { DEVICE_PROCESS_LOCK_FILENAME, DeviceProcessLock } from '../src/device/process-lock.ts'
import { DEVICE_WRITER_SLOT_FILENAME, DeviceWriterCoordinator, deviceWriterOwner, type DeviceWriterOwner } from '../src/device/writer-coordinator.ts'

const options = { timeout: 20000, skip: !['darwin', 'linux'].includes(process.platform) }
function owner(): DeviceWriterOwner {
  return deviceWriterOwner.parse({ kind: 'command', deviceId: randomUUID(), enrollmentId: randomUUID(),
    executionId: randomUUID(), processId: randomUUID(), directoryId: randomUUID(), requestDigest: 'a'.repeat(64) })
}
function receipt(input: DeviceWriterOwner) {
  return ownedContainerReceipt.parse({ containerId: 'b'.repeat(64), imageId: `sha256:${'c'.repeat(64)}`,
    owner: { deviceId: input.deviceId, enrollmentId: input.enrollmentId, executionId: input.executionId,
      creationId: randomUUID(), requestDigest: input.requestDigest } })
}
function stop(container: ReturnType<typeof receipt>) {
  return deviceStopObservation.parse({ receipt: container, Running: false, ExitCode: 0, Status: 'exited',
    StartedAt: '2026-10-04T00:00:00Z', FinishedAt: '2026-10-04T00:00:01Z' })
}
const stopId = () => deviceFinishRequest.shape.requestId.parse(randomUUID())
function ack(container: ReturnType<typeof receipt>, id: ReturnType<typeof stopId>, state = 'succeeded') {
  return deviceFinishReceipt.parse({ executionId: container.owner.executionId, dispatchId: container.owner.creationId,
    requestId: id, stopConfirmed: true, state })
}
function claimClosure(input: DeviceWriterOwner, dispatchId: string | null = null) {
  return deviceClaimClosureReceipt.parse({ kind: 'unstarted_claim_closed', deviceId: input.deviceId,
    instanceId: input.enrollmentId, executionId: input.executionId, processId: input.processId,
    directoryId: input.directoryId, digest: input.requestDigest, requestId: randomUUID(), dispatchId,
    state: 'cancelled', startNeverAuthorized: true, continuationQueued: true })
}
async function root(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'pe-writer-coordinator-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
const stateView = z.object({ slot: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), owner: deviceWriterOwner, receipt: ownedContainerReceipt.nullable(),
    stop: z.object({ requestId: deviceFinishRequest.shape.requestId, observation: deviceStopObservation }).nullable() }),
  z.object({ kind: z.literal('transfer'), id: z.uuid() }),
]).nullable(), interruptedTransfer: z.object({ id: z.uuid(), state: z.literal('interrupted') }).nullable() })
async function bytes(path: string) { return stateView.parse(JSON.parse(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME), 'utf8'))) }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned fixture deadline')), 5000)
  })]) } finally { clearTimeout(timer) }
}
async function child(t: TestContext, directory: string, source: string, inheritedFd?: number) {
  const path = join(directory, `child-${randomUUID()}.mjs`)
  await writeFile(path, source, { mode: 0o600 })
  const process = fork(path, [], { execArgv: ['--import', 'tsx/esm'], env: {},
    stdio: inheritedFd === undefined ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe', inheritedFd, 'ipc'] })
  process.stdout!.resume(); process.stderr!.resume()
  const closed = new Promise<void>((resolve, reject) => { process.once('error', reject); process.once('close', () => resolve()) })
  const ready = bounded(new Promise<unknown>((resolve, reject) => {
    process.once('message', resolve); process.once('error', reject)
    process.once('close', () => reject(new Error('child closed before handshake')))
  }))
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await bounded(closed)
  })
  return { process, ready, closed }
}
async function settleKnown(coordinator: DeviceWriterCoordinator, input: DeviceWriterOwner) {
  const lease = await coordinator.command(input), container = receipt(input), id = stopId()
  try { await lease.capture(container); await lease.recordStop(stop(container), id); assert.equal(await lease.settle(ack(container, id)), true) }
  finally { await lease.release() }
}

test('all Profiles and directories share one owner-only slot and retain the stable lock inode', options, async t => {
  const path = await root(t), a = new DeviceWriterCoordinator(path), b = new DeviceWriterCoordinator(path)
  const original = owner(), first = await a.command(original)
  t.after(() => first.release())
  const lockBefore = await lstat(join(path, DEVICE_PROCESS_LOCK_FILENAME), { bigint: true })
  assert.equal((await lstat(path)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(path, DEVICE_WRITER_SLOT_FILENAME))).mode & 0o777, 0o600)
  assert.deepEqual((await bytes(path)).slot, { kind: 'command', owner: original, receipt: null, stop: null })
  await assert.rejects(b.command(owner()), { code: 'device_process_already_owned' })
  await assert.rejects(b.transfer(async () => {}), { code: 'device_process_already_owned' })
  const container = receipt(original), id = stopId()
  await first.capture(container); await first.recordStop(stop(container), id)
  assert.equal(await first.settle(ack(container, id)), true)
  assert.equal((await bytes(path)).slot, null)
  await first.release()
  assert.equal(await b.transfer(async fd => { assert(fd >= 0); return 'copied' }), 'copied')
  const lockAfter = await lstat(join(path, DEVICE_PROCESS_LOCK_FILENAME), { bigint: true })
  assert.equal(lockAfter.ino, lockBefore.ino); assert.equal(lockAfter.dev, lockBefore.dev)
  const lockPath = join(path, DEVICE_PROCESS_LOCK_FILENAME)
  await rename(lockPath, join(path, 'old-empty-slot-lock')); await writeFile(lockPath, '', { mode: 0o600 })
  await assert.rejects(b.transfer(async () => {}), { code: 'device_writer_slot_invalid' })
})

test('release keeps a command reservation; only its original process and exact receipt recover it', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), input = owner(), container = receipt(input)
  const first = await coordinator.command(input)
  await first.capture(container); await first.release()
  const saved = (await bytes(path)).slot
  assert(saved?.kind === 'command'); assert.deepEqual(saved.receipt, container)
  await assert.rejects(coordinator.command(owner()), { code: 'device_writer_busy' })
  await assert.rejects(coordinator.command({ ...input, processId: owner().processId }), { code: 'device_writer_busy' })
  await assert.rejects(coordinator.transfer(async () => {}), { code: 'device_writer_busy' })
  const recovered = await new DeviceWriterCoordinator(path).command(input)
  t.after(() => recovered.release())
  await recovered.capture(container)
  await assert.rejects(recovered.capture({ ...container, containerId: receipt(input).containerId,
    imageId: ownedContainerReceipt.shape.imageId.parse(`sha256:${'d'.repeat(64)}`) }), { code: 'device_writer_identity_changed' })
  const id = stopId()
  await recovered.recordStop(stop(container), id)
  assert.equal(await recovered.settle(ack(container, id, 'closed_unknown')), true)
  await recovered.release()
  assert.throws(() => recovered.fd, { code: 'device_writer_lease_released' })
  await settleKnown(coordinator, owner())
})

test('SIGKILL drops the kernel holder but never clears a command or grants another writer', options, async t => {
  const path = await root(t), input = owner()
  const url = new URL('../src/device/writer-coordinator.ts', import.meta.url).href
  const holder = await child(t, path, `import {DeviceWriterCoordinator,deviceWriterOwner} from ${JSON.stringify(url)};
    await new DeviceWriterCoordinator(${JSON.stringify(path)}).command(deviceWriterOwner.parse(${JSON.stringify(input)}));
    process.send({event:'held'}); setInterval(()=>{},1000);`)
  assert.deepEqual(await holder.ready, { event: 'held' })
  holder.process.kill('SIGKILL'); await bounded(holder.closed)
  const coordinator = new DeviceWriterCoordinator(path)
  await assert.rejects(coordinator.command(owner()), { code: 'device_writer_busy' })
  await assert.rejects(coordinator.transfer(async () => {}), { code: 'device_writer_busy' })
  await settleKnown(coordinator, input)
})

test('durable waiting recovery abandons only its exact uncaptured intent, retaining kernel exclusion until release', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner()
  const privateJournal = await DeviceProcessLock.acquire(join(path, 'private-journal'))
  t.after(() => privateJournal.release())
  // Durable waiting verification belongs to the trusted Worker; this caller holds a separate real journal lock.
  const first = await coordinator.command(original)
  await first.release()
  await assert.rejects(coordinator.command(owner()), { code: 'device_writer_busy' })
  const waiting = await coordinator.command(original)
  t.after(() => waiting.release())
  await privateJournal.assertOwned()
  await waiting.abandonWaiting()
  assert.equal((await bytes(path)).slot, null)
  await assert.rejects(coordinator.command(owner()), { code: 'device_process_already_owned' })
  await assert.rejects(waiting.abandonWaiting(), { code: 'device_writer_identity_changed' })
  await waiting.release()
  await assert.rejects(waiting.abandonWaiting(), { code: 'device_writer_lease_released' })
  await settleKnown(coordinator, owner())
})

test('waiting abandonment refuses captured and stopped commands without altering their persistent reservation', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), container = receipt(original)
  const lease = await coordinator.command(original)
  t.after(() => lease.release())
  await lease.capture(container)
  const captured = await bytes(path)
  await assert.rejects(lease.abandonWaiting(), { code: 'device_writer_waiting_unavailable' })
  assert.deepEqual(await bytes(path), captured)
  await lease.recordStop(stop(container), stopId())
  const stopped = await bytes(path)
  await assert.rejects(lease.abandonWaiting(), { code: 'device_writer_waiting_unavailable' })
  assert.deepEqual(await bytes(path), stopped)
  await lease.release()
  await assert.rejects(coordinator.command(owner()), { code: 'device_writer_busy' })
})

test('unstarted claim retirement clears only its uncaptured owner and retries do not recreate its reservation', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), closed = claimClosure(original)
  const lease = await coordinator.command(original)
  await lease.verifyUncapturedClaim()
  await assert.rejects(coordinator.retireClaim(original, closed), { code: 'device_process_already_owned' })
  await lease.release()
  await coordinator.retireClaim(original, closed)
  assert.equal((await bytes(path)).slot, null)
  const empty = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await coordinator.retireClaim(original, closed)
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), empty)
  const next = owner(), other = await coordinator.command(next)
  await assert.rejects(coordinator.retireClaim(original, closed), { code: 'device_process_already_owned' })
  await other.release()
  const occupied = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await coordinator.retireClaim(original, closed)
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), occupied)
  assert.equal((await bytes(path)).slot?.kind, 'command')
  await settleKnown(coordinator, next)
})

test('claim retirement refuses mismatched receipt identities and captured or stopped original slots', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), closed = claimClosure(original, randomUUID())
  const lease = await coordinator.command(original); await lease.release()
  const prior = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  for (const key of ['deviceId', 'instanceId', 'executionId', 'processId', 'directoryId', 'digest'] as const) {
    const changed = deviceClaimClosureReceipt.parse({ ...closed, [key]: key === 'digest' ? 'd'.repeat(64) : randomUUID() })
    await assert.rejects(coordinator.retireClaim(original, changed), { code: 'device_writer_claim_closure_mismatch' })
    assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), prior)
  }
  const captured = await coordinator.command(original), container = receipt(original)
  await captured.capture(container)
  await assert.rejects(captured.verifyUncapturedClaim(), { code: 'device_writer_claim_closure_unavailable' })
  await captured.release()
  const saved = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await assert.rejects(coordinator.retireClaim(original, closed), { code: 'device_writer_claim_closure_unavailable' })
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), saved)
  const stopped = await coordinator.command(original)
  await stopped.recordStop(stop(container), stopId()); await stopped.release()
  const finished = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await assert.rejects(coordinator.retireClaim(original, closed), { code: 'device_writer_claim_closure_unavailable' })
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), finished)
})

test('retiring an old claim leaves an unrelated interrupted transfer untouched', options, async t => {
  const path = await root(t), original = owner(), input = claimClosure(original)
  const url = new URL('../src/device/writer-coordinator.ts', import.meta.url).href
  const holder = await child(t, path, `import {DeviceWriterCoordinator} from ${JSON.stringify(url)};
    await new DeviceWriterCoordinator(${JSON.stringify(path)}).transfer(async()=>{
      process.send({event:'transfer'});await new Promise(()=>{});
    });`)
  assert.deepEqual(await holder.ready, { event: 'transfer' })
  holder.process.kill('SIGKILL'); await bounded(holder.closed)
  const prior = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await new DeviceWriterCoordinator(path).retireClaim(original, input)
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), prior)
  await new DeviceWriterCoordinator(path).retireCreation(original, claimClosure(original, randomUUID()))
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), prior)
  assert.equal((await bytes(path)).slot?.kind, 'transfer')
})

test('creation verification preserves an exact capture and retirement requires its saved cleanup facts', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), container = receipt(original)
  const lease = await coordinator.command(original)
  t.after(() => lease.release())
  await lease.verifyCreation()
  await lease.capture(container)
  await lease.verifyCreation(container)
  await assert.rejects(lease.verifyCreation(), { code: 'device_writer_claim_closure_unavailable' })
  await assert.rejects(lease.verifyCreation(receipt(owner())), { code: 'device_writer_identity_changed' })
  const captured = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await lease.release()
  const closure = claimClosure(original, container.owner.creationId)
  await assert.rejects(coordinator.retireCreation(original, closure), { code: 'device_writer_claim_closure_unavailable' })
  await assert.rejects(coordinator.retireCreation(original, claimClosure(original, randomUUID()),
    { receipt: container, observation: stop(container) }), { code: 'device_writer_claim_closure_mismatch' })
  await assert.rejects(coordinator.retireCreation(original, closure,
    { receipt: container, observation: stop(receipt(original)) }), { code: 'device_writer_claim_closure_mismatch' })
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), captured)
  await coordinator.retireCreation(original, closure, { receipt: container, observation: stop(container) })
  assert.equal((await bytes(path)).slot, null)
  await settleKnown(coordinator, owner())
})

test('a sealed uncaptured creation retires once and late cleanup cannot clear a newer writer', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), closed = claimClosure(original, randomUUID())
  const lease = await coordinator.command(original); await lease.verifyCreation(); await lease.release()
  await coordinator.retireCreation(original, closed)
  const empty = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await coordinator.retireCreation(original, closed)
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), empty)
  const next = owner(), active = await coordinator.command(next); await active.release()
  const occupied = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await coordinator.retireCreation(original, closed)
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), occupied)
  assert.equal((await bytes(path)).slot?.kind, 'command')
  await settleKnown(coordinator, next)
})

test('a stopped creation cannot be retired as an unstarted intent even with a closure receipt', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), original = owner(), container = receipt(original)
  const lease = await coordinator.command(original); await lease.capture(container)
  await lease.recordStop(stop(container), stopId())
  const stopped = await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME))
  await assert.rejects(lease.verifyCreation(container), { code: 'device_writer_claim_closure_unavailable' })
  await lease.release()
  await assert.rejects(coordinator.retireCreation(original, claimClosure(original, container.owner.creationId),
    { receipt: container, observation: stop(container) }), { code: 'device_writer_claim_closure_unavailable' })
  assert.deepEqual(await readFile(join(path, DEVICE_WRITER_SLOT_FILENAME)), stopped)
})

test('stale ACKs and changed stop facts fail; uncertain preserves the reservation until matching closure', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), input = owner(), container = receipt(input), id = stopId()
  const lease = await coordinator.command(input)
  t.after(() => lease.release())
  await assert.rejects(lease.settle(ack(container, id)), { code: 'device_writer_stop_unconfirmed' })
  await assert.rejects(lease.capture(receipt(owner())), { code: 'device_writer_identity_changed' })
  await lease.capture(container)
  await assert.rejects(lease.recordStop(stop(receipt(input)), id), { code: 'device_writer_stop_unconfirmed' })
  await lease.recordStop(stop(container), id)
  await assert.rejects(lease.recordStop(stop(container), stopId()), { code: 'device_writer_identity_changed' })
  for (const changed of [ack(container, stopId()), ack({ ...container, owner: { ...container.owner, creationId: receipt(input).owner.creationId } }, id),
    ack(receipt(owner()), id)]) await assert.rejects(lease.settle(changed), { code: 'device_writer_settlement_mismatch' })
  assert.equal(await lease.settle(ack(container, id, 'uncertain')), false)
  await lease.release()
  await assert.rejects(coordinator.command(owner()), { code: 'device_writer_busy' })
  const recovered = await coordinator.command(input)
  t.after(() => recovered.release())
  assert.equal(await recovered.settle(ack(container, id, 'closed_unknown')), true)
  await recovered.release()
  await assert.rejects(recovered.capture(container), { code: 'device_writer_lease_released' })
  await coordinator.transfer(async () => {})
})

test('slot links, broadened permissions, in-place edits and inode replacement reject without clearing facts', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path), input = owner()
  const first = await coordinator.command(input), slotPath = join(path, DEVICE_WRITER_SLOT_FILENAME)
  await first.release()
  const saved = await readFile(slotPath, 'utf8'), original = join(path, 'original-slot')
  await rename(slotPath, original)
  await assert.rejects(coordinator.command(input), { code: 'device_writer_slot_invalid' })
  await assert.rejects(coordinator.transfer(async () => {}), { code: 'device_writer_slot_invalid' })
  await symlink(original, slotPath)
  await assert.rejects(coordinator.command(input), { code: 'device_writer_slot_invalid' })
  await rm(slotPath); await link(original, slotPath)
  await assert.rejects(coordinator.command(input), { code: 'device_writer_slot_invalid' })
  await rm(slotPath); await rename(original, slotPath)
  await chmod(slotPath, 0o644)
  await assert.rejects(coordinator.command(input), { code: 'device_writer_slot_invalid' })
  await chmod(slotPath, 0o600)
  const lease = await coordinator.command(input)
  t.after(() => lease.release())
  await writeFile(slotPath, saved + ' ')
  await assert.rejects(lease.capture(receipt(input)), { code: 'device_writer_slot_invalid' })
  await writeFile(slotPath, saved)
  await rename(slotPath, original); await writeFile(slotPath, saved, { mode: 0o600 })
  await assert.rejects(lease.capture(receipt(input)), { code: 'device_writer_slot_invalid' })
  assert.equal(await readFile(original, 'utf8'), saved)
  await lease.release()
  const lockPath = join(path, DEVICE_PROCESS_LOCK_FILENAME), marker = await readFile(lockPath)
  await rename(lockPath, join(path, 'old-lock')); await writeFile(lockPath, marker, { mode: 0o600 })
  await assert.rejects(coordinator.command(input), { code: 'device_writer_slot_invalid' })
})

test('inherited helper FD keeps flock after parent closes; only helper exit permits interrupted-transfer recovery', options, async t => {
  const path = await root(t), coordinator = new DeviceWriterCoordinator(path)
  let helper: Awaited<ReturnType<typeof child>> | undefined, calls = 0
  await assert.rejects(coordinator.transfer(async fd => {
    calls++
    helper = await child(t, path, `import fs from 'node:fs'; fs.fstatSync(3);
      process.send({event:'inherited'}); const timer=setInterval(()=>{},1000);
      process.on('message',()=>{fs.closeSync(3);clearInterval(timer);process.exit(0)});`, fd)
    assert.deepEqual(await helper.ready, { event: 'inherited' })
    throw new Error('synthetic parent response loss')
  }), /synthetic parent response loss/u)
  const abandoned = (await bytes(path)).slot
  assert(abandoned?.kind === 'transfer')
  await assert.rejects(coordinator.transfer(async () => { calls++ }), { code: 'device_process_already_owned' })
  await assert.rejects(coordinator.command(owner()), { code: 'device_process_already_owned' })
  assert(helper)
  helper.process.send('exit'); await bounded(helper.closed)
  assert.equal(await coordinator.transfer(async () => { calls++; return 'new explicit action' }), 'new explicit action')
  assert.equal(calls, 2)
  const state = await bytes(path)
  assert.equal(state.slot, null); assert.deepEqual(state.interruptedTransfer, { id: abandoned.id, state: 'interrupted' })
  const lock = await DeviceProcessLock.acquire(path)
  await lock.release()
  assert.throws(() => lock.fd, { code: 'device_process_lock_released' })
})
