/** Actual native Scheduler/AgentLoop/Scope/Session/persistence composition over an owned HTTP Platform fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '../../../../packages/core/agent-loop/lib/index.js'
import { Pool } from 'pg'
import { requestId, PlatformError } from '../lib/contracts.js'
import PlatformPersistence from '../lib/host/persistence.js'
import RuntimeScope from '../lib/host/scope.js'
import { Scheduler } from '../lib/host/scheduler.js'
import { LegacyMigrationHostImages } from '../lib/platform/legacy-migration-v2-host-images.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword, IdentityService } from '../lib/platform/identity.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { EventStore } from '../lib/platform/events.js'
import { NativeSessionWriter } from '../lib/platform/native-session-writer.js'
import { routeNativeWriter } from '../lib/platform/native-writer-routes.js'
import { NativeAssistantStore } from '../lib/platform/native-assistant-store.js'
import { releaseNativeAssistant } from '../lib/platform/native-assistant-lifecycle.js'
import { NativeExecutionFrames } from '../lib/platform/native-execution-frames.js'
import { NativeInputLedger } from '../lib/platform/native-input-ledger.js'
import { NativeInputCommit } from '../lib/platform/native-input-commit.js'
import { NativePreparedCancel } from '../lib/platform/native-prepared-cancel.js'
import { NativeArchiveInputCancel } from '../lib/platform/native-archive-input.js'
import { NativeTurnAdvanceIntentV2 } from '../lib/platform/native-turn-advance-intent-v2.js'
import { NativeTurnContinuationV2 } from '../lib/platform/native-turn-continuation-v2.js'
import { NativeRetainedIntentStore } from '../lib/platform/native-retained-intent-store.js'
import { NATIVE_RETAINED_ROUTES } from '../lib/native-retained-intent-contracts.js'
import { nativeInputFrameRequest, nativeInputPendingRequest } from '../lib/native-input-commit-contracts.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 8192,
  maxToolBytes: 4096, maxResultBytes: 8192, maxStderrBytes: 4096 }
const admission = { maxConnections: 4, maxTools: 10, maxSnapshotBytes: 262144, maxDescriptionBytes: 8192 }
const budget = { maxDepth: 40, maxNodes: 10000, maxBytes: 65536 }, sha = (domain, value) => stdioSha256V2(domain, value, budget)
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

function selection(userId) {
  const configuration = { name: 'Original frozen connection', invocation: { program: 'node', argv: ['never-executed.mjs'], cwd: '.' } }
  const rawCatalog = [{ name: 'echo', description: 'Original raw descriptor', inputSchema: { type: 'object',
    properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]
  const pin = { kind: 'cloud', deploymentId: id(50), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference: `synthetic.invalid/runner@sha256:${'b'.repeat(64)}`, configImageId: `sha256:${'c'.repeat(64)}`,
    runtimeImageIds: ['containerd://synthetic-original'] }
  return compileStdioOperationToolsV2([{ formatVersion: 2, connectionId: id(10), configRevision: 1,
    configDigest: sha('configuration', configuration), configuration, limits,
    scopeBinding: { kind: 'cloud', userId, workspaceId: id(20), bindingGeneration: 1,
      target: { spaceId: id(30), rootRelativePath: 'synthetic-owned' }, home: { kind: 'user', userId } },
    expectedDeploymentPin: pin, catalogId: id(40), catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog,
    catalogImageExpectation: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
  }], limits, admission, [])
}
const text = value => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (name, callId) => {
  const args = JSON.stringify({ text: 'original\0model arguments' }), key = ToolCallId(callId)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

async function fixture(t) {
  const root = new Context(), requests = [], paths = [], issued = new Map()
  const pending = new Set(), fixtureErrors = [], refusals = []
  const directory = await mkdtemp(join(tmpdir(), 'power-evolve-stdio-scheduler-'))
  const adminFile = process.env.PE_TEST_DATABASE_URL_FILE, ordinaryFile = process.env.PE_TEST_ORDINARY_DATABASE_URL_FILE
  assert(adminFile && ordinaryFile, 'Owned PG admin and existing ordinary-role credential files are required')
  const adminUrl = new URL((await readFile(adminFile, 'utf8')).trim())
  const ordinaryUrl = new URL((await readFile(ordinaryFile, 'utf8')).trim())
  assert.equal(ordinaryUrl.hostname, adminUrl.hostname); assert.equal(ordinaryUrl.port, adminUrl.port)
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname))
  const databaseName = 'pe_stdio_built_' + randomUUID().replaceAll('-', ''), role = decodeURIComponent(ordinaryUrl.username)
  assert.match(role, /^[a-zA-Z_][a-zA-Z_0-9]*$/u)
  ordinaryUrl.pathname = '/' + databaseName
  const admin = new Pool({ connectionString: adminUrl.href, max: 1, connectionTimeoutMillis: 5000 })
  const pool = new Pool({ connectionString: ordinaryUrl.href, max: 8, connectionTimeoutMillis: 5000 })
  const resources = { scheduler: undefined, databaseCreated: false, server: undefined }
  t.after(async () => {
    try { try { await resources.scheduler?.close() } finally { await root.fiber.dispose() } }
    finally {
      try {
        await Promise.allSettled(pending)
        if (resources.server?.listening) await new Promise((resolve, reject) => {
          resources.server.close((error) => { if (error) reject(error); else resolve() }); resources.server.closeIdleConnections()
        })
      } finally {
        try { await pool.end() }
        finally {
          try {
            if (resources.databaseCreated) await admin.query('DROP DATABASE "' + databaseName + '"')
          } finally { await admin.end(); await rm(directory, { recursive: true, force: true }) }
        }
      }
    }
  })
  const privilege = (await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=$1', [role])).rows[0]
  assert.equal(privilege?.rolsuper, false, 'Existing ordinary role must own the new test database')
  await admin.query('CREATE DATABASE "' + databaseName + '" OWNER "' + role + '"'); resources.databaseCreated = true
  assert.deepEqual((await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls '
    + 'FROM pg_roles WHERE rolname=current_user')).rows, [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, rolbypassrls: false }])
  await initializeDatabase(pool)
  const password = randomUUID(), username = 'stdio-' + randomUUID()
  await seedNewUser(pool, username, await hashPassword(password), { model: 'synthetic-no-network', maxTokens: 64, revision: 1 })
  const owner = await new IdentityService(pool, 60000).login(username, password), userId = owner.user.userId
  const frozen = selection(userId), scripts = [], workerId = randomUUID(), workerToken = randomUUID()
  const taskLimits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 1,
    stdioV2Admission: { selection: { select: async () => structuredClone(frozen), restore: (saved) => {
      assert.deepEqual(saved, frozen); return structuredClone(frozen)
    } }, reservedNames: [] } }
  const tasks = new TaskStore(pool, taskLimits, undefined,
    (client, session, fallback) => frames.selectClaimInTransaction(client, session, fallback))
  await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,false)', [id(20), userId, 'Original scope'])
  const { sessionId } = await tasks.create(owner.user, requestId.parse(randomUUID()), owner.token, id(20))
  const workerTokenFile = join(directory, 'worker-token')
  const publicationLimits = { maxBatchItems: 32, maxBatchBytes: 1048576, maxItemBytes: 1048576,
    maxActiveBytes: 4194304, maxRingItems: 1024, maxRingBytes: 4194304, ttlMs: 20000, maxEventBytes: 524288 }
  const history = { maxHistoryBytes: 8388608, maxHistoryEvents: 10000 }
  const input = { ...history, maxEventBytes: taskLimits.maxEventBytes, maxAcceptedAuditBytes: 2097152,
    maxRevisionBytes: 262144, maxCohortInputs: 128, maxCommandBytes: 4194304 }
  const events = new EventStore(tasks, { ...history, maxEventBytes: taskLimits.maxEventBytes })
  const writers = new NativeSessionWriter(tasks, { leaseMs: taskLimits.leaseMs })
  const frames = new NativeExecutionFrames(tasks, writers, { ...history, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const verify = (client, request) => frames.verifyInTransaction(client, request)
  const ledger = new NativeInputLedger(tasks, writers, events, input, verify)
  const publisher = new NativeAssistantStore(tasks, events, publicationLimits), config = { input, presentation: publicationLimits }
  const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers, config)
  const preparedCancel = new NativePreparedCancel(tasks, ledger, frames, publisher, writers, config)
  const archiveCancel = new NativeArchiveInputCancel(tasks, ledger, frames, publisher, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verify,
    { ...input, leaseMs: taskLimits.leaseMs, maxActivePerUser: 1, assistant: publicationLimits }, frames)
  const advance = new NativeTurnAdvanceIntentV2(tasks, writers, verify, { ...history,
    maxAcceptedAuditBytes: input.maxAcceptedAuditBytes, maxRevisionBytes: input.maxRevisionBytes,
    maxCohortInputs: input.maxCohortInputs, maxCommandBytes: input.maxCommandBytes, assistant: publicationLimits }, frames)
  const retained = new NativeRetainedIntentStore(tasks, writers, { publication: publisher, input: bridge,
    preparedCancel, archiveCancel, turn }, randomBytes(32).toString('base64url'), { maxRequestBytes: 8388608,
    maxPendingPerSession: 16, maxRecordsPerSession: 256, maxRetainedBytesPerSession: 33554432 })
  const readEvents = async () => (await pool.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [sessionId]))
    .rows.map(row => row.event)
  const server = createServer((req, res) => {
    const lifetime = new AbortController()
    req.once('aborted', () => { lifetime.abort() })
    res.once('close', () => { if (!res.writableEnded) lifetime.abort() })
    const processing = (async () => {
      try {
        assert.equal(req.method, 'POST')
        const chunks = []; let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.byteLength
          assert(bytes <= 1048576, 'fixture request must remain bounded')
          chunks.push(chunk)
        }
        const path = req.url, token = req.headers.authorization?.replace(/^Bearer /u, '')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), signal = lifetime.signal
        paths.push({ path, token, body: structuredClone(body), signal })
        let value
        if (path.startsWith('/runtime/native-writer/')) value = await routeNativeWriter(writers, path, token, body)
        else if (path === NATIVE_RETAINED_ROUTES.prepare) value = await retained.prepare(token, body)
        else if (path === NATIVE_RETAINED_ROUTES.execute) value = await retained.execute(token, body)
        else if (path === NATIVE_RETAINED_ROUTES.reconcile || path === NATIVE_RETAINED_ROUTES.resolve) {
          if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
          value = await (path === NATIVE_RETAINED_ROUTES.reconcile ? retained.reconcile(body) : retained.resolve(body))
        } else if (path === '/runtime/native-input/recover-prepared') {
          const request = nativeInputFrameRequest.parse(body)
          value = await transaction(pool, client => frames.recoverPreparedInTransaction(client,
            { writer: request.writer, operationToken: token }))
        } else if (path === '/runtime/native-input/recover-consumed') {
          const request = nativeInputFrameRequest.parse(body)
          const result = await transaction(pool, client => frames.readConsumedInTransaction(client,
            { writer: request.writer, operationToken: token }))
          value = { version: 1, kind: 'claimed', frame: result.operationFrame, grant: result.storageGrant }
        } else if (path === '/runtime/native-input/pending') {
          const request = nativeInputPendingRequest.parse(body)
          value = await transaction(pool, client => ledger.readAcceptedPendingInTransaction(client,
            { writer: request.writer, operationToken: token }, request.limit))
        } else if (path === '/runtime/native-input/frame') {
          const request = nativeInputFrameRequest.parse(body)
          value = await transaction(pool, async (client) => {
            const frame = await frames.verifyInTransaction(client,
              { kind: 'read', expected: null, authority: { writer: request.writer, operationToken: token } })
            return (await client.query('SELECT frame_json FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
              [frame.operationId, frame.operationEpoch])).rows[0].frame_json
          })
        } else if (path === '/runtime/native-turn/prepare') value = await advance.prepare(token, body)
        else if (path === '/runtime/renew') value = await tasks.renew(token)
        else if (path === '/runtime/snapshot') value = await events.runtimeSnapshot(token)
        else if (path === '/runtime/native-assistant') throw new PlatformError(410, 'native_retained_protocol_required')
        else if (path === '/runtime/native-assistant/release') {
          value = await releaseNativeAssistant(tasks, token, body.publisherId)
        } else if (path === '/runtime/finish') {
          await tasks.finish(token, body.outcome, body.errorCode); value = {}
        } else if (path === '/runtime/stdio-v2/calls/propose') {
          const grant = issued.get(token); assert(grant, 'only the original issued operation token may propose')
          await transaction(pool, client => tasks.authorized(client, token))
          assert.equal(body.toolName, grant.stdioV2Connections[0].tools[0].model.name)
          assert.equal(typeof body.callKey, 'string'); assert(signal instanceof AbortSignal)
          assert((await readEvents()).some(event => event.type === 'tool/call' && event.data.callId === body.callKey), 'native call must be durable before proposing')
          if (grant.source === 'stdio_v2_no_start') throw new PlatformError(409, 'stdio_v2_chain_stopped')
          value = { actionId: id(100), executionRef: { kind: 'cloud', executionId: id(101) }, taskDigest: 'a'.repeat(64), state: 'pending' }
        } else assert.fail(`unexpected API route ${path}`)
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
      } catch (error) {
        if (!(error instanceof PlatformError)) fixtureErrors.push(error)
        else refusals.push({ path: req.url, code: error.code })
        res.writeHead(error instanceof PlatformError ? error.status : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof PlatformError ? error.code : 'fixture_failure' }))
      }
    })().finally(() => { pending.delete(processing) })
    pending.add(processing)
  })
  resources.server = server
  class Model extends LlmAdapter {
    async *stream(options) {
      requests.push(structuredClone({ messages: options.messages, tools: options.tools, sessionId: options.sessionId }))
      const chunks = scripts.shift(); assert(chunks, 'a consumed request must not invoke the model again')
      for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
    }
  }
  let ctx
  await writeFile(workerTokenFile, workerToken, { mode: 0o600, flag: 'wx' })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address(); assert(address && typeof address !== 'string')
  await root.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile, workerId,
    timeoutMs: 10000, maxResponseBytes: 1048576 })
  await root.plugin(LlmRuntime); await root.plugin(SessionStore)
  await root.plugin(SessionProjectionRegistry); await root.plugin(SystemPrompt); await root.plugin(ToolRuntime)
  await root.plugin(AgentRegistry); await root.plugin(SkillRegistry); await root.plugin(PlatformPersistence)
  await root.plugin(AgentLoop, { agents: [] })
  await root.inject(['powerEvolveRuntime'], (imageCtx) => {
    new LegacyMigrationHostImages(imageCtx, imageCtx.powerEvolveRuntime, { cacheRoot: join(directory, 'image-cache'), imageLimits: {
      maxImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, maxImagesPerMessage: 4,
      maxMessageImageBytes: 262144, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    } })
  })
  await root.inject(['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'agents',
    'agentLoop', 'tools', 'skills', 'attachments'], (value) => { ctx = value })
  ctx.llm.registerAdapter(['power-evolve'], new Model())
  const scheduler = new Scheduler(ctx, { platformOrigin: 'https://trusted.example', concurrency: 1, pollMs: 50,
    renewMs: 8000, operationTimeoutMs: 10000, nativeInputPollMs: 100, nativeInputBatchSize: 16 })
  resources.scheduler = scheduler
  async function insertFixtureRow(client, table, row) {
    assert.match(table, /^pe_[a-z_0-9]+$/u)
    const columns = Object.keys(row); assert(columns.every(column => /^[a-z_0-9]+$/u.test(column)))
    await client.query('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES('
      + columns.map((_, index) => '$' + (index + 1)).join(',') + ')', Object.values(row))
  }
  await transaction(pool, async (client) => {
    await insertFixtureRow(client, 'pe_stdio_v2_connections', { id: id(10), user_id: userId, revision: 1 })
    await insertFixtureRow(client, 'pe_stdio_v2_configurations', { connection_id: id(10), user_id: userId, revision: 1,
      configuration: JSON.stringify(frozen[0].configuration), config_digest: frozen[0].configDigest })
  })
  const makeGrant = async (source) => {
    const originRequest = requestId.parse(randomUUID()), content = JSON.stringify({ kind: source,
      actionId: source === 'stdio_v2_no_start' ? id(103) : id(102),
      chainStopped: source === 'stdio_v2_no_start', instruction: source === 'stdio_v2_no_start'
        ? 'Report the exact no-start outcome; do not repeat or recreate this action.' : 'Continue only within current permissions and the original root budget.' })
    const operationId = source === 'user'
      ? (await tasks.accept(owner.user, sessionId, originRequest, content, owner.token)).operationId : randomUUID()
    let predecessor = [...issued.values()].at(-1)
    if (source !== 'user' && !predecessor) {
      // This controlled historical caller is failed through real authority before its no-start continuation exists.
      await tasks.accept(owner.user, sessionId, requestId.parse(randomUUID()), 'Original controlled caller', owner.token)
      predecessor = await tasks.claim(workerId); assert(predecessor)
      await tasks.finish(predecessor.token, 'failed', 'fixture_original_caller')
    }
    if (source !== 'user') await transaction(pool, async (client) => {
      assert(predecessor)
      // The original controlled external outcome now carries actual FK-bound producer identity.
      const actionId = source === 'stdio_v2_result' ? id(102) : id(103), executionId = randomUUID()
      const task = JSON.stringify({ phase: 'call', arguments: { text: 'original\0model arguments' } }), taskDigest = sha('task', JSON.parse(task))
      await insertFixtureRow(client, 'pe_stdio_v2_actions', { id: actionId, user_id: userId, session_id: sessionId,
        connection_id: id(10), config_revision: 1, config_digest: frozen[0].configDigest, phase: 'call', execution_target: 'cloud',
        execution_id: executionId, operation_id: predecessor.operationId, root_operation_id: predecessor.operationId,
        call_id: 'original-controlled-call', task, task_digest: taskDigest, state: source === 'stdio_v2_result' ? 'succeeded' : 'rejected',
        continuation_request_id: originRequest, continuation_queued: true })
      await insertFixtureRow(client, 'pe_cloud_executions', { id: executionId, user_id: userId, session_id: sessionId,
        operation_id: predecessor.operationId, call_id: 'original-controlled-call', request_digest: taskDigest,
        state: source === 'stdio_v2_result' ? 'succeeded' : 'failed', continuation_request_id: originRequest,
        execution_kind: 'stdio_v2', execution_target: 'cloud', origin_kind: 'operation', task_version: 2,
        stdio_phase: 'call', stdio_task: task, stdio_action_id: actionId })
      if (source === 'stdio_v2_result') await insertFixtureRow(client, 'pe_stdio_v2_results', { action_id: actionId,
        result: content, result_digest: sha('result', JSON.parse(content)), observation: '{}', stop_evidence: '{}' })
      else await insertFixtureRow(client, 'pe_stdio_v2_no_start_closures', { action_id: actionId, user_id: userId,
        session_id: sessionId, phase: 'call', execution_target: 'cloud', execution_id: executionId, task_digest: taskDigest,
        worker_id: workerId, lease_epoch: 1, receipt: content, receipt_digest: sha('no_start', JSON.parse(content)) })
      await client.query('INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,mcp_selection,'
        + 'stdio_mcp_selection,ssh_selection,execution_target,remote_mcp_selection,stdio_v2_selection,state,source,'
        + 'source_stdio_v2_action_id,source_stdio_v2_no_start_action_id,source_stdio_v2_phase,mcp_root_operation_id) '
        + 'SELECT $1,session_id,$2,$3,settings,skill_selection,mcp_selection,stdio_mcp_selection,ssh_selection,'
        + "execution_target,remote_mcp_selection,stdio_v2_selection,'queued',$4,$5,$6,'call',id FROM pe_operations WHERE id=$7",
      [operationId, originRequest, content, source, source === 'stdio_v2_result' ? actionId : null,
        source === 'stdio_v2_no_start' ? actionId : null, predecessor.operationId])
    })
    const original = await tasks.claim(workerId); assert(original, 'real current task authority must issue the grant')
    assert.equal(original.operationId, operationId); assert.equal(original.source, source)
    issued.set(original.token, original); return original
  }
  const released = async () => {
    assert.deepEqual(fixtureErrors, [])
    assert.deepEqual((await pool.query('SELECT session_id FROM pe_native_writers WHERE session_id=$1 AND expires_at IS NOT NULL',
      [sessionId])).rows, [])
    assert.equal(ctx.powerEvolveRuntime.grants.size, 0); assert.equal(ctx.agents.list().length, 0)
    assert.equal(ctx.sessions.get(sessionId), undefined); assert.equal(scheduler.handles.size, 0)
    assert.deepEqual(ctx.tools.schemas(), [])
  }
  const operation = async grant => (await pool.query('SELECT state FROM pe_operations WHERE id=$1', [grant.operationId])).rows[0]
  const journal = async grant => (await pool.query('SELECT family,state,receipt_json IS NOT NULL AS saved FROM pe_native_retained_intents '
    + 'WHERE operation_id=$1 ORDER BY family', [grant.operationId])).rows
  return { ctx, scheduler, requests, paths, frozen, scripts, makeGrant, released, refusals, operation, journal, events: readEvents }
}

test('native Scheduler installs frozen tools on user and real-result continuations, preserves trusted source, and cold recovery never re-proposes consumed input', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), name = f.frozen[0].tools[0].model.name
  for (const [source, callKey] of [['user', 'native-user-call'], ['stdio_v2_result', 'native-result-call']]) {
    const grant = await f.makeGrant(source), firstRequest = f.requests.length
    f.scripts.push(tool(name, callKey), text('Await the trusted continuation.'))
    await f.scheduler.run(grant); await f.released()
    const declaration = f.requests[firstRequest].tools.find(value => value.name === name)
    assert.deepEqual(declaration, f.frozen[0].tools[0].model)
    const consumed = (await f.events()).filter(event => event.type === 'user/message' && event.data.id === grant.operationId)
    assert.equal(consumed.length, 1)
    assert.deepEqual(consumed[0].data.source, source === 'user' ? { kind: 'user', rpcId: grant.requestId }
      : { kind: 'power-evolve-stdio-v2-result', actionId: grant.sourceStdioV2ActionId, phase: 'call' })
    assert(f.requests[firstRequest].messages.some(message => message.role === 'user' && message.source?.kind === consumed[0].data.source.kind))
    const proposed = f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose' && value.token === grant.token)
    assert.equal(proposed.length, 1); assert.deepEqual(proposed[0].body, { callKey, toolName: name, arguments: { text: 'original\0model arguments' } })
    assert.equal((await f.operation(grant)).state, 'completed')
    assert((await f.journal(grant)).some(row => row.family === 'turn-transition' && row.state === 'committed' && row.saved))
    const requestCount = f.requests.length, before = await f.events(), refused = f.refusals.length
    await assert.rejects(f.scheduler.run(grant), { code: 'lease_lost' }); await f.released()
    assert.equal(f.requests.length, requestCount); assert.deepEqual(await f.events(), before)
    assert.equal((await f.operation(grant)).state, 'completed')
    assert.deepEqual(f.refusals.slice(refused), [{ path: '/runtime/renew', code: 'lease_lost' }])
    assert.equal(f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose' && value.token === grant.token).length, 1)
  }
  assert(f.paths.every(value => ['/runtime/renew', '/runtime/snapshot', '/runtime/native-assistant/release', '/runtime/finish',
    '/runtime/stdio-v2/calls/propose', '/runtime/native-input/recover-prepared', '/runtime/native-input/recover-consumed',
    '/runtime/native-input/pending', '/runtime/native-input/frame', '/runtime/native-turn/prepare',
    '/runtime/native-writer/acquire', '/runtime/native-writer/renew', '/runtime/native-writer/release',
    ...Object.values(NATIVE_RETAINED_ROUTES)].includes(value.path)))
})

test('native no-start continuation retains its distinct action source and original tools without bypassing the Platform chain fence', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), grant = await f.makeGrant('stdio_v2_no_start'), name = f.frozen[0].tools[0].model.name
  f.scripts.push(tool(name, 'native-denied-call'), text('The provider never started; this chain is stopped.'))
  await f.scheduler.run(grant); await f.released()
  assert.deepEqual(f.requests[0].tools.find(value => value.name === name), f.frozen[0].tools[0].model)
  const message = (await f.events()).find(event => event.type === 'user/message' && event.data.id === grant.operationId)
  assert.deepEqual(message.data.source, { kind: 'power-evolve-stdio-v2-no-start', actionId: grant.sourceStdioV2NoStartActionId, phase: 'call' })
  assert(f.requests[0].messages.some(value => value.source?.kind === 'power-evolve-stdio-v2-no-start'))
  const denied = (await f.events()).find(event => event.type === 'tool/result' && event.data.message.source.callId === 'native-denied-call')
  assert.equal(denied.data.message.isError, true); assert.match(JSON.stringify(denied.data.message.content), /stdio_v2_chain_stopped/u)
  assert.equal(f.paths.filter(value => value.path === '/runtime/stdio-v2/calls/propose').length, 1)
  assert(f.paths.every(value => !/authorize|approval|discover|check|catalog|start/u.test(value.path)))
  const before = await f.events(), count = f.requests.length, refused = f.refusals.length
  assert.equal((await f.operation(grant)).state, 'completed')
  assert((await f.journal(grant)).some(row => row.family === 'turn-transition' && row.state === 'committed' && row.saved))
  await assert.rejects(f.scheduler.run(grant), { code: 'lease_lost' }); await f.released(); assert.deepEqual(await f.events(), before)
  assert.equal((await f.operation(grant)).state, 'completed')
  assert.deepEqual(f.refusals.slice(refused), [{ path: '/runtime/renew', code: 'lease_lost' }])
  assert.equal(f.requests.length, count)
})
