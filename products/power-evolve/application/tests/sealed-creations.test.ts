/** Real private FS/flock with synthetic Docker observations; no Docker daemon is used. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { deviceClaimClosureReceipt, ownedContainerOwner, ownedContainerReceipt } from '@power-evolve/contracts/device-execution'
import { DeviceProcessLock } from '../src/device/process-lock.ts'
import { SealedDeviceCreations, sealedCreation, type SealedCreation } from '../src/device/sealed-creations.ts'
import { DockerCommandError, OwnedDeviceContainer, OWNED_DEVICE_CONTAINER_LABELS,
  type DockerClient, type DockerCommandResult, type OwnedContainerObservation } from '../src/device/owned-container.ts'

const options = { timeout: 10000, skip: !['darwin', 'linux'].includes(process.platform) }
const IMAGE = 'sha256:' + 'a'.repeat(64), ID = 'b'.repeat(64)
const created: OwnedContainerObservation = { Running: false, Status: 'created', ExitCode: 0,
  StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }
function record(): SealedCreation {
  const owner = ownedContainerOwner.parse({ deviceId: randomUUID(), enrollmentId: randomUUID(), executionId: randomUUID(),
    creationId: randomUUID(), requestDigest: 'c'.repeat(64) })
  const closure = deviceClaimClosureReceipt.parse({ kind: 'unstarted_claim_closed', deviceId: owner.deviceId,
    instanceId: owner.enrollmentId, executionId: owner.executionId, processId: randomUUID(), directoryId: randomUUID(),
    digest: owner.requestDigest, requestId: randomUUID(), dispatchId: owner.creationId, state: 'cancelled',
    startNeverAuthorized: true, continuationQueued: true })
  return sealedCreation.parse({ closure, owner, name: 'pe-local-' + owner.executionId.replaceAll('-', ''),
    imageId: IMAGE, removalConfirmed: false })
}
class CleanupDocker implements DockerClient {
  calls: string[][] = []
  present = false
  state = { ...created }
  image = IMAGE
  lostRemove = false
  onRemove: (() => Promise<void>) | undefined
  constructor(private readonly source: SealedCreation) {}
  async run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult> {
    assert.equal(timeoutMs, 100); this.calls.push([...args])
    if (args[0] === 'container') {
      assert.equal(args[1], 'inspect')
      assert([ID, this.source.name].includes(args.at(-1)!))
      if (!this.present) throw new DockerCommandError('docker_not_found')
      const labels = { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: IMAGE,
        ...Object.fromEntries(Object.entries(this.source.owner).map(([key, value]) => [OWNED_DEVICE_CONTAINER_LABELS[key as keyof typeof this.source.owner], value])) }
      return { stdout: JSON.stringify({ Id: ID, Image: this.image, Labels: labels, State: this.state }), stderr: '' }
    }
    assert.deepEqual(args, ['rm', ID]); assert.equal(this.state.Running, false)
    await this.onRemove?.(); this.present = false
    if (this.lostRemove) throw new DockerCommandError('docker_command_failed')
    return { stdout: ID, stderr: '' }
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-sealed-creations-'))
  const lock = await DeviceProcessLock.acquire(root), store = new SealedDeviceCreations(root, () => lock.assertOwned())
  const source = record(), docker = new CleanupDocker(source)
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 100, stopTimeoutMs: 100, stopGraceSeconds: 1 }, docker)
  const identity = { deviceId: source.owner.deviceId, enrollmentId: source.owner.enrollmentId }
  const path = join(root, 'sealed-creations', source.closure.executionId + '.json')
  t.after(async () => { await store.close(); await lock.release(); await rm(root, { recursive: true, force: true }) })
  return { root, lock, store, source, docker, containers, identity, path }
}

test('one poll reads one strict owner-only record while missing creations remain on disk', options, async t => {
  const f = await fixture(t)
  await f.store.preserve(f.source)
  for (let index = 0; index < 2; index++) {
    const next = record()
    await f.store.preserve({ ...next, owner: { ...next.owner, deviceId: f.identity.deviceId, enrollmentId: f.identity.enrollmentId },
      closure: { ...next.closure, deviceId: f.identity.deviceId, instanceId: f.identity.enrollmentId } })
  }
  assert.equal((await stat(join(f.root, 'sealed-creations'))).mode & 0o777, 0o700)
  assert.equal((await stat(f.path)).mode & 0o777, 0o600)
  // Each synthetic read accepts any owned missing discovery name; no container is adopted.
  const missing: DockerClient = { async run(args) { assert.equal(args[0], 'container'); throw new DockerCommandError('docker_not_found') } }
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 100, stopTimeoutMs: 100, stopGraceSeconds: 1 }, missing)
  let lookedUp = 0
  const counted: DockerClient = { async run(args, timeoutMs) { lookedUp++; return missing.run(args, timeoutMs) } }
  const countedContainers = new OwnedDeviceContainer({ commandTimeoutMs: 100, stopTimeoutMs: 100, stopGraceSeconds: 1 }, counted)
  for (let index = 0; index < 3; index++) { const before = lookedUp; await f.store.reconcileOne(f.identity, countedContainers, () => false); assert.equal(lookedUp, before + 1) }
  assert.equal(sealedCreation.parse(JSON.parse(await readFile(f.path, 'utf8'))).receipt, undefined)
  await f.store.reconcileOne(f.identity, containers, () => false)
  await f.store.close()
  await assert.rejects(f.store.reconcileOne(f.identity, containers, () => false), { code: 'sealed_creations_closed' })
})

test('late creation is captured and observed durably before ordinary exact-ID removal', options, async t => {
  const f = await fixture(t); await f.store.preserve(f.source)
  await f.store.cleanup(f.source.closure.executionId, f.identity, f.containers)
  assert.equal(sealedCreation.parse(JSON.parse(await readFile(f.path, 'utf8'))).removalConfirmed, false)
  f.docker.present = true
  f.docker.onRemove = async () => {
    const saved = sealedCreation.parse(JSON.parse(await readFile(f.path, 'utf8')))
    assert.equal(saved.receipt?.containerId, ID); assert.equal(saved.observation?.Running, false); assert.equal(saved.removalConfirmed, false)
  }
  const cleaned = await f.store.cleanup(f.source.closure.executionId, f.identity, f.containers)
  assert.equal(cleaned.removalConfirmed, true)
  assert.equal(f.docker.calls.filter(args => args[0] === 'rm').length, 1)
  assert.deepEqual(await f.store.preserve(f.source), cleaned)
  assert.equal(f.docker.calls.some(args => ['create', 'start', 'stop'].includes(args[0]!)), false)
})

test('an interrupted atomic write cannot prevent later disk records from being reconciled', options, async t => {
  const f = await fixture(t); await f.store.preserve(f.source)
  await writeFile(join(f.root, 'sealed-creations', `.${f.source.closure.executionId}.${randomUUID()}.tmp`), 'partial', { mode: 0o600 })
  for (let index = 0; index < 3; index++) await f.store.reconcileOne(f.identity, f.containers, () => false)
  assert.equal(f.docker.calls.length, 1)
  assert.equal(sealedCreation.parse(JSON.parse(await readFile(f.path, 'utf8'))).removalConfirmed, false)
})

test('completed cleanup facts survive a pending journal and are removed only after retirement', options, async t => {
  for (const mode of ['removed', 'no-image'] as const) await t.test(mode, async t => {
    const f = await fixture(t)
    await f.store.preserve(mode === 'no-image' ? { ...f.source, imageId: null } : f.source)
    if (mode === 'removed') { f.docker.present = true; await f.store.cleanup(f.source.closure.executionId, f.identity, f.containers) }
    const before = f.docker.calls.length
    await f.store.reconcileOne(f.identity, f.containers, id => { assert.equal(id, f.source.closure.executionId); return true })
    assert.equal(f.docker.calls.length, before); await stat(f.path)
    await f.store.reconcileOne(f.identity, f.containers, () => false)
    await f.store.reconcileOne(f.identity, f.containers, () => false)
    await assert.rejects(stat(f.path), { code: 'ENOENT' })
    assert.equal(f.docker.calls.length, before)
  })
})

test('lost removal ACK uses only a previously synced exact stop observation; initial absence never becomes stop', options, async t => {
  const f = await fixture(t)
  const receipt = ownedContainerReceipt.parse({ containerId: ID, imageId: IMAGE, owner: f.source.owner })
  await f.store.preserve({ ...f.source, receipt })
  await assert.rejects(f.store.cleanup(f.source.closure.executionId, f.identity, f.containers), { code: 'sealed_creation_stop_unconfirmed' })
  f.docker.present = true; f.docker.lostRemove = true
  const cleaned = await f.store.cleanup(f.source.closure.executionId, f.identity, f.containers)
  assert(cleaned.observation); assert.equal(cleaned.removalConfirmed, true)
  const before = f.docker.calls.length
  assert.deepEqual(await f.store.cleanup(f.source.closure.executionId, f.identity, f.containers), cleaned)
  assert.equal(f.docker.calls.length, before)
})

test('running or foreign image observations are never removed or recorded as stopped', options, async t => {
  for (const mode of ['running', 'foreign'] as const) await t.test(mode, async t => {
    const f = await fixture(t); await f.store.preserve(f.source); f.docker.present = true
    if (mode === 'running') f.docker.state = { ...created, Running: true, Status: 'running' }
    else f.docker.image = 'sha256:' + 'd'.repeat(64)
    await assert.rejects(f.store.cleanup(f.source.closure.executionId, f.identity, f.containers),
      { code: mode === 'running' ? 'sealed_creation_running' : 'container_identity_mismatch' })
    const saved = sealedCreation.parse(JSON.parse(await readFile(f.path, 'utf8')))
    assert.equal(saved.observation, undefined); assert.equal(saved.removalConfirmed, false)
    assert.equal(f.docker.calls.some(args => args[0] === 'rm'), false)
  })
})

test('foreign enrollment, malformed JSON and linked record files fail without exposing contents or touching Docker', options, async t => {
  for (const mode of ['foreign', 'json', 'symlink', 'hardlink'] as const) await t.test(mode, async t => {
    const f = await fixture(t); await f.store.preserve(f.source)
    let identity = f.identity
    if (mode === 'foreign') identity = { ...identity, enrollmentId: ownedContainerOwner.shape.enrollmentId.parse(randomUUID()) }
    if (mode === 'json') await writeFile(f.path, '{"private":"must-not-appear"}', { mode: 0o600 })
    if (mode === 'symlink' || mode === 'hardlink') {
      const other = join(f.root, 'other.json'); await writeFile(other, JSON.stringify(f.source), { mode: 0o600 })
      await rm(f.path)
      if (mode === 'symlink') await symlink(other, f.path)
      else await link(other, f.path)
    }
    await assert.rejects(f.store.cleanup(f.source.closure.executionId, identity, f.containers),
      { code: mode === 'foreign' ? 'sealed_creation_identity_changed' : 'sealed_creation_invalid' })
    assert.equal(f.docker.calls.length, 0)
  })
})
