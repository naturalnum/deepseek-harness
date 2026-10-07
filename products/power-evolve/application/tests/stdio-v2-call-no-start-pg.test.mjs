/** Real isolated PG/POSIX closure transactions; discovery catalogs are seeded substitutes, with no Runner, SDK, Kube or model invocation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
import { StdioCloudWorkerV2 } from '../lib/platform/stdio-v2-cloud-worker.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { StdioCallContinuationV2 } from '../lib/platform/stdio-v2-continuations.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 524288, maxDescriptionBytes: 8192 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const image = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
const rawCatalog = JSON.parse('[{"name":"echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},"_meta":{"__proto__":{"retained":true}}}]')
const code = expected => error => error.code === expected

test('production call no-start closure and its unique continuation commit or roll back together in PG',
  { timeout: 60000, skip: !process.env.PE_TEST_DATABASE_URL && !process.env.PE_PRIVATE_DIR }, async t => {
    const databaseUrl = process.env.PE_TEST_DATABASE_URL
      ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
    const database = `pe_stdio_call_no_start_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-stdio-call-no-start-'))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 }); let pool, created = false, serial = 0
    try {
      await admin.query(`CREATE DATABASE "${database}"`); created = true
      const url = new URL(databaseUrl); url.pathname = `/${database}`
      pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 })
      await initializeDatabase(pool)
      const files = new FileService(pool, join(root, 'workspaces')); await files.init()
      const leaf = new StdioCallContinuationV2({ limits, admission, maxReplyBytes: 524288 })
      const options = { limits, leaseMs: 30000, maxActive: 16, maxCandidates: 32 }
      const store = new StdioCloudWorkerStoreV2(pool, { ...options, continuation: leaf })
      const leases = new StdioActionLeaseServiceV2(pool, { leaseMs: options.leaseMs })

      async function fresh(phase = 'call', { defer = true } = {}) {
        const userId = randomUUID(), sessionId = randomUUID(), connectionId = randomUUID(), catalogId = randomUUID()
        await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
          [userId, `call-no-start-${++serial}`, 'synthetic-no-login', {}])
        const workspaceId = await files.defaultWorkspaceId(userId), binding = await files.bindingForId(userId, workspaceId)
        await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
          [sessionId, userId, workspaceId, randomUUID(), {}])
        const configuration = { name: 'Synthetic', invocation: { program: 'node', argv: ['not-executed.mjs'], cwd: '.' } }
        const configDigest = sha('configuration', configuration), scopeBinding = { kind: 'cloud', userId, workspaceId,
          bindingGeneration: binding.generation, target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
        const discoverId = randomUUID(), discoverExec = randomUUID(), discoverRequest = randomUUID()
        const discover = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId: discoverId, userId, sessionId,
          connectionId, configRevision: 1, configDigest, phase: 'discover', limits, invocation: configuration.invocation,
          scopeBinding, expectedDeploymentPin: pin, origin: { kind: 'stdio_discovery', requestId: discoverRequest } })
        const groups = compileStdioOperationToolsV2([{ formatVersion: 2, connectionId, configRevision: 1, configDigest,
          configuration, limits, scopeBinding, expectedDeploymentPin: pin, catalogId, rawCatalog,
          catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), catalogImageExpectation: image }], limits, admission, [])
        const operationId = randomUUID(), actionId = randomUUID(), executionId = randomUUID(), requestId = randomUUID()
        const continuationId = phase === 'call' ? randomUUID() : null
        const task = stdioTaskSchemasV2(limits).task.parse({ ...discover, actionId, phase,
          ...(phase === 'call' ? { origin: { kind: 'operation', operationId, rootOperationId: operationId, callKey: 'original-call' },
            selection: { catalogId, catalogDigest: groups[0].catalogDigest, rawCatalog, catalogImageExpectation: image,
              rawName: 'echo', rawDescriptor: rawCatalog[0], arguments: { text: 'original\0arguments' } } }
            : { origin: { kind: 'stdio_discovery', requestId } }) })
        const taskDigest = sha('task', task)
        await transaction(pool, async client => {
          await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision,enabled) VALUES($1,$2,1,true)', [connectionId, userId])
          await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,1,$3,$4)',
            [connectionId, userId, JSON.stringify(configuration), configDigest])
          await client.query(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
            VALUES($1,$2,'check','{}',$3,'{}')`, [userId, discoverRequest, sha('management', {})])
          await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
            execution_target,execution_id,request_id,task,task_digest,state) VALUES($1,$2,$3,$4,1,$5,'discover','cloud',$6,$7,$8,$9,'succeeded')`,
          [discoverId, userId, sessionId, connectionId, configDigest, discoverExec, discoverRequest, JSON.stringify(discover), sha('task', discover)])
          await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,request_digest,state,execution_kind,origin_kind,task_version,
            stdio_phase,stdio_task,stdio_action_id,continuation_request_id) VALUES($1,$2,$3,$4,'succeeded','stdio_v2','stdio_discovery',2,'discover',$5,$6,NULL)`,
          [discoverExec, userId, sessionId, sha('task', discover), JSON.stringify(discover), discoverId])
          // Only a catalog-producer substitute; these bytes are not actual SDK output or stop evidence.
          const seeded = { syntheticCatalogProducer: true }
          await client.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$2,$2)',
            [discoverId, JSON.stringify(seeded), sha('result', seeded)])
          await client.query(`INSERT INTO pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision,config_digest,action_id,session_id,phase,
            raw_catalog,image_expectation,catalog_digest) VALUES($1,$2,$3,1,$4,$5,$6,'discover',$7,$8,$9)`,
          [catalogId, userId, connectionId, configDigest, discoverId, sessionId, JSON.stringify(rawCatalog), JSON.stringify(image), groups[0].catalogDigest])
          await client.query('UPDATE pe_stdio_v2_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
          if (phase === 'call') {
            await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,state)
              VALUES($1,$2,$3,'synthetic original user input',$4,$5,'completed')`,
            [operationId, sessionId, requestId, { model: 'synthetic', maxTokens: 64, revision: 1 }, JSON.stringify(groups)])
            await client.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,calls,max_calls,expires_at)
              VALUES($1,$2,$3,1,5,clock_timestamp()+interval '1 minute')`, [operationId, userId, sessionId])
          } else {
            await client.query(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
              VALUES($1,$2,'check','{}',$3,'{}')`, [userId, requestId, sha('management', {})])
          }
          await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
            execution_target,execution_id,request_id,operation_id,root_operation_id,call_id,task,task_digest,state,continuation_request_id)
            VALUES($1,$2,$3,$4,1,$5,$6,'cloud',$7,$8,$9,$9,$10,$11,$12,'queued',$13)`,
          [actionId, userId, sessionId, connectionId, configDigest, phase, executionId, phase === 'call' ? null : requestId,
            phase === 'call' ? operationId : null, phase === 'call' ? 'original-call' : null, JSON.stringify(task), taskDigest, continuationId])
          await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,request_digest,state,
            execution_kind,origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id)
            VALUES($1,$2,$3,$4,$5,$6,'queued','stdio_v2',$7,2,$8,$9,$10,$11)`,
          [executionId, userId, sessionId, phase === 'call' ? operationId : null, phase === 'call' ? 'original-call' : null,
            taskDigest, phase === 'call' ? 'operation' : 'stdio_discovery', phase, JSON.stringify(task), actionId, continuationId])
        })
        const lease = await leases.claim(actionId, randomUUID()); assert(lease)
        if (defer) await store.defer(lease, 'stdio_v2_cancel_requested')
        return { userId, sessionId, workspaceId, binding, connectionId, operationId, actionId, executionId, continuationId, task, groups, lease }
      }
      async function pending(f) {
        await store.beginPreparation(f.lease)
        const writer = { name: `synthetic-${randomUUID()}`, podUid: randomUUID(), runnerInstanceId: randomUUID(), token: 'synthetic',
          restartCount: 0, generation: '1', userId: f.userId, sessionId: f.sessionId, binding: f.binding }
        await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
          VALUES($1,$2,$3,1,'ready',$4,$5,$6)`, [f.userId, f.sessionId, f.workspaceId, writer.podUid, writer.runnerInstanceId, f.binding])
        await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
          VALUES($1,$2,$3,'ready',$4,$5,$6)`, [f.sessionId, f.userId, writer.name, writer.podUid, writer.runnerInstanceId, f.binding])
        await store.attach(f.lease, writer)
        const capture = { kind: 'cloud', podUid: writer.podUid, podName: writer.name, namespace: 'synthetic', nodeName: 'synthetic',
          runnerInstanceId: writer.runnerInstanceId, containerId: 'containerd://synthetic', restartCount: 0, mountGeneration: '1',
          workspaceMount: { claimName: 'synthetic', subPath: `workspaces/${f.binding.rootKey}`, mountPath: '/workspace', readOnly: false },
          homeMount: { claimName: 'synthetic', subPath: `homes/${f.userId}`, mountPath: '/home/agent', readOnly: false } }
        const authorization = new StdioAuthorizationServiceV2(pool, { limits, approvalKey: randomBytes(32), approvalLifetimeMs: 60000,
          async capture(_client, task, executionRef) {
            return stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task),
              scopeBinding: task.scopeBinding, expectedDeploymentPin: pin, actualExecutorImage: image, capture,
              fullScopeDigest: sha('scope', { scopeBinding: task.scopeBinding, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }),
              specDigest: sha('spec', { syntheticPod: true }) })
          } })
        const prepared = await authorization.prepareLeased(f.lease)
        return { writer, authorization, prepared }
      }
      const workerWithoutExecutor = (selectedStore, lease) => {
        const forbidden = async () => { throw new Error('Executor work is forbidden in this test') }
        return new StdioCloudWorkerV2(selectedStore, { prepareLeased: forbidden, authorizeLeased: forbidden },
          { ensureReady: forbidden, cancelCreation: forbidden }, { startDetached: forbidden, observeDetached: forbidden, cancelDetached: forbidden },
          { record: forbidden }, { workerId: lease.workerId, pollMs: 10, renewMs: 5000, leaseMs: 30000 })
      }
      const continued = async f => (await pool.query('SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2', [f.sessionId, f.continuationId])).rows
      async function counts(f) {
        return (await pool.query(`SELECT (SELECT count(*)::int FROM pe_stdio_v2_no_start_closures WHERE action_id=$1) AS closures,
          (SELECT count(*)::int FROM pe_stdio_v2_results WHERE action_id=$1) AS results,
          (SELECT count(*)::int FROM pe_stdio_v2_start_permits WHERE action_id=$1) AS permits,
          (SELECT count(*)::int FROM pe_stdio_v2_dispatches WHERE action_id=$1) AS dispatches`, [f.actionId])).rows[0]
      }
      const none = { closures: 0, results: 0, permits: 0, dispatches: 0 }
      async function snapshot(f) {
        const rows = await Promise.all([['pe_stdio_v2_actions', 'id', f.actionId], ['pe_cloud_executions', 'id', f.executionId],
          ['pe_mcp_action_chains', 'root_operation_id', f.operationId], ['pe_operations', 'session_id', f.sessionId],
          ['pe_stdio_v2_no_start_closures', 'action_id', f.actionId]].map(async ([table, key, id]) =>
          (await pool.query(`SELECT row_to_json(saved)::text AS literal FROM ${table} saved WHERE ${key}=$1 ORDER BY 1`, [id])).rows))
        return rows
      }

      for (const reason of ['root-cancelled', 'chain-expired', 'chain-stopped']) await t.test(`${reason} closes the original unallocated call without a writer or actual result`, async () => {
        const f = await fresh('call', { defer: false }); await store.release(f.lease)
        if (reason === 'root-cancelled') await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1', [f.operationId])
        else await pool.query(`UPDATE pe_mcp_action_chains SET ${reason === 'chain-expired' ? "expires_at=clock_timestamp()-interval '1 second'" : 'stopped_at=clock_timestamp()'} WHERE root_operation_id=$1`, [f.operationId])
        const before = (await pool.query('SELECT calls,max_calls,expires_at FROM pe_mcp_action_chains WHERE root_operation_id=$1', [f.operationId])).rows[0]
        const lease = await store.claimNext(randomUUID()); assert.equal(lease.actionId, f.actionId)
        assert.equal((await store.snapshot(lease)).cancelRequested, true)
        await assert.rejects(store.beginPreparation(lease), code('stdio_v2_action_not_startable'))
        for (const mode of ['acquire', 'mutation']) await assert.rejects(transaction(pool, client =>
          store.assertProvisioning(client, lease, f.sessionId, f.userId, mode)), code('stdio_v2_action_not_startable'))
        const worker = workerWithoutExecutor(store, lease)
        assert.equal(await worker.step(lease, new AbortController().signal), 'finalized'); await worker.stop()
        assert.equal((await store.readNoStart(f.actionId)).resource.kind, 'unallocated')
        assert.deepEqual(await counts(f), { ...none, closures: 1 })
        const reports = await continued(f)
        assert.equal(reports.length, reason === 'root-cancelled' ? 0 : 1)
        if (reports.length) assert.equal(JSON.parse(reports[0].input).chainStopped, true)
        assert.deepEqual((await pool.query('SELECT calls,max_calls,expires_at FROM pe_mcp_action_chains WHERE root_operation_id=$1', [f.operationId])).rows[0], before)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances WHERE user_id=$1', [f.userId])).rows[0].n, 0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].n, 0)
      })
      await t.test('pending call root markers and chain stop are claimed before original unexpired approval; original ready fixture is retained', async () => {
        for (const reason of ['root-cancelled', 'chain-stopped', 'chain-expired']) {
          const f = await fresh('call', { defer: false }), prepared = await pending(f)
          await store.release(f.lease); assert.equal(await store.claimNext(randomUUID()), null)
          if (reason === 'root-cancelled') await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1', [f.operationId])
          else await pool.query(`UPDATE pe_mcp_action_chains SET ${reason === 'chain-expired' ? "expires_at=clock_timestamp()-interval '1 second'" : 'stopped_at=clock_timestamp()'} WHERE root_operation_id=$1`, [f.operationId])
          const lease = await store.claimNext(randomUUID()); assert.equal(lease.actionId, f.actionId)
          const selected = await store.snapshot(lease)
          assert.equal(selected.cancelRequested, true); assert.equal(selected.prepared.expiresAt, prepared.prepared.expiresAt)
          assert(Date.parse(selected.prepared.expiresAt) > Date.now())
          const worker = workerWithoutExecutor(store, lease)
          assert.equal(await worker.step(lease, new AbortController().signal), 'finalized'); await worker.stop()
          const receipt = await store.readNoStart(f.actionId)
          assert.equal(receipt.resource.kind, 'ready_retained'); assert.equal(receipt.resource.podUid, prepared.writer.podUid)
          assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].state, 'ready')
          assert.deepEqual(await counts(f), { ...none, closures: 1 })
        }
      })

      await t.test('concurrent call closure and duplicate invoke the real leaf and retain one original source without a Runner result', async () => {
        const f = await fresh(); let invoked = 0
        const hooked = new StdioCloudWorkerStoreV2(pool, { ...options, continuation: { async enqueueLeased(client, lease) {
          invoked++; assert.equal((await client.query('SELECT state FROM pe_cloud_executions WHERE id=$1', [f.executionId])).rows[0].state, 'cancelled')
          assert.equal((await client.query('SELECT phase FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [f.actionId])).rows[0].phase, 'call')
          return leaf.enqueueLeased(client, lease)
        } } })
        const receipts = await Promise.all([hooked.closeUnstarted(f.lease), hooked.closeUnstarted(f.lease)])
        assert.deepEqual(receipts[0], receipts[1]); assert.equal(invoked, 2)
        assert.equal(receipts[0].resource.kind, 'unallocated'); assert.equal(receipts[0].phase, 'call')
        assert.equal(receipts[0].taskDigest, sha('task', f.task)); assert.equal(receipts[0].startNeverAuthorized, true)
        const saved = await continued(f); assert.equal(saved.length, 1)
        assert.equal(saved[0].source, 'stdio_v2_no_start'); assert.equal(saved[0].source_stdio_v2_no_start_action_id, f.actionId)
        assert.equal(saved[0].source_stdio_v2_action_id, null); assert.equal(saved[0].mcp_root_operation_id, f.operationId)
        assert.deepEqual(saved[0].stdio_v2_selection, f.groups)
        const body = JSON.parse(saved[0].input)
        assert.equal(body.kind, 'stdio_v2_no_start'); assert.equal(body.chainStopped, true)
        assert.equal(Object.hasOwn(body, 'outcome'), false); assert.equal(Object.hasOwn(body, 'writerStopConfirmed'), false)
        const before = await snapshot(f); await hooked.closeUnstarted(f.lease)
        assert.equal(invoked, 3); assert.deepEqual(await snapshot(f), before)
        assert.deepEqual(await counts(f), { ...none, closures: 1 })
        assert.deepEqual(await store.readNoStart(f.actionId), receipts[0])
      })
      await t.test('absent continuation refuses call closure before any mutation; discovery never invokes the configured leaf', async () => {
        const f = await fresh(), unavailable = new StdioCloudWorkerStoreV2(pool, options), before = await snapshot(f)
        await assert.rejects(unavailable.closeUnstarted(f.lease), code('stdio_v2_no_start_call_unavailable'))
        assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), none)
        const discover = await fresh('discover'), receipt = await store.closeUnstarted(discover.lease)
        assert.equal(receipt.phase, 'discover'); assert.equal(receipt.resource.kind, 'unallocated')
        assert.deepEqual(await counts(discover), { ...none, closures: 1 })
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations WHERE session_id=$1', [discover.sessionId])).rows[0].n, 0)
      })
      await t.test('an actual continuation INSERT error rolls back the closure, both terminal writes, chain stop and queue marker', async () => {
        const f = await fresh(), before = await snapshot(f)
        await pool.query(`CREATE FUNCTION reject_call_no_start() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.source='stdio_v2_no_start' THEN RAISE EXCEPTION 'synthetic continuation insertion failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER reject_call_no_start BEFORE INSERT ON pe_operations FOR EACH ROW EXECUTE FUNCTION reject_call_no_start();`)
        try { await assert.rejects(store.closeUnstarted(f.lease), { code: 'P0001' }) }
        finally { await pool.query('DROP TRIGGER reject_call_no_start ON pe_operations; DROP FUNCTION reject_call_no_start()') }
        assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), none)
        await store.closeUnstarted(f.lease); assert.equal((await continued(f)).length, 1)
      })
      for (const timing of ['before', 'after']) await t.test(`the real database clock fences expiry ${timing} continuation and rolls back all changes`, async () => {
        const f = await fresh()
        await pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.actionId])
        await pool.query('UPDATE pe_cloud_executions SET lease_until=(SELECT lease_until FROM pe_stdio_v2_actions WHERE id=$1) WHERE id=$2', [f.actionId, f.executionId])
        let invoked = false
        const before = await snapshot(f), expiring = new StdioCloudWorkerStoreV2(pool, { ...options, continuation: {
          async enqueueLeased(client, lease) {
            invoked = true
            if (timing === 'before') await client.query('SELECT pg_sleep(1.1)')
            const reply = await leaf.enqueueLeased(client, lease)
            if (timing === 'after') await client.query('SELECT pg_sleep(1.1)')
            return reply
          } } })
        await assert.rejects(expiring.closeUnstarted(f.lease), code('stdio_v2_lease_lost'))
        assert.equal(invoked, true, 'expiry is observed at the continuation stage, rather than an earlier fixture read')
        assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), none)
      })
      await t.test('a duplicate with expired action lease cannot repair or modify the committed original continuation', async () => {
        const f = await fresh(); await store.closeUnstarted(f.lease)
        await pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.actionId])
        const before = await snapshot(f)
        await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_lease_lost'))
        assert.deepEqual(await snapshot(f), before); assert.equal((await continued(f)).length, 1)
        assert.equal((await store.readNoStart(f.actionId)).phase, 'call')
      })
      await t.test('the actual worker recovers a committed call acknowledgement by reading once without executor or result work', async () => {
        const f = await fresh(); let closes = 0, reads = 0
        const uncertain = new Proxy(store, { get(target, property) {
          if (property === 'closeUnstarted') return async lease => { closes++; await target.closeUnstarted(lease); throw new Error('synthetic_lost_commit_ack') }
          if (property === 'readNoStart') return async id => { reads++; return target.readNoStart(id) }
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
        } })
        const forbidden = async () => { throw new Error('Executor work is forbidden in this test') }
        const worker = new StdioCloudWorkerV2(uncertain, { prepareLeased: forbidden, authorizeLeased: forbidden },
          { ensureReady: forbidden, cancelCreation: forbidden }, { startDetached: forbidden, observeDetached: forbidden, cancelDetached: forbidden },
          { record: forbidden }, { workerId: f.lease.workerId, pollMs: 10, renewMs: 5000, leaseMs: 30000 })
        assert.equal(await worker.step(f.lease, new AbortController().signal), 'finalized'); await worker.stop()
        assert.equal(closes, 1); assert.equal(reads, 1); assert.equal((await continued(f)).length, 1)
        assert.deepEqual(await counts(f), { ...none, closures: 1 })
        assert.equal((await pool.query('SELECT lease_owner FROM pe_stdio_v2_actions WHERE id=$1', [f.actionId])).rows[0].lease_owner, null)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].n, 0)
      })
      await t.test('a committed dispatch stays bound to the original writer after root cancellation; only observe capture remains allowed', async () => {
        const f = await fresh('call', { defer: false }), selected = await pending(f)
        // The decision and Pod observations are explicit substitutes; permission persistence is real PG, with no Runner start.
        await pool.query("INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,'once')",
          [f.actionId, f.userId, selected.prepared.fingerprint])
        await pool.query("UPDATE pe_stdio_v2_actions SET state='approved' WHERE id=$1", [f.actionId])
        const granted = await selected.authorization.authorizeLeased(f.lease, randomUUID(),
          { kind: 'cloud', runnerInstanceId: selected.writer.runnerInstanceId })
        assert.equal(granted.grantOnce, true)
        const before = await store.snapshot(f.lease); assert(before.dispatch)
        await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1', [f.operationId])
        const cancelled = await store.snapshot(f.lease)
        assert.equal(cancelled.cancelRequested, true); assert.deepEqual(cancelled.dispatch, before.dispatch); assert.deepEqual(cancelled.writer, before.writer)
        await assert.rejects(store.capture(f.lease, 'dispatch', async () => { assert.fail('fresh dispatch callback ran') }), code('stdio_v2_action_not_startable'))
        let observed = 0
        assert.deepEqual(await store.capture(f.lease, 'observe', async () => { observed++; return selected.writer }), selected.writer)
        assert.equal(observed, 1)
        await assert.rejects(store.closeUnstarted(f.lease), code('stdio_v2_start_already_authorized'))
        assert.deepEqual(await counts(f), { ...none, permits: 1, dispatches: 1 })
        assert.deepEqual((await store.snapshot(f.lease)).writer, before.writer)
        assert.equal((await pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1', [f.userId])).rows[0].state, 'ready')
        await store.release(f.lease)
      })
    } finally {
      await pool?.end()
      try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
      finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
    }
  })
