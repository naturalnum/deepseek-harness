/** Interrupted claims against isolated real PG; Docker receipts are synthetic and no containers run. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { DeviceService } from '../lib/platform/devices.js'
import { deviceProtocolFixture, registrationFor, finishFor } from './device-execution-protocol-fixture.mjs'
import { taskCredential, disableFixtureAccount, enableFixtureAccount } from './task-credential-fixture.mjs'

async function claiming(t, bound = true) {
  const f = await deviceProtocolFixture(t), d = await f.enroll(f.alice)
  const original = bound ? await f.claimed(f.alice, d) : await f.accepted(f.alice, d)
  const row = await f.row(original.execution.executionId)
  const input = { requestId: randomUUID(), instanceId: d.instanceId, executionId: row.id,
    processId: original.claim?.processId ?? randomUUID(), directoryId: d.directoryId, digest: row.request_digest }
  return { ...f, d, ...original, input }
}
const count = async f => (await f.pool.query('SELECT count(*)::integer AS n FROM pe_device_claim_closures')).rows[0].n
const facts = row => ({ command: row.command, cwd: row.cwd, request: row.dispatch_request, digest: row.request_digest,
  instance: row.device_instance_id, process: row.dispatch_process_id, dispatch: row.dispatch_id,
  receipt: row.container_receipt, start: row.start_authorized_at, result: row.result,
  stop: row.stop_observation, stopId: row.stop_request_id, stopDigest: row.stop_record_digest,
  continuationId: row.continuation_request_id })

async function concurrentAfterAccountLock(f, actions) {
  const client = await f.pool.connect()
  let locked = false, pending
  try {
    await client.query('BEGIN'); locked = true
    await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [f.alice.userId])
    const { pid } = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
    pending = Promise.allSettled(actions.map(action => action()))
    const deadline = Date.now() + 5000
    let blocked = 0
    do {
      blocked = (await f.pool.query(`WITH RECURSIVE waiters(pid) AS (
        SELECT $1::integer UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w
          ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database())
        SELECT (count(*)-1)::integer AS n FROM waiters`, [pid])).rows[0].n
      if (blocked === actions.length) break
      await setTimeout(10)
    } while (Date.now() < deadline)
    assert.equal(blocked, actions.length, 'both requests must wait on the same locked account before racing')
    await client.query('COMMIT'); locked = false
    return await pending
  } finally {
    if (locked) await client.query('ROLLBACK')
    client.release()
    await pending
  }
}

test('lost claim ACK closes the original dispatch with one exact no-start continuation and permanent late-RPC fences', { timeout: 60000 }, async t => {
  const f = await claiming(t), before = await f.row(f.input.executionId)
  const closed = await f.devices.closeUnstartedClaim(f.d.token, f.input)
  assert.deepEqual(closed, { ...f.input, kind: 'unstarted_claim_closed', deviceId: f.d.deviceId,
    dispatchId: f.claim.dispatchId, state: 'cancelled', startNeverAuthorized: true, continuationQueued: true })
  assert.deepEqual(facts(await f.row(f.input.executionId)), facts(before))
  assert.equal(await count(f), 1); assert.equal(await f.continuations(f.input.executionId), 1)
  const continued = (await f.pool.query(`SELECT request_id,input,execution_target FROM pe_operations
    WHERE source_desktop_execution_id=$1`, [f.input.executionId])).rows[0]
  assert.equal(continued.request_id, before.continuation_request_id)
  assert.deepEqual(continued.execution_target, { kind: 'desktop', deviceId: f.d.deviceId, directoryId: f.d.directoryId })
  assert.equal(continued.input, `可信本地桌面领取核验结果：执行 ${f.input.executionId} 的原领取已永久封存，未获启动权限，已取消。不自动重放原命令；请向用户说明领取中断与现有核验事实。此回执不是 Docker 停止证明，也不包含命令执行结果。`)
  assert.equal((await f.devices.jobs(f.d.token, f.d.instanceId)).jobs.length, 0)
  assert.equal((await f.devices.propose(f.grant.token, 'synthetic-call', 'printf synthetic', '.')).state, 'cancelled')
  await assert.rejects(f.devices.claim(f.d.token, f.d.instanceId, f.input.executionId, f.input.processId), { code: 'device_claim_closed' })
  await assert.rejects(f.devices.register(f.d.token, registrationFor(f.d, f.claim)), { code: 'device_claim_closed' })
  await assert.rejects(f.devices.finish(f.d.token, finishFor(f.d, f.claim)), { code: 'device_claim_closed' })
  assert.deepEqual(facts(await f.row(f.input.executionId)), facts(before))
})

test('unbound queued cancellation preserves its already durable continuation and invents no dispatch', { timeout: 60000 }, async t => {
  const f = await claiming(t, false)
  await f.devices.cancel(f.alice, f.input.executionId)
  const existing = (await f.pool.query('SELECT input FROM pe_operations WHERE source_desktop_execution_id=$1', [f.input.executionId])).rows[0].input
  const closed = await f.devices.closeUnstartedClaim(f.d.token, f.input)
  assert.equal(closed.dispatchId, null); assert.equal(closed.continuationQueued, true)
  assert.equal(await f.continuations(f.input.executionId), 1)
  assert.equal((await f.pool.query('SELECT input FROM pe_operations WHERE source_desktop_execution_id=$1', [f.input.executionId])).rows[0].input, existing)
  assert.equal((await f.row(f.input.executionId)).dispatch_process_id, null)
  await assert.rejects(f.devices.claim(f.d.token, f.d.instanceId, f.input.executionId, f.input.processId), { code: 'device_claim_closed' })
})

test('only the exact Device, enrollment, original process and frozen request may close; legacy remains blocked', { timeout: 60000 }, async t => {
  const f = await claiming(t), foreign = await f.enroll(f.bob), sibling = await f.enroll(f.alice)
  for (const token of [foreign.token, sibling.token]) await assert.rejects(f.devices.closeUnstartedClaim(token, f.input), { code: 'execution_not_found' })
  for (const audience of ['agent', 'approval']) await assert.rejects(f.devices.closeUnstartedClaim(await taskCredential(f.pool, f.alice, audience), f.input), { code: 'device_unauthorized' })
  for (const changed of [{ ...f.input, instanceId: randomUUID() }, { ...f.input, processId: randomUUID() },
    { ...f.input, directoryId: randomUUID() }, { ...f.input, digest: 'f'.repeat(64) }]) {
    await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, changed), { code: 'device_claim_identity_changed' })
  }
  const row = await f.row(f.input.executionId)
  await f.pool.query('UPDATE pe_desktop_executions SET dispatch_request=NULL WHERE id=$1', [f.input.executionId])
  await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), { code: 'device_dispatch_unavailable' })
  await f.pool.query('UPDATE pe_desktop_executions SET dispatch_request=$2,device_instance_id=NULL WHERE id=$1', [f.input.executionId, JSON.stringify(row.dispatch_request)])
  await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), { code: 'device_dispatch_unavailable' })
  assert.equal(await count(f), 0); assert.equal(await f.continuations(f.input.executionId), 0)
})

test('revocation and account disablement allow only original no-start cleanup without reopening authority', { timeout: 60000 }, async t => {
  for (const mode of ['device', 'directory', 'account']) await t.test(mode, async sub => {
    const f = await claiming(sub)
    if (mode === 'device') await f.devices.revoke(f.alice, f.d.deviceId)
    if (mode === 'directory') await f.devices.revokeDirectory(f.alice, f.d.directoryId)
    if (mode === 'account') await disableFixtureAccount(f.pool, f.alice)
    const closed = await f.devices.closeUnstartedClaim(f.d.token, f.input)
    assert.equal(closed.continuationQueued, mode !== 'account')
    assert.equal(await f.continuations(f.input.executionId), mode === 'account' ? 0 : 1)
    await assert.rejects(f.devices.register(f.d.token, registrationFor(f.d, f.claim)), { code: 'device_claim_closed' })
    await assert.rejects(f.devices.finish(f.d.token, finishFor(f.d, f.claim)), { code: 'device_claim_closed' })
    assert.deepEqual(await f.devices.closeUnstartedClaim(f.d.token, f.input), closed)
    if (mode === 'device') await assert.rejects(f.devices.jobs(f.d.token, f.d.instanceId), { code: 'device_unauthorized' })
    if (mode === 'account') {
      assert.equal((await f.row(f.input.executionId)).error_code, 'account_disabled')
      await enableFixtureAccount(f.pool, f.alice)
      assert.deepEqual(await f.devices.closeUnstartedClaim(f.d.token, f.input), closed)
      assert.equal(await f.continuations(f.input.executionId), 0)
    }
  })
})

test('two replicas and lost closure responses return one immutable receipt and reject changed requests or stored bytes', { timeout: 60000 }, async t => {
  const f = await claiming(t), replica = new DeviceService(f.tasks, 9876, {})
  const outcomes = await concurrentAfterAccountLock(f, [() => f.devices.closeUnstartedClaim(f.d.token, f.input),
    () => replica.closeUnstartedClaim(f.d.token, f.input)])
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'))
  const results = outcomes.map(outcome => outcome.value)
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(await replica.closeUnstartedClaim(f.d.token, f.input), results[0])
  for (const changed of [{ ...f.input, executionId: randomUUID() }, { ...f.input, processId: randomUUID() }, { ...f.input, digest: '0'.repeat(64) }]) {
    await assert.rejects(replica.closeUnstartedClaim(f.d.token, changed), { code: 'request_id_conflict' })
  }
  await assert.rejects(replica.closeUnstartedClaim(f.d.token, { ...f.input, requestId: randomUUID() }), { code: 'device_claim_closure_exists' })
  assert.equal(await count(f), 1); assert.equal(await f.continuations(f.input.executionId), 1)
  const record = (await f.pool.query('SELECT * FROM pe_device_claim_closures')).rows[0]
  for (const [field, value] of [['request', { ...record.request, directoryId: randomUUID() }],
    ['receipt', { ...record.receipt, startNeverAuthorized: false }], ['receipt', { ...record.receipt, dispatchId: randomUUID() }]]) {
    await f.pool.query(`UPDATE pe_device_claim_closures SET ${field}=$1`, [JSON.stringify(value)])
    await assert.rejects(replica.closeUnstartedClaim(f.d.token, f.input), { code: 'device_claim_closure_unavailable' })
    await f.pool.query(`UPDATE pe_device_claim_closures SET ${field}=$1`, [JSON.stringify(record[field])])
  }
  assert.deepEqual(await replica.closeUnstartedClaim(f.d.token, f.input), results[0])
})

test('closure racing a queued claim never leaves a restartable execution or a replacement process', { timeout: 60000 }, async t => {
  const f = await claiming(t, false)
  const [closure, claim] = await concurrentAfterAccountLock(f, [() => f.devices.closeUnstartedClaim(f.d.token, f.input),
    () => f.devices.claim(f.d.token, f.d.instanceId, f.input.executionId, f.input.processId)])
  assert.equal(closure.status, 'fulfilled')
  if (claim.status === 'fulfilled') assert.equal(claim.value.processId, f.input.processId)
  else assert.equal(claim.reason.code, 'device_claim_closed')
  assert.equal((await f.row(f.input.executionId)).state, 'cancelled')
  await assert.rejects(f.devices.claim(f.d.token, f.d.instanceId, f.input.executionId, randomUUID()), { code: 'device_claim_closed' })
  assert.equal(await count(f), 1); assert.equal(await f.continuations(f.input.executionId), 1)
})

test('a prior capture or start permit blocks closure, and concurrent registration can never win with closure', { timeout: 60000 }, async t => {
  await t.test('capture without start', async sub => {
    const f = await claiming(sub)
    await f.devices.revoke(f.alice, f.d.deviceId)
    assert.equal((await f.devices.register(f.d.token, registrationFor(f.d, f.claim))).canStart, false)
    await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), { code: 'device_claim_start_unconfirmed' })
    assert.equal(await count(f), 0)
  })
  await t.test('start permission and result', async sub => {
    const f = await claiming(sub)
    assert.equal((await f.devices.register(f.d.token, registrationFor(f.d, f.claim))).canStart, true)
    await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), { code: 'device_claim_start_unconfirmed' })
    await f.devices.finish(f.d.token, finishFor(f.d, f.claim))
    await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), { code: 'device_claim_start_unconfirmed' })
    assert.equal(await count(f), 0)
  })
  await t.test('concurrent register', async sub => {
    const f = await claiming(sub)
    const [closure, registration] = await concurrentAfterAccountLock(f, [() => f.devices.closeUnstartedClaim(f.d.token, f.input),
      () => f.devices.register(f.d.token, registrationFor(f.d, f.claim))])
    assert.notEqual(closure.status, registration.status)
    if (closure.status === 'fulfilled') {
      assert.equal(registration.reason.code, 'device_claim_closed')
      assert.equal((await f.row(f.input.executionId)).container_receipt, null)
    } else {
      assert.equal(closure.reason.code, 'device_claim_start_unconfirmed')
      assert.equal(registration.value.canStart, true)
    }
  })
})

test('receipt insertion failure rolls back the permanent fence, execution state and continuation together', { timeout: 60000 }, async t => {
  const f = await claiming(t), before = await f.row(f.input.executionId)
  await f.pool.query(`CREATE FUNCTION reject_claim_closure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic claim closure rollback'; END $$;
    CREATE TRIGGER reject_claim_closure BEFORE INSERT ON pe_device_claim_closures
    FOR EACH ROW EXECUTE FUNCTION reject_claim_closure();`)
  await assert.rejects(f.devices.closeUnstartedClaim(f.d.token, f.input), /synthetic claim closure rollback/u)
  const after = await f.row(f.input.executionId)
  assert.deepEqual(facts(after), facts(before)); assert.equal(after.state, before.state)
  assert.equal(after.cancel_requested, false); assert.equal(after.continuation_queued, false)
  assert.equal(await count(f), 0); assert.equal(await f.continuations(f.input.executionId), 0)
  await f.pool.query('DROP TRIGGER reject_claim_closure ON pe_device_claim_closures')
  assert.equal((await f.devices.closeUnstartedClaim(f.d.token, f.input)).state, 'cancelled')
})
