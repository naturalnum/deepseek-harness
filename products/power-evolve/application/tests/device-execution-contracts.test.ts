/** Device wire validation rejects identity substitution before Platform or Worker side effects. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { deviceClaimRequest, deviceContainerRegistered, deviceContainerRegistration,
  deviceFinishReceipt, deviceFinishRequest, deviceClaimClosureRequest, deviceClaimClosureReceipt } from '@power-evolve/contracts/device-execution'

function fixture() {
  const executionId = randomUUID(), instanceId = randomUUID(), dispatchId = randomUUID(), processId = randomUUID()
  const receipt = { containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), owner: {
    deviceId: randomUUID(), enrollmentId: instanceId, executionId, creationId: dispatchId, requestDigest: 'c'.repeat(64),
  } }
  const registration = { executionId, instanceId, dispatchId, processId, receipt }
  const finish = { executionId, instanceId, dispatchId, processId, requestId: randomUUID(),
    observation: { receipt, Running: false, ExitCode: 0, Status: 'exited',
      StartedAt: '2026-10-04T00:00:00Z', FinishedAt: '2026-10-04T00:00:01Z' },
    result: { state: 'uncertain', exitCode: null, stdout: '\0结果😀', stderr: '',
      stdoutTruncated: false, stderrTruncated: false, timedOut: false },
  }
  return { registration, finish }
}

test('claim and registration require an explicit process and exact original Docker owner', () => {
  const { registration } = fixture()
  assert.equal(deviceClaimRequest.safeParse({ instanceId: registration.instanceId, executionId: registration.executionId }).success, false)
  assert.equal(deviceContainerRegistration.safeParse(registration).success, true)
  for (const [key, value] of Object.entries({ executionId: randomUUID(), instanceId: randomUUID(), dispatchId: randomUUID() })) {
    assert.equal(deviceContainerRegistration.safeParse({ ...registration, [key]: value }).success, false)
  }
  assert.equal(deviceContainerRegistration.safeParse({ ...registration, localPath: '/private/local-project' }).success, false)
  assert.equal(deviceContainerRegistration.safeParse({ ...registration, receipt: { ...registration.receipt, containerId: 'a'.repeat(12) } }).success, false)
})

test('a stop report requires non-running original identity and preserves unknown output bytes', () => {
  const { finish } = fixture()
  assert.equal(deviceFinishRequest.parse(finish).result.stdout, '\0结果😀')
  assert.equal(deviceFinishRequest.safeParse({ ...finish, dispatchId: randomUUID() }).success, false)
  assert.equal(deviceFinishRequest.safeParse({ ...finish, observation: { ...finish.observation, Running: true } }).success, false)
  assert.equal(deviceFinishRequest.safeParse({ ...finish, observation: { ...finish.observation, Status: 'running' } }).success, false)
  assert.equal(deviceFinishRequest.safeParse({ ...finish, observation: null }).success, false)
  assert.equal(deviceFinishRequest.safeParse({ ...finish, result: { ...finish.result, state: 'closed_unknown' } }).success, false)
})

test('cleanup acknowledgements require a persisted stop and terminal state', () => {
  const { registration, finish } = fixture()
  const ack = { executionId: finish.executionId, dispatchId: finish.dispatchId, requestId: finish.requestId,
    stopConfirmed: true, state: 'uncertain' }
  assert.equal(deviceFinishReceipt.safeParse(ack).success, true)
  assert.equal(deviceFinishReceipt.safeParse({ ...ack, state: 'closed_unknown' }).success, true)
  assert.equal(deviceFinishReceipt.safeParse({ ...ack, state: 'running' }).success, false)
  assert.equal(deviceFinishReceipt.safeParse({ ...ack, stopConfirmed: false }).success, false)
  assert.equal(deviceFinishReceipt.safeParse({ ...ack, requestId: undefined }).success, false)
  assert.equal(deviceContainerRegistered.safeParse({ executionId: registration.executionId,
    dispatchId: registration.dispatchId, receipt: registration.receipt, canStart: false }).success, true)
})

test('an interrupted claim closes with original identities and a permanent no-start fact, never a fabricated stop', () => {
  const { registration } = fixture()
  const request = { instanceId: registration.instanceId, executionId: registration.executionId,
    processId: registration.processId, directoryId: randomUUID(), digest: registration.receipt.owner.requestDigest,
    requestId: randomUUID() }
  assert.equal(deviceClaimClosureRequest.safeParse(request).success, true)
  const receipt = { ...request, kind: 'unstarted_claim_closed', deviceId: registration.receipt.owner.deviceId,
    dispatchId: registration.dispatchId, state: 'cancelled', startNeverAuthorized: true, continuationQueued: false }
  assert.equal(deviceClaimClosureReceipt.safeParse(receipt).success, true)
  assert.equal(deviceClaimClosureReceipt.safeParse({ ...receipt, dispatchId: null }).success, true)
  for (const extra of [{ command: 'echo unwanted' }, { localPath: '/private/project' }, { observation: { Running: false } }]) {
    assert.equal(deviceClaimClosureRequest.safeParse({ ...request, ...extra }).success, false)
    assert.equal(deviceClaimClosureReceipt.safeParse({ ...receipt, ...extra }).success, false)
  }
  assert.equal(deviceClaimClosureReceipt.safeParse({ ...receipt, startNeverAuthorized: false }).success, false)
  assert.equal(deviceClaimClosureReceipt.safeParse({ ...receipt, stopConfirmed: true }).success, false)
  assert.equal(deviceClaimClosureReceipt.safeParse({ ...receipt, state: 'succeeded' }).success, false)
})
