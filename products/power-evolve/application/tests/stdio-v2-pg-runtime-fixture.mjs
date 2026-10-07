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
import { StdioCloudRunTransportV2 } from '../lib/platform/stdio-v2-cloud-runtime.js'
import { StdioResultServiceV2 } from '../lib/platform/stdio-v2-results.js'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
import { StdioCloudWorkerV2 } from '../lib/platform/stdio-v2-cloud-worker.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

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
    const store = new StdioCloudWorkerStoreV2(pool, { limits, leaseMs: 30000, maxActive: 4, maxCandidates: 10 })
    const results = new StdioResultServiceV2(pool, { limits, maxReplyBytes: 131072 })
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
      const headers = { 'content-type': 'application/json', 'x-power-evolve-runner-token': token }
      const current = async () => {
        const actual = await inspect(), health = await (await fetch('http://127.0.0.1:8080/health', { headers })).json()
        assert.equal(actual.Id, containerId); assert.equal(actual.Image, imageId); assert.equal(actual.State.Running, true)
        assert.equal(health.instanceId, instanceId); assert.equal(health.ready, true)
      }
      let creations = 0, posts = 0, repliesLost = 0, dropReply = username === 'pg-runtime-bob'
      const ready = { name, podUid, runnerInstanceId: instanceId, token, restartCount: 0, generation: '1', sessionId, userId, binding }
      const manager = {
        async ensureReady(session, owner, assertLease) {
          assert.deepEqual([session, owner], [sessionId, userId]); await assertLease(); await current(); creations++
          // Provisioning is substituted by the same real Docker Runner and trusted fixture slot.
          return ready
        },
        async cancelCreation() { throw new Error('Normal discovery must not use creation cancellation') },
        async observeReady(session, owner, pod, runner, client, mode) {
          assert.deepEqual([session, owner, pod, runner], [sessionId, userId, podUid, instanceId])
          assert.ok(client); await current()
          if (mode === 'dispatch') assert.equal((await client.query('SELECT enabled FROM pe_users WHERE id=$1', [userId])).rows[0].enabled, true)
          return ready
        },
        async captureStdioV2() { await current(); return { capture: captured,
          actualExecutorImage: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
          spec: { syntheticPod: true, actualContainerId: containerId, actualConfigImageId: imageId } } },
        async runnerBounded(_name, credential, method, path, body) {
          assert.equal(credential, token)
          // These real NOWAIT locks would fail if the execution HTTP retained its capture transaction.
          await transaction(pool, async client => {
            for (const [table, id] of [['pe_users', userId], ['pe_sessions', sessionId],
              ['pe_stdio_v2_connections', connection.connectionId], ['pe_stdio_v2_actions', receipt.actionId],
              ['pe_cloud_executions', receipt.executionRef.executionId]]) {
              assert.equal((await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`, [id])).rowCount, 1)
            }
          })
          if (method === 'POST' && path === '/stdio/v2/executions') posts++
          const response = await fetch(`http://127.0.0.1:8080${path}`, { method, headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
          if (!response.ok) throw new KubernetesError(response.status, 'controlled_runtime_response')
          const received = await response.json()
          if (dropReply && method === 'POST' && path === '/stdio/v2/executions') {
            dropReply = false; repliesLost++; throw new KubernetesError(502, 'controlled_runtime_reply_lost')
          }
          return received
        },
      }
      const adapter = new StdioCloudPreparationV2(manager), approvalKey = randomBytes(32)
      const auth = new StdioAuthorizationServiceV2(pool, { limits, approvalKey, approvalLifetimeMs: 60000,
        capture: (client, task, ref) => adapter.capture(client, task, ref) })
      const workerOptions = { workerId: randomUUID(), pollMs: 20, renewMs: 10000, leaseMs: 30000 }
      const transportOptions = { limits, maxReplyBytes: 131072, requestTimeoutMs: 3000, maxTrackedActions: 10 }
      const makeWorker = (options = workerOptions) => new StdioCloudWorkerV2(store, auth, manager,
        new StdioCloudRunTransportV2(manager, transportOptions), results, options)
      const firstLease = await store.claimNext(workerOptions.workerId)
      assert.equal(firstLease.actionId, receipt.actionId)
      assert.equal(await makeWorker().step(firstLease, new AbortController().signal), 'pending')
      assert.equal(creations, 1); assert.equal(posts, 0)
      assert.equal((await fetch(`http://127.0.0.1:8080/stdio/v2/executions/${receipt.actionId}`, { headers })).status, 404)
      const prepared = await auth.inspect(approval.token, receipt.actionId)
      await auth.decide(approval.token, { actionId: receipt.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
      const nextLease = await store.claimNext(workerOptions.workerId)
      assert.equal(nextLease.actionId, receipt.actionId); assert(nextLease.leaseEpoch > firstLease.leaseEpoch)
      let category = await makeWorker().step(nextLease, new AbortController().signal)
      if (username === 'pg-runtime-bob') assert.equal(category, 'deferred')
      const deadline = Date.now() + 10000
      const coldOptions = { ...workerOptions, workerId: randomUUID() }
      const cold = makeWorker(coldOptions)
      while (category !== 'finalized' && Date.now() < deadline) {
        const recoveredLease = await store.claimNext(coldOptions.workerId)
        assert.equal(recoveredLease.actionId, receipt.actionId)
        category = await cold.step(recoveredLease, new AbortController().signal)
      }
      assert.equal(category, 'finalized'); assert.equal(creations, 1); assert.equal(posts, 1)
      assert.equal(repliesLost, username === 'pg-runtime-bob' ? 1 : 0)
      const archived = (await pool.query('SELECT result,observation,stop_evidence FROM pe_stdio_v2_results WHERE action_id=$1', [receipt.actionId])).rows[0]
      assert.equal(archived.observation.state, 'completed'); assert.ok(archived.stop_evidence)
      assert.deepEqual(archived.result.catalog, catalog)
      const final = (await pool.query('SELECT id FROM pe_stdio_v2_catalogs WHERE action_id=$1', [receipt.actionId])).rows
      assert.equal(final.length, 1)
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1', [receipt.actionId])).rows[0].n, 1)
      assert.equal(await store.claimNext(coldOptions.workerId), null)
      const events = await trace(traceId), spawns = events.filter(item => item.event === 'spawn')
      assert.equal(spawns.length, 1); assert.equal(spawns[0].uid, 1000); assert.equal(spawns[0].tokenReadable, false)
      const saved = (await pool.query('SELECT result,observation,stop_evidence FROM pe_stdio_v2_results WHERE action_id=$1', [receipt.actionId])).rows[0]
      assert.deepEqual(saved.result, archived.result); assert.deepEqual(saved.observation, archived.observation)
      assert.deepEqual(saved.stop_evidence, archived.stop_evidence)
      completed.push({ actionId: receipt.actionId, catalogId: final[0].id, executionId: receipt.executionRef.executionId,
        creates: creations, startPosts: posts, lostReplies: repliesLost })
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
