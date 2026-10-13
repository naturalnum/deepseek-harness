/** Actual PG archive races and external Connector reply loss; no Runner termination is synthesized. */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { officePreviewSourcePrepareRequest } from '@power-evolve/contracts/office-preview'
import { requestId, workspaceId } from '../src/contracts.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { ConnectorService } from '../src/platform/connectors.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { ExecutionService } from '../src/platform/executions.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { requestSessionActivityStopInTransaction } from '../src/platform/native-session-activity-stop.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { PluginService } from '../src/platform/plugins.ts'
import { OfficePreviewService } from '../src/platform/office-previews.ts'
import { SandboxManager } from '../src/platform/sandbox.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const limits = { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 2, executionEnabled: true }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Activity stop fixture returned no original row')
  return row
}

async function prepare(f: Fixture, targetUrl = 'http://127.0.0.1:9') {
  expect(first((await f.pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).version).toBe(CURRENT_SCHEMA_VERSION)
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Original activity', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Activity stop fixture did not claim its original operation')
  const connectors = new ConnectorService(tasks, targetUrl, 'unused-external-test-key', 1000, 100)
  await new PluginService(f.pool).seedUsers([f.alice.user.username])
  await connectors.seedPermissions([f.alice.user.username])
  const kubeconfig = join(f.root, 'unused-kubeconfig.json')
  await writeFile(kubeconfig, JSON.stringify({ 'current-context': 'owned',
    clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:9', 'certificate-authority-data': Buffer.from('unused').toString('base64') } }],
    contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }], users: [{ name: 'owned', user: { token: 'unused' } }] }))
  const sandbox = new SandboxManager(await KubernetesClient.fromFile(kubeconfig), f.files, f.pool, randomUUID(), {
    namespace: 'owned-unused-activity', image: 'fixture.invalid/unused', localRoot: f.root,
    nodeRoot: join(f.root, 'unused-node'), readyTimeoutMs: 1000, maxExecutions: 2,
  })
  const executions = new ExecutionService(tasks, sandbox, 1, 100, 60_000, 1000)
  return { tasks, session, grant, connectors, executions }
}

async function archive(f: Fixture, n: Awaited<ReturnType<typeof prepare>>, client: PoolClient, activity = false) {
  const actor = await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
  await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [n.session.sessionId, actor.userId])
  const workspaces = (await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [actor.userId])).rows
  const layout = await readWorkspaceLayout(client, actor.userId, workspaces)
  layout.archivedSessionIds = [n.session.sessionId]
  await writeWorkspaceLayout(client, actor.userId, layout)
  await n.tasks.requestArchiveStopInTransaction(client, f.alice.user, n.session.sessionId)
  if (activity) await requestSessionActivityStopInTransaction(client, f.alice.user, n.session.sessionId)
}

test('fresh cloud and Connector writes waiting behind the actual archive transaction refuse but exact receipts remain readable', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  const cloudCall = randomUUID(), noteCall = randomUUID()
  try {
    const cloud = await n.executions.propose(n.grant.token, cloudCall, 'printf original', '')
    const note = await n.connectors.prepare(n.grant.token, noteCall, 'original note')
    // The route's already-completed preflight cannot protect these later service transactions.
    await transaction(f.pool, client => n.tasks.authorized(client, n.grant.token))
    const blocker = await f.pool.connect()
    let writes: Promise<unknown[]> | undefined
    try {
      await blocker.query('BEGIN')
      const pid = first((await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows).pid
      await requireBrowserAccount(blocker, f.alice.token, { lock: 'update' })
      writes = Promise.all([
        n.executions.propose(n.grant.token, randomUUID(), 'printf forbidden', ''),
        n.connectors.prepare(n.grant.token, randomUUID(), 'forbidden note'),
      ].map(promise => promise.then(value => ({ value }), (error: unknown) => ({ error }))))
      await expect.poll(async () => first((await f.pool.query<{ waiting: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows).waiting).toBe(true)
      await archive(f, n, blocker)
      await blocker.query('COMMIT')
      for (const result of await writes) expect(result).toMatchObject({ error: { code: 'native_session_archived' } })
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await writes
    }
    expect(await n.executions.propose(n.grant.token, cloudCall, 'printf original', '')).toEqual(cloud)
    expect(await n.connectors.prepare(n.grant.token, noteCall, 'original note')).toEqual(note)
    expect(first((await f.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pe_cloud_executions')).rows).n).toBe(1)
    expect(first((await f.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pe_connector_actions')).rows).n).toBe(1)
  } finally { await n.connectors.close(); await n.executions.close() }
}))

test('Session activity requests flag the original completed-parent command and preserve another owned Session', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  try {
    await n.executions.propose(n.grant.token, randomUUID(), 'printf retained', '')
    await n.connectors.prepare(n.grant.token, randomUUID(), 'never approved')
    await n.tasks.finish(n.grant.token, 'completed', null)
    const other = await n.tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await n.tasks.accept(f.alice.user, other.sessionId, requestId.parse(randomUUID()), 'other Session', f.alice.token)
    const grant = await n.tasks.claim(randomUUID())
    if (!grant || grant.sessionId !== other.sessionId) throw new Error('Other Session was not actually claimed')
    await n.executions.propose(grant.token, randomUUID(), 'printf other', '')
    const before = (await f.pool.query<Record<string, unknown> & { session_id: string }>('SELECT * FROM pe_cloud_executions ORDER BY id')).rows
    await transaction(f.pool, client => archive(f, n, client, true))
    const stopped = first((await f.pool.query<{ cancel_requested: boolean; state: string; sandbox_name: string | null }>(
      'SELECT cancel_requested,state,sandbox_name FROM pe_cloud_executions WHERE session_id=$1', [n.session.sessionId])).rows)
    expect(stopped).toEqual({ cancel_requested: true, state: 'queued', sandbox_name: null })
    const listed = z.object({ items: z.array(z.object({ command: z.string(), state: z.string() }).loose()) })
      .parse(await n.executions.list(f.alice.user))
    expect(listed.items.find(item => item.command === 'printf retained')?.state).toBe('queued')
    expect((await f.pool.query('SELECT * FROM pe_cloud_executions WHERE session_id=$1', [other.sessionId])).rows)
      .toEqual(before.filter(row => row.session_id === other.sessionId))
    expect(first((await f.pool.query<{ state: string; error_code: string }>(
      'SELECT state,error_code FROM pe_connector_actions WHERE session_id=$1', [n.session.sessionId])).rows))
      .toEqual({ state: 'failed', error_code: 'native_session_stopped' })
    expect(first((await f.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_action_id IS NOT NULL')).rows).n).toBe(0)
  } finally { await n.connectors.close(); await n.executions.close() }
}))

test('an uncertain Connector effect is never posted again after stop and its later observed result stores without a business follow-up', () => cloudFixture(async (f) => {
  let posts = 0, lookups = 0, visible = false
  let effect: { actionId: string; owner: string; text: string; createdAt: string } | undefined
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') {
        lookups++
        if (!visible || !effect) { res.writeHead(404).end(); return }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(effect)); return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(z.instanceof(Uint8Array).parse(chunk)))
      const input = z.object({ owner: z.string(), text: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString()))
      posts++
      effect = { ...input, actionId: String(req.headers['idempotency-key']), createdAt: new Date().toISOString() }
      res.writeHead(503).end() // External write happened; its reply does not establish the outcome.
    })().catch(() => { res.writeHead(500).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connector fixture did not acquire its own port')
  const password = randomUUID()
  await seedNewUser(f.pool, 'activity-owner', await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
  const owner = await f.identities.login('activity-owner', password)
  const ownedFixture = { ...f, alice: owner }
  const n = await prepare(ownedFixture, `http://127.0.0.1:${address.port}`)
  let resumed: ConnectorService | undefined
  try {
    const approval = await f.identities.login('activity-owner', password, 'approval')
    const action = z.object({ actionId: z.uuid(), fingerprint: z.string() }).loose()
      .parse(await n.connectors.prepare(n.grant.token, randomUUID(), 'actual uncertain note'))
    const original = first((await f.pool.query<{ request_digest: string; request: unknown; continuation_request_id: string }>(
      'SELECT request_digest,request,continuation_request_id FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows)
    await n.connectors.decide(owner.user, action.actionId, action.fingerprint, true, approval.token)
    n.connectors.start()
    await expect.poll(async () => first((await f.pool.query<{ state: string }>(
      'SELECT state FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows).state).toBe('uncertain')
    await n.connectors.close()
    expect(posts).toBe(1)
    expect(effect).toMatchObject({ actionId: action.actionId, owner: owner.user.userId, text: 'actual uncertain note' })
    await transaction(f.pool, client => archive(ownedFixture, n, client, true))
    await transaction(f.pool, async (client) => {
      await requireBrowserAccount(client, owner.token, { lock: 'update' })
      await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [n.session.sessionId, owner.user.userId])
      const workspaces = (await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [owner.user.userId])).rows
      const layout = await readWorkspaceLayout(client, owner.user.userId, workspaces)
      layout.archivedSessionIds = []
      await writeWorkspaceLayout(client, owner.user.userId, layout)
      // Persisted native-purpose completion is a gate fixture; it is not evidence that the external effect was stopped.
      await client.query(`UPDATE pe_native_preferences SET value=jsonb_set(value,'{status}','"complete"'::jsonb)
        WHERE user_id=$1 AND namespace=$2`, [owner.user.userId, `session-archive-stop:${n.session.sessionId}`])
    })
    const queriesBefore = lookups
    await f.pool.query("UPDATE pe_connector_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [action.actionId])
    resumed = new ConnectorService(n.tasks, `http://127.0.0.1:${address.port}`, 'unused-external-test-key', 1000, 100)
    resumed.start()
    await expect.poll(async () => first((await f.pool.query<{ state: string; error_code: string }>(
      'SELECT state,error_code FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows))
      .toEqual({ state: 'uncertain', error_code: 'native_session_stopped' })
    expect(lookups).toBeGreaterThan(queriesBefore)
    expect(posts).toBe(1)
    visible = true
    await f.pool.query("UPDATE pe_connector_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [action.actionId])
    await expect.poll(async () => first((await f.pool.query<{ state: string }>(
      'SELECT state FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows).state).toBe('succeeded')
    await resumed.close()
    expect(posts).toBe(1)
    expect(first((await f.pool.query<{ result: unknown }>('SELECT result FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows).result)
      .toEqual({ actionId: action.actionId, text: effect?.text, createdAt: effect?.createdAt })
    expect(first((await f.pool.query('SELECT request_digest,request,continuation_request_id FROM pe_connector_actions WHERE id=$1', [action.actionId])).rows))
      .toEqual(original)
    expect(first((await f.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_action_id=$1', [action.actionId])).rows).n).toBe(0)
  } finally {
    await resumed?.close()
    await n.connectors.close(); await n.executions.close()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
}))

test('an actually admitted Office preview retains its original generation and source when archival cancels it before parser creation', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  let networkRequests = 0
  const forbidden = (): never => { networkRequests++; throw new Error('Office activity fixture must not create a parser') }
  const previews = new OfficePreviewService(f.pool, f.files, { call: async () => forbidden(), resourcePath: forbidden }, {
    namespace: 'owned-office', runtimeClassName: 'gvisor',
    image: `registry.example/office@sha256:${'a'.repeat(64)}`, volumeClaimName: 'office-cache', volumeSubPath: 'jobs',
    kubernetesTimeoutMs: 1000, terminationGraceSeconds: 5, cpuMilliCores: 1000, memoryMiB: 2048, temporaryMiB: 256,
    localRoot: join(f.root, 'isolated-previews'), fontPolicyDigest: 'b'.repeat(64),
    limits: { inputBytes: 16_777_216, outputBytes: 8_388_608, timeoutMs: 20_000,
      archiveEntries: 1000, uncompressedBytes: 67_108_864, fontLoadedBytes: 134_217_728,
      pages: 100, fontFiles: 100, fontFileBytes: 134_217_728, fontResolutionEntries: 1000, imageResolution: 150 },
    maxConcurrentParsers: 2, maxRetainedJobsPerUser: 32, leaseMs: 30_000, jobDeadlineMs: 60_000,
  })
  try {
    const workspace = first((await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1', [n.session.sessionId])).rows)
    await f.files.put(f.alice.user, randomUUID(), 'untrusted.docx', Buffer.from('original untrusted upload').toString('base64'),
      workspaceId.parse(workspace.workspace_id))
    const { generation } = await previews.generation(f.alice.token)
    const request = officePreviewSourcePrepareRequest.parse({ requestId: randomUUID(), sessionId: n.session.sessionId,
      path: 'untrusted.docx', priority: 'foreground', generation })
    const original = await previews.prepare(f.alice.token, request)
    expect(original.state).toBe('queued')
    const before = first((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_office_preview_jobs WHERE id=$1', [original.jobId])).rows)
    await transaction(f.pool, client => archive(f, n, client, true))
    const after = first((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_office_preview_jobs WHERE id=$1', [original.jobId])).rows)
    expect(after).toEqual({ ...before, state: 'cancelled', cancel_requested: true, error_code: null,
      completed_at: after.completed_at, updated_at: after.updated_at })
    const cancelled = await previews.status(f.alice.token, { jobId: original.jobId, generation })
    expect(cancelled.state).toBe('cancelled')
    expect(await previews.prepare(f.alice.token, request)).toEqual(cancelled)
    expect(await previews.cancel(f.alice.token, { jobId: original.jobId, generation })).toEqual(cancelled)
    await expect(previews.prepare(f.alice.token, { ...request,
      requestId: officePreviewSourcePrepareRequest.shape.requestId.parse(randomUUID()) }))
      .rejects.toMatchObject({ code: 'native_session_archived' })
    expect(networkRequests).toBe(0)
  } finally { await previews.stop(); await n.connectors.close(); await n.executions.close() }
}))
