/** Real PG authority, capacity and lease tests; all executor observations are explicit substitutes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { StdioAdmissionServiceV2 } from '../lib/platform/stdio-v2-admission.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
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

test('Cloud STDIO workers use real PG capacity, owner rotation and fenced original grants', { timeout: 60000 }, async t => {
  const databaseUrl = process.env.PE_TEST_DATABASE_URL
    ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
  const database = `pe_stdio_worker_${randomBytes(10).toString('hex')}`, root = await mkdtemp(join(tmpdir(), 'pe-stdio-worker-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 1 }), ready = new Map()
  let pool, created = false
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 12, statement_timeout: 15000 })
    await initializeDatabase(pool)
    const files = new FileService(pool, join(root, 'workspaces')); await files.init()
    const identity = new IdentityService(pool, 600000)
    const connections = new StdioConnectionServiceV2(pool, limits, management)
    const admission = new StdioAdmissionServiceV2(pool, files,
      { limits, management, maxPendingPerUser: 10, deployments: { cloud: pin, desktop: [] } })
    async function account(username) {
      const userId = randomUUID(), password = randomBytes(24).toString('base64url')
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, username, await hashPassword(password), { model: 'synthetic-model', maxTokens: 64, revision: 1 }])
      return { userId, agent: (await identity.login(username, password, 'agent')).token,
        approval: (await identity.login(username, password, 'approval')).token, workspaceId: await files.defaultWorkspaceId(userId) }
    }
    async function discover(actor) {
      const sessionId = randomUUID()
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, actor.userId, actor.workspaceId, randomUUID(), {}])
      const connection = await connections.create(actor.agent, { requestId: randomUUID(),
        configuration: { name: 'synthetic', invocation: { program: 'node', argv: ['server.mjs'], cwd: '.' } } })
      const receipt = await admission.check(actor.agent, { requestId: randomUUID(), sessionId,
        connectionId: connection.connectionId, expectedRevision: 1, target: { kind: 'cloud' } })
      return { actor, connection, receipt, sessionId }
    }
    const alice = await account('worker-alice'), bob = await account('worker-bob')
    const first = await discover(alice), backlog = await discover(alice), other = await discover(bob)
    const options = { limits, leaseMs: 30000, maxActive: 2, maxCandidates: 10 }
    const store = new StdioCloudWorkerStoreV2(pool, options), replica = new StdioCloudWorkerStoreV2(pool, options)
    let firstLease, otherLease

    await t.test('two replicas rotate users before older backlog and cannot exceed shared capacity', async () => {
      firstLease = await store.claimNext(randomUUID())
      assert.equal(firstLease.actionId, first.receipt.actionId)
      otherLease = await replica.claimNext(randomUUID())
      assert.equal(otherLease.actionId, other.receipt.actionId)
      assert.equal(await store.claimNext(randomUUID()), null)
      const rows = (await pool.query(`SELECT a.id,a.lease_owner,a.lease_until,a.lease_epoch,
        e.lease_owner AS execution_owner,e.lease_until AS execution_until FROM pe_stdio_v2_actions a
        JOIN pe_cloud_executions e ON e.stdio_action_id=a.id WHERE a.lease_owner IS NOT NULL`)).rows
      assert.equal(rows.length, 2)
      for (const row of rows) {
        assert.equal(row.lease_owner, row.execution_owner)
        assert.equal(row.lease_until.getTime(), row.execution_until.getTime())
      }
    })

    await t.test('expired epoch is reclaimed and every old mutation or capture is denied', async () => {
      const expired = firstLease
      await pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.actionId])
      await pool.query("UPDATE pe_cloud_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.receipt.executionRef.executionId])
      firstLease = await replica.claimNext(randomUUID())
      assert.equal(firstLease.actionId, expired.actionId); assert(firstLease.leaseEpoch > expired.leaseEpoch)
      let captures = 0
      for (const attempt of [() => store.snapshot(expired), () => store.renew(expired), () => store.beginPreparation(expired),
        () => store.defer(expired, 'stdio_v2_worker_unavailable'), () => store.release(expired),
        () => store.capture(expired, 'observe', async () => { captures++; return {} })]) {
        await assert.rejects(attempt(), code('stdio_v2_lease_lost'))
      }
      assert.equal(captures, 0)
      await store.renew(firstLease)
      const row = (await pool.query(`SELECT a.lease_until,e.lease_until AS execution_until FROM pe_stdio_v2_actions a
        JOIN pe_cloud_executions e ON e.stdio_action_id=a.id WHERE a.id=$1`, [firstLease.actionId])).rows[0]
      assert.equal(row.lease_until.getTime(), row.execution_until.getTime())
    })

    await t.test('one ready original is attached once; worker approval and start are fenced by its current lease', async () => {
      await store.beginPreparation(firstLease)
      const binding = await files.bindingForId(alice.userId, alice.workspaceId)
      const writer = { name: `synthetic-${randomUUID()}`, podUid: randomUUID(), runnerInstanceId: randomUUID(), token: 'fixture-only',
        restartCount: 0, generation: '1', userId: alice.userId, sessionId: first.sessionId, binding }
      ready.set(firstLease.actionId, writer)
      await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,1,'ready',$4,$5,$6)`, [alice.userId, first.sessionId, alice.workspaceId, writer.podUid, writer.runnerInstanceId, binding])
      await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,'ready',$4,$5,$6)`, [first.sessionId, alice.userId, writer.name, writer.podUid, writer.runnerInstanceId, binding])
      await store.attach(firstLease, writer); await store.attach(firstLease, writer)
      await assert.rejects(store.attach(firstLease, { ...writer, podUid: randomUUID() }))
      let captures = 0
      const auth = new StdioAuthorizationServiceV2(pool, { limits, approvalKey: randomBytes(32), approvalLifetimeMs: 60000,
        async capture(_client, task, executionRef) {
          captures++
          const actual = ready.get(task.actionId), capture = { kind: 'cloud', podUid: actual.podUid, podName: actual.name,
            namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId: actual.runnerInstanceId,
            containerId: 'containerd://synthetic', restartCount: 0, mountGeneration: actual.generation,
            workspaceMount: { claimName: 'synthetic', subPath: `workspaces/${binding.rootKey}`, mountPath: '/workspace', readOnly: false },
            homeMount: { claimName: 'synthetic', subPath: `homes/${alice.userId}`, mountPath: '/home/agent', readOnly: false } }
          return { formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task),
            scopeBinding: task.scopeBinding, expectedDeploymentPin: task.expectedDeploymentPin,
            actualExecutorImage: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
            capture, specDigest: sha('spec', { synthetic: true }), fullScopeDigest: sha('scope', { scopeBinding: task.scopeBinding,
              workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }) }
        } })
      const preparation = await auth.prepareLeased(firstLease)
      await assert.rejects(auth.decide(bob.approval,
        { actionId: firstLease.actionId, fingerprint: preparation.fingerprint, decision: 'once' }))
      await auth.decide(alice.approval, { actionId: firstLease.actionId, fingerprint: preparation.fingerprint, decision: 'once' })
      const owner = { kind: 'cloud', runnerInstanceId: writer.runnerInstanceId }
      const grants = await Promise.all(Array.from({ length: 6 }, () => auth.authorizeLeased(firstLease, randomUUID(), owner)))
      assert.equal(grants.filter(grant => grant.grantOnce).length, 1)
      assert(grants.every(grant => grant.permit.permitId === grants[0].permit.permitId))
      assert.equal(captures, 2)
      assert((await store.snapshot(firstLease)).dispatch)
      await store.release(firstLease)
      await assert.rejects(auth.authorizeLeased(firstLease, randomUUID(), owner), code('stdio_v2_lease_lost'))
      assert.equal(captures, 2)
    })

    await t.test('a rejected original remains claimable for cancellation and never obtains another start', async () => {
      const precise = new StdioActionLeaseServiceV2(pool, { leaseMs: 30000 })
      const lease = await precise.claim(backlog.receipt.actionId, randomUUID())
      await pool.query("UPDATE pe_stdio_v2_actions SET state='rejected',cancel_requested=true WHERE id=$1", [lease.actionId])
      await store.release(lease)
      const replacement = await precise.claim(lease.actionId, randomUUID())
      assert(replacement)
      assert.equal((await store.snapshot(replacement)).cancelRequested, true)
      await store.defer(replacement, 'stdio_v2_cancel_requested')
      const retained = (await pool.query('SELECT state,cancel_requested,lease_owner FROM pe_cloud_executions WHERE id=$1',
        [backlog.receipt.executionRef.executionId])).rows[0]
      assert.equal(retained.cancel_requested, true); assert.equal(retained.state, 'uncertain')
      assert.equal(retained.lease_owner, replacement.workerId)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1', [lease.actionId])).rows[0].n, 0)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
