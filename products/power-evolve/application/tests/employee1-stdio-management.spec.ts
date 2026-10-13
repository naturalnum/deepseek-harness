/** Real PG management, discovery admission and unallocated cancellation; no Pod or Runner success is substituted. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { stdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCloudDeploymentV2, stdioReceiptRequestV2, stdioCheckRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { cloudFixture } from './cloud-fixture.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { StdioConnectionServiceV2 } from '../src/platform/stdio-v2-connections.ts'
import { StdioAdmissionServiceV2 } from '../src/platform/stdio-v2-admission.ts'
import { StdioActionServiceV2 } from '../src/platform/stdio-v2-actions.ts'
import { StdioCloudWorkerStoreV2 } from '../src/platform/stdio-v2-worker-store.ts'
import { requestId } from '../src/contracts.ts'

const limits = { runtimeMs: 10_000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 65_536, maxMessageBytes: 8192, maxProtocolBytes: 131_072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16_384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const management = { maxNameBytes: 80, pageItems: 2, maxConnections: 4 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const configuration = (name: string) => ({ name, invocation: { program: 'node', argv: ['', 'literal;$(not-a-shell)', '中文'], cwd: '.' } })
const newRequestId = () => stdioReceiptRequestV2.shape.requestId.parse(randomUUID())
const deployment = () => stdioCloudDeploymentV2.parse({ kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2,
  platform: { os: 'linux', architecture: 'arm64' }, imageReference: `fixture.invalid/runner@sha256:${'a'.repeat(64)}`,
  configImageId: `sha256:${'a'.repeat(64)}`, runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] })

test('STDIO management preserves literal arguments, exact retries and historical revisions under owner isolation', () => cloudFixture(async ({ pool, alice, bob }) => {
  const connections = new StdioConnectionServiceV2(pool, limits, management)
  const input = { requestId: newRequestId(), configuration: configuration('Literal process') }
  const created = await connections.create(alice.token, input)
  expect(await connections.create(alice.token, input)).toEqual(created)
  await expect(connections.create(alice.token, { ...input, configuration: configuration('Changed') })).rejects.toMatchObject({ code: 'stdio_v2_request_conflict' })
  expect((await connections.list(alice.token, {})).items[0]).toMatchObject({ enabled: false, revision: 1,
    configuration: input.configuration })
  expect(await connections.list(bob.token, {})).toEqual({ items: [], next: null })
  await expect(connections.update(bob.token, { requestId: newRequestId(), connectionId: created.connectionId,
    expectedRevision: 1, configuration: configuration('Foreign') })).rejects.toMatchObject({ status: 404 })
  await expect(connections.receipt(bob.token, { requestId: input.requestId })).rejects.toMatchObject({ status: 404 })
  await expect(connections.toggle(alice.token, { requestId: newRequestId(), connectionId: created.connectionId,
    expectedRevision: 1, enabled: true })).rejects.toMatchObject({ code: 'stdio_v2_catalog_required' })
  const update = { requestId: newRequestId(), connectionId: created.connectionId, expectedRevision: 1, configuration: configuration('New revision') }
  const updated = await connections.update(alice.token, update)
  expect(updated).toMatchObject({ revision: 2, enabled: false })
  expect(await connections.update(alice.token, update)).toEqual(updated)
  await expect(connections.update(alice.token, { ...update, requestId: newRequestId() })).rejects.toMatchObject({ code: 'stdio_v2_revision_conflict' })
  const remove = { requestId: newRequestId(), connectionId: created.connectionId, expectedRevision: 2 }
  const removed = await connections.remove(alice.token, remove)
  expect(await connections.remove(alice.token, remove)).toEqual(removed)
  expect(await connections.receipt(alice.token, { requestId: remove.requestId })).toEqual(removed)
  expect(await connections.list(alice.token, {})).toEqual({ items: [], next: null })
  expect((await pool.query('SELECT configuration FROM pe_stdio_v2_configurations WHERE connection_id=$1 ORDER BY revision', [created.connectionId])).rows)
    .toEqual([{ configuration: input.configuration }, { configuration: update.configuration }])
  expect((await pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_management_requests')).rows[0]!.n).toBe(3)
}))

test('STDIO discovery commits one original task and execution and cancellation retains them until a worker closes no-start', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const tasks = new TaskStore(pool, taskLimits), connections = new StdioConnectionServiceV2(pool, limits, management)
  const actions = new StdioActionServiceV2(pool, { limits, maxReplyBytes: 131_072, maxPageSize: management.pageItems })
  const admission = new StdioAdmissionServiceV2(pool, files, { limits, management,
    maxPendingPerUser: 4, deployments: { cloud: deployment() } })
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const connection = await connections.create(alice.token, { requestId: newRequestId(), configuration: configuration('Discovery') })
  const input = { requestId: newRequestId(), connectionId: connection.connectionId, expectedRevision: 1, sessionId: stdioCheckRequestV2.shape.sessionId.parse(session.sessionId), target: { kind: 'cloud' as const } }
  const receipt = await admission.check(alice.token, input)
  expect(await admission.check(alice.token, input)).toEqual(receipt)
  expect(await connections.receipt(alice.token, { requestId: input.requestId })).toEqual(receipt)
  await expect(admission.check(alice.token, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'stdio_v2_request_conflict' })
  await expect(actions.detail(bob.token, { actionId: receipt.actionId })).rejects.toMatchObject({ status: 404 })
  const detail = await actions.detail(alice.token, { actionId: receipt.actionId })
  expect(detail).toMatchObject({ state: 'queued', executionState: 'queued', outcome: null,
    task: { invocation: configuration('Discovery').invocation, origin: { kind: 'stdio_discovery', requestId: input.requestId } } })
  const cancel = await actions.cancel(alice.token, { actionId: receipt.actionId })
  expect(cancel).toMatchObject({ state: 'queued', executionState: 'queued', cancelRequested: true })
  expect(await actions.cancel(alice.token, { actionId: receipt.actionId })).toEqual(cancel)
  const store = new StdioCloudWorkerStoreV2(pool, { limits, leaseMs: 30_000, maxActive: 2, maxCandidates: 4 })
  const lease = await store.claimNext(stdioWorkerIdV2.parse(randomUUID()))
  expect(lease).not.toBeNull()
  const closed = await store.closeUnstarted(lease!)
  expect(closed).toMatchObject({ kind: 'unstarted_closed', phase: 'discover', startNeverAuthorized: true, resource: { kind: 'unallocated' } })
  expect(await store.closeUnstarted(lease!)).toEqual(closed)
  expect(await store.readNoStart(receipt.actionId)).toEqual(closed)
  expect(await actions.detail(alice.token, { actionId: receipt.actionId })).toMatchObject({ state: 'cancelled', executionState: 'cancelled',
    noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' } })
  for (const table of ['pe_stdio_v2_actions', 'pe_cloud_executions', 'pe_stdio_v2_no_start_closures']) {
    expect((await pool.query<{ readonly n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(1)
  }
  for (const table of ['pe_stdio_v2_start_permits', 'pe_stdio_v2_results', 'pe_sandbox_instances', 'pe_operations']) {
    expect((await pool.query<{ readonly n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(0)
  }
}))

test('STDIO discovery refuses foreign sessions, busy writers and unavailable deployments without inserting intents', () => cloudFixture(async ({ pool, files, alice, bob }) => {
  const tasks = new TaskStore(pool, taskLimits), connections = new StdioConnectionServiceV2(pool, limits, management)
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const connection = await connections.create(alice.token, { requestId: newRequestId(), configuration: configuration('Refusal') })
  const input = { requestId: newRequestId(), connectionId: connection.connectionId, expectedRevision: 1, sessionId: stdioCheckRequestV2.shape.sessionId.parse(session.sessionId), target: { kind: 'cloud' as const } }
  const unavailable = new StdioAdmissionServiceV2(pool, files, { limits, management, maxPendingPerUser: 1, deployments: { cloud: null } })
  await expect(unavailable.check(alice.token, input)).rejects.toMatchObject({ status: 503, code: 'stdio_v2_deployment_unavailable' })
  await expect(unavailable.check(bob.token, input)).rejects.toMatchObject({ status: 404 })
  expect((await pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_actions')).rows[0]!.n).toBe(0)
  const admission = new StdioAdmissionServiceV2(pool, files, { limits, management,
    maxPendingPerUser: 4, deployments: { cloud: deployment() } })
  await admission.check(alice.token, input)
  await expect(admission.check(alice.token, { ...input, requestId: newRequestId() })).rejects.toMatchObject({ code: 'execution_busy' })
  expect((await pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_cloud_executions')).rows[0]!.n).toBe(1)
}))

test('STDIO account-lock waits reject a newly revoked credential without committing a connection', () => cloudFixture(async ({ pool, alice }) => {
  const connections = new StdioConnectionServiceV2(pool, limits, management), blocker = await pool.connect()
  let mutation: Promise<unknown> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [alice.user.userId])
    mutation = connections.create(alice.token, { requestId: newRequestId(), configuration: configuration('Revoked') })
    const outcome = mutation.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
    await expect.poll(async () => (await pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
      .toBe(true)
    await blocker.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [alice.user.userId])
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ status: 401 })
    expect((await pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_connections')).rows[0]!.n).toBe(0)
    expect((await pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_stdio_v2_management_requests')).rows[0]!.n).toBe(0)
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await mutation?.catch(() => undefined)
  }
}))
