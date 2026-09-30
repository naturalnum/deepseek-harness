/** Real PG and HTTP proxy checks; tool catalogs and the model response are deterministic fixtures. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, BlockAssembler, LlmRuntime, createDeveloperMessage,
  createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { installRemoteMcpTools } from '../lib/host/mcp.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { EventStore } from '../lib/platform/events.js'
import { McpActionStore } from '../lib/platform/mcp-actions.js'
import { proxyModel } from '../lib/platform/model.js'
import { mcpCatalogTools, mcpCatalogDigest } from '../lib/platform/mcp-catalog.js'
import { TaskStore } from '../lib/platform/tasks.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const limits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16, maxActivePerUser: 2,
  remoteMcpAdmission: { maxTools: 8, maxSnapshotBytes: 131072, maxToolBytes: 32768, maxDescriptionBytes: 4096 } }

async function fixture(t) {
  const database = `pe_mcp_admit_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 8 })
  await pool.query(migrations.schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 21; version++) await pool.query(migrations[`schemaV${version}`])
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
  const users = ['alice', 'bob'].map(username => identity.parse({ username, userId: randomUUID() }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,64,true)',
      [user.userId, 'fixture'])
  }
  return { pool, users, tasks: new TaskStore(pool, limits) }
}

function rawTool(name, description = 'A fixture tool\0including preserved JSON data') {
  return { name, description, inputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { count: { type: 'integer', minimum: 1, maximum: 100 } },
    required: ['count'], additionalProperties: false }, icons: [{ src: 'https://example.org/icon.svg' }] }
}

async function connection(pool, user, rawTools, withCatalog = true) {
  const connectionId = randomUUID(), catalogId = randomUUID()
  const tools = mcpCatalogTools(connectionId, rawTools)
  await transaction(pool, async client => {
    await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
      VALUES($1,$2,$3,1,1,true)`, [connectionId, user.userId, connectionId])
    await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,configuration)
      VALUES($1,$2,1,$3)`, [connectionId, user.userId, { displayName: 'Fixture', serverUrl: 'https://example.org/mcp',
      enabled: true, authentication: { kind: 'none' } }])
    if (withCatalog) {
      await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
        VALUES($1,$2,$3,1,$4,$5)`, [catalogId, user.userId, connectionId, mcpCatalogDigest(rawTools), JSON.stringify(tools)])
      await client.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
    }
  })
  return { connectionId, catalogId, tools }
}

async function startServer(t, handler) {
  const server = createServer(handler)
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('V22 admission pins owner catalogs across retries, changes and task-store restart; model proxy uses PG definitions',
  { timeout: 30000 }, async t => {
    const { pool, users: [alice, bob], tasks } = await fixture(t)
    const aliceFirst = await connection(pool, alice, [rawTool('sum'), rawTool('lookup')])
    await connection(pool, alice, [rawTool('sum')])
    await connection(pool, alice, [])
    await connection(pool, alice, [], false)
    const bobConnection = await connection(pool, bob, [rawTool('sum')])
    const bobTool = bobConnection.tools[0]
    const session = await tasks.create(alice, randomUUID())
    const requestId = randomUUID()
    const accepted = await tasks.accept(alice, session.sessionId, requestId, 'Use my tools')
    const before = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection
    assert.equal(before.length, 3)
    assert.equal(new Set(before.map(tool => tool.model.name)).size, 3)
    assert.ok(before.every(tool => tool.model.name !== bobTool.publicName))
    assert.ok(before.every(tool => tool.raw.description.includes('\0')))
    assert.ok(before.every(tool => !('headers' in tool) && !('serverUrl' in tool)))
    assert.ok(before.every(tool => tool.model.parameters.$schema === 'https://json-schema.org/draft/2020-12/schema'))
    assert.ok(before.every(tool => tool.model.parameters.properties.count.minimum === 1
      && tool.model.parameters.properties.count.maximum === 100))
    assert.deepEqual(before[0].raw.icons, [{ src: 'https://example.org/icon.svg' }])
    await assert.rejects(tasks.accept(bob, session.sessionId, randomUUID(), 'Cross-owner'),
      { status: 404, code: 'session_not_found' })
    await assert.rejects(tasks.accept(alice, session.sessionId, requestId, 'Changed'),
      { status: 409, code: 'request_id_conflict' })

    const changedCatalog = randomUUID()
    await pool.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
      VALUES($1,$2,$3,1,$4,$5)`, [changedCatalog, alice.userId, aliceFirst.connectionId, 'c'.repeat(64),
      JSON.stringify(mcpCatalogTools(aliceFirst.connectionId, [rawTool('replacement')]))])
    await pool.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1',
      [aliceFirst.connectionId, changedCatalog])
    assert.deepEqual(await tasks.accept(alice, session.sessionId, requestId, 'Use my tools'), accepted)
    const restored = new TaskStore(pool, limits)
    const grant = await restored.claim(randomUUID())
    assert.equal(grant.operationId, accepted.operationId)
    assert.deepEqual(grant.remoteMcpTools, before)

    const upstreamRequests = []
    const upstream = await startServer(t, async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      upstreamRequests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_stop\ndata: {}\n\n')
    })
    const proxy = await startServer(t, (req, res) => {
      proxyModel(restored, { url: upstream, apiKey: 'fixture-only', timeoutMs: 1000,
        maxRequestBytes: 262144, maxResponseBytes: 8192 }, req, res).catch(error => {
        res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.code ?? 'test_failure' }))
      })
    })
    const declarations = before.map(tool => ({ name: tool.model.name,
      description: tool.model.description, input_schema: tool.model.parameters }))
    const call = tools => fetch(proxy, { method: 'POST', headers: { authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ model: 'fixture', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'fixture' }], tools }) })
    const okay = await call(declarations)
    assert.equal(okay.status, 200); await okay.text()
    assert.equal(upstreamRequests.length, 1)
    assert.deepEqual(upstreamRequests[0].tools, declarations)
    for (const changed of [
      { ...declarations[0], name: bobTool.publicName },
      { ...declarations[0], description: 'forged' },
      { ...declarations[0], input_schema: { type: 'object' } },
    ]) {
      const denied = await call([changed]); assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: 'model_tool_not_authorized' })
    }
    assert.equal(upstreamRequests.length, 1)
    for (const table of ['pe_cloud_executions', 'pe_sandbox_instances']) {
      assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0)
    }
    await restored.finish(grant.token, 'completed', null)
    const revoked = await call(declarations); assert.equal(revoked.status, 409); await revoked.text()
    assert.equal(upstreamRequests.length, 1)
    const next = await tasks.accept(alice, session.sessionId, randomUUID(), 'Use the new catalog')
    const updated = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [next.operationId]))
      .rows[0].remote_mcp_selection
    assert.equal(updated.length, 2)
    assert.ok(updated.some(tool => tool.catalogId === changedCatalog))
    assert.ok(updated.every(tool => tool.catalogId !== aliceFirst.catalogId))
    assert.deepEqual((await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection, before)
  })

test('whole-selection budgets roll back admission, and disabled/deleted connections cannot enter new inputs',
  { timeout: 30000 }, async t => {
    const { pool, users: [alice], tasks } = await fixture(t)
    const first = await connection(pool, alice, [rawTool('one')])
    const second = await connection(pool, alice, [rawTool('two')])
    const session = await tasks.create(alice, randomUUID())
    const constrained = new TaskStore(pool, { ...limits, remoteMcpAdmission: { ...limits.remoteMcpAdmission, maxTools: 1 } })
    const requestId = randomUUID()
    await assert.rejects(constrained.accept(alice, session.sessionId, requestId, 'Too many'),
      { status: 429, code: 'mcp_operation_tool_limit' })
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM pe_operations')).rows[0].count, 0)
    await pool.query('UPDATE pe_mcp_remote_connections SET enabled=false,revision=revision+1 WHERE id=$1', [first.connectionId])
    const accepted = await constrained.accept(alice, session.sessionId, requestId, 'Too many')
    const saved = (await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [accepted.operationId]))
      .rows[0].remote_mcp_selection
    assert.deepEqual(saved.map(tool => tool.connectionId), [second.connectionId])
    await pool.query('UPDATE pe_mcp_remote_connections SET deleted_at=now(),revision=revision+1 WHERE id=$1', [second.connectionId])
    const afterDelete = await tasks.accept(alice, session.sessionId, randomUUID(), 'No remote tools')
    assert.deepEqual((await pool.query('SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [afterDelete.operationId]))
      .rows[0].remote_mcp_selection, [])
    await assert.rejects(pool.query("UPDATE pe_mcp_catalog_versions SET tools='[]' WHERE id=$1", [first.catalogId]),
      /MCP snapshots are immutable/u)
  })

const toolBeta = 'mid-conversation-tool-changes-2026-07-01'
const wireChanges = body => body.messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => ['tool_addition', 'tool_removal'].includes(block.type)) : [])
const wireCalls = body => body.messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => ['tool_use', 'tool_result'].includes(block.type)) : [])

for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  test(`${model}: real native history, PG admission and proxy survive late tools, calls and connection changes`,
    { timeout: 30000 }, async t => {
      const { pool, users: [alice, bob], tasks } = await fixture(t)
      await pool.query('UPDATE pe_users SET settings=$2 WHERE id=$1',
        [alice.userId, { model, maxTokens: 64, revision: 2 }])
      await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,64,true)',
        [alice.userId, model])
      const { sessionId } = await tasks.create(alice, randomUUID())
      const events = new EventStore(tasks, { maxHistoryBytes: 2_097_152, maxHistoryEvents: 1000, maxEventBytes: 524288 })
      const actions = new McpActionStore(tasks, randomBytes(32).toString('base64url'), {
        maxArgumentBytes: 8192, maxResultBytes: 32768, maxCallsPerChain: 4, maxPendingPerUser: 8,
        chainLifetimeMs: 60000, approvalLifetimeMs: 60000, leaseMs: 10000, listLimit: 50,
      })
      const received = []
      let replyCall = false, token, turn = 0, currentGrant, nativeSession
      const upstream = await startServer(t, async (req, res) => {
        let text = ''; for await (const part of req) text += part
        const body = JSON.parse(text)
        received.push({ body, beta: req.headers['anthropic-beta'] })
        const call = replyCall; replyCall = false
        const frames = [
          { type: 'message_start', message: { id: 'fixture-message', model,
            usage: { input_tokens: 12, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: call
            ? { type: 'tool_use', id: 'native-mcp-call', name: body.tools[0].name, input: {} }
            : { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: call
            ? { type: 'input_json_delta', partial_json: '{"count":1}' }
            : { type: 'text_delta', text: 'Fixture response' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
      })
      const proxy = await startServer(t, (req, res) => {
        proxyModel(tasks, { url: upstream, apiKey: 'fixture-provider-key', timeoutMs: 5000,
          maxRequestBytes: 262144, maxResponseBytes: 8192 }, req, res).catch(error => {
          res.writeHead(error.status ?? 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: error.code ?? 'invalid_request' }))
        })
      })
      const ctx = new Context()
      t.after(() => ctx.fiber.dispose())
      await ctx.plugin(LlmRuntime)
      const options = resolveAdapterOptions({ baseURL: proxy, thinking: 'disabled', streamIdleTimeoutMs: 5000 })
      ctx.llm.registerAdapter(['power-evolve'], new DeepSeekAdapter({ options: () => options,
        resolveAuth: async () => ({ headers: { authorization: `Bearer ${token}` } }),
        resolveUserId: () => 'fixture-user', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      }))

      async function runTurn(text, invoke = false, inspect) {
        const requestId = randomUUID()
        const accepted = await tasks.accept(alice, sessionId, requestId, text)
        currentGrant = await tasks.claim(randomUUID()); token = currentGrant.token
        assert.equal(currentGrant.operationId, accepted.operationId)
        const stored = await events.runtimeSnapshot(token)
        const session = nativeSession ??= Session.create(sessionId, undefined, stored.header)
        assert.equal(session.seq, stored.eventCount)
        const pending = []
        const append = (type, data, surface = false) => {
          const event = session.append(type, data, surface ? { surfaceOp: 'append' } : undefined)
          pending.push(event); return event
        }
        const flush = async () => { await events.append(token, pending.splice(0)) }
        const position = { turn: ++turn, step: 1 }
        append('turn/start', { turn }); append('step/start', position)
        append('user/message', { ...createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'text', text }] }), id: requestId }, true)
        const tools = currentGrant.remoteMcpTools.map(tool => tool.model)
        const previous = session.requestHeader()
        const header = append('request/header', { reason: previous === undefined ? 'initial' : 'change',
          header: { config: { provider: 'power-evolve', model, maxTokens: 64 },
            ...tools.length === 0 ? {} : { tools } } })
        if (previous !== undefined) {
          const before = new Set(previous.tools?.map(tool => tool.name)), after = new Set(tools.map(tool => tool.name))
          const additions = tools.filter(tool => !before.has(tool.name)).map(tool => ({ type: 'tool-addition', toolName: tool.name }))
          const removals = (previous.tools ?? []).filter(tool => !after.has(tool.name)).map(tool => ({ type: 'tool-removal', toolName: tool.name }))
          if (additions.length + removals.length > 0) append('developer/message', { ...position,
            message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
            ...additions.length > 0 ? { headerSeq: header.seq } : {},
          }, true)
        }
        await flush()
        async function generate() {
          const assembler = new BlockAssembler(), accumulator = new AssistantStreamAccumulator()
          for await (const chunk of ctx.llm.stream({ provider: 'power-evolve', model, maxTokens: 64,
            tools: session.requestHeader().tools, toolHistory: session.toolHistory(),
            messages: session.deriveMessages(), sessionId })) {
            assembler.push(accumulator.push({ time: Date.now(), chunk }).chunk)
          }
          assert.notEqual(assembler.finish.kind, 'error')
          const message = assembler.message({ provider: 'power-evolve', model })
          append('assistant/message', { ...position, message, stream: accumulator.snapshot(),
            ...assembler.usage === undefined ? {} : { usage: assembler.usage } }, true)
          return message
        }
        replyCall = invoke
        const message = await generate()
        const request = received.at(-1)
        assert.deepEqual(request.body.tools?.map(({ defer_loading, ...declaration }) => declaration) ?? [],
          tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })))
        assert.equal(request.beta, wireChanges(request.body).length > 0 ? toolBeta : undefined)
        if (invoke) {
          const call = message.content.find(block => block.type === 'tool-call')
          assert.ok(call)
          append('tool/call', { ...position, callId: call.id, name: call.name, arguments: call.arguments })
          const toolCtx = new Context()
          try {
            await toolCtx.plugin(SystemPrompt); await toolCtx.plugin(ToolRuntime)
            installRemoteMcpTools({ ctx: toolCtx }, currentGrant, { async call(path, grant, body) {
              assert.equal(path, '/runtime/mcp/actions/propose'); assert.equal(grant, token)
              return actions.propose(grant, body)
            } }, proxy)
            const result = await toolCtx.tools.execute({ name: call.name, arguments: JSON.parse(call.arguments),
              callId: call.id, signal: new AbortController().signal })
            assert.equal(result.isError, false)
            assert.equal(JSON.parse(result.value.content[0].text).state, 'pending')
            append('tool/result', { ...position, message: createToolResultMessage({ callId: call.id,
              content: result.value.content, isError: false }) }, true)
          } finally { await toolCtx.fiber.dispose() }
          append('step/end', position); position.step++
          append('step/start', position); await flush(); await generate()
          assert.equal(wireCalls(received.at(-1).body).length, 2)
        }
        await inspect?.(request)
        append('step/end', position); append('turn/end', { turn, reason: { kind: 'completed' } })
        await flush()
        const saved = await events.runtimeSnapshot(token)
        const restored = Session.fromRestore(sessionId, saved.events, saved.header, SessionLogOffset(0), 'detached')
        assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
        assert.deepEqual(restored.toolHistory(), session.toolHistory())
        await tasks.finish(token, 'completed', null)
        return request
      }

      const hi = await runTurn('hi')
      assert.deepEqual(hi.body.tools ?? [], []); assert.deepEqual(wireChanges(hi.body), [])
      const selected = await connection(pool, alice, [rawTool('calculate')])
      const other = await connection(pool, bob, [rawTool('calculate')])
      const added = await runTurn('Use the newly installed tool', true, async request => {
        const deferred = model === 'deepseek-flash'
        assert.equal(request.body.tools[0].defer_loading, deferred ? true : undefined)
        assert.equal(wireChanges(request.body).length, deferred ? 1 : 0)
        const count = received.length
        const post = body => fetch(proxy, { method: 'POST', headers: { authorization: `Bearer ${token}`,
          'anthropic-beta': 'untrusted-beta' }, body: JSON.stringify(body) })
        const reference = { type: 'tool_addition', tool: { type: 'tool_reference', name: selected.tools[0].publicName } }
        const deferredTool = { ...request.body.tools[0], defer_loading: true }
        const activate = [{ role: 'user', content: 'fixture' }, { role: 'system', content: [reference] }]
        const attempts = [
          { ...request.body, tools: [{ ...request.body.tools[0], name: other.tools[0].publicName }] },
          { ...request.body, tools: [{ ...request.body.tools[0], description: 'forged' }] },
          { ...request.body, tools: [{ ...request.body.tools[0], input_schema: { type: 'object' } }] },
          ...[
            [{ role: 'user', content: [reference] }],
            [{ role: 'system', content: [reference] }, { role: 'user', content: 'late' }],
            [...activate, { role: 'system', content: [reference] }],
            [{ role: 'user', content: 'fixture' }],
            [{ role: 'user', content: 'fixture' }, { role: 'system', content: [{ ...reference,
              tool: { ...reference.tool, name: other.tools[0].publicName } }] }],
            [{ role: 'user', content: 'fixture' }, { role: 'system', content: [{ ...reference,
              tool: { ...reference.tool, input_schema: deferredTool.input_schema } }] }],
            [{ role: 'user', content: 'fixture' }, { role: 'system', content: [{ ...reference, description: 'inline override' }] }],
            [{ role: 'user', content: 'fixture' }, { role: 'system', content: [{ ...reference, type: 'tool_removal' }] }],
            [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: [reference] }] }],
          ].map(messages => ({ ...request.body, tools: [deferredTool], messages })),
          { ...request.body, tools: [deferredTool], messages: activate, system: [reference] },
          { ...request.body, tools: [{ ...deferredTool, defer_loading: undefined }], messages: activate },
        ]
        for (const body of attempts) {
          const denied = await post(body)
          assert.equal(denied.status, 403); await denied.text()
        }
        assert.equal(received.length, count)
        const allowed = await post(request.body)
        assert.equal(allowed.status, 200); await allowed.text()
        assert.equal(received.at(-1).beta, deferred ? toolBeta : undefined)
      })
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_mcp_actions')).rows[0].n, 1)
      const oldHistory = wireCalls(received.at(-2).body)
      await pool.query('UPDATE pe_mcp_remote_connections SET enabled=false,revision=revision+1 WHERE id=$1', [selected.connectionId])
      const initialDisabled = await runTurn('Disable the newly added tool without changing its schema')
      assert.deepEqual(initialDisabled.body.tools ?? [], []); assert.deepEqual(wireChanges(initialDisabled.body), [])
      assert.deepEqual(wireCalls(initialDisabled.body), oldHistory)
      await pool.query('UPDATE pe_mcp_remote_connections SET enabled=true,revision=revision+1 WHERE id=$1', [selected.connectionId])
      const sameCatalogRestored = await runTurn('Reenable the original catalog')
      assert.equal(sameCatalogRestored.body.tools[0].defer_loading, model === 'deepseek-flash' ? true : undefined)
      assert.deepEqual(wireChanges(sameCatalogRestored.body), wireChanges(added.body))
      assert.deepEqual(wireCalls(sameCatalogRestored.body), oldHistory)
      const editedRaw = rawTool('calculate', 'Edited description')
      editedRaw.inputSchema.properties.count.minimum = 2
      async function editCatalog(raw) {
        const id = randomUUID()
        await pool.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,catalog_digest,tools)
          VALUES($1,$2,$3,1,$4,$5)`, [id, alice.userId, selected.connectionId,
          mcpCatalogDigest([raw]), JSON.stringify(mcpCatalogTools(selected.connectionId, [raw]))])
        await pool.query('UPDATE pe_mcp_remote_connections SET revision=revision+1,current_catalog_id=$2 WHERE id=$1',
          [selected.connectionId, id])
      }
      await editCatalog(editedRaw)
      const edited = await runTurn('Continue after editing the same tool')
      assert.equal(edited.body.tools[0].input_schema.properties.count.minimum, 2)
      assert.equal(edited.body.tools[0].defer_loading, undefined)
      assert.deepEqual(wireChanges(edited.body), []); assert.deepEqual(wireCalls(edited.body), oldHistory)
      await pool.query('UPDATE pe_mcp_remote_connections SET enabled=false,revision=revision+1 WHERE id=$1', [selected.connectionId])
      for (const text of ['Continue after disabling', 'Continue with no active remote tools']) {
        const disabled = await runTurn(text)
        assert.deepEqual(disabled.body.tools ?? [], []); assert.deepEqual(wireChanges(disabled.body), [])
        assert.deepEqual(wireCalls(disabled.body), oldHistory)
      }
      await pool.query('UPDATE pe_mcp_remote_connections SET enabled=true,revision=revision+1 WHERE id=$1', [selected.connectionId])
      const reenabled = await runTurn('Continue after reenabling')
      assert.equal(reenabled.body.tools[0].name, added.body.tools[0].name)
      assert.equal(reenabled.body.tools[0].defer_loading, undefined)
      assert.deepEqual(wireChanges(reenabled.body), []); assert.deepEqual(wireCalls(reenabled.body), oldHistory)
      const changedAgain = structuredClone(editedRaw)
      changedAgain.inputSchema.properties.count.maximum = 50
      await editCatalog(changedAgain)
      const changed = await runTurn('Continue after another same-name schema change')
      assert.equal(changed.body.tools[0].input_schema.properties.count.maximum, 50)
      assert.deepEqual(wireChanges(changed.body), []); assert.deepEqual(wireCalls(changed.body), oldHistory)
      assert.ok((await pool.query('SELECT count(*)::integer AS n FROM pe_events WHERE session_id=$1', [sessionId])).rows[0].n > 40)
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n, 0)
    })
}
