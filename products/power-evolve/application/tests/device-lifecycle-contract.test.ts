/** Private process lifecycle messages keep readiness, quiescence and durable stop facts distinct. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { deviceLifecycleReady, deviceLifecycleRequest, deviceLifecycleSnapshot,
  deviceDrainEntry, deviceDrainReport } from '@power-evolve/contracts/device-lifecycle'

const base = { kind: 'power-evolve-device-lifecycle', version: 1, launchId: randomUUID() }

test('startup cancellation requires no old readiness but termination needs the current instance', () => {
  const request = { ...base, type: 'request', action: 'quiesce', instanceId: null, requestId: randomUUID() }
  assert(deviceLifecycleRequest.safeParse(request).success)
  assert(!deviceLifecycleRequest.safeParse({ ...request, action: 'terminate' }).success)
  assert(deviceLifecycleRequest.safeParse({ ...request, action: 'terminate', instanceId: randomUUID() }).success)
  assert(!deviceLifecycleRequest.safeParse({ ...request, path: '/private/project' }).success)
  assert(!deviceLifecycleRequest.safeParse({ ...request, version: 2 }).success)
})

test('readiness permits only a fresh process and an exact loopback origin', () => {
  const ready = { ...base, type: 'ready', instanceId: randomUUID(), pid: process.pid, url: 'http://127.0.0.1:20891/' }
  assert(deviceLifecycleReady.safeParse(ready).success)
  for (const url of ['https://example.com/', 'http://127.0.0.1:20891/config', 'http://user@127.0.0.1:20891/',
    'http://127.0.0.1:20891/?nonce=private', 'http://127.0.0.1/']) {
    assert(!deviceLifecycleReady.safeParse({ ...ready, url }).success, url)
  }
  assert(!deviceLifecycleReady.safeParse({ ...ready, pid: 0 }).success)
})

test('process quiescence can retain unconfirmed writers and pending late cleanup', () => {
  const entry = { executionId: randomUUID(), state: 'unconfirmed' }
  const snapshot = { phase: 'quiescent', admissionOpen: false, pendingActions: 0, journalEntries: 1,
    drain: { entries: [entry], cleanupPending: 1 } }
  assert(deviceLifecycleSnapshot.safeParse(snapshot).success)
  assert(!deviceLifecycleSnapshot.safeParse({ ...snapshot, admissionOpen: true }).success)
  assert(!deviceLifecycleSnapshot.safeParse({ ...snapshot, pendingActions: 1 }).success)
  assert(!deviceLifecycleSnapshot.safeParse({ ...snapshot, drain: null }).success)
  assert(!deviceLifecycleSnapshot.safeParse({ ...snapshot, allContainersStopped: true }).success)
  assert(!deviceDrainReport.safeParse({ entries: [entry, entry], cleanupPending: 0 }).success)
})

test('a stop observation belongs to its exact journal execution', () => {
  const executionId = randomUUID()
  const observation = { receipt: { containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
    owner: { deviceId: randomUUID(), enrollmentId: randomUUID(), executionId, creationId: randomUUID(), requestDigest: 'c'.repeat(64) } },
    Running: false, ExitCode: 0, Status: 'exited', StartedAt: 'started', FinishedAt: 'finished' }
  assert(deviceDrainEntry.safeParse({ executionId, state: 'stopConfirmed', observation }).success)
  assert(!deviceDrainEntry.safeParse({ executionId: randomUUID(), state: 'stopConfirmed', observation }).success)
  assert(!deviceDrainEntry.safeParse({ executionId, state: 'stopConfirmed', observation: { ...observation, Running: true } }).success)
})
