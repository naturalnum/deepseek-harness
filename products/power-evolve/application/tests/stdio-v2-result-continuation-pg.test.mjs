/** Actual isolated PG result/continuation transactions; SDK and independent stop facts are synthetic, with no executor invocation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { StdioResultServiceV2 } from '../lib/platform/stdio-v2-results.js'
import { StdioCallContinuationV2 } from '../lib/platform/stdio-v2-continuations.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { stdioDispatchV2, stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const admission = { maxConnections: 10, maxTools: 20, maxSnapshotBytes: 524288, maxDescriptionBytes: 8192 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const maxReplyBytes = 524288, sha = (domain, value) => stdioSha256V2(domain, value, budget)
const rawCatalog = JSON.parse('[{"name":"echo","description":"synthetic","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"_meta":{"__proto__":{"raw":"目录\\u0000😀"}},"extension":{"10":10,"2":2}}]')
const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const image = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }

test('production result persistence atomically delivers the original call once or rolls back in real PG', { timeout: 60000 }, async t => {
  const databaseUrl = process.env.PE_TEST_DATABASE_URL
    ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
  const database = `pe_stdio_result_${randomBytes(10).toString('hex')}`
  const directory = await mkdtemp(join(tmpdir(), 'pe-stdio-result-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 10000 })
  let pool, created = false
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 2, statement_timeout: 10000 })
    await initializeDatabase(pool)
    const files = new FileService(pool, join(directory, 'workspaces')); await files.init()
    const userId = randomUUID(), discoverySessionId = randomUUID(), connectionId = randomUUID()
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [userId, `result-${randomUUID()}`, 'synthetic-no-login', {}])
    const workspaceId = await files.defaultWorkspaceId(userId), binding = await files.bindingForId(userId, workspaceId)
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [discoverySessionId, userId, workspaceId, randomUUID(), {}])
    const configuration = { name: 'Synthetic original', invocation: { program: 'node', argv: ['never-executed.mjs'], cwd: '.' } }
    const configDigest = sha('configuration', configuration)
    const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: binding.generation,
      target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
    await transaction(pool, async client => {
      await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision,enabled) VALUES($1,$2,1,false)', [connectionId, userId])
      await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,1,$3,$4)',
        [connectionId, userId, JSON.stringify(configuration), configDigest])
    })
    const continuation = new StdioCallContinuationV2({ limits, admission, maxReplyBytes })
    const service = new StdioResultServiceV2(pool, { limits, maxReplyBytes, continuation })
    const noContinuation = new StdioResultServiceV2(pool, { limits, maxReplyBytes })
    let groups

    async function accepted(phase, { isError = false } = {}) {
      const sessionId = phase === 'call' ? randomUUID() : discoverySessionId
      if (phase === 'call') await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, userId, workspaceId, randomUUID(), {}])
      const actionId = randomUUID(), executionId = randomUUID(), operationId = phase === 'call' ? randomUUID() : null
      const requestId = randomUUID(), continuationRequest = phase === 'call' ? randomUUID() : null, workerId = randomUUID()
      const executionRef = { kind: 'cloud', executionId }, lease = { actionId, workerId, leaseEpoch: 1 }
      const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, phase, actionId, userId, sessionId, connectionId,
        configRevision: 1, configDigest, scopeBinding: scope, expectedDeploymentPin: pin, invocation: configuration.invocation, limits,
        ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId } }
          : { origin: { kind: 'operation', operationId, rootOperationId: operationId, callKey: 'original-call' },
            selection: { catalogId: groups[0].catalogId, catalogDigest: groups[0].catalogDigest, rawCatalog,
              catalogImageExpectation: image, rawName: 'echo', rawDescriptor: rawCatalog[0], arguments: { text: 'original\0arguments' } } }) })
      const taskDigest = sha('task', task)
      const capture = { kind: 'cloud', podName: 'synthetic-owned', podUid: randomUUID(), namespace: 'synthetic', nodeName: 'synthetic',
        runnerInstanceId: randomUUID(), containerId: 'containerd://synthetic', restartCount: 0, mountGeneration: '1',
        workspaceMount: { claimName: 'synthetic', subPath: 'synthetic-workspace', mountPath: '/workspace', readOnly: false },
        homeMount: { claimName: 'synthetic', subPath: 'synthetic-home', mountPath: '/home/agent', readOnly: false } }
      const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef, taskDigest, scopeBinding: scope,
        expectedDeploymentPin: pin, actualExecutorImage: image, capture, specDigest: sha('spec', { synthetic: true }),
        fullScopeDigest: sha('scope', { scopeBinding: scope, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }) })
      const preparedDigest = sha('prepared', prepared), fingerprint = 'c'.repeat(64)
      const expiresAt = new Date(Date.now() + 120000).toISOString()
      const approval = { actionId, taskDigest, preparedDigest, approvalEpoch: 1, expiresAt }
      const permit = { ...approval, approvalFingerprint: fingerprint, permitId: randomUUID(), authorizationRequestId: randomUUID(),
        executionRef, executorOwner: { kind: 'cloud', runnerInstanceId: capture.runnerInstanceId }, issuedAt: new Date().toISOString() }
      const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest, executionRef, preparedDigest, permit })
      const dispatchDigest = sha('dispatch', dispatch)
      const facts = { programStartAttempted: true, toolsCallAttempted: phase === 'call', effectMayHaveOccurred: true,
        childPid: 12345, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
        protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
      const outcome = { state: 'completed', phase, catalog: rawCatalog, pages: [{ tools: rawCatalog, extension: 'page\0raw' }],
        initializeResult: { protocolVersion: 'synthetic', _meta: { raw: 'init\0raw' } }, facts,
        ...(phase === 'call' ? { result: { content: [{ type: 'text', text: 'complete\0result' }], isError,
          _meta: JSON.parse('{"__proto__":{"raw":true}}') } } : {}) }
      const view = { formatVersion: 2, instanceId: capture.runnerInstanceId, actionId, executionRef, taskDigest, dispatchDigest,
        state: 'completed', writerStopConfirmed: true, outcome }
      const stopEvidence = { formatVersion: 2, kind: 'cloud_uid_quiet', actionId, executionRef, taskDigest, dispatchDigest, preparedDigest,
        fullScopeDigest: prepared.fullScopeDigest, podUid: capture.podUid, runnerInstanceId: capture.runnerInstanceId,
        mountGeneration: capture.mountGeneration, observedAt: new Date().toISOString() }
      await transaction(pool, async client => {
        if (operationId) {
          await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,state)
            VALUES($1,$2,$3,'synthetic accepted call',$4,$5,'completed')`,
          [operationId, sessionId, requestId, { model: 'synthetic-no-model', maxTokens: 64, revision: 1 }, JSON.stringify(groups)])
          await client.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,calls,max_calls,expires_at)
            VALUES($1,$2,$3,1,5,$4)`, [operationId, userId, sessionId, expiresAt])
        } else await client.query(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
          VALUES($1,$2,'check','{}',$3,'{}')`, [userId, requestId, sha('management', {})])
        await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
          execution_target,execution_id,request_id,operation_id,root_operation_id,call_id,task,task_digest,state,
          continuation_request_id,lease_owner,lease_epoch,lease_until)
          VALUES($1,$2,$3,$4,1,$5,$6,'cloud',$7,$8,$9,$9,$10,$11,$12,'dispatch-intent',$13,$14,1,$15)`,
        [actionId, userId, sessionId, connectionId, configDigest, phase, executionId, phase === 'discover' ? requestId : null,
          operationId, phase === 'call' ? 'original-call' : null, JSON.stringify(task), taskDigest, continuationRequest, workerId, expiresAt])
        await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,request_digest,state,
          execution_kind,origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id,
          sandbox_name,pod_uid,runner_instance_id,lease_owner,lease_until)
          VALUES($1,$2,$3,$4,$5,$6,'starting','stdio_v2',$7,2,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [executionId, userId, sessionId, operationId, phase === 'call' ? 'original-call' : null, taskDigest,
          phase === 'call' ? 'operation' : 'stdio_discovery', phase, JSON.stringify(task), actionId, continuationRequest,
          capture.podName, capture.podUid, capture.runnerInstanceId, workerId, expiresAt])
        await client.query(`INSERT INTO pe_stdio_v2_preparations(action_id,user_id,session_id,phase,execution_target,execution_id,
          task_digest,prepared,prepared_digest,approval_binding,fingerprint,approval_epoch,expires_at)
          VALUES($1,$2,$3,$4,'cloud',$5,$6,$7,$8,$9,$10,1,$11)`,
        [actionId, userId, sessionId, phase, executionId, taskDigest, JSON.stringify(prepared), preparedDigest, JSON.stringify(approval), fingerprint, expiresAt])
        await client.query('INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,\'once\')', [actionId, userId, fingerprint])
        await client.query(`INSERT INTO pe_stdio_v2_start_permits(action_id,permit_id,authorization_request_id,execution_id,task_digest,
          prepared_digest,fingerprint,decision,executor_owner,permit,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'once',$8,$9,$10,$11)`,
        [actionId, permit.permitId, permit.authorizationRequestId, executionId, taskDigest, preparedDigest, fingerprint,
          JSON.stringify(permit.executorOwner), JSON.stringify(permit), permit.issuedAt, expiresAt])
        await client.query('INSERT INTO pe_stdio_v2_dispatches(action_id,dispatch,dispatch_digest) VALUES($1,$2,$3)',
          [actionId, JSON.stringify(dispatch), dispatchDigest])
      })
      return { lease, task, prepared, operationId, continuationRequest, executionId, observation: { view, stopEvidence } }
    }
    const rows = async (table, f) => (await pool.query(`SELECT * FROM ${table} WHERE action_id=$1`, [f.lease.actionId])).rows
    const continued = async f => (await pool.query('SELECT * FROM pe_operations WHERE source_stdio_v2_action_id=$1', [f.lease.actionId])).rows
    async function unchanged(f) {
      for (const table of ['pe_stdio_v2_results', 'pe_stdio_v2_observations']) assert.deepEqual(await rows(table, f), [])
      assert.deepEqual(await continued(f), [])
      const action = (await pool.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1', [f.lease.actionId])).rows[0]
      const execution = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [f.executionId])).rows[0]
      assert.equal(action.state, 'dispatch-intent'); assert.equal(action.continuation_queued, false)
      assert.equal(action.lease_owner, f.lease.workerId); assert.equal(execution.state, 'starting')
      assert.equal(execution.lease_owner, f.lease.workerId); assert(execution.lease_until)
    }

    await t.test('discovery remains compatible without a continuation and mints the complete original catalog', async () => {
      const f = await accepted('discover'), result = await noContinuation.record(f.lease, f.observation)
      assert.equal(result.state, 'succeeded'); assert.equal(result.finalized, true); assert(result.catalogId)
      const catalog = (await rows('pe_stdio_v2_catalogs', f))[0]
      assert.deepEqual(catalog.raw_catalog, rawCatalog); assert.equal(catalog.catalog_digest, stdioCatalogFingerprintV2(rawCatalog, limits))
      assert.deepEqual(await continued(f), [])
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations')).rows[0].n, 0)
      groups = compileStdioOperationToolsV2([{ formatVersion: 2, connectionId, configRevision: 1, configDigest,
        configuration, limits, scopeBinding: scope, expectedDeploymentPin: pin, catalogId: result.catalogId,
        catalogDigest: catalog.catalog_digest, rawCatalog: catalog.raw_catalog, catalogImageExpectation: catalog.image_expectation }], limits, admission, [])
    })
    await t.test('a final call without a continuation rolls back the result and both terminal states', async () => {
      const f = await accepted('call')
      await assert.rejects(noContinuation.record(f.lease, f.observation), { code: 'stdio_v2_continuation_unavailable' })
      await unchanged(f)
    })
    await t.test('two result services store one call outcome and one original continuation, including timestamp-only final replay', async () => {
      const f = await accepted('call'), other = new StdioResultServiceV2(pool, { limits, maxReplyBytes, continuation })
      const replies = await Promise.all([service.record(f.lease, f.observation), other.record(f.lease, f.observation)])
      assert.deepEqual(replies[0], replies[1]); assert.equal(replies[0].finalized, true); assert.equal(replies[0].catalogId, null)
      const first = await rows('pe_stdio_v2_results', f), original = (await continued(f))[0]
      assert.equal((await continued(f)).length, 1); assert.equal((await rows('pe_stdio_v2_observations', f)).length, 1)
      assert.deepEqual(first[0].result, f.observation.view.outcome)
      assert.equal(Object.hasOwn(first[0].result.result._meta, '__proto__'), true)
      const body = JSON.parse(original.input); assert.deepEqual(body.outcome, f.observation.view.outcome)
      assert.equal(original.request_id, f.continuationRequest); assert.equal(original.mcp_root_operation_id, f.operationId)
      assert.equal(original.source, 'stdio_v2_result'); assert.equal(original.source_stdio_v2_phase, 'call')
      assert.deepEqual(original.stdio_v2_selection, groups); assert.equal(original.state, 'queued')
      const action = (await pool.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1', [f.lease.actionId])).rows[0]
      const execution = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [f.executionId])).rows[0]
      assert.equal(action.continuation_queued, true); assert.equal(action.lease_owner, f.lease.workerId)
      assert.equal(execution.state, 'succeeded'); assert.equal(execution.lease_owner, null); assert.equal(execution.lease_until, null)
      const replay = structuredClone(f.observation); replay.stopEvidence.observedAt = new Date(Date.now() + 1000).toISOString()
      await service.record(f.lease, replay)
      assert.deepEqual(await rows('pe_stdio_v2_results', f), first); assert.deepEqual(await continued(f), [original])
      await assert.rejects(noContinuation.record(f.lease, replay), { code: 'stdio_v2_continuation_unavailable' })
      assert.deepEqual(await continued(f), [original])
    })
    await t.test('unknown call facts cannot create a result or queue a continuation even with attached stop data', async () => {
      const f = await accepted('call'), unknown = structuredClone(f.observation)
      unknown.view.state = 'unknown'; unknown.view.writerStopConfirmed = false
      unknown.view.outcome = { state: 'failed', errorCode: 'stdio_v2_cleanup_unconfirmed', facts: unknown.view.outcome.facts }
      const result = await service.record(f.lease, unknown)
      assert.equal(result.finalized, false); assert.equal(result.state, 'blocked')
      assert.deepEqual(await rows('pe_stdio_v2_results', f), []); assert.deepEqual(await continued(f), [])
      assert.equal((await pool.query('SELECT state,lease_owner FROM pe_cloud_executions WHERE id=$1', [f.executionId])).rows[0].lease_owner, f.lease.workerId)
    })
    await t.test('failure after the real leaf inserts a continuation rolls back result, observations, chain stop and writer retirement', async () => {
      const f = await accepted('call', { isError: true })
      await pool.query(`CREATE FUNCTION reject_continuation_mark() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.continuation_queued AND NOT OLD.continuation_queued THEN RAISE EXCEPTION 'synthetic mark failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_continuation_mark BEFORE UPDATE ON pe_stdio_v2_actions FOR EACH ROW EXECUTE FUNCTION reject_continuation_mark();`)
      try { await assert.rejects(service.record(f.lease, f.observation), /synthetic mark failure/u) }
      finally { await pool.query('DROP TRIGGER reject_continuation_mark ON pe_stdio_v2_actions') }
      await unchanged(f)
      assert.equal((await pool.query('SELECT stopped_at FROM pe_mcp_action_chains WHERE root_operation_id=$1', [f.operationId])).rows[0].stopped_at, null)
      assert.equal((await service.record(f.lease, f.observation)).state, 'succeeded')
      assert.equal((await continued(f)).length, 1)
      const body = JSON.parse((await continued(f))[0].input)
      assert.deepEqual(body.outcome, f.observation.view.outcome); assert.equal(body.errorCode, 'stdio_v2_tool_error'); assert.equal(body.chainStopped, true)
      await service.record(f.lease, f.observation); assert.equal((await continued(f)).length, 1)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }) }
  }
})
