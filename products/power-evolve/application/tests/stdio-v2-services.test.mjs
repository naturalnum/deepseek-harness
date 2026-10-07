/** Real isolated PG and private POSIX; executor captures, images and stop/results are explicit synthetic fixtures. */
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
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { StdioAdmissionServiceV2 } from '../lib/platform/stdio-v2-admission.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { stdioPreparedV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const management = { maxNameBytes: 80, pageItems: 2, maxConnections: 40 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const platform = { os: 'linux', architecture: 'arm64' }
const cloud = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform,
  imageReference: `registry.example.test/synthetic@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const configuration = { name: '合成程序', invocation: { program: 'node', argv: ['server.mjs', 'a b', '$(whoami)', ''], cwd: '.' } }
const expectCode = code => error => error.code === code

test('generic management, atomic discovery and independent once authorization on real isolated PG', { timeout: 60000 }, async t => {
  const databaseUrl = process.env.PE_TEST_DATABASE_URL
    ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
  const name = `pe_stdio_services_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-stdio-services-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 0 })
  let pool, created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 12, idleTimeoutMillis: 0, statement_timeout: 15000 })
    await initializeDatabase(pool)
    const files = new FileService(pool, join(root, 'workspaces')); await files.init()
    const identity = new IdentityService(pool, 600000)
    async function account(username) {
      const userId = randomUUID(), password = randomBytes(24).toString('base64url')
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, username, await hashPassword(password), { model: 'synthetic-model', maxTokens: 64, revision: 1 }])
      const agent = await identity.login(username, password, 'agent'), approval = await identity.login(username, password, 'approval')
      const workspaceId = await files.defaultWorkspaceId(userId)
      return { userId, agent: agent.token, approval: approval.token, workspaceId }
    }
    const alice = await account('isolated-alice'), bob = await account('isolated-bob')
    async function session(actor) {
      const id = randomUUID()
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [id, actor.userId, actor.workspaceId, randomUUID(), {}])
      return id
    }
    const connections = new StdioConnectionServiceV2(pool, limits, management)
    const admissionOptions = { limits, management, maxPendingPerUser: 40, deployments: { cloud, desktop: [] } }
    const admission = new StdioAdmissionServiceV2(pool, files, admissionOptions)
    const approvalKey = randomBytes(32), captures = new Map()
    let captureCalls = 0, alterCapture = false
    async function capture(_client, task, executionRef) {
      captureCalls++
      let saved = captures.get(task.actionId)
      if (!saved) {
        assert.equal(task.scopeBinding.kind, 'cloud')
        const image = { kind: 'cloud', platform, imageReference: cloud.imageReference, runtimeImageId: cloud.runtimeImageIds[0] }
        const facts = { kind: 'cloud', podUid: randomUUID(), podName: 'synthetic-pod', namespace: 'synthetic-namespace',
          nodeName: 'synthetic-node', runnerInstanceId: randomUUID(), containerId: 'containerd://synthetic-container', restartCount: 0,
          mountGeneration: '1', workspaceMount: { claimName: 'synthetic-claim', subPath: task.scopeBinding.workspaceId,
            mountPath: '/workspace', readOnly: false }, homeMount: { claimName: 'synthetic-claim', subPath: task.userId,
            mountPath: '/home/agent', readOnly: false } }
        saved = stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task),
          scopeBinding: task.scopeBinding, expectedDeploymentPin: task.expectedDeploymentPin, actualExecutorImage: image, capture: facts,
          fullScopeDigest: sha('scope', { scopeBinding: task.scopeBinding, workspaceMount: facts.workspaceMount, homeMount: facts.homeMount }),
          specDigest: sha('spec', { facts, image }) })
        captures.set(task.actionId, saved)
      }
      return alterCapture ? { ...saved, specDigest: 'f'.repeat(64) } : saved
    }
    const authOptions = { limits, approvalKey, approvalLifetimeMs: 60000, capture }
    const authorization = new StdioAuthorizationServiceV2(pool, authOptions)
    async function discover(actor = alice) {
      const connection = await connections.create(actor.agent, { requestId: randomUUID(), configuration })
      const request = { requestId: randomUUID(), connectionId: connection.connectionId, expectedRevision: connection.revision,
        sessionId: await session(actor), target: { kind: 'cloud' } }
      const receipt = await admission.check(actor.agent, request)
      return { connection, request, receipt }
    }
    async function approved() {
      const fixture = await discover(), preparation = await authorization.prepare(fixture.receipt.actionId)
      const decision = { actionId: fixture.receipt.actionId, fingerprint: preparation.fingerprint, decision: 'once' }
      await authorization.decide(alice.approval, decision)
      return { ...fixture, preparation, decision, owner: { kind: 'cloud', runnerInstanceId: preparation.prepared.capture.runnerInstanceId } }
    }

    await t.test('same-owner concurrent creation is accepted once and foreign receipt/configuration are denied', async () => {
      const request = { requestId: randomUUID(), configuration }
      const receipts = await Promise.all(Array.from({ length: 8 }, () => connections.create(alice.agent, request)))
      assert.ok(receipts.every(receipt => receipt.connectionId === receipts[0].connectionId))
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_connections WHERE id=$1', [receipts[0].connectionId])).rows[0].n, 1)
      await assert.rejects(connections.create(alice.agent, { ...request, configuration: { ...configuration, name: 'changed' } }), expectCode('stdio_v2_request_conflict'))
      await assert.rejects(connections.receipt(bob.agent, { requestId: request.requestId }), expectCode('stdio_v2_request_not_found'))
      await assert.rejects(connections.remove(bob.agent, { requestId: randomUUID(), connectionId: receipts[0].connectionId, expectedRevision: 1 }), expectCode('stdio_v2_connection_not_found'))
      await assert.rejects(connections.create(alice.approval, { requestId: randomUUID(), configuration }), expectCode('account_unauthorized'))
    })

    await t.test('discovery commits management, original task and unique execution without an Agent operation', async () => {
      const fixture = await discover()
      const all = await Promise.all(Array.from({ length: 8 }, () => admission.check(alice.agent, fixture.request)))
      assert.ok(all.every(value => value.actionId === fixture.receipt.actionId && value.executionRef.executionId === fixture.receipt.executionRef.executionId))
      assert.deepEqual(await connections.receipt(alice.agent, { requestId: fixture.request.requestId }), fixture.receipt)
      const row = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [fixture.receipt.executionRef.executionId])).rows[0]
      assert.equal(row.operation_id, null); assert.equal(row.command, null); assert.equal(row.continuation_request_id, null)
      assert.equal(row.stdio_task.origin.kind, 'stdio_discovery'); assert.deepEqual(row.stdio_task.invocation, configuration.invocation)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations WHERE session_id=$1', [fixture.request.sessionId])).rows[0].n, 0)
      await assert.rejects(admission.check(alice.agent, { ...fixture.request, target: { kind: 'desktop', deviceId: randomUUID(), directoryId: randomUUID() } }), expectCode('stdio_v2_request_conflict'))
      await assert.rejects(admission.check(bob.agent, { ...fixture.request, requestId: randomUUID() }), expectCode('session_not_found'))
    })

    await t.test('original writer prevents another discovery and unavailable deployment leaves no acceptance', async () => {
      const fixture = await discover()
      await assert.rejects(admission.check(alice.agent, { ...fixture.request, requestId: randomUUID() }), expectCode('execution_busy'))
      const noDeployment = new StdioAdmissionServiceV2(pool, files, { ...admissionOptions, deployments: { cloud: null, desktop: [] } })
      const request = { ...fixture.request, requestId: randomUUID(), sessionId: await session(alice) }
      await assert.rejects(noDeployment.check(alice.agent, request), expectCode('stdio_v2_deployment_unavailable'))
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_management_requests WHERE request_id=$1', [request.requestId])).rows[0].n, 0)
    })

    await t.test('independent approval rejects agent and foreign bearers; immutable first preparation cannot change', async () => {
      const fixture = await discover(), p = await authorization.prepare(fixture.receipt.actionId)
      await assert.rejects(authorization.inspect(alice.agent, fixture.receipt.actionId), expectCode('account_unauthorized'))
      await assert.rejects(authorization.inspect(bob.approval, fixture.receipt.actionId), expectCode('stdio_v2_action_not_found'))
      const view = await authorization.inspect(alice.approval, fixture.receipt.actionId)
      assert.equal('prepared' in view, false); assert.equal('capture' in view, false)
      assert.deepEqual(await authorization.prepare(fixture.receipt.actionId), p)
      alterCapture = true
      await assert.rejects(authorization.prepare(fixture.receipt.actionId), expectCode('stdio_v2_capture_changed'))
      alterCapture = false
    })

    await t.test('competing authorizations produce exactly one true after one permit and dispatch commit', async () => {
      const f = await approved(), requestId = randomUUID()
      const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => authorization.authorize(f.receipt.actionId, i % 2 ? requestId : randomUUID(), f.owner)))
      assert.equal(replies.filter(reply => reply.grantOnce).length, 1)
      assert.ok(replies.every(reply => reply.permit.permitId === replies[0].permit.permitId))
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1', [f.receipt.actionId])).rows[0].n, 1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_dispatches WHERE action_id=$1', [f.receipt.actionId])).rows[0].n, 1)
      await assert.rejects(authorization.authorize(f.receipt.actionId, randomUUID(), { kind: 'cloud', runnerInstanceId: randomUUID() }), expectCode('stdio_v2_executor_owner_changed'))
      const cold = new StdioAuthorizationServiceV2(pool, { ...authOptions, capture: async () => { throw new Error('Destroyed executor must not be captured on receipt query') } })
      assert.equal((await cold.authorize(f.receipt.actionId, requestId, f.owner)).grantOnce, false)
    })

    await t.test('a committed authorization whose reply is lost returns only false after service restart', async () => {
      const f = await approved(); let loseReply = true
      const losingPool = { async connect() {
        const client = await pool.connect()
        return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
          async query(sql, values) { const response = await client.query(sql, values)
            if (sql === 'COMMIT' && loseReply) { loseReply = false; throw new Error('synthetic_commit_reply_lost') }
            return response } }
      } }
      const lossy = new StdioAuthorizationServiceV2(losingPool, authOptions)
      await assert.rejects(lossy.authorize(f.receipt.actionId, randomUUID(), f.owner), /synthetic_commit_reply_lost/u)
      assert.equal((await authorization.authorize(f.receipt.actionId, randomUUID(), f.owner)).grantOnce, false)
    })

    await t.test('changed fresh capture refuses start without issuing any permit', async () => {
      const f = await approved(); alterCapture = true
      await assert.rejects(authorization.authorize(f.receipt.actionId, randomUUID(), f.owner), expectCode('stdio_v2_capture_changed'))
      alterCapture = false
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1', [f.receipt.actionId])).rows[0].n, 0)
    })

    await t.test('configuration revision invalidates pending approval but retains original receipt and writer', async () => {
      const f = await discover(), p = await authorization.prepare(f.receipt.actionId)
      await connections.update(alice.agent, { requestId: randomUUID(), connectionId: f.connection.connectionId, expectedRevision: 1,
        configuration: { ...configuration, name: 'new revision' } })
      await assert.rejects(authorization.decide(alice.approval, { actionId: f.receipt.actionId, fingerprint: p.fingerprint, decision: 'once' }), expectCode('stdio_v2_configuration_stale'))
      assert.deepEqual(await admission.check(alice.agent, f.request), f.receipt)
      const action = (await pool.query('SELECT state,cancel_requested FROM pe_stdio_v2_actions WHERE id=$1', [f.receipt.actionId])).rows[0]
      assert.equal(action.state, 'pending'); assert.equal(action.cancel_requested, true)
      assert.equal((await pool.query('SELECT state FROM pe_cloud_executions WHERE id=$1', [f.receipt.executionRef.executionId])).rows[0].state, 'queued')
    })

    await t.test('human rejection is immutable and leaves the original execution occupied until cleanup', async () => {
      const f = await discover(), p = await authorization.prepare(f.receipt.actionId)
      const request = { actionId: f.receipt.actionId, fingerprint: p.fingerprint, decision: 'reject' }
      assert.equal((await authorization.decide(alice.approval, request)).state, 'rejected')
      assert.equal((await authorization.decide(alice.approval, request)).decision, 'reject')
      await assert.rejects(authorization.decide(alice.approval, { ...request, decision: 'once' }), expectCode('stdio_v2_decision_conflict'))
      await assert.rejects(admission.check(alice.agent, { ...f.request, requestId: randomUUID() }), expectCode('execution_busy'))
      const active = (await pool.query(`SELECT count(*)::int AS n FROM pe_cloud_executions WHERE user_id=$1
        AND execution_kind='stdio_v2' AND state IN ('queued','starting','running','cancelling','uncertain')`, [alice.userId])).rows[0].n
      const constrained = new StdioAdmissionServiceV2(pool, files, { ...admissionOptions, maxPendingPerUser: active })
      await assert.rejects(constrained.check(alice.agent, { ...f.request, requestId: randomUUID(), sessionId: await session(alice) }),
        expectCode('stdio_v2_action_limit'))
    })

    await t.test('DB-clock expiry prevents approval and cannot renew the first preparation', async () => {
      const f = await discover(), short = new StdioAuthorizationServiceV2(pool, { ...authOptions, approvalLifetimeMs: 1 })
      const p = await short.prepare(f.receipt.actionId)
      await pool.query('SELECT pg_sleep(0.01)')
      await assert.rejects(short.decide(alice.approval, { actionId: f.receipt.actionId, fingerprint: p.fingerprint, decision: 'once' }),
        expectCode('stdio_v2_approval_expired_or_closed'))
      assert.deepEqual(await short.prepare(f.receipt.actionId), p)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_decisions WHERE action_id=$1', [f.receipt.actionId])).rows[0].n, 0)
    })

    await t.test('concurrent Sessions cannot exceed the configured owner admission capacity', async () => {
      const full = (await pool.query(`SELECT count(*)::int AS n FROM pe_cloud_executions WHERE user_id=$1
        AND execution_kind='stdio_v2' AND state IN ('queued','starting','running','cancelling','uncertain')`, [alice.userId])).rows[0].n
      const constrained = new StdioAdmissionServiceV2(pool, files, { ...admissionOptions, maxPendingPerUser: full + 1 })
      const connection = await connections.create(alice.agent, { requestId: randomUUID(), configuration })
      const requests = await Promise.all(Array.from({ length: 2 }, async () => ({ requestId: randomUUID(),
        connectionId: connection.connectionId, expectedRevision: 1, sessionId: await session(alice), target: { kind: 'cloud' } })))
      const results = await Promise.allSettled(requests.map(request => constrained.check(alice.agent, request)))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.ok(results.some(result => result.status === 'rejected' && result.reason.code === 'stdio_v2_action_limit'))
    })

    await t.test('Device admission binds the exact enrolled owner/directory and approved private deployment', async () => {
      const deviceId = randomUUID(), directoryId = randomUUID(), enrollmentId = randomUUID()
      await pool.query('INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id) VALUES($1,$2,$3,$4,$5)',
        [deviceId, alice.userId, 'synthetic-device', randomUUID(), enrollmentId])
      await pool.query('INSERT INTO pe_device_directories(id,device_id,user_id,label) VALUES($1,$2,$3,$4)',
        [directoryId, deviceId, alice.userId, 'synthetic-directory'])
      const deployment = { kind: 'desktop', deploymentId: randomUUID(), protocolVersion: 2, platform, configImageId: `sha256:${'c'.repeat(64)}` }
      const desktop = new StdioAdmissionServiceV2(pool, files, { ...admissionOptions,
        deployments: { cloud, desktop: [{ deviceId, enrollmentId, deployment }] } })
      const connection = await connections.create(alice.agent, { requestId: randomUUID(), configuration })
      const request = { requestId: randomUUID(), connectionId: connection.connectionId, expectedRevision: 1,
        sessionId: await session(alice), target: { kind: 'desktop', deviceId, directoryId } }
      const receipt = await desktop.check(alice.agent, request)
      const row = (await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [receipt.executionRef.executionId])).rows[0]
      assert.equal(row.device_id, deviceId); assert.equal(row.directory_id, directoryId); assert.equal(row.device_instance_id, enrollmentId)
      assert.equal(row.stdio_task.scopeBinding.home.enrollmentId, enrollmentId); assert.equal(row.operation_id, null)
      await assert.rejects(desktop.check(alice.agent, { ...request, requestId: randomUUID(), sessionId: await session(alice) }), expectCode('desktop_directory_busy'))
      const foreign = await connections.create(bob.agent, { requestId: randomUUID(), configuration })
      await assert.rejects(desktop.check(bob.agent, { ...request, requestId: randomUUID(), connectionId: foreign.connectionId,
        sessionId: await session(bob) }), expectCode('desktop_target_unavailable'))
      const absent = new StdioAdmissionServiceV2(pool, files, { ...admissionOptions,
        deployments: { cloud, desktop: [{ deviceId, enrollmentId: randomUUID(), deployment }] } })
      await assert.rejects(absent.check(alice.agent, { ...request, requestId: randomUUID(), sessionId: await session(alice) }), expectCode('stdio_v2_deployment_unavailable'))
    })

    await t.test('successful synthetic catalog retains raw JSON; enable/update/pagination are owner scoped', async () => {
      const f = await discover(), raw = JSON.parse('[{"name":"raw","inputSchema":{"type":"object","properties":{"10":{"type":"string"},"2":{"type":"number"}}},"_meta":{"literal":"a\\u0000b"},"__proto__":{"literal":true}}]')
      const result = { tools: raw }, image = { kind: 'cloud', platform, imageReference: cloud.imageReference, runtimeImageId: cloud.runtimeImageIds[0] }
      const catalogId = randomUUID()
      await transaction(pool, async client => {
        await client.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2::json,$3,$4::json,$5::json)',
          [f.receipt.actionId, JSON.stringify(result), sha('result', result), JSON.stringify({ synthetic: true }), JSON.stringify({ synthetic: true })])
        await client.query("UPDATE pe_stdio_v2_actions SET state='succeeded' WHERE id=$1", [f.receipt.actionId])
        await client.query("UPDATE pe_cloud_executions SET state='succeeded' WHERE id=$1", [f.receipt.executionRef.executionId])
        const task = (await client.query('SELECT task FROM pe_stdio_v2_actions WHERE id=$1', [f.receipt.actionId])).rows[0].task
        await client.query(`INSERT INTO pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision,config_digest,action_id,session_id,phase,raw_catalog,image_expectation,catalog_digest)
          VALUES($1,$2,$3,1,$4,$5,$6,'discover',$7::json,$8::json,$9)`,
        [catalogId, alice.userId, f.connection.connectionId, task.configDigest, f.receipt.actionId, f.request.sessionId,
          JSON.stringify(raw), JSON.stringify(image), stdioCatalogFingerprintV2(raw, limits)])
        await client.query('UPDATE pe_stdio_v2_connections SET current_catalog_id=$2 WHERE id=$1', [f.connection.connectionId, catalogId])
      })
      const toggle = { requestId: randomUUID(), connectionId: f.connection.connectionId, expectedRevision: 1, enabled: true }
      assert.equal((await connections.toggle(alice.agent, toggle)).enabled, true)
      assert.deepEqual((await pool.query('SELECT raw_catalog FROM pe_stdio_v2_catalogs WHERE id=$1', [catalogId])).rows[0].raw_catalog, raw)
      const first = await connections.list(alice.agent, {}), second = await connections.list(alice.agent, { after: first.next })
      assert.equal(first.items.length, 2); assert.ok(first.next); assert.ok(second.items.every(item => item.connectionId > first.next))
      const bobIds = (await pool.query('SELECT id FROM pe_stdio_v2_connections WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [bob.userId])).rows.map(row => row.id)
      assert.deepEqual((await connections.list(bob.agent, {})).items.map(item => item.connectionId), bobIds)
    })

    await t.test('account revocation prevents a fresh permit while the original issued receipt stays false', async () => {
      const issued = await approved(), pending = await approved()
      await authorization.authorize(issued.receipt.actionId, randomUUID(), issued.owner)
      await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.userId])
      try {
        assert.equal((await authorization.authorize(issued.receipt.actionId, randomUUID(), issued.owner)).grantOnce, false)
        await assert.rejects(authorization.authorize(pending.receipt.actionId, randomUUID(), pending.owner), expectCode('account_disabled'))
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1', [pending.receipt.actionId])).rows[0].n, 0)
      } finally { await pool.query('UPDATE pe_users SET enabled=true WHERE id=$1', [alice.userId]) }
    })
    assert.ok(captureCalls > 0)
  } finally {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${name}"`)
    await admin.end(); await rm(root, { recursive: true, force: true })
  }
})
