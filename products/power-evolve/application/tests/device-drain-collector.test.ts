/** Original-file durability checks; Worker regressions separately exercise the real journal decoder. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { deviceDrainReport } from '@power-evolve/contracts/device-lifecycle'
import { collectDeviceDrainReport } from '../src/device/lifecycle.ts'

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pe-drain-collector-'))
  const root = join(base, 'private'), journal = join(root, 'journal.json')
  await mkdir(root, { mode: 0o700 })
  const executionId = randomUUID(), deviceId = randomUUID(), instanceId = randomUUID(), dispatchId = randomUUID()
  const stop = { executionId, state: 'stopConfirmed', observation: { receipt: {
    containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), owner: {
      deviceId, enrollmentId: instanceId, executionId, creationId: dispatchId, requestDigest: 'c'.repeat(64) } },
  Running: false, ExitCode: 0, Status: 'exited', StartedAt: 'started', FinishedAt: 'finished' } }
  await writeFile(journal, JSON.stringify([stop]), { mode: 0o600 })
  t.after(() => rm(base, { recursive: true, force: true }))
  const collect = () => collectDeviceDrainReport(root, value => deviceDrainReport.parse({ entries: value, cleanupPending: 0 }).entries,
    async () => {})
  return { root, journal, stop, collect, executionId, deviceId, instanceId, dispatchId }
}

test('collector returns synced original stop bytes and counts retained sealed cleanup without modifying either', async t => {
  const f = await fixture(t), cleanup = join(f.root, 'sealed-creations')
  await mkdir(cleanup, { mode: 0o700 })
  const file = join(cleanup, f.executionId + '.json')
  const closure = { instanceId: f.instanceId, executionId: f.executionId, processId: randomUUID(), directoryId: randomUUID(),
    digest: 'c'.repeat(64), requestId: randomUUID(), kind: 'unstarted_claim_closed', deviceId: f.deviceId,
    dispatchId: f.dispatchId, state: 'cancelled', startNeverAuthorized: true, continuationQueued: false }
  const pending = { closure, name: 'pe-local-' + f.executionId.replaceAll('-', ''),
    owner: f.stop.observation.receipt.owner, imageId: f.stop.observation.receipt.imageId, removalConfirmed: false }
  await writeFile(file, JSON.stringify(pending), { mode: 0o600 })
  const original = await readFile(f.journal), cleanupBytes = await readFile(file)
  assert.deepEqual(await f.collect(), { entries: [f.stop], cleanupPending: 1 })
  assert.deepEqual(await readFile(f.journal), original)
  assert.deepEqual(await readFile(file), cleanupBytes)
})

test('continuous file and directory sync failures never yield a report and retain original bytes for recovery', async t => {
  const f = await fixture(t), original = await readFile(f.journal)
  const handle = await open(f.journal, 'r'), prototype = Object.getPrototypeOf(handle), sync = handle.sync
  await handle.close()
  for (const kind of ['file', 'directory']) {
    const refusal = t.mock.method(prototype, 'sync', async function(this: FileHandle) {
      const current = await this.stat()
      if (kind === 'file' ? current.isFile() : current.isDirectory()) throw new Error('fixture sync /private/path failed')
      await sync.call(this)
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.collect(), error => error instanceof Error && error.message === 'device_drain_read_failed')
      assert.deepEqual(await readFile(f.journal), original)
    }
    refusal.mock.restore()
  }
  assert.equal((await f.collect()).entries[0]!.state, 'stopConfirmed')
})

test('existing invalid journal and symlink refuse without an empty-report fallback', async t => {
  const f = await fixture(t)
  await writeFile(f.journal, '{invalid json')
  await assert.rejects(f.collect(), /device_drain_read_failed/u)
  await rm(f.journal)
  const outside = join(f.root, 'outside.json')
  await writeFile(outside, JSON.stringify([f.stop]), { mode: 0o600 })
  await symlink(outside, f.journal)
  await assert.rejects(f.collect(), /device_drain_read_failed/u)
  assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), [f.stop])
})

test('collector enforces the 1024 residual-entry protocol limit without truncation', async t => {
  const f = await fixture(t)
  await writeFile(f.journal, JSON.stringify(Array.from({ length: 1025 }, () => ({ executionId: randomUUID(), state: 'unconfirmed' }))))
  await assert.rejects(f.collect(), /device_drain_read_failed/u)
})
