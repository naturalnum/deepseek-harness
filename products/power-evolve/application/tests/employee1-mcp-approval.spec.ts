/** Real PG approval mutations; seeded catalog descriptors do not establish remote discovery or execution acceptance. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { cloudFixture } from './cloud-fixture.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword, type IdentityService } from '../src/platform/identity.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { McpActionStore } from '../src/platform/mcp-actions.ts'
import { McpConnectionService } from '../src/platform/mcp-connections.ts'
import { routeMcpApproval } from '../src/platform/mcp-routes.ts'
import { transaction } from '../src/platform/database.ts'
import { mcpCatalogDigest, mcpCatalogTools } from '../src/platform/mcp-catalog.ts'
import { mcpConnectionValue } from '../src/mcp-management-rpc.ts'
import { mcpResourceId, mcpLeaseOwnerId } from '../src/mcp-contracts.ts'
import { requestId } from '../src/contracts.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'

const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1,
  remoteMcpAdmission: { maxTools: 8, maxSnapshotBytes: 131_072, maxToolBytes: 32_768, maxDescriptionBytes: 4096 } }
const actionLimits = { maxArgumentBytes: 8192, maxResultBytes: 32_768, maxCallsPerChain: 2,
  maxPendingPerUser: 8, chainLifetimeMs: 60_000, approvalLifetimeMs: 60_000, leaseMs: 10_000, listLimit: 50 }

type Login = Awaited<ReturnType<IdentityService['login']>>
async function approvalFixture(run: (fixture: {
  pool: Pool
  tasks: TaskStore
  grant: NonNullable<Awaited<ReturnType<TaskStore['claim']>>>
  store: McpActionStore
  owner: Login
  approval: string
  agent: string
  foreign: Login
  action: Awaited<ReturnType<McpActionStore['propose']>>
  logout: () => Promise<void>
}) => Promise<void>) {
  return cloudFixture(async ({ pool, identities, bob }) => {
    const password = randomUUID()
    await seedNewUser(pool, 'connector-owner', await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
    const owner = await identities.login('connector-owner', password)
    const approval = await identities.login('connector-owner', password, 'approval')
    const connectionId = mcpResourceId.parse(randomUUID()), catalogId = randomUUID()
    const descriptors = [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
    const catalog = mcpCatalogTools(connectionId, descriptors)
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
        VALUES($1,$2,'fixture-remote',1,1,true)`, [connectionId, owner.user.userId])
      await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,configuration)
        VALUES($1,$2,1,$3)`, [connectionId, owner.user.userId,
        { displayName: 'Fixture', serverUrl: 'https://example.invalid/mcp', enabled: true, authentication: 'none', headerNames: [] }])
      await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
        VALUES($1,$2,$3,1,$4,$5::json)`, [catalogId, owner.user.userId, connectionId, mcpCatalogDigest(descriptors), JSON.stringify(catalog)])
      await client.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
    })
    const tasks = new TaskStore(pool, taskLimits)
    const session = await tasks.create(owner.user, requestId.parse(randomUUID()), owner.token)
    await tasks.accept(owner.user, session.sessionId, requestId.parse(randomUUID()), 'approval mutation fixture', owner.token)
    const grant = await tasks.claim(randomUUID())
    expect(grant).not.toBeNull()
    const store = new McpActionStore(tasks, randomBytes(32).toString('base64url'), actionLimits)
    const action = await store.propose(grant!.token, { callKey: randomUUID(), toolName: catalog[0]!.publicName, arguments: { text: 'exact\0中文' } })
    await run({ pool, tasks, grant: grant!, store, owner, approval: approval.token, agent: owner.token, foreign: bob, action,
      logout: () => identities.logout(approval.token) })
  })
}

test('MCP stored receipt survives archival while fresh admission and a late cancelled-root follow-up remain blocked after unarchive', () => approvalFixture(async (f) => {
  await transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.owner.token, { lock: 'update' })
    await f.tasks.requestArchiveStopInTransaction(client, f.owner.user, f.grant.sessionId)
  })
  const selected = f.grant.remoteMcpTools[0]
  if (!selected) throw new Error('MCP fixture did not select its actual tool')
  const original = (await f.pool.query<{ call_key: string; arguments: unknown }>(
    'SELECT call_key,arguments FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0]!
  expect(await f.store.propose(f.grant.token, { callKey: original.call_key, toolName: selected.model.name, arguments: original.arguments }))
    .toEqual(f.action)
  await expect(f.store.propose(f.grant.token, { callKey: randomUUID(), toolName: selected.model.name, arguments: { text: 'forbidden' } }))
    .rejects.toMatchObject({ code: 'native_session_archived' })
  await transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.owner.token, { lock: 'update' })
    await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [f.grant.sessionId, f.owner.user.userId])
    const workspaces = (await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.owner.user.userId])).rows
    const layout = await readWorkspaceLayout(client, f.owner.user.userId, workspaces)
    layout.archivedSessionIds = []
    await writeWorkspaceLayout(client, f.owner.user.userId, layout)
    // Exercise an already-completed native stop marker as a gate input, without asserting provider stop evidence.
    await client.query(`UPDATE pe_native_preferences SET value=jsonb_set(value,'{status}','"complete"'::jsonb)
      WHERE user_id=$1 AND namespace=$2`, [f.owner.user.userId, `session-archive-stop:${f.grant.sessionId}`])
  })
  expect(await f.store.cancel(f.owner.user, f.action.actionId, { token: f.owner.token, audience: 'agent' }))
    .toMatchObject({ actionId: f.action.actionId, state: 'cancelled' })
  expect((await f.pool.query('SELECT id FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows).toEqual([])
}))

test('a cancelled MCP action commits one continuation and repeated cancellation preserves the original receipt', () => approvalFixture(async (f) => {
  await expect(routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, { actionId: randomUUID() }, f.approval))
    .rejects.toMatchObject({ status: 404 })
  const input = { actionId: f.action.actionId }
  const cancelled = await routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, input, f.approval)
  expect(cancelled).toMatchObject({ actionId: f.action.actionId, state: 'cancelled' })
  expect(await routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, input, f.approval)).toEqual(cancelled)
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
  expect((await f.pool.query<{ readonly dispatch_id: string | null; readonly result: unknown }>('SELECT dispatch_id,result FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0])
    .toEqual({ dispatch_id: null, result: null })
}))

test('MCP cancellation rechecks the approval bearer after logout and rejects agent or mismatched identities', () => approvalFixture(async (f) => {
  const input = { actionId: f.action.actionId }
  await expect(routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, input, f.agent)).rejects.toMatchObject({ status: 401 })
  await expect(routeMcpApproval(f.store, '/approvals/mcp/cancel', f.foreign.user, input, f.approval)).rejects.toMatchObject({ status: 401 })
  await f.logout()
  await expect(routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, input, f.approval)).rejects.toMatchObject({ status: 401 })
  expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0]!.state).toBe('pending')
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(0)
}))

test('MCP permission revocation rechecks approval credentials and remains idempotent for the current owner', () => approvalFixture(async (f) => {
  await expect(routeMcpApproval(f.store, '/approvals/mcp/revoke', f.owner.user, { permissionId: randomUUID() }, f.approval))
    .rejects.toMatchObject({ status: 404 })
  await f.store.decide(f.owner.user, f.action.actionId, f.action.fingerprint, 'persistent', f.approval)
  const permission = (await f.pool.query<{ readonly permission_id: string | null }>('SELECT permission_id FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0]!.permission_id
  const input = { permissionId: permission }
  await expect(routeMcpApproval(f.store, '/approvals/mcp/revoke', f.owner.user, input, f.agent)).rejects.toMatchObject({ status: 401 })
  expect((await f.pool.query<{ readonly revoked_at: Date | null }>('SELECT revoked_at FROM pe_mcp_permissions WHERE id=$1', [permission])).rows[0]!.revoked_at).toBeNull()
  expect(await routeMcpApproval(f.store, '/approvals/mcp/revoke', f.owner.user, input, f.approval)).toEqual({ ok: true })
  const revoked = (await f.pool.query<{ readonly revoked_at: Date | null }>('SELECT revoked_at FROM pe_mcp_permissions WHERE id=$1', [permission])).rows[0]!.revoked_at
  expect(await routeMcpApproval(f.store, '/approvals/mcp/revoke', f.owner.user, input, f.approval)).toEqual({ ok: true })
  expect((await f.pool.query<{ readonly revoked_at: Date | null }>('SELECT revoked_at FROM pe_mcp_permissions WHERE id=$1', [permission])).rows[0]!.revoked_at).toEqual(revoked)
  await f.logout()
  await expect(routeMcpApproval(f.store, '/approvals/mcp/revoke', f.owner.user, input, f.approval)).rejects.toMatchObject({ status: 401 })
}))

test('MCP cancellation after committed dispatch preserves uncertainty and cannot claim or continue the action twice', () => approvalFixture(async (f) => {
  await f.store.decide(f.owner.user, f.action.actionId, f.action.fingerprint, 'once', f.approval)
  const lease = await f.store.claim(mcpLeaseOwnerId.parse(randomUUID()))
  expect(lease).not.toBeNull()
  const prepared = await f.store.preparation(lease!)
  const observed = (await f.pool.query<{ readonly catalog_digest: string }>('SELECT catalog_digest FROM pe_mcp_catalog_versions WHERE id=$1', [prepared.tool.catalogId])).rows[0]!.catalog_digest
  expect(await f.store.authorizeDispatch(lease!, observed)).toBe(true)
  const dispatch = (await f.pool.query<{ readonly dispatch_id: string | null }>('SELECT dispatch_id FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0]!.dispatch_id
  const cancelled = await routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, { actionId: f.action.actionId }, f.approval)
  expect(cancelled).toMatchObject({ state: 'uncertain', errorCode: 'mcp_cancel_after_intent' })
  expect(await routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, { actionId: f.action.actionId }, f.approval)).toEqual(cancelled)
  expect(await f.store.claim(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
  await expect(f.store.finish(lease!, { result: { content: [{ type: 'text', text: 'late' }] } }))
    .rejects.toMatchObject({ status: 409 })
  expect((await f.pool.query<{ readonly dispatch_id: string | null; readonly result: unknown }>('SELECT dispatch_id,result FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0])
    .toEqual({ dispatch_id: dispatch, result: null })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
}))

test('a current owner agent bearer can cancel but cannot revoke permissions or approve a call', () => approvalFixture(async (f) => {
  await expect(f.store.decide(f.owner.user, f.action.actionId, f.action.fingerprint, 'once', f.agent)).rejects.toMatchObject({ status: 401 })
  expect(await f.store.cancel(f.owner.user, f.action.actionId, { token: f.agent, audience: 'agent' })).toMatchObject({ state: 'cancelled' })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
}))

test('MCP cancellation waiting on the account lock observes credential revocation before changing durable state', () => approvalFixture(async (f) => {
  const blocker = await f.pool.connect()
  let cancellation: Promise<unknown> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.owner.user.userId])
    cancellation = routeMcpApproval(f.store, '/approvals/mcp/cancel', f.owner.user, { actionId: f.action.actionId }, f.approval)
    const outcome = cancellation.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
    await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
      .toBe(true)
    await blocker.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.owner.user.userId])
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ status: 401 })
    expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_mcp_actions WHERE id=$1', [f.action.actionId])).rows[0]!.state).toBe('pending')
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(0)
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await cancellation?.catch(() => undefined)
  }
}))

test('MCP draft tickets reject incomplete source revision pairs without durable changes and allow the same requests when complete', () => cloudFixture(async ({ pool, alice }) => {
  const endpoint = 'https://example.invalid/mcp', admittedEndpoints: string[] = []
  const service = new McpConnectionService(pool, randomBytes(32).toString('base64url'), {
    maxConnections: 8, maxPendingTickets: 8, maxActiveChecks: 4, maxDrafts: 4, maxDraftsPerHour: 8,
    maxTools: 8, maxCatalogBytes: 65_536, maxToolBytes: 16_384, ticketLifetimeMs: 60_000,
    checkLifetimeMs: 60_000, draftLifetimeMs: 60_000, retentionMs: 120_000, checkLeaseMs: 10_000,
    assertEndpoint: (url) => { expect(url).toBe(endpoint); admittedEndpoints.push(url) },
  })
  const tasks = new TaskStore(pool, taskLimits)
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const configuration = { presentation: { note: 'Owned service', icon: null },
    displayName: 'Draft ticket fixture', serverUrl: endpoint, enabled: true,
    authentication: { kind: 'none' as const } }
  const connection = await service.create(alice.user, { requestId: randomUUID(), configuration })
  expect(mcpConnectionValue.parse(connection).presentation).toEqual(configuration.presentation)
  const credentials = Buffer.from(JSON.stringify({ formatVersion: 1, bearerToken: 'owned-draft-fixture' }))
  const snapshot = async () => {
    const [tickets, requests, drafts] = await Promise.all([
      pool.query('SELECT to_jsonb(t) AS row FROM pe_mcp_credential_tickets t ORDER BY user_id,request_id'),
      pool.query('SELECT to_jsonb(r) AS row FROM pe_mcp_management_requests r ORDER BY user_id,request_id'),
      pool.query('SELECT to_jsonb(d) AS row FROM pe_mcp_drafts d ORDER BY id'),
    ])
    return { tickets: tickets.rows, requests: requests.rows, drafts: drafts.rows }
  }
  const variants = [
    { invalid: { sourceConnectionId: connection.connectionId }, valid: {}, source: null, revision: null },
    { invalid: { baseRevision: connection.revision },
      valid: { sourceConnectionId: connection.connectionId, baseRevision: connection.revision },
      source: connection.connectionId, revision: connection.revision },
  ]
  for (const variant of variants) {
    const input = { purpose: 'draft' as const, requestId: randomUUID(), sessionId: session.sessionId,
      configuration: { ...configuration, authentication: { kind: 'bearer' as const, action: 'replace' as const } },
      sizeBytes: credentials.length }
    const before = await snapshot(), admissions = admittedEndpoints.length
    await expect(service.issueTicket(alice.user, { ...input, ...variant.invalid }, 'https://platform.example.invalid'))
      .rejects.toMatchObject({ name: 'ZodError' })
    expect(await snapshot()).toEqual(before)
    expect(admittedEndpoints).toHaveLength(admissions)
    const issued = await service.issueTicket(alice.user, { ...input, ...variant.valid }, 'https://platform.example.invalid')
    expect(issued).toMatchObject({ state: 'pending', requestId: input.requestId,
      uploadUrl: 'https://platform.example.invalid/mcp/connections/upload' })
    const result = await service.upload(issued.ticket, (async function* () { yield credentials })())
    if (result.kind !== 'check') throw new Error('Owned draft upload did not create a check')
    expect(result.item).toMatchObject({ sessionId: session.sessionId, state: 'queued', connectionId: null })
    expect((await pool.query(`SELECT source_connection_id,source_revision FROM pe_mcp_drafts
      WHERE id=$1 AND user_id=$2`, [result.item.draftId, alice.user.userId])).rows)
      .toEqual([{ source_connection_id: variant.source, source_revision: variant.revision }])
    expect((await pool.query(`SELECT purpose,result FROM pe_mcp_management_requests
      WHERE user_id=$1 AND request_id=$2`, [alice.user.userId, input.requestId])).rows)
      .toEqual([{ purpose: 'draft', result }])
    expect((await pool.query(`SELECT purpose,consumed_at IS NOT NULL AS consumed FROM pe_mcp_credential_tickets
      WHERE user_id=$1 AND request_id=$2`, [alice.user.userId, input.requestId])).rows)
      .toEqual([{ purpose: 'draft', consumed: true }])
  }
}))
