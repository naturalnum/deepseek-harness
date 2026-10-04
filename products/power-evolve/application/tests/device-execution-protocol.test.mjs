/** Device dispatch, start authority and stop records against isolated real PostgreSQL; no Docker is started. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { DeviceService } from '../lib/platform/devices.js'
import { disableFixtureAccount } from './task-credential-fixture.mjs'
import { deviceProtocolFixture, deviceResult as result, registrationFor, finishFor } from './device-execution-protocol-fixture.mjs'

test('frozen dispatch timeout survives service recreation and only one process owns its dispatch', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), op = await f.accepted(f.alice, d)
  const rebuilt = new DeviceService(f.tasks, 9876, {})
  assert.deepEqual(await rebuilt.propose(op.grant.token, 'synthetic-call', 'printf synthetic', '.'), op.execution)
  await assert.rejects(rebuilt.propose(op.grant.token, 'synthetic-call', 'printf changed', '.'), { code: 'request_id_conflict' })
  assert.equal((await rebuilt.jobs(d.token, d.instanceId)).jobs[0].timeoutMs, 1234)
  const processId = randomUUID(), claim = await rebuilt.claim(d.token, d.instanceId, op.execution.executionId, processId)
  assert.equal(claim.timeoutMs, 1234)
  assert.deepEqual(await rebuilt.claim(d.token, d.instanceId, op.execution.executionId, processId), claim)
  await assert.rejects(rebuilt.claim(d.token, d.instanceId, op.execution.executionId, randomUUID()), { code: 'device_process_changed' })
  const stored = await f.row(claim.executionId)
  assert.equal(stored.device_instance_id, d.instanceId)
  assert.equal(stored.dispatch_id, claim.dispatchId)
  assert.equal(stored.dispatch_process_id, processId)
  assert.equal(stored.request_digest, createHash('sha256').update(JSON.stringify(stored.dispatch_request)).digest('hex'))
})

test('legacy dispatches without snapshot or enrollment are never delivered or claimed', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { execution } = await f.accepted(f.alice, d)
  for (const field of ['dispatch_request', 'device_instance_id']) {
    const original = await f.row(execution.executionId)
    await f.pool.query(`UPDATE pe_desktop_executions SET ${field}=NULL WHERE id=$1`, [execution.executionId])
    assert.equal((await f.devices.jobs(d.token, d.instanceId)).jobs.length, 0)
    await assert.rejects(f.devices.claim(d.token, d.instanceId, execution.executionId, randomUUID()), { code: 'device_dispatch_unavailable' })
    await f.pool.query(`UPDATE pe_desktop_executions SET ${field}=$2 WHERE id=$1`,
      [execution.executionId, field === 'dispatch_request' ? JSON.stringify(original[field]) : original[field]])
  }
  assert.equal((await f.row(execution.executionId)).state, 'queued')
})

test('first container registration alone grants start, including an ACK-loss retry and concurrent duplicate', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  const registration = registrationFor(d, claim)
  const responses = await Promise.all([f.devices.register(d.token, registration), f.devices.register(d.token, registration)])
  assert.deepEqual(responses.map(value => value.canStart).sort(), [false, true])
  assert.equal((await new DeviceService(f.tasks, 4321, {}).register(d.token, registration)).canStart, false)
  const stored = await f.row(claim.executionId)
  assert.deepEqual(stored.container_receipt, registration.receipt)
  assert.ok(stored.start_authorized_at instanceof Date)
  await assert.rejects(f.devices.register(d.token, { ...registration,
    receipt: { ...registration.receipt, containerId: 'c'.repeat(64) } }), { code: 'container_identity_changed' })
})

test('recovery capture queries never register or grant a start and preserve every execution field', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), foreign = await f.enroll(f.bob)
  const { claim } = await f.claimed(f.alice, d), registration = registrationFor(d, claim)
  const before = await f.row(claim.executionId)
  await assert.rejects(f.devices.registered(d.token, registration), { code: 'device_container_not_registered' })
  assert.deepEqual(await f.row(claim.executionId), before)
  assert.equal((await f.devices.register(d.token, registration)).canStart, true)
  const captured = await f.row(claim.executionId)
  const rebuilt = new DeviceService(f.tasks, 9876, {})
  const receipts = await Promise.all([f.devices.registered(d.token, registration), rebuilt.registered(d.token, registration)])
  assert.deepEqual(receipts, [0, 1].map(() => ({ executionId: claim.executionId,
    dispatchId: claim.dispatchId, receipt: registration.receipt, canStart: false })))
  await assert.rejects(rebuilt.registered(foreign.token, registration), { code: 'execution_not_found' })
  await assert.rejects(rebuilt.registered(d.token, { ...registration, processId: randomUUID() }), { code: 'device_process_changed' })
  await assert.rejects(rebuilt.registered(d.token, { ...registration, receipt: { ...registration.receipt,
    containerId: 'c'.repeat(64) } }), { code: 'container_identity_changed' })
  assert.deepEqual(await f.row(claim.executionId), captured)
  assert.equal(await f.continuations(claim.executionId), 0)
  await f.devices.revoke(f.alice, d.deviceId)
  const revoked = await f.row(claim.executionId)
  assert.equal((await rebuilt.registered(d.token, registration)).canStart, false)
  assert.deepEqual(await f.row(claim.executionId), revoked)
})

test('recovery capture queries refuse a permanently sealed creation without changing its fence or continuation', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  await f.devices.closeUnstartedClaim(d.token, { instanceId: d.instanceId, executionId: claim.executionId,
    processId: claim.processId, directoryId: claim.directoryId, digest: claim.digest, requestId: randomUUID() })
  const sealed = await f.row(claim.executionId)
  await assert.rejects(f.devices.registered(d.token, registrationFor(d, claim)), { code: 'device_claim_closed' })
  assert.deepEqual(await f.row(claim.executionId), sealed)
  assert.equal(await f.continuations(claim.executionId), 1)
})

test('foreign device, process, dispatch and immutable receipts cannot register or report stop', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), foreign = await f.enroll(f.bob)
  const { claim } = await f.claimed(f.alice, d), registration = registrationFor(d, claim)
  await assert.rejects(f.devices.register(foreign.token, registration), { code: 'execution_not_found' })
  await assert.rejects(f.devices.register(d.token, { ...registration, processId: randomUUID() }), { code: 'device_process_changed' })
  await assert.rejects(f.devices.register(d.token, { ...registration, dispatchId: randomUUID() }), { code: 'device_process_changed' })
  for (const owner of [{ ...registration.receipt.owner, deviceId: foreign.deviceId },
    { ...registration.receipt.owner, executionId: randomUUID() },
    { ...registration.receipt.owner, requestDigest: 'c'.repeat(64) }]) {
    await assert.rejects(f.devices.register(d.token, { ...registration,
      receipt: { ...registration.receipt, owner } }), { code: 'container_identity_changed' })
  }
  assert.equal((await f.row(claim.executionId)).container_receipt, null)
  await assert.rejects(f.devices.finish(d.token, finishFor(d, claim)), { code: 'container_identity_changed' })
  await f.devices.register(d.token, registration)
  await assert.rejects(f.devices.finish(foreign.token, finishFor(d, claim)), { code: 'execution_not_found' })
  await assert.rejects(f.devices.finish(d.token, { ...finishFor(d, claim), processId: randomUUID() }), { code: 'device_process_changed' })
  await assert.rejects(f.devices.finish(d.token, finishFor(d, claim, result,
    { ...registration.receipt, imageId: `sha256:${'d'.repeat(64)}` })), { code: 'container_identity_changed' })
  assert.equal((await f.row(claim.executionId)).stop_request_id, null)
})

test('revoked credentials retain only their original cleanup path and success cannot release unknown work', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  await f.devices.revoke(f.alice, d.deviceId)
  assert.equal(await f.continuations(claim.executionId), 0)
  await assert.rejects(f.devices.jobs(d.token, d.instanceId), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.claim(d.token, d.instanceId, claim.executionId, claim.processId), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.directory(d.token, 'new directory'), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.readCloud(d.token, d.directoryId, 'anything'), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.putCloud(d.token, d.directoryId, randomUUID(), 'anything', 'eA=='), { code: 'device_unauthorized' })
  assert.equal((await f.devices.register(d.token, registrationFor(d, claim))).canStart, false)
  const report = finishFor(d, claim), receipt = await f.devices.finish(d.token, report)
  assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.stopConfirmed, true)
  assert.deepEqual(await f.devices.finish(d.token, report), receipt)
  const stored = await f.row(claim.executionId)
  assert.deepEqual(stored.result, result); assert.deepEqual(stored.stop_observation, report.observation)
  assert.equal(stored.continuation_queued, false); assert.equal(await f.continuations(claim.executionId), 0)
})

test('unknown stop records reserve their directory; known result retries queue exactly one original continuation', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), first = await f.claimed(f.alice, d)
  await f.devices.register(d.token, registrationFor(d, first.claim))
  const report = finishFor(d, first.claim)
  const receipts = await Promise.all([f.devices.finish(d.token, report), f.devices.finish(d.token, report)])
  assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0].state, 'succeeded')
  assert.equal(await f.continuations(first.claim.executionId), 1)
  assert.equal((await f.row(first.claim.executionId)).continuation_queued, true)
  await assert.rejects(f.devices.finish(d.token, { ...report, result: { ...result, stdout: 'changed' } }), { code: 'stop_record_conflict' })
  await assert.rejects(f.devices.finish(d.token, { ...report, requestId: randomUUID() }), { code: 'stop_record_conflict' })
  await f.tasks.finish(first.grant.token, 'completed', null)
  // Complete the platform continuation so the next accepted user input owns its own task grant.
  const resumed = await f.tasks.claim(randomUUID()); await f.tasks.finish(resumed.token, 'completed', null)
  const second = await f.claimed(f.alice, d)
  await f.devices.register(d.token, registrationFor(d, second.claim))
  const unknown = finishFor(d, second.claim, { ...result, state: 'uncertain', exitCode: null })
  assert.equal((await f.devices.finish(d.token, unknown)).state, 'uncertain')
  assert.equal(await f.continuations(second.claim.executionId), 0)
  assert.equal((await f.devices.jobs(d.token, d.instanceId)).jobs.length, 0)
  const another = await f.operation(f.alice, d)
  await assert.rejects(f.devices.propose(another.grant.token, 'different-session', 'printf new', '.'), { code: 'desktop_directory_busy' })
})

test('disablement still permits exact stop facts but never resumes the original account', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  await disableFixtureAccount(f.pool, f.alice)
  assert.equal((await f.devices.register(d.token, registrationFor(d, claim))).canStart, false)
  const finished = await f.devices.finish(d.token, finishFor(d, claim, { ...result, state: 'failed', exitCode: 1 }))
  assert.equal(finished.state, 'failed'); assert.equal(finished.errorCode, 'account_disabled')
  assert.equal(finished.stopConfirmed, true)
  assert.equal((await f.row(claim.executionId)).continuation_queued, false)
  assert.equal(await f.continuations(claim.executionId), 0)
})

test('same owned Device directory admits at most one concurrent writer across Sessions', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice)
  const first = await f.operation(f.alice, d), second = await f.operation(f.alice, d)
  const responses = await Promise.allSettled([f.devices.propose(first.grant.token, 'first', 'printf first', '.'),
    f.devices.propose(second.grant.token, 'second', 'printf second', '.')])
  assert.equal(responses.filter(value => value.status === 'fulfilled').length, 1)
  const rejected = responses.find(value => value.status === 'rejected')
  assert.equal(rejected.reason.code, 'desktop_directory_busy')
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_desktop_executions')).rows[0].n, 1)
})

test('known results must agree with exact stopped facts and a never-started container stays unknown', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  await f.devices.register(d.token, registrationFor(d, claim))
  const base = finishFor(d, claim)
  for (const input of [
    { ...base, observation: { ...base.observation, Status: 'created' } },
    { ...base, observation: { ...base.observation, Status: 'dead' } },
    { ...base, observation: { ...base.observation, ExitCode: 1 } },
    { ...base, result: { ...base.result, timedOut: true } },
    { ...base, result: { ...base.result, state: 'failed' } },
  ]) await assert.rejects(f.devices.finish(d.token, input), { code: 'stop_result_conflict' })
  assert.equal((await f.row(claim.executionId)).stop_request_id, null)
  const unstarted = { ...base, observation: { ...base.observation, Status: 'created' },
    result: { ...base.result, state: 'uncertain', exitCode: null } }
  assert.equal((await f.devices.finish(d.token, unstarted)).state, 'uncertain')
  assert.equal(await f.continuations(claim.executionId), 0)
  assert.equal((await f.devices.jobs(d.token, d.instanceId)).jobs.length, 0)
})
