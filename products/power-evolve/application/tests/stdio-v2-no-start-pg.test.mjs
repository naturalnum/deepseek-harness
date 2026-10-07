/** Actual isolated PG/POSIX cancellation tests; Pod, image and stop observations are explicit substitutes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { StdioAdmissionServiceV2 } from '../lib/platform/stdio-v2-admission.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
import { StdioCloudWorkerV2 } from '../lib/platform/stdio-v2-cloud-worker.js'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const management = { maxNameBytes: 80, pageItems: 10, maxConnections: 10 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const code = value => error => error.code === value
function gate() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('no-start Cloud cancellation closes only original safe resources and permanently excludes start authority', { timeout: 60000 }, async t => {
  const databaseUrl = process.env.PE_TEST_DATABASE_URL
    ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
  const database = `pe_stdio_no_start_${randomBytes(10).toString('hex')}`, root = await mkdtemp(join(tmpdir(), 'pe-stdio-no-start-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false, serial = 0
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 10, statement_timeout: 15000 })
    await initializeDatabase(pool)
    const files = new FileService(pool, join(root, 'workspaces')); await files.init()
    const identity = new IdentityService(pool, 600000), ready = new Map()
    const connections = new StdioConnectionServiceV2(pool, limits, management)
    const admission = new StdioAdmissionServiceV2(pool, files,
      { limits, management, maxPendingPerUser: 10, deployments: { cloud: pin, desktop: [] } })
    const leases = new StdioActionLeaseServiceV2(pool, { leaseMs: 30000 })
    const store = new StdioCloudWorkerStoreV2(pool, { limits, leaseMs: 30000, maxActive: 5, maxCandidates: 10 })
    const auth = new StdioAuthorizationServiceV2(pool, { limits, approvalKey: randomBytes(32), approvalLifetimeMs: 60000,
      async capture(_client, task, executionRef) {
        const writer = ready.get(task.actionId), capture = { kind: 'cloud', podUid: writer.podUid, podName: writer.name,
          namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId: writer.runnerInstanceId,
          containerId: 'containerd://synthetic', restartCount: 0, mountGeneration: writer.generation,
          workspaceMount: { claimName: 'synthetic', subPath: `workspaces/${writer.binding.rootKey}`, mountPath: '/workspace', readOnly: false },
          homeMount: { claimName: 'synthetic', subPath: `homes/${task.userId}`, mountPath: '/home/agent', readOnly: false } }
        return { formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task), scopeBinding: task.scopeBinding,
          expectedDeploymentPin: task.expectedDeploymentPin, actualExecutorImage: { kind: 'cloud', platform: pin.platform,
            imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }, capture, specDigest: sha('spec', { synthetic: true }),
          fullScopeDigest: sha('scope', { scopeBinding: task.scopeBinding, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }) }
      } })
    async function fresh() {
      const userId = randomUUID(), password = randomBytes(24).toString('base64url'), username = `no-start-${++serial}`
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, username, await hashPassword(password), { model: 'synthetic-model', maxTokens: 64, revision: 1 }])
      const agent = (await identity.login(username, password, 'agent')).token
      const approval = (await identity.login(username, password, 'approval')).token
      const workspaceId = await files.defaultWorkspaceId(userId), sessionId = randomUUID()
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, userId, workspaceId, randomUUID(), {}])
      const connection = await connections.create(agent, { requestId: randomUUID(), configuration: {
        name: 'synthetic', invocation: { program: 'node', argv: ['server.mjs'], cwd: '.' } } })
      const admitted = await admission.check(agent, { requestId: randomUUID(), sessionId,
        connectionId: connection.connectionId, expectedRevision: 1, target: { kind: 'cloud' } })
      const lease = await leases.claim(admitted.actionId, randomUUID())
      assert(lease)
      return { userId, sessionId, workspaceId, agent, approval, admitted, lease }
    }
    async function writerFor(f, state = 'ready') {
      await store.beginPreparation(f.lease)
      const binding = await files.bindingForId(f.userId, f.workspaceId)
      const writer = { name: `synthetic-${randomUUID()}`, podUid: randomUUID(), runnerInstanceId: randomUUID(), token: 'synthetic',
        restartCount: 0, generation: '1', userId: f.userId, sessionId: f.sessionId, binding }
      ready.set(f.lease.actionId, writer)
      await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,1,$4,$5,$6,$7)`, [f.userId, f.sessionId, f.workspaceId, state,
        state === 'ready' ? writer.podUid : null, state === 'ready' ? writer.runnerInstanceId : null, binding])
      await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [f.sessionId, f.userId, writer.name, state === 'ready' ? 'ready' : 'creating',
        state === 'ready' ? writer.podUid : null, state === 'ready' ? writer.runnerInstanceId : null, binding])
      if (state === 'ready') await store.attach(f.lease, writer)
      return writer
    }
    async function raw(table, where, id) { return (await pool.query(`SELECT row_to_json(saved)::text AS literal FROM ${table} saved WHERE ${where}=$1`, [id])).rows }
    async function counts(actionId) {
      return (await pool.query(`SELECT (SELECT count(*)::int FROM pe_stdio_v2_start_permits WHERE action_id=$1) AS permits,
        (SELECT count(*)::int FROM pe_stdio_v2_dispatches WHERE action_id=$1) AS dispatches,
        (SELECT count(*)::int FROM pe_stdio_v2_results WHERE action_id=$1) AS results,
        (SELECT count(*)::int FROM pe_stdio_v2_no_start_closures WHERE action_id=$1) AS closures`, [actionId])).rows[0]
    }

    await t.test('concurrent queued cancellation preserves one raw receipt, has no Runner result, and permits a new discovery', async () => {
      const f = await fresh(); await store.defer(f.lease, 'stdio_v2_cancel_requested')
      const receipts = await Promise.all(Array.from({ length: 5 }, () => store.closeUnstarted(f.lease)))
      assert(receipts.every(item => JSON.stringify(item) === JSON.stringify(receipts[0])))
      assert.equal(receipts[0].resource.kind, 'unallocated'); assert.equal(receipts[0].startNeverAuthorized, true)
      assert.deepEqual(await counts(f.lease.actionId), { permits: 0, dispatches: 0, results: 0, closures: 1 })
      const original = await raw('pe_stdio_v2_no_start_closures', 'action_id', f.lease.actionId)
      assert.deepEqual(await store.readNoStart(f.lease.actionId), receipts[0])
      await store.release(f.lease)
      assert.deepEqual(await store.readNoStart(f.lease.actionId), receipts[0])
      assert.deepEqual(await raw('pe_stdio_v2_no_start_closures', 'action_id', f.lease.actionId), original)
      await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_lease_lost'))
      const connection = (await pool.query('SELECT connection_id FROM pe_stdio_v2_actions WHERE id=$1', [f.lease.actionId])).rows[0]
      const next = await admission.check(f.agent, { requestId: randomUUID(), sessionId: f.sessionId,
        connectionId: connection.connection_id, expectedRevision: 1, target: { kind: 'cloud' } })
      assert.notEqual(next.actionId, f.lease.actionId)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].n, 0)
    })

    await t.test('the actual worker reads one committed closure after an injected lost acknowledgement, without any executor work', async () => {
      const f = await fresh(); await store.defer(f.lease, 'stdio_v2_cancel_requested')
      let closes = 0, reads = 0
      // The closure really commits in PG; only its returned acknowledgement is deliberately lost.
      const uncertainReply = new Proxy(store, { get(target, property) {
        if (property === 'closeUnstarted') return async lease => {
          closes++; await target.closeUnstarted(lease); throw new Error('injected_lost_commit_acknowledgement')
        }
        if (property === 'readNoStart') return async actionId => { reads++; return target.readNoStart(actionId) }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const forbidden = async () => { throw new Error('Executor work is forbidden for an unallocated cancellation') }
      const worker = new StdioCloudWorkerV2(uncertainReply, { prepareLeased: forbidden, authorizeLeased: forbidden },
        { ensureReady: forbidden, cancelCreation: forbidden },
        { startDetached: forbidden, observeDetached: forbidden, cancelDetached: forbidden }, { record: forbidden },
        { workerId: f.lease.workerId, pollMs: 10, renewMs: 5000, leaseMs: 30000 })
      assert.equal(await worker.step(f.lease, new AbortController().signal), 'finalized')
      await worker.stop()
      assert.equal(closes, 1); assert.equal(reads, 1)
      const receipt = await store.readNoStart(f.lease.actionId)
      assert.equal(receipt.resource.kind, 'unallocated')
      assert.deepEqual(await counts(f.lease.actionId), { permits: 0, dispatches: 0, results: 0, closures: 1 })
      assert.equal((await pool.query('SELECT lease_owner FROM pe_stdio_v2_actions WHERE id=$1', [f.lease.actionId])).rows[0].lease_owner, null)
      assert.equal(await leases.claim(f.lease.actionId, randomUUID()), null)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].n, 0)
    })

    await t.test('an approved original closes without changing Prepared, decision, ready slot or instance bytes', async () => {
      const f = await fresh(), writer = await writerFor(f), prepared = await auth.prepareLeased(f.lease)
      await auth.decide(f.approval, { actionId: f.lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
      const sources = [['pe_stdio_v2_preparations', 'action_id', f.lease.actionId], ['pe_stdio_v2_decisions', 'action_id', f.lease.actionId],
        ['pe_mount_slots', 'user_id', f.userId], ['pe_sandbox_instances', 'session_id', f.sessionId]]
      const before = await Promise.all(sources.map(values => raw(...values)))
      await store.defer(f.lease, 'stdio_v2_cancel_requested')
      const closed = await store.closeUnstarted(f.lease)
      assert.equal(closed.resource.kind, 'ready_retained'); assert.equal(closed.resource.podUid, writer.podUid)
      assert.equal(closed.preparedDigest, prepared.preparedDigest)
      assert.deepEqual(await Promise.all(sources.map(values => raw(...values))), before)
      await assert.rejects(auth.authorizeLeased(f.lease, randomUUID(), { kind: 'cloud', runnerInstanceId: writer.runnerInstanceId }))
      const task = (await store.snapshot(f.lease)).task
      const requestId = randomUUID(), permit = { formatVersion: 2, actionId: f.lease.actionId, permitId: randomUUID(),
        authorizationRequestId: requestId, executionRef: f.admitted.executionRef, taskDigest: sha('task', task),
        preparedDigest: prepared.preparedDigest, approvalFingerprint: prepared.fingerprint, issuedAt: new Date().toISOString(),
        expiresAt: prepared.expiresAt, executorOwner: { kind: 'cloud', runnerInstanceId: writer.runnerInstanceId } }
      await assert.rejects(transaction(pool, client => client.query(`INSERT INTO pe_stdio_v2_start_permits
        (action_id,permit_id,authorization_request_id,execution_id,task_digest,prepared_digest,fingerprint,decision,executor_owner,permit,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'once',$8,$9,$10,$11)`, [f.lease.actionId, permit.permitId, requestId,
        f.admitted.executionRef.executionId, permit.taskDigest, prepared.preparedDigest, prepared.fingerprint,
        JSON.stringify(permit.executorOwner), JSON.stringify(permit), permit.issuedAt, permit.expiresAt])), { code: '23514' })
      await assert.rejects(pool.query('UPDATE pe_stdio_v2_no_start_closures SET receipt=$2 WHERE action_id=$1',
        [f.lease.actionId, JSON.stringify({ replaced: true })]), { code: '23514' })
      await assert.rejects(pool.query('DELETE FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [f.lease.actionId]), { code: '23514' })
      assert.deepEqual(await counts(f.lease.actionId), { permits: 0, dispatches: 0, results: 0, closures: 1 })
    })

    await t.test('creation reservations and missing or mismatched dual stop evidence never become no-start receipts', async () => {
      const f = await fresh(), writer = await writerFor(f, 'reserved')
      await store.defer(f.lease, 'stdio_v2_cancel_requested')
      await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_no_start_resources_unavailable'))
      await pool.query("UPDATE pe_mount_slots SET state='free',session_id=NULL,workspace_id=NULL WHERE user_id=$1", [f.userId])
      await pool.query("UPDATE pe_sandbox_instances SET state='deleted' WHERE session_id=$1", [f.sessionId])
      await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_no_start_resources_unavailable'))
      const proof = { status: 'KUBELET_STOPPED', podUid: writer.podUid, sandboxUid: randomUUID(), generation: '1',
        sessionId: f.sessionId, runnerInstanceId: null, bindingSnapshot: writer.binding, observedAt: new Date().toISOString() }
      await pool.query('UPDATE pe_mount_slots SET stop_pod_uid=$2,stop_evidence=$3 WHERE user_id=$1',
        [f.userId, writer.podUid, proof])
      await pool.query('UPDATE pe_sandbox_instances SET stop_pod_uid=$2,stop_evidence=$3 WHERE session_id=$1',
        [f.sessionId, writer.podUid, { ...proof, sandboxUid: randomUUID() }])
      await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_no_start_resources_unavailable'))
      assert.deepEqual(await counts(f.lease.actionId), { permits: 0, dispatches: 0, results: 0, closures: 0 })
      await pool.query('UPDATE pe_sandbox_instances SET stop_evidence=$2 WHERE session_id=$1', [f.sessionId, proof])
      const receipt = await store.closeUnstarted(f.lease)
      assert.equal(receipt.resource.kind, 'creation_stopped'); assert.deepEqual(receipt.resource.stopEvidence, proof)
    })

    await t.test('cancellation cannot pass a resource mutation transaction; unknown creation remains reserved after it settles', async () => {
      const f = await fresh(), writer = await writerFor(f, 'reserved'), entered = gate(), finish = gate()
      const config = { namespace: 'unused', image: pin.imageReference, localRoot: root, nodeRoot: root, readyTimeoutMs: 100,
        fileScan: { maxEntries: 10, maxHashBytes: 1024, timeoutMs: 100, maxSnapshotBytes: 1024, maxFiles: 10 } }
      const manager = new SandboxManager({}, files, pool, 'synthetic', config)
      await pool.query('UPDATE pe_sandbox_instances SET name=$2 WHERE session_id=$1', [f.sessionId, manager.name(f.userId)])
      const slot = (await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0]
      let writes = 0, cancellationDone = false
      const mutation = manager.provisionMutation(slot, null,
        (client, mode) => store.assertProvisioning(client, f.lease, f.sessionId, f.userId, mode),
        async () => { writes++; entered.resolve(); await finish.promise })
      await Promise.race([entered.promise, mutation.then(() => { throw new Error('Resource mutation was not entered') })])
      const cancellation = store.defer(f.lease, 'stdio_v2_cancel_requested').then(() => { cancellationDone = true })
      try {
        const deadline = Date.now() + 2000; let observedLock = false
        while (Date.now() < deadline) {
          const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")
          if (waiting.rows[0].n > 0) { observedLock = true; break }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        assert(observedLock); assert.equal(cancellationDone, false); assert.equal(writes, 1)
      } finally { finish.resolve(); await mutation; await cancellation }
      await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_no_start_resources_unavailable'))
      assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].state, 'reserved')
      assert.deepEqual(await counts(f.lease.actionId), { permits: 0, dispatches: 0, results: 0, closures: 0 })
      assert.equal(writer.generation, slot.generation)
    })

    await t.test('a late outer lease check cannot reserve resources after no-start closure, and foreign closure fields fail atomically', async () => {
      const f = await fresh(); await store.defer(f.lease, 'stdio_v2_cancel_requested')
      const closed = await store.closeUnstarted(f.lease)
      const manager = new SandboxManager({ async call() { throw new Error('No Kubernetes request permitted') } }, files, pool, 'synthetic', {
        namespace: 'unused', image: pin.imageReference, localRoot: root, nodeRoot: root, readyTimeoutMs: 100,
        fileScan: { maxEntries: 10, maxHashBytes: 1024, timeoutMs: 100, maxSnapshotBytes: 1024, maxFiles: 10 } })
      await assert.rejects(manager.ensureReady(f.sessionId, f.userId, async () => {},
        (client, mode) => store.assertProvisioning(client, f.lease, f.sessionId, f.userId, mode)))
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].n, 0)
      const other = await fresh()
      await assert.rejects(pool.query(`INSERT INTO pe_stdio_v2_no_start_closures
        (action_id,user_id,session_id,phase,execution_target,execution_id,task_digest,prepared_digest,worker_id,lease_epoch,receipt,receipt_digest)
        SELECT $2,user_id,session_id,phase,execution_target,$3,task_digest,prepared_digest,worker_id,lease_epoch,receipt,receipt_digest
        FROM pe_stdio_v2_no_start_closures WHERE action_id=$1`, [f.lease.actionId, other.lease.actionId, other.admitted.executionRef.executionId]), { code: '23503' })
      assert.deepEqual(await store.readNoStart(f.lease.actionId), closed)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
