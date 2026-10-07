/** Real PG grants/results and actual private Docker Runner; Pod/PVC/manifest captures remain explicit substitutes. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { StdioAdmissionServiceV2 } from '../lib/platform/stdio-v2-admission.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { StdioCloudPreparationV2 } from '../lib/platform/stdio-v2-cloud-capture.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioCloudRunTransportV2 } from '../lib/platform/stdio-v2-cloud-runtime.js'
import { StdioResultServiceV2 } from '../lib/platform/stdio-v2-results.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'

/** Exercise an actual SDK discovery for two PG owners without claiming real Kubernetes mount or manifest capture.
 * @param fixture Root-owned private Docker control and operator-selected PG configuration.
 * @returns Two once-minted catalogs and private execution identities after all owned PG resources are closed.
 */
export async function exercisePgRuntime(fixture) {
  const { root, privateDir, imageId, architecture, instanceId, containerId, name, token, limits, fetch, inspect, trace, catalog } = fixture
  const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const database = `pe_stdio_runtime_${randomBytes(10).toString('hex')}`, admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 15000 })
    await initializeDatabase(pool)
    const files = new FileService(pool, join(root, 'pg-workspaces')); await files.init()
    const identity = new IdentityService(pool, 600000), management = { maxNameBytes: 80, pageItems: 10, maxConnections: 10 }
    const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture },
      imageReference: `qa.invalid/runner@${imageId}`, configImageId: imageId, runtimeImageIds: [`qa.invalid/runner@${imageId}`] }
    const connections = new StdioConnectionServiceV2(pool, limits, management)
    const admission = new StdioAdmissionServiceV2(pool, files, { limits, management, maxPendingPerUser: 10, deployments: { cloud: pin, desktop: [] } })
    const leases = new StdioActionLeaseServiceV2(pool, { leaseMs: 30000 }), results = new StdioResultServiceV2(pool, { limits, maxReplyBytes: 131072 })
    const completed = []
    for (const username of ['pg-runtime-alice', 'pg-runtime-bob']) {
      const userId = randomUUID(), password = randomBytes(24).toString('base64url'), sessionId = randomUUID(), podUid = randomUUID()
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, username, await hashPassword(password), { model: 'synthetic-model', maxTokens: 64, revision: 1 }])
      const agent = await identity.login(username, password, 'agent'), approval = await identity.login(username, password, 'approval')
      const workspaceId = await files.defaultWorkspaceId(userId), binding = await files.bindingForId(userId, workspaceId)
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, userId, workspaceId, randomUUID(), {}])
      const traceId = randomUUID(), configuration = { name: username, invocation: { program: 'node',
        argv: ['/qa/stdio-v2-fixture.mjs', 'good', `/workspace/${traceId}.jsonl`, 'literal;$(not-a-shell)', '中文'], cwd: '.' } }
      const connection = await connections.create(agent.token, { requestId: randomUUID(), configuration })
      const receipt = await admission.check(agent.token, { requestId: randomUUID(), connectionId: connection.connectionId,
        expectedRevision: 1, sessionId, target: { kind: 'cloud' } })
      const captured = { kind: 'cloud', podUid, podName: name, namespace: 'synthetic-pg-runtime', nodeName: 'synthetic-node',
        runnerInstanceId: instanceId, containerId: `docker://${containerId}`, restartCount: 0, mountGeneration: '1',
        workspaceMount: { claimName: 'synthetic-pvc', subPath: `workspaces/${binding.rootKey}`, mountPath: '/workspace', readOnly: false },
        homeMount: { claimName: 'synthetic-pvc', subPath: `homes/${userId}`, mountPath: '/home/agent', readOnly: false } }
      await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,1,'ready',$4,$5,$6)`, [userId, sessionId, workspaceId, podUid, instanceId, binding])
      await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,'ready',$4,$5,$6)`, [sessionId, userId, `${name}-${username}`, podUid, instanceId, binding])
      // The actual same Docker Runner is used sequentially; these rows do not claim tenant filesystem isolation.
      await pool.query('UPDATE pe_sandbox_instances SET name=$2 WHERE session_id=$1', [sessionId, name])
      await pool.query('UPDATE pe_cloud_executions SET sandbox_name=$2,pod_uid=$3,runner_instance_id=$4 WHERE id=$1',
        [receipt.executionRef.executionId, name, podUid, instanceId])
      const headers = { 'content-type': 'application/json', 'x-power-evolve-runner-token': token }
      const current = async () => {
        const actual = await inspect(), health = await (await fetch('http://127.0.0.1:8080/health', { headers })).json()
        assert.equal(actual.Id, containerId); assert.equal(actual.Image, imageId); assert.equal(actual.State.Running, true)
        assert.equal(health.instanceId, instanceId); assert.equal(health.ready, true)
      }
      const manager = {
        async observeReady(session, owner, pod, runner, client, mode) {
          assert.deepEqual([session, owner, pod, runner], [sessionId, userId, podUid, instanceId])
          assert.ok(client); await current()
          if (mode === 'dispatch') assert.equal((await client.query('SELECT enabled FROM pe_users WHERE id=$1', [userId])).rows[0].enabled, true)
          return { name, podUid, runnerInstanceId: instanceId, token, restartCount: 0, generation: '1', sessionId, userId, binding }
        },
        async captureStdioV2() { await current(); return { capture: captured,
          actualExecutorImage: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
          spec: { syntheticPod: true, actualContainerId: containerId, actualConfigImageId: imageId } } },
        async runnerBounded(_name, credential, method, path, body) {
          assert.equal(credential, token)
          const response = await fetch(`http://127.0.0.1:8080${path}`, { method, headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
          assert.ok(response.ok); return response.json()
        },
      }
      const adapter = new StdioCloudPreparationV2(manager), approvalKey = randomBytes(32)
      const auth = new StdioAuthorizationServiceV2(pool, { limits, approvalKey, approvalLifetimeMs: 60000,
        capture: (client, task, ref) => adapter.capture(client, task, ref) })
      const prepared = await auth.prepare(receipt.actionId)
      await auth.decide(approval.token, { actionId: receipt.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
      const grant = await auth.authorize(receipt.actionId, randomUUID(), { kind: 'cloud', runnerInstanceId: instanceId })
      assert.equal(grant.grantOnce, true)
      const dispatch = (await pool.query('SELECT dispatch FROM pe_stdio_v2_dispatches WHERE action_id=$1', [receipt.actionId])).rows[0].dispatch
      const lease = await leases.claim(receipt.actionId, randomUUID())
      const locked = operation => transaction(pool, async client => {
        await lockAccountAuthorities(client, [userId], 'update')
        await client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE', [sessionId])
        await client.query('SELECT id FROM pe_stdio_v2_connections WHERE id=$1 FOR UPDATE', [connection.connectionId])
        await client.query('SELECT id FROM pe_stdio_v2_actions WHERE id=$1 FOR UPDATE', [receipt.actionId])
        await client.query('SELECT id FROM pe_cloud_executions WHERE id=$1 FOR UPDATE', [receipt.executionRef.executionId])
        return operation(client)
      })
      const transportOptions = { limits, maxReplyBytes: 131072, requestTimeoutMs: 3000, maxTrackedActions: 10 }
      const transport = new StdioCloudRunTransportV2(manager, transportOptions)
      const started = await locked(client => transport.start(client, dispatch, grant, prepared.prepared))
      await results.record(lease, started)
      let observed = started, deadline = Date.now() + 10000
      while (observed.view.state === 'running' && Date.now() < deadline) {
        observed = await locked(client => transport.observe(client, dispatch, prepared.prepared))
      }
      assert.equal(observed.view.state, 'completed'); assert.ok(observed.stopEvidence)
      assert.deepEqual(observed.view.outcome.catalog, catalog)
      const final = await results.record(lease, observed)
      assert.equal(final.finalized, true); assert.ok(final.catalogId)
      const cold = new StdioAuthorizationServiceV2(pool, { limits, approvalKey, approvalLifetimeMs: 60000,
        capture: async () => { throw new Error('Cold receipt cannot provision or recapture') } })
      const query = await cold.authorize(receipt.actionId, randomUUID(), { kind: 'cloud', runnerInstanceId: instanceId })
      assert.equal(query.grantOnce, false)
      const coldTransport = new StdioCloudRunTransportV2(manager, transportOptions)
      const original = await locked(client => coldTransport.start(client, dispatch, query, prepared.prepared))
      assert.deepEqual(await results.record(lease, original), final)
      const events = await trace(traceId), spawns = events.filter(item => item.event === 'spawn')
      assert.equal(spawns.length, 1); assert.equal(spawns[0].uid, 1000); assert.equal(spawns[0].tokenReadable, false)
      const saved = (await pool.query('SELECT result,observation,stop_evidence FROM pe_stdio_v2_results WHERE action_id=$1', [receipt.actionId])).rows[0]
      assert.deepEqual(saved.result, observed.view.outcome); assert.deepEqual(saved.observation, observed.view)
      assert.deepEqual(saved.stop_evidence, observed.stopEvidence)
      completed.push({ actionId: receipt.actionId, catalogId: final.catalogId, executionId: receipt.executionRef.executionId })
      // Preserve observations/catalogs, but retire the synthetic instance name before the next owner uses this same QA Runner.
      await pool.query("UPDATE pe_sandbox_instances SET name=$2,state='deleted' WHERE session_id=$1", [sessionId, `${name}-${username}`])
    }
    assert.equal(completed.length, 2); assert.notEqual(completed[0].catalogId, completed[1].catalogId)
    return completed
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}"`) } finally { await admin.end() }
  }
}
