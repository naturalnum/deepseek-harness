/** Device closed_unknown against isolated real PG; container receipts are synthetic, never Docker evidence. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DeviceService } from '../lib/platform/devices.js'
import { taskCredential, disableFixtureAccount, enableFixtureAccount } from './task-credential-fixture.mjs'
import { deviceProtocolFixture, registrationFor, finishFor, deviceResult } from './device-execution-protocol-fixture.mjs'

async function stopped(t, output = { ...deviceResult, state: 'uncertain', exitCode: null }) {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), original = await f.claimed(f.alice, d)
  await f.devices.register(d.token, registrationFor(d, original.claim))
  const report = finishFor(d, original.claim, output)
  await f.devices.finish(d.token, report)
  const approval = await taskCredential(f.pool, f.alice, 'approval')
  const inspection = await f.devices.inspectResolution(f.alice, original.claim.executionId)
  return { ...f, d, ...original, report, approval, inspection }
}
const request = f => ({ requestId: randomUUID(), executionId: f.claim.executionId, target: 'desktop',
  fingerprint: f.inspection.fingerprint, note: 'Synthetic independent Device closure' })
const facts = row => ({ dispatchRequest: row.dispatch_request, requestDigest: row.request_digest,
  instanceId: row.device_instance_id, processId: row.dispatch_process_id, dispatchId: row.dispatch_id,
  containerReceipt: row.container_receipt, startAuthorizedAt: row.start_authorized_at,
  stopRequestId: row.stop_request_id, stopRecordDigest: row.stop_record_digest,
  observation: row.stop_observation, result: row.result, continuationRequestId: row.continuation_request_id })
const countResolutions = async f => (await f.pool.query('SELECT count(*)::integer AS n FROM pe_device_execution_resolutions')).rows[0].n

test('independent closure retains NUL output and all stop facts, resumes once, and permits the original finish ACK', { timeout: 60000 }, async t => {
  const f = await stopped(t, { ...deviceResult, state: 'uncertain', exitCode: null, stdout: 'kept\u0000表😀\n' })
  const before = await f.row(f.claim.executionId), input = request(f)
  assert.equal(f.inspection.canStop, true); assert.equal(f.inspection.runnerObservation, 'stopped_unknown')
  const completed = await f.devices.resolveUncertain(f.alice, input, f.approval)
  assert.equal(completed.state, 'completed'); assert.equal(completed.target, 'desktop')
  assert.equal(completed.finalState, 'closed_unknown'); assert.equal(completed.stopConfirmed, true)
  assert.equal(completed.continuationQueued, true)
  assert.deepEqual(facts(await f.row(f.claim.executionId)), facts(before))
  const stored = (await f.pool.query('SELECT snapshot FROM pe_device_execution_resolutions')).rows[0].snapshot
  assert.equal(stored.result.stdout, f.report.result.stdout)
  const continuation = (await f.pool.query(`SELECT request_id,execution_target,input FROM pe_operations
    WHERE source_desktop_execution_id=$1`, [f.claim.executionId])).rows[0]
  assert.equal(continuation.request_id, before.continuation_request_id)
  assert.deepEqual(continuation.execution_target, { kind: 'desktop', deviceId: f.d.deviceId, directoryId: f.d.directoryId })
  assert.equal(continuation.input, `可信本地桌面对账结果：执行 ${f.claim.executionId} 的原容器已确切停止，命令结果仍然未知，已以 closed_unknown 结案。这不表示命令成功、失败或没有产生副作用。不要重放原命令；先核对现有文件和外部状态，再向用户说明已知事实与未确认结果。`)
  assert.equal((await f.devices.finish(f.d.token, f.report)).state, 'closed_unknown')
  assert.equal(await f.continuations(f.claim.executionId), 1)
  assert.deepEqual((await f.devices.resolutionStatus(f.alice, input.requestId)).receipt, completed)
  assert.equal((await f.devices.inspectResolution(f.alice, f.claim.executionId)).canStop, false)
  assert.equal((await f.devices.listResolutions(f.alice, { sessionId: f.sessionId })).items[0].executionState, 'closed_unknown')
  const next = await f.operation(f.alice, f.d)
  assert.equal((await f.devices.propose(next.grant.token, 'next-safe-command', 'printf next', '.')).state, 'queued')
})

test('foreign owners and Agent credentials cannot approve, inspect or obtain another closure receipt', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f)
  assert.equal((await f.devices.listResolutions(f.bob, {})).items.length, 0)
  await assert.rejects(f.devices.inspectResolution(f.bob, f.claim.executionId), { code: 'execution_not_found' })
  await assert.rejects(f.devices.listResolutions(f.bob, { sessionId: f.sessionId }), { code: 'session_not_found' })
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, await taskCredential(f.pool, f.alice)), { status: 401 })
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, await taskCredential(f.pool, f.bob, 'approval')), { status: 401 })
  await assert.rejects(f.devices.resolveUncertain(f.bob, input, await taskCredential(f.pool, f.bob, 'approval')), { code: 'execution_not_found' })
  await assert.rejects(f.devices.resolveUncertain(f.alice, { ...input, target: 'cloud' }, f.approval), { code: 'wrong_execution_target' })
  assert.equal(await countResolutions(f), 0)
  await f.devices.resolveUncertain(f.alice, input, f.approval)
  assert.equal((await f.devices.resolutionStatus(f.bob, input.requestId)).receipt, null)
})

test('no stop, legacy and cold-claim identities remain blocked with no release or continuation', { timeout: 60000 }, async t => {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice), { claim } = await f.claimed(f.alice, d)
  const approval = await taskCredential(f.pool, f.alice, 'approval')
  await f.pool.query("UPDATE pe_desktop_executions SET state='uncertain' WHERE id=$1", [claim.executionId])
  const input = { requestId: randomUUID(), executionId: claim.executionId, target: 'desktop', fingerprint: '0'.repeat(64), note: '' }
  assert.equal((await f.devices.inspectResolution(f.alice, claim.executionId)).blockedReason, 'device_stop_unconfirmed')
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, approval), { code: 'device_stop_unconfirmed' })
  await assert.rejects(f.devices.claim(d.token, d.instanceId, claim.executionId, randomUUID()), { code: 'desktop_execution_unavailable' })
  await f.pool.query('UPDATE pe_desktop_executions SET dispatch_id=NULL,dispatch_process_id=NULL,dispatch_request=NULL,device_instance_id=NULL WHERE id=$1', [claim.executionId])
  assert.equal((await f.devices.inspectResolution(f.alice, claim.executionId)).canStop, false)
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, approval), { code: 'device_stop_unconfirmed' })
  assert.equal(await countResolutions(f), 0); assert.equal(await f.continuations(claim.executionId), 0)
  assert.equal((await f.row(claim.executionId)).state, 'uncertain')
})

test('any changed enrollment, process, dispatch, receipt, request or stop fact rejects the frozen approval', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f), original = await f.row(f.claim.executionId)
  const edits = [
    ['device_instance_id', randomUUID()], ['dispatch_process_id', randomUUID()], ['dispatch_id', randomUUID()],
    ['container_receipt', { ...original.container_receipt, containerId: 'c'.repeat(64) }],
    ['container_receipt', { ...original.container_receipt, imageId: `sha256:${'d'.repeat(64)}` }],
    ['dispatch_request', { ...original.dispatch_request, timeoutMs: 9999 }],
    ['stop_record_digest', 'f'.repeat(64)], ['stop_request_id', randomUUID()],
    ['stop_observation', { ...original.stop_observation, ExitCode: 4 }],
    ['result', { ...original.result, stdout: 'changed' }],
  ]
  for (const [field, value] of edits) {
    await f.pool.query(`UPDATE pe_desktop_executions SET ${field}=$2 WHERE id=$1`,
      [f.claim.executionId, typeof value === 'object' ? JSON.stringify(value) : value])
    assert.equal((await f.devices.inspectResolution(f.alice, f.claim.executionId)).canStop, false)
    await assert.rejects(f.devices.resolveUncertain(f.alice, input, f.approval), error => error.status === 409)
    await f.pool.query(`UPDATE pe_desktop_executions SET ${field}=$2 WHERE id=$1`,
      [f.claim.executionId, typeof original[field] === 'object' ? JSON.stringify(original[field]) : original[field]])
  }
  await f.pool.query('UPDATE pe_devices SET instance_id=$2 WHERE id=$1', [f.d.deviceId, randomUUID()])
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, f.approval), { code: 'device_resolution_identity_changed' })
  await f.pool.query('UPDATE pe_devices SET instance_id=$2 WHERE id=$1', [f.d.deviceId, f.d.instanceId])
  await assert.rejects(f.devices.resolveUncertain(f.alice, { ...input, fingerprint: '0'.repeat(64) }, f.approval), { code: 'execution_identity_changed' })
  assert.equal(await countResolutions(f), 0); assert.equal(await f.continuations(f.claim.executionId), 0)
})

test('two replicas and response-loss retries return one receipt; conflicting bytes and a second intent fail', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f), second = new DeviceService(f.tasks, 9999, {})
  const [a, b] = await Promise.all([f.devices.resolveUncertain(f.alice, input, f.approval), second.resolveUncertain(f.alice, input, f.approval)])
  assert.deepEqual(a, b)
  assert.deepEqual(await second.resolveUncertain(f.alice, input, f.approval), a)
  assert.deepEqual((await second.resolutionStatus(f.alice, input.requestId)).receipt, a)
  for (const changed of [{ ...input, note: 'changed' }, { ...input, fingerprint: '0'.repeat(64) },
    { ...input, executionId: randomUUID() }]) {
    await assert.rejects(second.resolveUncertain(f.alice, changed, f.approval), { code: 'request_id_conflict' })
  }
  await assert.rejects(second.resolveUncertain(f.alice, { ...input, requestId: randomUUID() }, f.approval), { code: 'execution_resolution_exists' })
  assert.equal(await countResolutions(f), 1); assert.equal(await f.continuations(f.claim.executionId), 1)
})

test('revoked Device can retry exact finish after closure, but changed cleanup bytes remain rejected', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f), before = facts(await f.row(f.claim.executionId))
  await f.devices.revoke(f.alice, f.d.deviceId)
  const completed = await f.devices.resolveUncertain(f.alice, input, f.approval)
  assert.equal(completed.finalState, 'closed_unknown')
  await assert.rejects(f.devices.jobs(f.d.token, f.d.instanceId), { code: 'device_unauthorized' })
  const ack = await f.devices.finish(f.d.token, f.report)
  assert.equal(ack.state, 'closed_unknown'); assert.equal(ack.stopConfirmed, true)
  assert.equal((await f.devices.register(f.d.token, registrationFor(f.d, f.claim))).canStart, false)
  await assert.rejects(f.devices.finish(f.d.token, { ...f.report, requestId: randomUUID() }), { code: 'stop_record_conflict' })
  await assert.rejects(f.devices.finish(f.d.token, { ...f.report, result: { ...f.report.result, stdout: 'changed' } }), { code: 'stop_record_conflict' })
  assert.deepEqual(facts(await f.row(f.claim.executionId)), before)
  assert.equal(await f.continuations(f.claim.executionId), 1)
})

test('account disablement fences approval; re-enable permits closure without reviving old account work', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f)
  await disableFixtureAccount(f.pool, f.alice)
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, f.approval), { status: 401 })
  assert.equal(await countResolutions(f), 0)
  await enableFixtureAccount(f.pool, f.alice)
  const completed = await f.devices.resolveUncertain(f.alice, input, await taskCredential(f.pool, f.alice, 'approval'))
  assert.equal(completed.continuationQueued, false)
  assert.equal((await f.row(f.claim.executionId)).error_code, 'account_disabled')
  assert.equal(await f.continuations(f.claim.executionId), 0)
  assert.equal((await f.devices.finish(f.d.token, f.report)).state, 'closed_unknown')
})

test('failure after continuation insertion rolls back state, receipt and continuation together', { timeout: 60000 }, async t => {
  const f = await stopped(t), input = request(f), before = await f.row(f.claim.executionId)
  await f.pool.query(`CREATE FUNCTION reject_device_closure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic closure rollback'; END $$;
    CREATE TRIGGER reject_device_closure BEFORE INSERT ON pe_device_execution_resolutions
    FOR EACH ROW EXECUTE FUNCTION reject_device_closure();`)
  await assert.rejects(f.devices.resolveUncertain(f.alice, input, f.approval), /synthetic closure rollback/u)
  const after = await f.row(f.claim.executionId)
  assert.equal(after.state, 'uncertain'); assert.equal(after.continuation_queued, false)
  assert.deepEqual(facts(after), facts(before))
  assert.equal(await countResolutions(f), 0); assert.equal(await f.continuations(f.claim.executionId), 0)
  await f.pool.query('DROP TRIGGER reject_device_closure ON pe_device_execution_resolutions')
  assert.equal((await f.devices.resolveUncertain(f.alice, input, f.approval)).finalState, 'closed_unknown')
})
