/** Real PG dispatch, approval, result and writer fences; synthetic private observations grant no physical execution evidence. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { stdioCloudStopEvidenceV2, stdioRuntimeViewV2, stdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCheckRequestV2, stdioExecutorOwnerV2 } from '@power-evolve/contracts/stdio-mcp'
import { requestId } from '../src/contracts.ts'
import { StdioActionLeaseServiceV2 } from '../src/platform/stdio-v2-leases.ts'
import { registerNativeToolNames } from '../src/platform/native-tool-catalog.ts'
import { PRODUCT_MODEL_TOOL_NAMES } from '../src/mcp-model-tools.ts'
import { mcpOperationTool } from '../src/mcp-operation-contracts.ts'
import { stdioWorkflow, workflowCatalog, workflowLimits, workflowRequest } from './employee1-stdio-workflow-fixture.ts'

const nativeNames = ['job_output', 'job_list', 'job_kill', 'skill', 'web_search', 'web_fetch', 'todo_write',
  'send_message', 'interrupt_agent', 'list_agents', 'get_goal', 'create_goal', 'update_goal', 'ask_user_question',
  'exit_plan_mode', 'subagent_fork', 'read', 'write', 'edit', 'present', 'glob', 'grep', 'bash', 'workflow', 'read_image',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update', 'subagent', 'skill_resource',
  'trial_notes_list', 'trial_notes_append', 'office']
type Workflow = Parameters<Parameters<typeof stdioWorkflow>[0]>[0]
async function rememberNativeTools(f: Workflow): Promise<void> {
  await f.tasks.accept(f.owner.user, f.session.sessionId, requestId.parse(randomUUID()), 'Register original native tools', f.owner.token)
  const grant = await f.tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned registration operation missing')
  await registerNativeToolNames(f.tasks, grant.token, { names: nativeNames })
  await f.tasks.finish(grant.token, 'completed', null)
}

test('six overlapping native reservations admit an ordinary prompt with no STDIO selection', () => stdioWorkflow(async (f) => {
  expect(nativeNames.filter(name => PRODUCT_MODEL_TOOL_NAMES.includes(name))).toHaveLength(6)
  await rememberNativeTools(f)
  const nonce = requestId.parse(randomUUID())
  const accepted = z.object({ accepted: z.literal(true), operationId: z.uuid(), state: z.literal('queued') }).parse(
    await f.tasks.accept(f.owner.user, f.session.sessionId, nonce, 'Next native prompt', f.owner.token))
  expect(accepted.state).toBe('queued')
  expect((await f.pool.query('SELECT state,stdio_v2_selection FROM pe_operations WHERE session_id=$1 AND request_id=$2',
    [f.session.sessionId, nonce])).rows).toEqual([{ state: 'queued', stdio_v2_selection: [] }])
  const grant = await f.tasks.claim(randomUUID())
  expect(grant?.operationId).toBe(accepted.operationId)
  expect(grant?.stdioV2Connections).toEqual([])
  expect(() => f.selection.restore([], ['skill', 'skill']))
    .toThrow(expect.objectContaining({ status: 409, code: 'stdio_v2_tool_name_conflict' }))
}))

test('native reservation overlap preserves STDIO acceptance and calls while independent tool collisions still refuse', () => stdioWorkflow(async (f) => {
  await rememberNativeTools(f)
  const { grant, input, call } = await f.startCall()
  expect(call.state).toBe('queued')
  expect(grant.stdioV2Connections).toHaveLength(1)
  const before = (await f.pool.query('SELECT count(*)::integer AS count FROM pe_stdio_v2_actions')).rows
  for (const names of [['skill'], ['web_fetch'], ['owned_remote', 'owned_remote'], [input.toolName]]) {
    const remote = names.map(name => mcpOperationTool.parse({ formatVersion: 1, connectionId: randomUUID(),
      connectionRevision: 1, configurationRevision: 1, credentialRevision: null, catalogId: randomUUID(),
      toolId: randomUUID(), descriptorDigest: 'a'.repeat(64), raw: { name: 'owned_remote', inputSchema: { type: 'object' } },
      model: { name, description: 'Owned collision fixture', parameters: { type: 'object' } }, modelDigest: 'b'.repeat(64) }))
    await f.pool.query('UPDATE pe_operations SET remote_mcp_selection=$2 WHERE id=$1', [grant.operationId, JSON.stringify(remote)])
    await expect(f.calls.propose(grant.token, { ...input, callKey: 'collision' }))
      .rejects.toMatchObject({ status: 409, code: 'stdio_v2_tool_name_conflict' })
    expect((await f.pool.query('SELECT count(*)::integer AS count FROM pe_stdio_v2_actions')).rows).toEqual(before)
  }
}))

test('STDIO independent approval commits one first reply and never replays start authority', () => stdioWorkflow(async (f) => {
  const lease = await f.claim(), prepared = await f.prepare(lease)
  expect(await f.authorization.prepareLeased(lease)).toEqual(prepared)
  await expect(f.authorization.inspect(f.owner.token, lease.actionId)).rejects.toMatchObject({ status: 401 })
  await expect(f.authorization.inspect(f.foreign.token, lease.actionId)).rejects.toMatchObject({ status: 401 })
  const inspected = await f.authorization.inspect(f.approval.token, lease.actionId)
  expect(inspected).toMatchObject({ state: 'pending', approvalEpoch: 1, expired: false, decision: null,
    task: { invocation: f.configuration.invocation } })
  expect(inspected).not.toHaveProperty('capture')
  const input = { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' as const }
  await expect(f.authorization.decide(f.owner.token, input)).rejects.toMatchObject({ status: 401 })
  const decided = await f.authorization.decide(f.approval.token, input)
  expect(await f.authorization.decide(f.approval.token, input)).toEqual(decided)
  await expect(f.authorization.decide(f.approval.token, { ...input, decision: 'reject' })).rejects.toMatchObject({ code: 'stdio_v2_decision_conflict' })
  const grants = await Promise.all(Array.from({ length: 4 }, () => f.dispatch(lease)))
  expect(grants.filter(grant => grant.grantOnce)).toHaveLength(1)
  for (const grant of grants) expect(grant.permit).toEqual(grants[0]!.permit)
  expect(await f.dispatch(lease)).toMatchObject({ grantOnce: false, permit: grants[0]!.permit })
  await expect(f.authorization.authorizeLeased(lease, workflowRequest(), stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: randomUUID() })))
    .rejects.toMatchObject({ code: 'stdio_v2_executor_owner_changed' })
  for (const table of ['pe_stdio_v2_preparations', 'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches']) {
    expect((await f.pool.query<{ readonly n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(1)
  }
}))

test('STDIO final discovery needs full original UID quiet proof and mints one immutable usable catalog', () => stdioWorkflow(async (f) => {
  const lease = await f.claim()
  await f.approve(lease); await f.dispatch(lease)
  expect(await f.results.record(lease, await f.observe(lease, 'running', false))).toMatchObject({ state: 'running', finalized: false, catalogId: null })
  const completed = await f.observe(lease, 'completed', false)
  expect(await f.results.record(lease, completed)).toMatchObject({ state: 'stopping', finalized: false, catalogId: null })
  expect((await f.pool.query('SELECT state,pod_uid,runner_instance_id FROM pe_cloud_executions WHERE id=$1', [f.discovery.executionRef.executionId])).rows[0])
    .toMatchObject({ state: 'cancelling', pod_uid: f.writer().podUid, runner_instance_id: f.writer().runnerInstanceId })
  await expect(f.admission.check(f.owner.token, stdioCheckRequestV2.parse({ requestId: workflowRequest(),
    connectionId: f.connection.connectionId,
    expectedRevision: 1, sessionId: f.session.sessionId, target: { kind: 'cloud' } }))).rejects.toMatchObject({ code: 'execution_busy' })
  const final = await f.observe(lease, 'completed', true)
  if (!final.stopEvidence) throw new Error('Expected fixture quiet proof')
  await expect(f.results.record(lease, { ...final,
    stopEvidence: stdioCloudStopEvidenceV2.parse({ ...final.stopEvidence, podUid: final.view.instanceId }) }))
    .rejects.toMatchObject({ code: 'stdio_v2_stop_evidence_changed' })
  const receipt = await f.results.record(lease, final)
  expect(receipt).toMatchObject({ state: 'succeeded', finalized: true })
  expect(receipt.catalogId).not.toBeNull()
  expect(await f.results.record(lease, { ...final,
    stopEvidence: { ...final.stopEvidence, observedAt: new Date().toISOString() } })).toEqual(receipt)
  expect((await f.pool.query<{ readonly raw_catalog: unknown }>('SELECT raw_catalog FROM pe_stdio_v2_catalogs WHERE id=$1', [receipt.catalogId])).rows[0]!.raw_catalog).toEqual(workflowCatalog)
  const toggled = await f.connections.toggle(f.owner.token, { requestId: workflowRequest(), connectionId: f.connection.connectionId,
    expectedRevision: 1, enabled: true })
  expect(toggled).toMatchObject({ revision: 1, enabled: true })
  const updated = await f.connections.update(f.owner.token, { requestId: workflowRequest(), connectionId: f.connection.connectionId,
    expectedRevision: 1, configuration: { ...f.configuration, name: 'Revision 2' } })
  expect(updated).toMatchObject({ revision: 2, enabled: false })
  expect((await f.pool.query<{ readonly current_catalog_id: string | null }>('SELECT current_catalog_id FROM pe_stdio_v2_connections WHERE id=$1', [f.connection.connectionId])).rows[0]!.current_catalog_id).toBeNull()
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(1)
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_catalogs')).rows[0]!.n).toBe(1)
}))

test('STDIO generic call retains original raw JSON and queues one fenced native continuation', () => stdioWorkflow(async (f) => {
  const { grant, input, call } = await f.startCall()
  expect(await f.calls.propose(grant.token, input)).toEqual(call)
  await expect(f.calls.propose(grant.token, { ...input, arguments: { message: 'changed' } })).rejects.toMatchObject({ code: 'stdio_v2_request_conflict' })
  await f.tasks.finish(grant.token, 'completed', null)
  const lease = await f.claim()
  expect(lease.actionId).toBe(call.actionId)
  await f.approve(lease); await f.dispatch(lease)
  const observation = await f.observe(lease, 'completed', true)
  const receipt = await f.results.record(lease, observation)
  expect(receipt).toMatchObject({ state: 'succeeded', finalized: true, catalogId: null })
  expect(await f.results.record(lease, observation)).toEqual(receipt)
  const queued = (await f.pool.query<{ readonly stdio_v2_selection: unknown; readonly input: string }>('SELECT * FROM pe_operations WHERE source_stdio_v2_action_id=$1', [call.actionId])).rows
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ source: 'stdio_v2_result', mcp_root_operation_id: grant.operationId, source_stdio_v2_phase: 'call', state: 'queued' })
  expect(queued[0]!.stdio_v2_selection).toEqual(grant.stdioV2Connections)
  expect(queued[0]!.input).toContain('full\\u0000😀')
  expect((await f.pool.query<{ readonly calls: number }>('SELECT calls FROM pe_mcp_action_chains WHERE root_operation_id=$1', [grant.operationId])).rows[0]!.calls).toBe(1)
  expect((await f.pool.query<{ readonly continuation_queued: boolean }>('SELECT continuation_queued FROM pe_stdio_v2_actions WHERE id=$1', [call.actionId])).rows[0]!.continuation_queued).toBe(true)
}))

test('STDIO cancellation after start retains the original writer and never grants a replacement start', () => stdioWorkflow(async (f) => {
  const lease = await f.claim()
  await f.approve(lease); const first = await f.dispatch(lease)
  const writer = f.writer()
  await f.actions.cancel(f.owner.token, { actionId: lease.actionId })
  const snapshot = await f.store.snapshot(lease)
  expect(snapshot).toMatchObject({ cancelRequested: true,
    writer: { name: writer.name, podUid: writer.podUid, runnerInstanceId: writer.runnerInstanceId } })
  expect(await f.dispatch(lease)).toEqual({ grantOnce: false, permit: first.permit })
  await expect(f.store.capture(lease, 'dispatch', async () => writer)).rejects.toMatchObject({ code: 'stdio_v2_action_not_startable' })
  await expect(f.store.capture(lease, 'observe', async () => ({ ...writer, podUid: randomUUID() }))).rejects.toMatchObject({ code: 'stdio_v2_writer_changed' })
  expect(await f.store.capture(lease, 'observe', async () => writer)).toEqual(writer)
  expect(await f.results.record(lease, await f.observe(lease, 'cancelled', false))).toMatchObject({ state: 'stopping', finalized: false })
  expect(await f.results.record(lease, await f.observe(lease, 'cancelled', true))).toMatchObject({ state: 'cancelled', finalized: true, catalogId: null })
  expect((await f.pool.query('SELECT state,pod_uid,runner_instance_id FROM pe_mount_slots WHERE user_id=$1', [f.owner.user.userId])).rows[0])
    .toEqual({ state: 'ready', pod_uid: writer.podUid, runner_instance_id: writer.runnerInstanceId })
}))

test('STDIO revoked approval credentials cannot decide after account lock waiting', () => stdioWorkflow(async (f) => {
  const lease = await f.claim(), prepared = await f.prepare(lease), blocker = await f.pool.connect()
  let decision: Promise<unknown> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.owner.user.userId])
    decision = f.authorization.decide(f.approval.token, { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
    const outcome = decision.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
    await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting).toBe(true)
    await blocker.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.owner.user.userId])
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ status: 401 })
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_decisions')).rows[0]!.n).toBe(0)
    expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_stdio_v2_actions WHERE id=$1', [lease.actionId])).rows[0]!.state).toBe('pending')
  } finally {
    try { await blocker.query('ROLLBACK') } finally { blocker.release() }
    await decision?.catch(() => undefined)
  }
}))

test('STDIO takeover rejects stale leases and preserves original committed permit identities', () => stdioWorkflow(async (f) => {
  const lease = await f.claim()
  await f.approve(lease); const first = await f.dispatch(lease), before = await f.store.snapshot(lease)
  await f.pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [lease.actionId])
  await f.pool.query("UPDATE pe_cloud_executions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE stdio_action_id=$1", [lease.actionId])
  const recovered = await f.store.claimNext(stdioWorkerIdV2.parse(randomUUID()))
  if (!recovered) throw new Error('Original expired work must be reclaimable')
  expect(recovered).toMatchObject({ actionId: lease.actionId, leaseEpoch: lease.leaseEpoch + 1 })
  const observation = await f.observe(recovered, 'running', false)
  const outcomes = await Promise.all([f.store.renew(lease), f.store.release(lease), f.results.record(lease, observation)]
    .map(work => work.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))))
  for (const outcome of outcomes) expect(outcome.error).toMatchObject({ code: 'stdio_v2_lease_lost' })
  expect((await f.store.snapshot(recovered)).dispatch).toEqual(before.dispatch)
  expect(await f.dispatch(recovered)).toEqual({ grantOnce: false, permit: first.permit })
}))

test('STDIO expired preparation cannot renew its first approval epoch or mint a start permit', () => stdioWorkflow(async (f) => {
  const lease = await f.claim(), prepared = await f.prepare(lease)
  await expect.poll(async () => (await f.pool.query<{ readonly expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM pe_stdio_v2_preparations WHERE action_id=$1', [lease.actionId])).rows[0]!.expired).toBe(true)
  expect(await f.authorization.prepareLeased(lease)).toEqual(prepared)
  expect(await f.authorization.inspect(f.approval.token, lease.actionId)).toMatchObject({ expired: true, approvalEpoch: 1 })
  await expect(f.authorization.decide(f.approval.token, { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' }))
    .rejects.toMatchObject({ code: 'stdio_v2_approval_expired_or_closed' })
  await expect(f.dispatch(lease)).rejects.toMatchObject({ code: 'stdio_v2_not_approved_or_expired' })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits')).rows[0]!.n).toBe(0)
}, 200))

test('STDIO rejected approval closes no-start while retaining the exact ready writer', () => stdioWorkflow(async (f) => {
  const lease = await f.claim(), prepared = await f.prepare(lease), writer = f.writer()
  const rejected = await f.authorization.decide(f.approval.token, { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'reject' })
  expect(rejected).toMatchObject({ state: 'rejected', decision: 'reject' })
  await expect(f.dispatch(lease)).rejects.toMatchObject({ code: 'stdio_v2_action_not_startable' })
  const closed = await f.store.closeUnstarted(lease)
  expect(closed).toMatchObject({ kind: 'unstarted_closed', startNeverAuthorized: true,
    resource: { kind: 'ready_retained', name: writer.name, podUid: writer.podUid, runnerInstanceId: writer.runnerInstanceId } })
  expect(await f.store.closeUnstarted(lease)).toEqual(closed)
  expect(await f.store.readNoStart(lease.actionId)).toEqual(closed)
  expect((await f.pool.query('SELECT state,pod_uid,runner_instance_id FROM pe_mount_slots WHERE user_id=$1', [f.owner.user.userId])).rows[0])
    .toEqual({ state: 'ready', pod_uid: writer.podUid, runner_instance_id: writer.runnerInstanceId })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(0)
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits')).rows[0]!.n).toBe(0)
}))

test.each(['actionId', 'instanceId', 'taskDigest', 'dispatchDigest'] as const)(
  'STDIO running observation refuses a changed %s without recording it', field => stdioWorkflow(async (f) => {
    const lease = await f.claim()
    await f.approve(lease); await f.dispatch(lease)
    const observation = await f.observe(lease, 'running', false)
    const view = stdioRuntimeViewV2(workflowLimits, 131_072).parse({ ...observation.view,
      [field]: field.endsWith('Digest') ? 'f'.repeat(64) : randomUUID() })
    await expect(f.results.record(lease, { view, stopEvidence: null })).rejects.toMatchObject({ code: 'stdio_v2_observation_changed' })
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_observations')).rows[0]!.n).toBe(0)
    expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_stdio_v2_actions WHERE id=$1', [lease.actionId])).rows[0]!.state).toBe('dispatch-intent')
  }))

test.each(['podUid', 'runnerInstanceId', 'mountGeneration', 'fullScopeDigest'] as const)(
  'STDIO terminal proof refuses a changed %s while retaining the writer', field => stdioWorkflow(async (f) => {
    const lease = await f.claim()
    await f.approve(lease); await f.dispatch(lease)
    const observation = await f.observe(lease, 'completed', true)
    const stopEvidence = stdioCloudStopEvidenceV2.parse({ ...observation.stopEvidence,
      [field]: field === 'mountGeneration' ? '2' : field === 'fullScopeDigest' ? 'e'.repeat(64) : randomUUID() })
    await expect(f.results.record(lease, { ...observation, stopEvidence })).rejects.toMatchObject({ code: 'stdio_v2_stop_evidence_changed' })
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(0)
    expect((await f.pool.query('SELECT state,pod_uid FROM pe_cloud_executions WHERE id=$1', [f.discovery.executionRef.executionId])).rows[0])
      .toMatchObject({ state: 'starting', pod_uid: f.writer().podUid })
  }))

test.each(['account-disabled', 'connection-deleted', 'configuration-updated'] as const)(
  'STDIO discovery result after %s retires execution without publishing fresh catalog authority', revoke => stdioWorkflow(async (f) => {
    const lease = await f.claim()
    await f.approve(lease); await f.dispatch(lease)
    const observation = await f.observe(lease, 'completed', true)
    if (revoke === 'account-disabled') await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.owner.user.userId])
    else if (revoke === 'connection-deleted') await f.connections.remove(f.owner.token, { requestId: workflowRequest(), connectionId: f.connection.connectionId, expectedRevision: 1 })
    else await f.connections.update(f.owner.token, { requestId: workflowRequest(), connectionId: f.connection.connectionId,
      expectedRevision: 1, configuration: { ...f.configuration, name: 'Revoked revision' } })
    expect(await f.results.record(lease, observation)).toMatchObject({ state: 'succeeded', finalized: true, catalogId: null })
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_catalogs')).rows[0]!.n).toBe(0)
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(1)
    expect((await f.pool.query('SELECT pod_uid,runner_instance_id FROM pe_cloud_executions WHERE id=$1', [f.discovery.executionRef.executionId])).rows[0])
      .toMatchObject({ pod_uid: f.writer().podUid, runner_instance_id: f.writer().runnerInstanceId })
  }))

test.each(['renew', 'alternate-renew', 'authorize', 'result'] as const)(
  'STDIO %s refuses a lease that expires while waiting on its account lock', phase => stdioWorkflow(async (f) => {
    const lease = await f.claim()
    const prepared = await f.approve(lease)
    if (phase === 'result') await f.dispatch(lease)
    const observation = phase === 'result' ? await f.observe(lease, 'completed', true) : null
    const blocker = await f.pool.connect()
    let mutation: Promise<unknown> | undefined
    try {
      await f.pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [lease.actionId])
      await f.pool.query('UPDATE pe_cloud_executions SET lease_until=(SELECT lease_until FROM pe_stdio_v2_actions WHERE id=$1) WHERE stdio_action_id=$1', [lease.actionId])
      await blocker.query('BEGIN')
      const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.owner.user.userId])
      mutation = phase === 'renew' ? f.store.renew(lease) : phase === 'alternate-renew' ? new StdioActionLeaseServiceV2(f.pool, { leaseMs: 60_000 }).renew(lease) : phase === 'authorize'
        ? f.authorization.authorizeLeased(lease, workflowRequest(), stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: prepared.prepared.capture.runnerInstanceId }))
        : observation ? f.results.record(lease, observation) : Promise.reject(new Error('Observation missing'))
      const outcome = mutation.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
      await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting).toBe(true)
      await expect.poll(async () => (await f.pool.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_stdio_v2_actions WHERE id=$1', [lease.actionId])).rows[0]!.expired).toBe(true)
      await blocker.query('COMMIT')
      expect((await outcome).error).toMatchObject({ code: 'stdio_v2_lease_lost' })
      expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(0)
      expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits')).rows[0]!.n).toBe(phase === 'result' ? 1 : 0)
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await mutation?.catch(() => undefined)
    }
  }))

test('STDIO original root cancellation suppresses automatic call continuation without discarding its result', () => stdioWorkflow(async (f) => {
  const { grant, call } = await f.startCall()
  await f.tasks.finish(grant.token, 'completed', null)
  const lease = await f.claim()
  await f.approve(lease); await f.dispatch(lease)
  const observation = await f.observe(lease, 'cancelled', true)
  await f.tasks.cancel(f.owner.user, f.session.sessionId, f.owner.token)
  expect((await f.store.snapshot(lease)).cancelRequested).toBe(true)
  expect(await f.results.record(lease, observation)).toMatchObject({ state: 'cancelled', finalized: true })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_stdio_v2_action_id=$1', [call.actionId])).rows[0]!.n).toBe(0)
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results WHERE action_id=$1', [call.actionId])).rows[0]!.n).toBe(1)
  expect((await f.pool.query<{ readonly stopped: boolean }>('SELECT mcp_chain_cancelled_at IS NOT NULL AS stopped FROM pe_operations WHERE id=$1', [grant.operationId])).rows[0]!.stopped).toBe(true)
}))

test('STDIO action lease service preserves live epochs, mirrors expiry and fences takeover and terminal work', () => stdioWorkflow(async (f) => {
  const service = new StdioActionLeaseServiceV2(f.pool, { leaseMs: 60_000 }), firstOwner = stdioWorkerIdV2.parse(randomUUID())
  const lease = await service.claim(f.discovery.actionId, firstOwner)
  if (!lease) throw new Error('Original discovery lease must be claimable')
  expect(await service.claim(lease.actionId, firstOwner)).toEqual(lease)
  const other = stdioWorkerIdV2.parse(randomUUID())
  expect(await service.claim(lease.actionId, other)).toBeNull()
  expect(await service.renew(lease)).toEqual(lease)
  expect((await f.pool.query<{ readonly mirrored: boolean }>(`SELECT a.lease_until=e.lease_until AND a.lease_owner=e.lease_owner AS mirrored
    FROM pe_stdio_v2_actions a JOIN pe_cloud_executions e ON e.id=a.execution_id WHERE a.id=$1`, [lease.actionId])).rows[0]!.mirrored).toBe(true)
  await f.pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [lease.actionId])
  await f.pool.query('UPDATE pe_cloud_executions SET lease_until=(SELECT lease_until FROM pe_stdio_v2_actions WHERE id=$1) WHERE stdio_action_id=$1', [lease.actionId])
  const recovered = await service.claim(lease.actionId, other)
  if (!recovered) throw new Error('Expired original must be reclaimed')
  expect(recovered).toMatchObject({ leaseEpoch: lease.leaseEpoch + 1, workerId: other })
  await expect(service.renew(lease)).rejects.toMatchObject({ code: 'stdio_v2_lease_lost' })
  await f.actions.cancel(f.owner.token, { actionId: lease.actionId })
  await f.store.closeUnstarted(recovered)
  expect(await service.claim(lease.actionId, other)).toBeNull()
  await expect(service.renew(recovered)).rejects.toMatchObject({ code: 'stdio_v2_lease_lost' })
}))

test('STDIO management and action pages retain distinct owner cursors and reject foreign sessions', () => stdioWorkflow(async (f) => {
  const created = [f.connection]
  for (let index = 0; index < 3; index++) created.push(await f.connections.create(f.owner.token,
    { requestId: workflowRequest(), configuration: { ...f.configuration, name: `Page ${index}` } }))
  await expect(f.connections.create(f.owner.token, { requestId: workflowRequest(), configuration: { ...f.configuration, name: 'Over capacity' } }))
    .rejects.toMatchObject({ code: 'stdio_v2_connection_limit' })
  const first = await f.connections.list(f.owner.token, {})
  expect(first.items).toHaveLength(2)
  if (!first.next) throw new Error('Two more owned connections must remain')
  const second = await f.connections.list(f.owner.token, { after: first.next })
  expect(second.items).toHaveLength(2)
  expect(second.next).toBeNull()
  expect([...first.items, ...second.items].map(item => item.connectionId)).toEqual(created.map(item => item.connectionId).sort())
  const session = await f.tasks.create(f.owner.user, requestId.parse(randomUUID()), f.owner.token)
  await f.admission.check(f.owner.token, stdioCheckRequestV2.parse({ requestId: workflowRequest(), connectionId: created[1]!.connectionId,
    expectedRevision: 1, sessionId: session.sessionId, target: { kind: 'cloud' } }))
  const page = await f.actions.list(f.owner.token, { offset: 0, limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.nextOffset).toBe(1)
  expect((await f.actions.list(f.owner.token, { offset: 1, limit: 1 })).nextOffset).toBeNull()
  expect((await f.actions.approvalList(f.approval.token, { offset: 0, limit: 2 })).items).toHaveLength(2)
  await expect(f.actions.approvalList(f.owner.token, { offset: 0, limit: 2 })).rejects.toMatchObject({ status: 401 })
  expect(await f.actions.list(f.foreign.token, { offset: 0, limit: 2 })).toEqual({ items: [], nextOffset: null })
  await expect(f.actions.list(f.foreign.token, { offset: 0, limit: 1, sessionId: f.session.sessionId }))
    .rejects.toMatchObject({ status: 404 })
  expect((await f.actions.list(f.owner.token, { offset: 0, limit: 2, sessionId: f.session.sessionId })).items).toHaveLength(1)
}))

test('STDIO persisted result retries reject changed raw JSON and public detail retains the complete first outcome', () => stdioWorkflow(async (f) => {
  const lease = await f.claim()
  await f.approve(lease); await f.dispatch(lease)
  const first = await f.observe(lease, 'completed', true)
  await f.results.record(lease, first)
  const detail = await f.actions.detail(f.owner.token, { actionId: lease.actionId })
  expect(detail).toMatchObject({ state: 'succeeded', executionState: 'succeeded', outcome: first.view.outcome })
  const changed = stdioRuntimeViewV2(workflowLimits, 131_072).parse({ ...first.view,
    outcome: { ...first.view.outcome, initializeResult: { protocolVersion: 'changed' } } })
  await expect(f.results.record(lease, { ...first, view: changed })).rejects.toMatchObject({ code: 'stdio_v2_result_conflict' })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_results')).rows[0]!.n).toBe(1)
  expect((await f.pool.query<{ readonly result: unknown }>('SELECT result FROM pe_stdio_v2_results WHERE action_id=$1', [lease.actionId])).rows[0]!.result).toEqual(first.view.outcome)
}))
