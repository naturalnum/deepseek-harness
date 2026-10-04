/** Trusted reconciliation never accepts browser-supplied execution results or stop proof. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { executionResolutionRequest, executionResolutionReceipt, executionResolutionInspection,
  executionResolutionsList, EXECUTION_RESOLUTION_ROUTES,
  EXECUTION_RESOLUTION_APPROVAL_ROUTES } from '../../contracts/lib/execution-resolution.js'

const identity = { requestId: randomUUID(), executionId: randomUUID(), sessionId: randomUUID() }
const request = { requestId: identity.requestId, executionId: identity.executionId,
  target: 'cloud', fingerprint: 'a'.repeat(64), note: '核实原执行者；结果不明时保留未知状态。' }
const receipt = { ...identity, target: 'cloud', state: 'completed', finalState: 'closed_unknown',
  stopConfirmed: true, continuationQueued: true, errorCode: null }
const item = { executionId: identity.executionId, sessionId: identity.sessionId, target: 'cloud',
  executionState: 'uncertain', command: 'git status', cwd: '.', createdAt: new Date().toISOString(),
  errorCode: 'runner_missing', resolution: null }

test('stop-and-reconcile selects original identities and excludes browser assertions of facts', () => {
  assert.deepEqual(executionResolutionRequest.parse(request), request)
  for (const field of ['userId', 'podUid', 'runnerInstanceId', 'stopEvidence', 'result', 'command']) {
    assert.equal(executionResolutionRequest.safeParse({ ...request, [field]: 'untrusted' }).success, false)
  }
  for (const invalid of [{ ...request, target: 'local-shell' }, { ...request, fingerprint: 'stopped' },
    { ...request, note: '\0' }, { ...request, note: 'x'.repeat(501) }]) {
    assert.equal(executionResolutionRequest.safeParse(invalid).success, false)
  }
  const { requestId: omitted, ...withoutId } = request
  assert.equal(executionResolutionRequest.safeParse(withoutId).success, false)
})

test('Desktop closure selects its provider and cannot treat an unavailable observation as stopped', () => {
  assert.deepEqual(executionResolutionRequest.parse({ ...request, target: 'desktop' }), { ...request, target: 'desktop' })
  const inspection = { item: { ...item, target: 'desktop' }, fingerprint: request.fingerprint,
    canStop: true, blockedReason: null, runnerObservation: 'stopped_unknown' }
  assert.deepEqual(executionResolutionInspection.parse(inspection), inspection)
  for (const runnerObservation of ['not_observed', 'running', 'unavailable', 'identity_changed']) {
    assert.equal(executionResolutionInspection.safeParse({ ...inspection, runnerObservation }).success, false)
  }
  const desktopReceipt = { ...receipt, target: 'desktop' }
  const completed = { ...inspection.item, executionState: 'closed_unknown', resolution: desktopReceipt }
  assert.equal(executionResolutionsList.safeParse({ available: true, items: [completed] }).success, true)
  assert.equal(executionResolutionsList.safeParse({ available: true,
    items: [{ ...completed, resolution: receipt }] }).success, false)
  assert.equal(executionResolutionInspection.safeParse({ ...inspection, item }).success, false)
})

test('completion preserves unknown outcomes and requires an independently confirmed stopped writer', () => {
  assert.deepEqual(executionResolutionReceipt.parse(receipt), receipt)
  for (const finalState of ['succeeded', 'failed', 'cancelled', 'closed_unknown']) {
    assert.equal(executionResolutionReceipt.safeParse({ ...receipt, finalState }).success, true)
  }
  for (const invalid of [{ ...receipt, stopConfirmed: false }, { ...receipt, finalState: null },
    { ...receipt, errorCode: 'mount_stop_unconfirmed' }, { ...receipt, state: 'stopping' }]) {
    assert.equal(executionResolutionReceipt.safeParse(invalid).success, false)
  }
  const blocked = { ...receipt, state: 'blocked', finalState: null, stopConfirmed: false,
    continuationQueued: false, errorCode: 'mount_stop_proof_missing' }
  assert.deepEqual(executionResolutionReceipt.parse(blocked), blocked)
  assert.equal(executionResolutionReceipt.safeParse({ ...blocked, errorCode: null }).success, false)
  assert.equal(executionResolutionReceipt.safeParse({ ...blocked, continuationQueued: true }).success, false)
})

test('inspection distinguishes missing identities and ongoing reconciliation without granting approval', () => {
  const inspection = { item, fingerprint: request.fingerprint, canStop: true,
    blockedReason: null, runnerObservation: 'not_observed' }
  assert.deepEqual(executionResolutionInspection.parse(inspection), inspection)
  assert.equal(executionResolutionInspection.safeParse({ ...inspection, fingerprint: null }).success, false)
  assert.equal(executionResolutionInspection.safeParse({ ...inspection,
    item: { ...item, resolution: receipt } }).success, false)
  const unavailable = { ...inspection, fingerprint: null, canStop: false,
    blockedReason: 'execution_identity_missing', runnerObservation: 'unavailable' }
  assert.deepEqual(executionResolutionInspection.parse(unavailable), unavailable)
  assert.equal(executionResolutionsList.safeParse({ available: true, items: [item] }).success, true)
  const completed = { ...item, executionState: 'closed_unknown', resolution: receipt }
  assert.equal(executionResolutionsList.safeParse({ available: true, items: [completed] }).success, true)
  assert.equal(executionResolutionsList.safeParse({ available: true,
    items: [{ ...completed, resolution: { ...receipt, executionId: randomUUID() } }] }).success, false)
  assert.equal(executionResolutionsList.safeParse({ available: true, items: Array(101).fill(item) }).success, false)
  assert.equal(Object.values(EXECUTION_RESOLUTION_ROUTES).some(route => route.includes('/approvals/')), false)
  assert.equal(Object.values(EXECUTION_RESOLUTION_ROUTES).includes(EXECUTION_RESOLUTION_APPROVAL_ROUTES.resolve), false)
})
