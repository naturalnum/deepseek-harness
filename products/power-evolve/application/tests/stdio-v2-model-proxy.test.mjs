/** Real isolated PG grants and HTTP/native Messages codec; catalogs, terminal SDK evidence and provider SSE are synthetic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { digest } from '../lib/platform/identity.js'
import { proxyModel } from '../lib/platform/model.js'
import { sendFailure } from '../lib/http.js'
import { StdioOperationAdmissionV2 } from '../lib/platform/stdio-v2-operation-admission.js'
import { compileStdioOperationToolsV2 } from '../lib/stdio-v2-model-tools.js'
import { compileMcpModelTool } from '../lib/mcp-model-tools.js'
import { stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const admission = { maxConnections: 10, maxTools: 20, maxSnapshotBytes: 524288, maxDescriptionBytes: 8192 }
const budget = { maxDepth: 40, maxNodes: 10000, maxBytes: 262144 }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const image = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
const rawCatalog = JSON.parse('[{"name":"echo","description":"literal\\u0000目录😀","inputSchema":{"type":"object","properties":{"text":{"type":"string","default":{"__proto__":{"raw":"原值\\u0000😀"}}}},"required":["text"],"additionalProperties":false,"default":{"__proto__":{"annotation":true}}},"_meta":{"__proto__":{"original":true}}}]')
const settings = { model: 'deepseek-flash', maxTokens: 64, revision: 1 }
const wire = definition => ({ name: definition.name, description: definition.description, input_schema: definition.parameters })
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

test('model egress consumes only original owned STDIO declarations with current PG leases', { timeout: 60000 }, async t => {
  const databaseUrl = process.env.PE_TEST_DATABASE_URL
    ?? (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
  const database = `pe_stdio_model_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 10000 })
  let pool, proxy, upstream, created = false
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 2, statement_timeout: 10000 })
    await initializeDatabase(pool)
    const selector = new StdioOperationAdmissionV2({ bindingForId() { assert.fail('restoration must never read current storage') } },
      { limits, admission, maxReplyBytes: 524288, cloudDeployment: pin })
    const configured = { selection: selector, reservedNames: ['cloud_exec'] }
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8,
      maxActivePerUser: 1, stdioV2Admission: configured })
    const remoteRaw = { name: 'legacy_echo', inputSchema: { type: 'object' }, description: 'Remote fixture' }
    const remoteModel = compileMcpModelTool({ publicName: 'mcp__fixture__echo', raw: remoteRaw },
      { maxToolBytes: 16384, maxDescriptionBytes: 8192 })
    const remote = [{ formatVersion: 1, connectionId: randomUUID(), connectionRevision: 1, configurationRevision: 1,
      credentialRevision: null, catalogId: randomUUID(), toolId: randomUUID(), descriptorDigest: 'c'.repeat(64),
      raw: remoteRaw, model: remoteModel, modelDigest: 'd'.repeat(64) }]
    async function actor(label, { savedSelection = value => value, running = false } = {}) {
      const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), connectionId = randomUUID()
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, `${label}-${randomUUID()}`, 'synthetic-no-login', settings])
      await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)', [userId, settings.model])
      await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, userId])
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, userId, workspaceId, randomUUID(), {}])
      const configuration = { name: label, invocation: { program: 'node', argv: ['never-executed.mjs'], cwd: '.' } }
      const configDigest = sha('configuration', configuration)
      await transaction(pool, async client => {
        await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision,enabled) VALUES($1,$2,1,true)', [connectionId, userId])
        await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,1,$3,$4)',
          [connectionId, userId, JSON.stringify(configuration), configDigest])
      })
      const scopeBinding = { kind: 'cloud', userId, workspaceId, bindingGeneration: 1,
        target: { spaceId: randomUUID(), rootRelativePath: '' }, home: { kind: 'user', userId } }
      const groups = compileStdioOperationToolsV2([{ formatVersion: 2, connectionId, configRevision: 1, configDigest,
        configuration, limits, scopeBinding, expectedDeploymentPin: pin, catalogId: randomUUID(),
        catalogDigest: stdioCatalogFingerprintV2(rawCatalog, limits), rawCatalog, catalogImageExpectation: image }],
      limits, admission, ['cloud_exec', remoteModel.name])
      const operationId = randomUUID()
      await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,remote_mcp_selection,stdio_v2_selection,state)
        VALUES($1,$2,$3,'synthetic original accepted input',$4,$5,$6,$7)`,
      [operationId, sessionId, randomUUID(), settings, JSON.stringify(remote), JSON.stringify(savedSelection(groups)), running ? 'running' : 'queued'])
      const token = running ? randomBytes(32).toString('base64url') : null
      if (token) await pool.query(`UPDATE pe_sessions SET lease_epoch=1,lease_until=clock_timestamp()+interval '30 seconds',
        grant_digest=$2 WHERE id=$1`, [sessionId, digest(token)])
      return { userId, workspaceId, sessionId, connectionId, groups, operationId, token }
    }
    const alice = await actor('alice'), bob = await actor('bob')
    const aliceGrant = await tasks.claim(randomUUID()), bobGrant = await tasks.claim(randomUUID())
    assert.equal(aliceGrant.userId, alice.userId); assert.equal(bobGrant.userId, bob.userId)
    const observed = []
    upstream = createServer(async (request, response) => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
      observed.push({ body, beta: request.headers['anthropic-beta'] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture response' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 } }, { type: 'message_stop' }]
      response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
    })
    const upstreamUrl = await listen(upstream)
    const config = { url: `${upstreamUrl}/v1/messages`, apiKey: 'synthetic-only', timeoutMs: 3000,
      maxRequestBytes: 131072, maxResponseBytes: 4096, stdioV2Admission: configured }
    proxy = createServer(async (request, response) => {
      try { await proxyModel(tasks, config, request, response) } catch (error) { sendFailure(response, error) }
    })
    const proxyUrl = await listen(proxy)
    const bodyFor = owner => structuredClone({ model: settings.model, max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'literal\0prompt' }], tools: [...remote.map(tool => wire(tool.model)),
        ...owner.groups.flatMap(group => group.tools.map(tool => wire(tool.model)))] })
    async function call(token, body) {
      const response = await fetch(`${proxyUrl}/model/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, text: await response.text() }
    }
    async function refused(token, body, code, status = 403) {
      const before = observed.length, result = await call(token, body)
      assert.equal(result.status, status); assert.deepEqual(JSON.parse(result.text), { error: code }); assert.equal(observed.length, before)
    }

    await t.test('the native DeepSeek codec sends frozen declarations with original NUL and prototype-named JSON keys', async () => {
      const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ baseURL: `${proxyUrl}/model`, thinking: 'disabled',
        streamIdleTimeoutMs: 3000 }), resolveAuth: async () => ({ headers: { authorization: `Bearer ${aliceGrant.token}` } }),
      resolveUserId: () => 'synthetic-owner', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
      const chunks = await Array.fromAsync(adapter.stream({ provider: 'power-evolve', model: settings.model, maxTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'literal\0prompt' }] }],
        tools: [...remote.map(tool => tool.model), ...alice.groups.flatMap(group => group.tools.map(tool => tool.model))],
        signal: AbortSignal.timeout(5000) }))
      assert(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'fixture response'))
      const sent = observed.at(-1).body
      assert.deepEqual(sent.tools, bodyFor(alice).tools)
      assert.equal(sent.messages[0].content[0].text, 'literal\0prompt')
      assert(Object.hasOwn(sent.tools[1].input_schema.default, '__proto__'))
      assert(Object.hasOwn(sent.tools[1].input_schema.properties.text.default, '__proto__'))
      assert.equal(sent.tools[1].input_schema.properties.text.default.__proto__.raw, '原值\0😀')
    })
    await t.test('two current owner grants cannot declare each other tools or change original schemas, names or descriptions', async () => {
      assert.equal((await call(bobGrant.token, bodyFor(bob))).status, 200)
      await refused(aliceGrant.token, bodyFor(bob), 'model_tool_not_authorized')
      await refused(bobGrant.token, bodyFor(alice), 'model_tool_not_authorized')
      for (const mutate of [tool => { tool.description += ' changed' }, tool => { tool.name = 'stdio__unselected' },
        tool => { delete tool.input_schema.default.__proto__ }, tool => { tool.input_schema.properties.text.type = 'number' }]) {
        const body = bodyFor(alice); mutate(body.tools[1]); await refused(aliceGrant.token, body, 'model_tool_not_authorized')
      }
      const duplicate = bodyFor(alice); duplicate.tools.push(duplicate.tools[1])
      await refused(aliceGrant.token, duplicate, 'model_tool_duplicate')
      await refused(randomBytes(32).toString('base64url'), bodyFor(alice), 'lease_lost', 409)
    })
    await t.test('Messages history, metadata and Flash additions retain original JSON without authorizing historical names', async () => {
      const body = bodyFor(alice), history = JSON.parse('{"type":"tool_use","id":"old","name":"historical_unselected","input":{"__proto__":{"text":"历史\\u0000😀"}},"_meta":{"__proto__":{"retained":true}}}')
      body.messages = [{ role: 'assistant', content: [history] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old',
        content: [JSON.parse('{"type":"text","text":"prior\\u0000result","__proto__":{"metadata":true}}')] }] },
      { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: body.tools[1].name } }] }]
      body.tools[1].defer_loading = true
      body.system = [JSON.parse('{"type":"text","text":"leading","__proto__":{"annotation":true}}')]
      body.thinking = JSON.parse('{"type":"disabled","__proto__":{"annotation":true}}')
      body.output_config = JSON.parse('{"__proto__":{"raw":"配置\\u0000😀"}}')
      assert.equal((await call(aliceGrant.token, body)).status, 200)
      assert.deepEqual(observed.at(-1).body, body)
      assert.equal(observed.at(-1).beta, 'mid-conversation-tool-changes-2026-07-01')
      body.messages.at(-1).content[0].tool.name = 'unselected_addition'
      await refused(aliceGrant.token, body, 'model_tool_changes_invalid')
    })
    await t.test('missing selector and original selection corruption refuse egress; empty historical selections remain valid', async () => {
      const legacy = await actor('empty-original', { savedSelection: () => [], running: true })
      const original = config.stdioV2Admission; config.stdioV2Admission = undefined
      try {
        await refused(aliceGrant.token, bodyFor(alice), 'stdio_v2_admission_unavailable', 409)
        assert.equal((await call(legacy.token, { ...bodyFor(legacy), tools: [wire(remoteModel)] })).status, 200)
      } finally { config.stdioV2Admission = original }
      const corrupt = await actor('corrupt-original', { running: true, savedSelection: groups => {
        const changed = structuredClone(groups); changed[0].tools[0].model.description += ' changed'; return changed
      } })
      await refused(corrupt.token, bodyFor(corrupt), 'stdio_v2_record_invalid', 409)
      const foreign = await actor('foreign-original', { running: true, savedSelection: () => bob.groups })
      await refused(foreign.token, bodyFor(bob), 'stdio_v2_origin_changed', 409)
      config.stdioV2Admission = { ...original, reservedNames: [...original.reservedNames, alice.groups[0].tools[0].model.name] }
      try { await refused(aliceGrant.token, bodyFor(alice), 'stdio_v2_tool_name_conflict', 409) }
      finally { config.stdioV2Admission = original }
      await assert.rejects(pool.query("UPDATE pe_operations SET stdio_v2_selection='[]'::json WHERE id=$1", [alice.operationId]), { code: '23514' })
      assert.deepEqual((await pool.query('SELECT stdio_v2_selection FROM pe_operations WHERE id=$1', [alice.operationId])).rows[0].stdio_v2_selection, alice.groups)
    })
    await t.test('a formal result continuation uses its original selection after connection revision and enablement change', async () => {
      const group = alice.groups[0], actionId = randomUUID(), executionId = randomUUID(), requestId = randomUUID()
      const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, phase: 'call', actionId, userId: alice.userId,
        sessionId: alice.sessionId, connectionId: group.connectionId, configRevision: 1, configDigest: group.configDigest,
        scopeBinding: group.scopeBinding, expectedDeploymentPin: pin, invocation: group.configuration.invocation, limits,
        origin: { kind: 'operation', operationId: alice.operationId, rootOperationId: alice.operationId, callKey: 'synthetic-prior-call' },
        selection: { catalogId: group.catalogId, catalogDigest: group.catalogDigest, rawCatalog, catalogImageExpectation: image,
          rawName: rawCatalog[0].name, rawDescriptor: rawCatalog[0], arguments: { text: 'prior\0call' } } })
      const taskDigest = sha('task', task), operationId = randomUUID()
      await transaction(pool, async client => {
        await client.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [alice.operationId])
        await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL WHERE id=$1', [alice.sessionId])
        await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
          execution_target,execution_id,operation_id,root_operation_id,call_id,task,task_digest,state,continuation_request_id,continuation_queued)
          VALUES($1,$2,$3,$4,1,$5,'call','cloud',$6,$7,$7,'synthetic-prior-call',$8,$9,'succeeded',$10,true)`,
        [actionId, alice.userId, alice.sessionId, group.connectionId, group.configDigest, executionId, alice.operationId,
          JSON.stringify(task), taskDigest, requestId])
        await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,request_digest,state,
          execution_kind,origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id)
          VALUES($1,$2,$3,$4,'synthetic-prior-call',$5,'succeeded','stdio_v2','operation',2,'call',$6,$7,$8)`,
        [executionId, alice.userId, alice.sessionId, alice.operationId, taskDigest, JSON.stringify(task), actionId, requestId])
        // Only the model proxy is under test: terminal SDK/stop evidence and the continuation payload are data fixtures.
        await client.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$2,$2)',
          [actionId, JSON.stringify({ synthetic: true }), sha('result', { synthetic: true })])
        await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,source,source_stdio_v2_action_id,
          source_stdio_v2_phase,remote_mcp_selection,stdio_v2_selection,mcp_root_operation_id)
          VALUES($1,$2,$3,$4,$5,'queued','stdio_v2_result',$6,'call',$7,$8,$9)`,
        [operationId, alice.sessionId, requestId, JSON.stringify({ kind: 'stdio_v2_result', instruction: 'synthetic original continuation' }),
          settings, actionId, JSON.stringify(remote), JSON.stringify(alice.groups), alice.operationId])
        const next = { ...group.configuration, name: 'New current label' }
        await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,2,$3,$4)',
          [group.connectionId, alice.userId, JSON.stringify(next), sha('configuration', next)])
        await client.query('UPDATE pe_stdio_v2_connections SET enabled=false,revision=2 WHERE id=$1', [group.connectionId])
      })
      const continued = await tasks.claim(randomUUID())
      assert.equal(continued.source, 'stdio_v2_result'); assert.equal(continued.sourceStdioV2ActionId, actionId)
      assert.deepEqual(continued.stdioV2Connections, alice.groups)
      assert.equal((await call(continued.token, bodyFor(alice))).status, 200)
      assert.deepEqual(observed.at(-1).body.tools, bodyFor(alice).tools)
      await refused(aliceGrant.token, bodyFor(alice), 'lease_lost', 409)
      await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [alice.sessionId])
      await refused(continued.token, bodyFor(alice), 'lease_lost', 409)
    })
    await t.test('whole Messages input bytes and invalid protocol fields refuse before upstream', async () => {
      const body = bodyFor(bob); body.messages[0].content = 'x'.repeat(config.maxRequestBytes)
      await refused(bobGrant.token, body, 'request_too_large', 413)
      await refused(bobGrant.token, { ...bodyFor(bob), extra: true }, 'invalid_request', 400)
      const before = observed.length, invalid = JSON.stringify(bodyFor(bob)).replace('"stream":true',
        '"stream":true,"thinking":{"__proto__":{"invalid":1e400}}')
      const response = await fetch(`${proxyUrl}/model/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${bobGrant.token}`, 'content-type': 'application/json' }, body: invalid })
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_request' })
      assert.equal(observed.length, before)
    })
  } finally {
    try { await close(proxy); await close(upstream) }
    finally {
      try { await pool?.end() }
      finally { try { if (created) await admin.query(`DROP DATABASE "${database}"`) } finally { await admin.end() } }
    }
  }
})
