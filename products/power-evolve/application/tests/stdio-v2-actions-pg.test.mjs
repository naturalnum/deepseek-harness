/** Real isolated PG/browser authority/action services; all Runner, SDK, Prepared and stop facts below are synthetic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { stdioPreparedV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { FileService } from '../lib/platform/files.js'
import { StdioConnectionServiceV2 } from '../lib/platform/stdio-v2-connections.js'
import { StdioAdmissionServiceV2 } from '../lib/platform/stdio-v2-admission.js'
import { StdioAuthorizationServiceV2 } from '../lib/platform/stdio-v2-authorization.js'
import { StdioActionServiceV2 } from '../lib/platform/stdio-v2-actions.js'
import { StdioActionLeaseServiceV2 } from '../lib/platform/stdio-v2-leases.js'
import { StdioCloudWorkerStoreV2 } from '../lib/platform/stdio-v2-worker-store.js'
import { StdioResultServiceV2 } from '../lib/platform/stdio-v2-results.js'
import { StdioOperationAdmissionV2 } from '../lib/platform/stdio-v2-operation-admission.js'
import { StdioCallAdmissionV2 } from '../lib/platform/stdio-v2-call-admission.js'
import { StdioCallContinuationV2 } from '../lib/platform/stdio-v2-continuations.js'
import { TaskStore } from '../lib/platform/tasks.js'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const management = { maxNameBytes: 100, pageItems: 20, maxConnections: 100 }
const options = { limits, maxReplyBytes: 524288, maxPageSize: 20 }
const operationAdmission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 524288, maxDescriptionBytes: 8192 }
const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const image = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
const facts = { programStartAttempted: true, toolsCallAttempted: false, effectMayHaveOccurred: false,
  childPid: 123, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
  protocolBytes: 400, protocolMessages: 3, stderrBytes: 0, stderr: '' }
const raw = JSON.parse('[{"name":"echo","inputSchema":{"type":"object"},"_meta":{"__proto__":{"original":true}}}]')
const code = expected => error => error.code === expected

test('production Cloud action reads, independent approval candidates and flag cancellation on isolated PG',
  { timeout: 90000, skip: !process.env.PE_TEST_DATABASE_URL && !process.env.PE_PRIVATE_DIR }, async t => {
    const databaseUrl = process.env.PE_TEST_DATABASE_URL
      ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
    const database = `pe_stdio_actions_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-stdio-actions-'))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
    let pool, created = false, serial = 0
    try {
      await admin.query(`CREATE DATABASE "${database}"`); created = true
      const url = new URL(databaseUrl); url.pathname = `/${database}`
      pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 })
      await initializeDatabase(pool)
      const files = new FileService(pool, join(root, 'workspaces')); await files.init()
      const identities = new IdentityService(pool, 600000)
      const connections = new StdioConnectionServiceV2(pool, limits, management)
      const admission = new StdioAdmissionServiceV2(pool, files,
        { limits, management, maxPendingPerUser: 100, deployments: { cloud: pin, desktop: [] } })
      const actions = new StdioActionServiceV2(pool, options)
      const store = new StdioCloudWorkerStoreV2(pool, { limits, leaseMs: 30000, maxActive: 100, maxCandidates: 100 })
      const leases = new StdioActionLeaseServiceV2(pool, { leaseMs: 30000 })
      const continuation = new StdioCallContinuationV2({ limits, maxReplyBytes: options.maxReplyBytes, admission: operationAdmission })
      const results = new StdioResultServiceV2(pool, { limits, maxReplyBytes: options.maxReplyBytes, continuation })
      async function actor() {
        const userId = randomUUID(), username = `action-fixture-${++serial}`, password = randomBytes(24).toString('base64url')
        await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
          [userId, username, await hashPassword(password), { model: 'synthetic', maxTokens: 64, revision: 1 }])
        const agent = await identities.login(username, password), approval = await identities.login(username, password, 'approval')
        return { userId, token: agent.token, approval: approval.token,
          account: (await identities.login(username, password, 'account')).token }
      }
      async function fresh(owner) {
        const sessionId = randomUUID(), workspaceId = await files.defaultWorkspaceId(owner.userId)
        const binding = await files.bindingForId(owner.userId, workspaceId)
        await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
          [sessionId, owner.userId, workspaceId, randomUUID(), {}])
        const configuration = { name: `Synthetic ${++serial}`, invocation: { program: 'node', argv: ['not-executed.mjs', 'literal;$(unused)'], cwd: '.' } }
        const connection = await connections.create(owner.token, { requestId: randomUUID(), configuration })
        const receipt = await admission.check(owner.token, { requestId: randomUUID(), connectionId: connection.connectionId,
          expectedRevision: 1, sessionId, target: { kind: 'cloud' } })
        const task = (await pool.query('SELECT task FROM pe_stdio_v2_actions WHERE id=$1', [receipt.actionId])).rows[0].task
        return { owner, sessionId, workspaceId, binding, configuration, connectionId: connection.connectionId,
          actionId: receipt.actionId, executionId: receipt.executionRef.executionId, executionRef: receipt.executionRef, task }
      }
      async function originalRows(f) {
        return (await pool.query(`SELECT row_to_json(a) AS action,row_to_json(e) AS execution
          FROM pe_stdio_v2_actions a JOIN pe_cloud_executions e ON e.id=a.execution_id WHERE a.id=$1`, [f.actionId])).rows[0]
      }
      async function captured(f, existing = null) {
        const lease = await leases.claim(f.actionId, randomUUID()); assert(lease)
        await store.beginPreparation(lease)
        const writer = existing?.writer ?? { name: `synthetic-${randomUUID()}`, podUid: randomUUID(), runnerInstanceId: randomUUID(),
          token: 'synthetic-private-runner-token', restartCount: 0, generation: '1', userId: f.owner.userId, sessionId: f.sessionId, binding: f.binding }
        if (!existing) {
          await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
            VALUES($1,$2,$3,1,'ready',$4,$5,$6)`, [f.owner.userId, f.sessionId, f.workspaceId, writer.podUid, writer.runnerInstanceId, f.binding])
          await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
            VALUES($1,$2,$3,'ready',$4,$5,$6)`, [f.sessionId, f.owner.userId, writer.name, writer.podUid, writer.runnerInstanceId, f.binding])
        }
        await store.attach(lease, writer)
        const capture = { kind: 'cloud', podUid: writer.podUid, podName: writer.name, namespace: 'synthetic-private-namespace', nodeName: 'synthetic-node',
          runnerInstanceId: writer.runnerInstanceId, containerId: 'containerd://synthetic-private-container', restartCount: 0, mountGeneration: '1',
          workspaceMount: { claimName: 'synthetic-private-pvc', subPath: `workspaces/${f.binding.rootKey}`, mountPath: '/workspace', readOnly: false },
          homeMount: { claimName: 'synthetic-private-pvc', subPath: `homes/${f.owner.userId}`, mountPath: '/home/agent', readOnly: false } }
        const authorization = new StdioAuthorizationServiceV2(pool, { limits, approvalKey: randomBytes(32), approvalLifetimeMs: 60000,
          async capture(_client, task, executionRef) {
            return stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: sha('task', task),
              scopeBinding: task.scopeBinding, expectedDeploymentPin: pin, actualExecutorImage: image, capture,
              fullScopeDigest: sha('scope', { scopeBinding: task.scopeBinding, workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }),
              specDigest: sha('spec', { syntheticExecutionConfiguration: true }) })
          } })
        const prepared = await authorization.prepareLeased(lease)
        return { lease, writer, capture, authorization, prepared }
      }
      async function authorize(f, c) {
        const inspected = await c.authorization.inspect(f.owner.approval, f.task.actionId)
        await c.authorization.decide(f.owner.approval, { actionId: f.task.actionId, fingerprint: inspected.fingerprint, decision: 'once' })
        const grant = await c.authorization.authorizeLeased(c.lease, randomUUID(), { kind: 'cloud', runnerInstanceId: c.writer.runnerInstanceId })
        assert.equal(grant.grantOnce, true)
      }
      async function finish(f, c, callResult = null) {
        const saved = (await pool.query('SELECT dispatch_digest FROM pe_stdio_v2_dispatches WHERE action_id=$1', [f.actionId])).rows[0]
        const outcome = { state: 'completed', phase: f.task.phase, catalog: raw, pages: [{ tools: raw }],
          initializeResult: JSON.parse('{"protocolVersion":"synthetic","__proto__":{"retained":true}}'),
          facts: { ...facts, toolsCallAttempted: f.task.phase === 'call', effectMayHaveOccurred: f.task.phase === 'call' },
          ...(callResult ? { result: callResult } : {}) }
        outcome.initializeResult.originalText = 'retained\0data'
        const view = { formatVersion: 2, instanceId: c.writer.runnerInstanceId, actionId: f.actionId, executionRef: f.executionRef,
          taskDigest: sha('task', f.task), dispatchDigest: saved.dispatch_digest, state: 'completed', writerStopConfirmed: true, outcome }
        const stopEvidence = { formatVersion: 2, kind: 'cloud_uid_quiet', actionId: f.actionId, executionRef: f.executionRef,
          taskDigest: view.taskDigest, dispatchDigest: view.dispatchDigest, preparedDigest: c.prepared.preparedDigest,
          fullScopeDigest: c.prepared.prepared.fullScopeDigest, podUid: c.writer.podUid,
          runnerInstanceId: c.writer.runnerInstanceId, mountGeneration: '1', observedAt: new Date().toISOString() }
        assert.equal((await results.record(c.lease, { view, stopEvidence })).finalized, true)
        return { ...f, ...c, outcome }
      }
      async function completed(owner) {
        const f = await fresh(owner), c = await captured(f)
        await authorize(f, c)
        return finish(f, c)
      }
      const alice = await actor(), bob = await actor(), a = await fresh(alice), b = await fresh(bob)
      await t.test('two browser owners receive only their own full original logical task and bounded summaries', async () => {
        assert.deepEqual((await actions.list(alice.token, { offset: 0, limit: 20 })).items.map(x => x.actionId), [a.actionId])
        assert.deepEqual((await actions.list(bob.token, { offset: 0, limit: 20 })).items.map(x => x.actionId), [b.actionId])
        const detail = await actions.detail(alice.token, { actionId: a.actionId })
        assert.deepEqual(detail.task, a.task); assert.equal(detail.outcome, null); assert.equal(detail.noStart, null)
        assert.deepEqual(detail.executionRef, a.executionRef); assert.equal(detail.executionState, 'queued')
        for (const method of ['detail', 'cancel']) await assert.rejects(actions[method](bob.token, { actionId: a.actionId }), code('stdio_v2_action_not_found'))
        await assert.rejects(actions.list(bob.token, { sessionId: a.sessionId, offset: 0, limit: 1 }), code('session_not_found'))
        assert.deepEqual((await actions.list(alice.token, { sessionId: a.sessionId, offset: 0, limit: 20 })).items.map(x => x.actionId), [a.actionId])
      })
      await t.test('fixed independent audiences reject wrong browser audiences and unknown valid-shaped bearers', async () => {
        for (const token of [alice.approval, alice.account, randomBytes(32).toString('base64url')]) {
          for (const method of ['detail', 'cancel']) await assert.rejects(actions[method](token, { actionId: a.actionId }), code('account_unauthorized'))
          await assert.rejects(actions.list(token, { offset: 0, limit: 20 }), code('account_unauthorized'))
        }
        for (const token of [alice.token, alice.account, randomBytes(32).toString('base64url')]) {
          await assert.rejects(actions.approvalList(token, { offset: 0, limit: 20 }), code('account_unauthorized'))
        }
        assert.deepEqual((await actions.approvalList(alice.approval, { offset: 0, limit: 20 })).items.map(x => x.actionId), [a.actionId])
        assert.deepEqual((await actions.approvalList(bob.approval, { offset: 0, limit: 20 })).items.map(x => x.actionId), [b.actionId])
      })
      await t.test('repeated and concurrent cancellation only sets both flags; original writer, state and leases remain byte-identical', async () => {
        const lease = await leases.claim(a.actionId, randomUUID()); assert(lease)
        await pool.query('UPDATE pe_cloud_executions SET sandbox_name=$2,pod_uid=$3,runner_instance_id=$4 WHERE id=$1',
          [a.executionId, 'synthetic-existing-writer', randomUUID(), randomUUID()])
        const before = await originalRows(a)
        const first = await actions.cancel(alice.token, { actionId: a.actionId }); assert.equal(first.cancelRequested, true)
        const accepted = await originalRows(a)
        const responses = await Promise.all([actions.cancel(alice.token, { actionId: a.actionId }), actions.cancel(alice.token, { actionId: a.actionId })])
        assert.deepEqual(responses, [first, first]); assert.deepEqual(await originalRows(a), accepted)
        for (const key of ['action', 'execution']) {
          const original = { ...before[key] }, changed = { ...accepted[key] }
          delete original.cancel_requested; delete changed.cancel_requested; delete original.updated_at; delete changed.updated_at
          assert.deepEqual(changed, original); assert.equal(accepted[key].cancel_requested, true)
        }
        for (const table of ['pe_stdio_v2_results', 'pe_stdio_v2_no_start_closures', 'pe_stdio_v2_start_permits']) {
          assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE action_id=$1`, [a.actionId])).rows[0].n, 0)
        }
      })
      await t.test('pagination never crosses owners; explicit invalid page, unknown keys and oversized whole request are rejected', async () => {
        const second = await fresh(bob), third = await fresh(bob)
        const all = await actions.list(bob.token, { offset: 0, limit: 20 })
        assert.equal(all.items.length, 3); assert.equal(all.nextOffset, null)
        const page = await actions.list(bob.token, { offset: 0, limit: 2 }); assert.equal(page.nextOffset, 2)
        const last = await actions.list(bob.token, { offset: page.nextOffset, limit: 2 })
        assert.deepEqual([...page.items, ...last.items], all.items); assert.equal(last.nextOffset, null)
        assert(all.items.every(x => [b.actionId, second.actionId, third.actionId].includes(x.actionId)))
        for (const input of [{ offset: -1, limit: 1 }, { offset: 0, limit: 0 }, { offset: 0, limit: 21 },
          { offset: Number.MAX_SAFE_INTEGER, limit: 1 }, { offset: 0, limit: 1, userId: alice.userId }]) {
          await assert.rejects(actions.list(bob.token, input), { name: 'ZodError' })
        }
        await assert.rejects(actions.approvalList(alice.approval, { offset: 0, limit: 1, sessionId: a.sessionId }), { name: 'ZodError' })
        await assert.rejects(actions.detail(alice.token, { actionId: a.actionId, padding: 'x'.repeat(limits.maxInputBytes) }), { name: 'ZodError' })
      })
      await t.test('history remains readable and locally cancellable after configuration replacement, disablement and deletion', async () => {
        const owner = await actor(), f = await fresh(owner)
        await connections.update(owner.token, { requestId: randomUUID(), connectionId: f.connectionId, expectedRevision: 1,
          configuration: { name: 'New configuration', invocation: { program: 'python3', argv: ['not-executed.py'], cwd: '.' } } })
        await connections.remove(owner.token, { requestId: randomUUID(), connectionId: f.connectionId, expectedRevision: 2 })
        const detail = await actions.detail(owner.token, { actionId: f.actionId })
        assert.equal(detail.configRevision, 1); assert.deepEqual(detail.task, f.task)
        assert.equal((await actions.cancel(owner.token, { actionId: f.actionId })).cancelRequested, true)
        assert.equal((await actions.list(owner.token, { offset: 0, limit: 1 })).items[0].actionId, f.actionId)
      })
      await t.test('formal no-start readback reports resource disposition without fabricating a runtime outcome or releasing retained resources', async () => {
        const owner = await actor(), f = await fresh(owner)
        await actions.cancel(owner.token, { actionId: f.actionId })
        const lease = await leases.claim(f.actionId, randomUUID()); assert(lease)
        const closure = await store.closeUnstarted(lease)
        assert.equal(closure.startNeverAuthorized, true)
        const detail = await actions.detail(owner.token, { actionId: f.actionId })
        assert.equal(detail.state, 'cancelled'); assert.equal(detail.outcome, null)
        assert.deepEqual(detail.noStart, { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' })
        const before = await originalRows(f)
        assert.equal((await actions.cancel(owner.token, { actionId: f.actionId })).state, 'cancelled')
        assert.deepEqual(await originalRows(f), before)
      })
      await t.test('independent candidate list works with real inspect/decide; rejected preparation keeps exact writer and lease', async () => {
        const owner = await actor(), f = await fresh(owner), c = await captured(f)
        assert.equal((await actions.approvalList(owner.approval, { offset: 0, limit: 20 })).items[0].state, 'pending')
        const view = await c.authorization.inspect(owner.approval, f.task.actionId)
        assert.deepEqual(view.task, f.task); assert.equal(Object.hasOwn(view, 'capture'), false)
        await c.authorization.decide(owner.approval, { actionId: f.task.actionId, fingerprint: view.fingerprint, decision: 'reject' })
        const before = await originalRows(f)
        assert.equal((await actions.cancel(owner.token, { actionId: f.actionId })).cancelRequested, true)
        const after = await originalRows(f)
        assert.equal(after.action.state, 'rejected'); assert.equal(after.execution.state, before.execution.state)
        for (const key of ['sandbox_name', 'pod_uid', 'runner_instance_id', 'lease_owner', 'lease_until']) assert.equal(after.execution[key], before.execution[key])
        const detail = await actions.detail(owner.token, { actionId: f.actionId })
        assert.equal(detail.outcome, null); assert.equal(detail.noStart, null)
        for (const forbidden of ['prepared', 'capture', 'permit', 'token', 'stopEvidence', 'fingerprint']) assert.equal(Object.hasOwn(detail, forbidden), false)
        for (const secret of [c.writer.token, c.writer.name, c.capture.namespace, c.capture.containerId, c.capture.workspaceMount.subPath]) {
          assert.equal(JSON.stringify(detail).includes(secret), false)
        }
      })
      await t.test('formal completed output retains original raw extensions and NUL data, remains read-only after terminal cancellation', async () => {
        const owner = await actor(), f = await completed(owner)
        const detail = await actions.detail(owner.token, { actionId: f.actionId })
        assert.equal(detail.state, 'succeeded'); assert.deepEqual(detail.outcome, f.outcome)
        assert.equal(Object.hasOwn(detail.outcome.initializeResult, '__proto__'), true)
        assert.equal(Object.hasOwn(detail.outcome.catalog[0]._meta, '__proto__'), true)
        const before = await originalRows(f)
        assert.equal((await actions.cancel(owner.token, { actionId: f.actionId })).state, 'succeeded')
        assert.deepEqual(await originalRows(f), before)
        await connections.remove(owner.token, { requestId: randomUUID(), connectionId: f.connectionId, expectedRevision: 1 })
        assert.deepEqual((await actions.detail(owner.token, { actionId: f.actionId })).outcome, f.outcome)
      })
      await t.test('production call admission/result readback retains actual completed isError after local cancel and reports once without root cancellation', async () => {
        const owner = await actor(), discovery = await completed(owner)
        await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$3,64,true)',
          [owner.userId, 'synthetic', 'Not executed'])
        await connections.toggle(owner.token, { requestId: randomUUID(), connectionId: discovery.connectionId, expectedRevision: 1, enabled: true })
        const selector = new StdioOperationAdmissionV2(files,
          { limits, admission: operationAdmission, maxReplyBytes: options.maxReplyBytes, cloudDeployment: pin })
        const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 20, maxActivePerUser: 4,
          stdioV2Admission: { selection: selector, reservedNames: [] } })
        const calls = new StdioCallAdmissionV2(tasks, selector, files, { limits, cloudDeployment: pin,
          maxPendingPerUser: 20, maxCallsPerChain: 5, chainLifetimeMs: 60000, reservedNames: [] })
        await tasks.accept(await identities.authenticate(owner.token), discovery.sessionId, randomUUID(), 'synthetic no-model input', owner.token)
        const grant = await tasks.claim(randomUUID()); assert.equal(grant.sessionId, discovery.sessionId)
        await assert.rejects(actions.list(grant.token, { offset: 0, limit: 1 }), code('account_unauthorized'))
        const receipt = await calls.propose(grant.token, { callKey: 'original-call', toolName: grant.stdioV2Connections[0].tools[0].model.name,
          arguments: { text: 'original\0argument' } })
        await tasks.finish(grant.token, 'completed', null)
        const task = (await pool.query('SELECT task FROM pe_stdio_v2_actions WHERE id=$1', [receipt.actionId])).rows[0].task
        const f = { ...discovery, actionId: receipt.actionId, executionId: receipt.executionRef.executionId, executionRef: receipt.executionRef, task }
        const c = await captured(f, discovery)
        await authorize(f, c)
        const before = await originalRows(f)
        const cancelled = await actions.cancel(owner.token, { actionId: f.actionId })
        assert.equal(cancelled.state, 'dispatch-intent'); assert.equal(cancelled.executionState, before.execution.state)
        const result = JSON.parse('{"isError":true,"content":[{"type":"text","text":"retained\\u0000result"}],"__proto__":{"original":true}}')
        await finish(f, c, result)
        const detail = await actions.detail(owner.token, { actionId: f.actionId })
        assert.equal(detail.phase, 'call'); assert.equal(detail.state, 'succeeded'); assert.equal(detail.outcome.state, 'completed')
        assert.deepEqual(detail.outcome.result, result); assert.deepEqual(detail.task.selection.arguments, { text: 'original\0argument' })
        assert.equal(Object.hasOwn(detail.outcome.result, '__proto__'), true)
        const root = (await pool.query('SELECT mcp_chain_cancelled_at FROM pe_operations WHERE id=$1', [task.origin.rootOperationId])).rows[0]
        assert.equal(root.mcp_chain_cancelled_at, null)
        assert.equal((await pool.query('SELECT stopped_at FROM pe_mcp_action_chains WHERE root_operation_id=$1', [task.origin.rootOperationId])).rows[0].stopped_at instanceof Date, true)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations WHERE source_stdio_v2_action_id=$1', [f.actionId])).rows[0].n, 1)
        assert.deepEqual((await actions.detail(owner.token, { actionId: f.actionId })).outcome.result, result)
      })
      await t.test('whole list/detail/cancel reply budgets reject instead of truncating or committing hidden cancellation', async () => {
        const small = new StdioActionServiceV2(pool, { ...options, maxReplyBytes: 64 })
        const f = await fresh(await actor()), before = await originalRows(f)
        await assert.rejects(small.list(f.owner.token, { offset: 0, limit: 1 }), code('stdio_v2_reply_limit'))
        await assert.rejects(small.approvalList(f.owner.approval, { offset: 0, limit: 1 }), code('stdio_v2_reply_limit'))
        await assert.rejects(small.detail(f.owner.token, { actionId: f.actionId }), code('stdio_v2_reply_limit'))
        await assert.rejects(small.cancel(f.owner.token, { actionId: f.actionId }), code('stdio_v2_reply_limit'))
        assert.deepEqual(await originalRows(f), before)
      })
      await t.test('durable task/execution/config JSON mismatch fails closed; no mutation follows an invalid original', async () => {
        const owner = await actor(), f = await fresh(owner)
        await transaction(pool, async client => {
          await client.query('ALTER TABLE pe_stdio_v2_actions DISABLE TRIGGER pe_stdio_v2_actions_original')
          const corrupted = { ...f.task, invocation: { ...f.task.invocation, argv: ['tampered'] } }
          await client.query('UPDATE pe_stdio_v2_actions SET task=$2 WHERE id=$1', [f.actionId, JSON.stringify(corrupted)])
          await client.query('ALTER TABLE pe_stdio_v2_actions ENABLE TRIGGER pe_stdio_v2_actions_original')
        })
        const before = await originalRows(f)
        for (const method of ['detail', 'cancel']) await assert.rejects(actions[method](owner.token, { actionId: f.actionId }), code('stdio_v2_record_invalid'))
        await assert.rejects(actions.list(owner.token, { offset: 0, limit: 1 }), code('stdio_v2_record_invalid'))
        assert.deepEqual(await originalRows(f), before)
      })
      await t.test('expired/logout/rotated credentials and disabled accounts cannot query or mutate old actions', async () => {
        const owner = await actor(), f = await fresh(owner)
        await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [owner.userId])
        for (const method of ['detail', 'cancel']) await assert.rejects(actions[method](owner.token, { actionId: f.actionId }), code('account_disabled'))
        await assert.rejects(actions.approvalList(owner.approval, { offset: 0, limit: 1 }), code('account_disabled'))
        await pool.query('UPDATE pe_users SET enabled=true,credential_version=credential_version+1 WHERE id=$1', [owner.userId])
        await assert.rejects(actions.detail(owner.token, { actionId: f.actionId }), code('account_unauthorized'))
        const second = await actor(), g = await fresh(second)
        await identities.logout(second.token)
        await assert.rejects(actions.cancel(second.token, { actionId: g.actionId }), code('account_unauthorized'))
        await pool.query('UPDATE pe_credentials SET expires_at=clock_timestamp()-interval \'1 second\' WHERE user_id=$1', [second.userId])
        await assert.rejects(actions.approvalList(second.approval, { offset: 0, limit: 1 }), code('account_unauthorized'))
      })
      await t.test('explicit options reject invalid page/reply/limits budgets without deployment defaults', () => {
        for (const patch of [{ maxPageSize: 0 }, { maxReplyBytes: 0 }, { maxPageSize: true },
          { maxPageSize: Number.MAX_SAFE_INTEGER }, { limits: { ...limits, maxJsonDepth: 0 } }]) {
          assert.throws(() => new StdioActionServiceV2(pool, { ...options, ...patch }), { name: 'ZodError' })
        }
      })
    } finally {
      await pool?.end()
      try { if (created) await admin.query(`DROP DATABASE "${database}"`) }
      finally { try { await admin.end() } finally { await rm(root, { recursive: true, force: true }) } }
    }
  })
