/** Isolated real PG plus short-lived TLS prove one-use effects and quiescent worker cancellation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { Pool } from 'pg'
import { identity, PlatformError } from '../lib/contracts.js'
import { mcpLeaseOwnerId } from '../lib/mcp-contracts.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { McpActionStore } from '../lib/platform/mcp-actions.js'
import { McpConnectionService } from '../lib/platform/mcp-connections.js'
import { McpActionWorker, McpActionWorkerError } from '../lib/platform/mcp-action-worker.js'
import { TaskStore } from '../lib/platform/tasks.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s6-mcp-dev')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const budgets = { timeoutMs: 5_000, idleTimeoutMs: 2_000, maxRequestBytes: 65_536,
  maxResponseBytes: 65_536, maxTotalResponseBytes: 262_144, maxResponseHeaderBytes: 16_384,
  maxRequests: 32, maxHeaderBytes: 8_192, maxHeaders: 16, maxPages: 4, maxTools: 8, maxCatalogBytes: 65_536 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 120_000, maxPendingPerUser: 64, maxActivePerUser: 64,
  remoteMcpAdmission: { maxTools: 8, maxSnapshotBytes: 131_072, maxToolBytes: 16_384, maxDescriptionBytes: 8_192 } }
const actionLimits = { maxArgumentBytes: 8_192, maxResultBytes: 65_536, maxCallsPerChain: 4,
  maxPendingPerUser: 16, chainLifetimeMs: 120_000, approvalLifetimeMs: 120_000, leaseMs: 10_000, listLimit: 50 }
const tools = ['write', 'other'].map(name => ({ name, description: '原始\u0000表😀 literal \\u0000',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true, idempotentHint: true }, extension: { nested: ['\u0000', { original: true }] } }))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const turn = () => new Promise(done => setImmediate(done))
const workerError = code => error => {
  assert(error instanceof McpActionWorkerError)
  assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.cause, undefined)
  return true
}

async function fixture(t) {
  const database = `pe_mcp_worker_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000 })
  let pool, created = false, server, temporary
  const closes = [], routes = new Map(), serverErrors = []
  t.after(async () => {
    if (server?.listening) {
      const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed
    }
    await Promise.all(closes)
    if (temporary) await rm(temporary, { recursive: true, force: true })
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 6, connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000 })
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
  const users = ['alice', 'bob'].map(username => identity.parse({ userId: randomUUID(), username }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$2,64,true)',
      [user.userId, 'fixture'])
  }
  temporary = await mkdtemp(join(tmpdir(), 'pe-s6-action-worker-'))
  const keyPath = join(temporary, 'key.pem'), certPath = join(temporary, 'ca.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=mcp-action.test',
    '-addext', 'subjectAltName=DNS:mcp-action.test'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(generated.signal, null); assert.equal(generated.error, undefined)
  assert.equal(generated.status, 0, generated.stderr)
  const ca = await readFile(certPath, 'utf8')
  server = createServer({ key: await readFile(keyPath), cert: ca }, (request, response) => {
    const handle = async () => {
      const route = routes.get(request.url)
      assert(route); assert.equal(route.snapshotTransactionOpen, false)
      assert.equal(request.headers.authorization, `Bearer ${route.token}`)
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const encoded = Buffer.concat(chunks).toString('utf8'), message = encoded ? JSON.parse(encoded) : {}
      route.messages.push({ method: message.method ?? request.method, session: request.headers['mcp-session-id'],
        arguments: message.params?.arguments })
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return }
      if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return }
      const rpc = value => { response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...value })) }
      if (message.method === 'server/discover') { rpc({ error: { code: -32601, message: 'legacy fixture' } }); return }
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', randomUUID())
        rpc({ result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'action-fixture', version: '1' } } }); return
      }
      if (message.method === 'tools/list') {
        route.listed++
        if (message.params?.cursor === 'tail') rpc({ result: { tools: [route.tools[1]] } })
        else rpc({ result: { tools: [route.tools[0]], nextCursor: 'tail' } })
        return
      }
      assert.equal(message.method, 'tools/call'); assert.equal(message.params.name, 'write')
      route.calls++; route.callStarted.resolve()
      if (route.mode === 'drop') { request.socket.destroy(); return }
      if (route.mode === 'hang') {
        request.socket.once('close', () => route.networkClosed.resolve()); return
      }
      rpc({ result: { content: [{ type: 'text', text: message.params.arguments.text,
        extension: { original: '\u0000' } }], structuredContent: message.params.arguments,
        extension: { raw: '\u0000表😀' } } })
    }
    void handle().catch(error => { serverErrors.push(error); request.socket.destroy() })
  })
  server.on('connection', socket => { closes.push(new Promise(done => socket.once('close', done))) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `https://mcp-action.test:${server.address().port}`
  const networkPolicy = { internalExceptions: [{ origin, addresses: ['127.0.0.1'], ca }],
    resolve: async () => [{ address: '127.0.0.1', family: 4 }] }
  const key = randomBytes(32).toString('base64url'), tasks = new TaskStore(pool, taskLimits)
  const store = new McpActionStore(tasks, key, actionLimits)
  const management = { maxConnections: 64, maxPendingTickets: 8, maxActiveChecks: 8, maxDrafts: 32,
    maxDraftsPerHour: 64, maxTools: 8, maxCatalogBytes: 65_536, maxToolBytes: 16_384,
    ticketLifetimeMs: 60_000, checkLifetimeMs: 60_000, draftLifetimeMs: 120_000,
    retentionMs: 3_600_000, checkLeaseMs: 10_000, assertEndpoint(endpoint) { assert.equal(new URL(endpoint).origin, origin) } }
  const connections = new McpConnectionService(pool, key, management)
  t.after(() => assert.deepEqual(serverErrors, []))
  const context = async (st, user = users[0], decision = 'once') => {
    const path = '/' + randomUUID(), token = 'fixture-' + randomUUID()
    const route = { token, tools: structuredClone(tools), mode: 'reply', calls: 0, listed: 0, messages: [],
      callStarted: deferred(), networkClosed: deferred(), snapshotTransactionOpen: false }
    routes.set(path, route)
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, bearerToken: token }))
    const ticket = await connections.issueTicket(user, { purpose: 'create', requestId: randomUUID(), sizeBytes: bytes.length,
      configuration: { displayName: 'Fixture', enabled: true, serverUrl: origin + path,
        authentication: { kind: 'bearer', action: 'replace' } } }, origin)
    const connection = (await connections.upload(ticket.ticket, Readable.from([bytes]))).item
    st.after(async () => { await pool.query('UPDATE pe_mcp_remote_connections SET enabled=false WHERE id=$1', [connection.connectionId]) })
    const { sessionId } = await tasks.create(user, randomUUID())
    const check = await connections.startCheck(user, { requestId: randomUUID(), sessionId,
      connectionId: connection.connectionId, baseRevision: connection.revision })
    const checkLease = await connections.claimCheck(mcpLeaseOwnerId.parse(randomUUID()))
    assert.equal(checkLease.checkId, check.checkId)
    await connections.finishCheck(checkLease, { tools })
    await tasks.accept(user, sessionId, randomUUID(), '调用 write 并保留原始结果')
    const grant = await tasks.claim(randomUUID()); assert.equal(grant.sessionId, sessionId)
    const tool = grant.remoteMcpTools.find(tool => tool.raw.name === 'write')
    const input = { callKey: randomUUID(), toolName: tool.model.name, arguments: { text: '\u0000表😀 literal \\u0000' } }
    const action = await store.propose(grant.token, input)
    if (decision) await store.decide(user, action.actionId, action.fingerprint, decision)
    const snapshot = async preparation => {
      assert.equal(preparation.owner.userId, user.userId)
      route.snapshotTransactionOpen = true
      try {
        return await transaction(pool, client => connections.runtimeSnapshot(client, preparation.owner, {
          connectionId: preparation.tool.connectionId, revision: preparation.tool.connectionRevision,
          configurationRevision: preparation.tool.configurationRevision,
          credentialRevision: preparation.tool.credentialRevision, catalogId: preparation.tool.catalogId }))
      } finally { route.snapshotTransactionOpen = false }
    }
    return { user, route, connection, sessionId, grant, input, action, snapshot }
  }
  const row = async c => (await pool.query('SELECT * FROM pe_mcp_actions WHERE id=$1', [c.action.actionId])).rows[0]
  const continuationCount = async c => (await pool.query('SELECT count(*)::int AS n FROM pe_operations WHERE source_mcp_action_id=$1',
    [c.action.actionId])).rows[0].n
  return { pool, users, key, tasks, store, connections, networkPolicy, context, row, continuationCount, closes }
}

function launch(t, f, c, storeOverrides = {}, options = {}) {
  const controller = new AbortController(), trace = [], stats = { claims: 0, renewals: 0, finishes: 0, outcomes: [] }
  const finished = deferred()
  const port = {
    async claim(owner) { stats.claims++; return f.store.claim(owner) },
    async renew(lease) { stats.renewals++; trace.push('renew-start'); await f.store.renew(lease); trace.push('renew-end') },
    preparation: lease => f.store.preparation(lease),
    authorizeDispatch: (lease, digest) => f.store.authorizeDispatch(lease, digest),
    async finish(lease, outcome) {
      stats.finishes++; stats.outcomes.push(outcome); trace.push('finish-start'); finished.resolve()
      try { return await f.store.finish(lease, outcome) }
      finally { trace.push('finish-end'); controller.abort() }
    },
    ...storeOverrides,
  }
  const worker = new McpActionWorker(port, { ownerId: mcpLeaseOwnerId.parse(randomUUID()), pollMs: 50,
    renewMs: 25, budgets, networkPolicy: f.networkPolicy, snapshot: c.snapshot, ...options })
  const run = worker.run(controller.signal); run.catch(() => {})
  t.after(async () => {
    controller.abort()
    await worker.stop().catch(() => {}); await run.catch(() => {})
  })
  return { worker, run, controller, port, trace, stats, finished }
}

test('MCP action executor uses real PG authority and a short-lived TLS endpoint', { timeout: 60_000 }, async t => {
  const f = await fixture(t)
  await t.test('two users receive original results through isolated private snapshots and sessions', async st => {
    const first = await f.context(st), second = await f.context(st, f.users[1])
    const a = launch(st, f, first); await a.run
    const b = launch(st, f, second); await b.run
    for (const c of [first, second]) {
      const row = await f.row(c)
      assert.equal(row.state, 'succeeded'); assert(row.dispatch_id)
      assert.equal(row.result.content[0].text, c.input.arguments.text)
      assert.deepEqual(row.result.content[0].extension, { original: '\u0000' })
      assert.deepEqual(row.result.extension, { raw: '\u0000表😀' })
      assert.equal(c.route.calls, 1); assert.equal(c.route.listed, 2)
      assert.equal(await f.continuationCount(c), 1)
    }
    assert.notEqual(first.route.messages.find(x => x.method === 'tools/call').session,
      second.route.messages.find(x => x.method === 'tools/call').session)
    await assert.rejects(f.store.status(f.users[1], first.action.actionId), { code: 'mcp_action_not_found' })
  })
  await t.test('no human approval means no claim or network operation', async st => {
    const c = await f.context(st, f.users[0], null)
    const launched = launch(st, f, c, { async claim(owner) { const lease = await f.store.claim(owner);
      launched.controller.abort(); return lease } })
    await launched.run
    assert.equal((await f.row(c)).state, 'pending'); assert.equal(c.route.messages.length, 0)
    await f.store.cancel(c.user, c.action.actionId)
  })
  await t.test('wrong snapshot owner cannot read credentials or send a request', async st => {
    const c = await f.context(st)
    const { run } = launch(st, f, c, {}, { snapshot: preparation => transaction(f.pool, client =>
      f.connections.runtimeSnapshot(client, f.users[1], { connectionId: preparation.tool.connectionId,
        revision: preparation.tool.connectionRevision, configurationRevision: preparation.tool.configurationRevision,
        credentialRevision: preparation.tool.credentialRevision, catalogId: preparation.tool.catalogId })) })
    await run
    assert.equal((await f.row(c)).error_code, 'mcp_connection_revoked'); assert.equal(c.route.messages.length, 0)
  })
  for (const mode of ['permission', 'connection', 'catalog']) await t.test(`${mode} changes before authorization prevent every POST`, async st => {
    const c = await f.context(st, f.users[0], mode === 'permission' ? 'persistent' : 'once')
    const auth = async (lease, digest) => {
      if (mode === 'permission') {
        const permissionId = (await f.row(c)).permission_id; await f.store.revoke(c.user, permissionId)
      } else if (mode === 'connection') {
        await f.connections.toggle(c.user, { requestId: randomUUID(), connectionId: c.connection.connectionId,
          baseRevision: c.connection.revision, enabled: false })
      }
      return f.store.authorizeDispatch(lease, digest)
    }
    if (mode === 'catalog') c.route.tools[1].extension.nested.push('directory changed outside selected tool')
    const { run } = launch(st, f, c, { authorizeDispatch: auth })
    await run
    const row = await f.row(c)
    assert.equal(row.state, 'failed'); assert.equal(row.dispatch_id, null); assert.equal(c.route.calls, 0)
    assert.equal(row.error_code, `mcp_${mode === 'permission' ? 'permission_revoked' : mode === 'connection' ? 'connection_revoked' : 'catalog_changed'}`)
    assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('lost authorization COMMIT acknowledgement is uncertain and cannot become dispatch rejection', async st => {
    const c = await f.context(st)
    const { run, stats } = launch(st, f, c, { async authorizeDispatch(lease, digest) {
      assert.equal(await f.store.authorizeDispatch(lease, digest), true)
      throw new Error('private COMMIT connection lost')
    } })
    await run
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal((await f.row(c)).error_code, 'mcp_callback_uncertain')
    assert.equal(c.route.calls, 0); assert.equal(stats.finishes, 1); assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('lost remote reply sends one POST and a fresh store cannot replay the action', async st => {
    const c = await f.context(st); c.route.mode = 'drop'
    const { run } = launch(st, f, c); await run
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal(c.route.calls, 1)
    const restarted = new McpActionStore(f.tasks, f.key, actionLimits)
    assert.equal(await restarted.claim(mcpLeaseOwnerId.parse(randomUUID())), null)
    assert.equal((await restarted.propose(c.grant.token, c.input)).state, 'uncertain')
    assert.equal(c.route.calls, 1); assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('a worker lost after intent is reconciled by a fresh worker without another POST', async st => {
    const c = await f.context(st); c.route.mode = 'drop'
    const { run, stats } = launch(st, f, c, { async finish() { throw new Error('worker lost before finish acknowledgement') } })
    await assert.rejects(run, workerError('mcp_action_finish_uncertain'))
    assert.equal((await f.row(c)).state, 'dispatch-intent'); assert.equal(stats.claims, 1); assert.equal(c.route.calls, 1)
    await f.pool.query("UPDATE pe_mcp_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.action.actionId])
    const restarted = new McpActionStore(f.tasks, f.key, actionLimits)
    const next = launch(st, f, c, { async claim(owner) { const lease = await restarted.claim(owner); next.controller.abort(); return lease } })
    await next.run
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal((await f.row(c)).error_code, 'mcp_worker_lost_after_intent')
    assert.equal(c.route.calls, 1); assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('lease expiry after the POST cancels network and recovery retains uncertainty', async st => {
    const c = await f.context(st); c.route.mode = 'hang'
    const { run } = launch(st, f, c)
    await c.route.callStarted.promise
    await f.pool.query("UPDATE pe_mcp_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.action.actionId])
    await c.route.networkClosed.promise; await run
    assert.equal((await f.row(c)).state, 'dispatch-intent')
    assert.equal(await new McpActionStore(f.tasks, f.key, actionLimits).claim(mcpLeaseOwnerId.parse(randomUUID())), null)
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal(c.route.calls, 1)
  })
  await t.test('unknown renewal failure after intent aborts the socket and stores only a fixed uncertain code', async st => {
    const c = await f.context(st); c.route.mode = 'hang'
    const launched = launch(st, f, c, { async renew(lease) {
      await c.route.callStarted.promise
      await f.store.renew(lease)
      throw new Error('private renewal COMMIT acknowledgement lost')
    } })
    await c.route.networkClosed.promise; await launched.run
    const row = await f.row(c)
    assert.equal(row.state, 'uncertain'); assert.equal(row.error_code, 'mcp_aborted'); assert.equal(c.route.calls, 1)
    assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('stop waits for the private snapshot transaction and starts no network afterward', async st => {
    const entered = deferred(), release = deferred()
    st.after(() => release.resolve())
    const c = await f.context(st)
    const { worker, run } = launch(st, f, c, {}, { snapshot: async preparation => {
      c.route.snapshotTransactionOpen = true
      try {
        return await transaction(f.pool, async client => {
          const snapshot = await f.connections.runtimeSnapshot(client, preparation.owner, {
            connectionId: preparation.tool.connectionId, revision: preparation.tool.connectionRevision,
            configurationRevision: preparation.tool.configurationRevision,
            credentialRevision: preparation.tool.credentialRevision, catalogId: preparation.tool.catalogId })
          entered.resolve(); await release.promise; return snapshot
        })
      } finally { c.route.snapshotTransactionOpen = false }
    } })
    await entered.promise
    let stopped = false; const stop = worker.stop().then(() => { stopped = true })
    await turn(); assert.equal(stopped, false)
    assert.equal((await f.row(c)).state, 'preparing')
    release.resolve(); await Promise.all([stop, run])
    assert.equal((await f.row(c)).state, 'failed'); assert.equal(c.route.messages.length, 0)
  })
  await t.test('private snapshot failures do not copy credential or database text into a durable result', async st => {
    const c = await f.context(st)
    const { run } = launch(st, f, c, {}, { snapshot: async () => { throw new Error('Bearer private database password') } })
    await run
    const row = await f.row(c)
    assert.equal(row.state, 'failed'); assert.equal(row.error_code, 'mcp_action_snapshot_failed')
    assert.equal(c.route.messages.length, 0)
  })
  for (const when of ['before-commit', 'after-commit']) await t.test(`stop waits for authorization ${when} before writing an uncertain terminal state`, async st => {
    const c = await f.context(st), entered = deferred(), release = deferred(), trace = []
    st.after(() => release.resolve())
    const auth = async (lease, digest) => {
      trace.push('auth-start')
      let permitted
      if (when === 'after-commit') permitted = await f.store.authorizeDispatch(lease, digest)
      entered.resolve(); await release.promise
      if (when === 'before-commit') permitted = await f.store.authorizeDispatch(lease, digest)
      trace.push('auth-end'); return permitted
    }
    const launched = launch(st, f, c, { authorizeDispatch: auth, async finish(lease, outcome) {
      trace.push('finish'); return f.store.finish(lease, outcome)
    } })
    await entered.promise
    let stopped = false; const stop = launched.worker.stop().then(() => { stopped = true })
    await turn(); assert.equal(stopped, false); assert(!trace.includes('finish'))
    assert.equal((await f.row(c)).state, when === 'before-commit' ? 'preparing' : 'dispatch-intent')
    release.resolve(); await Promise.all([stop, launched.run])
    assert.deepEqual(trace, ['auth-start', 'auth-end', 'finish'])
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal(c.route.calls, 0)
    assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('transport deadline waits for a late authorization before terminal persistence', async st => {
    const c = await f.context(st), trace = []
    const launched = launch(st, f, c, { async authorizeDispatch(lease, digest) {
      trace.push('auth-start')
      // A real delayed DB dependency outlives the transport deadline; ordering is asserted below.
      await f.pool.query('SELECT pg_sleep(1.5)')
      const allowed = await f.store.authorizeDispatch(lease, digest); trace.push('auth-end'); return allowed
    }, async finish(lease, outcome) { trace.push('finish'); launched.controller.abort(); return f.store.finish(lease, outcome) } },
    { budgets: { ...budgets, timeoutMs: 1_000, idleTimeoutMs: 1_000 } })
    await launched.run
    assert.deepEqual(trace, ['auth-start', 'auth-end', 'finish'])
    const row = await f.row(c); assert.equal(row.state, 'uncertain'); assert.equal(row.error_code, 'mcp_timeout')
    assert.equal(c.route.calls, 0); assert(row.dispatch_id)
  })
  await t.test('durable cancellation during pending authorization cannot issue a late intent', async st => {
    const c = await f.context(st), entered = deferred(), release = deferred()
    st.after(() => release.resolve())
    const launched = launch(st, f, c, { async authorizeDispatch(lease, digest) {
      entered.resolve(); await release.promise; return f.store.authorizeDispatch(lease, digest)
    } })
    await entered.promise
    assert.equal((await f.store.cancel(c.user, c.action.actionId)).state, 'cancelled')
    const stop = launched.worker.stop(); release.resolve(); await Promise.all([stop, launched.run])
    assert.equal((await f.row(c)).state, 'cancelled'); assert.equal((await f.row(c)).dispatch_id, null)
    assert.equal(c.route.calls, 0); assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('stop waits for in-flight renewal and socket close before terminal persistence', async st => {
    const c = await f.context(st), renewing = deferred(), release = deferred(), trace = []
    c.route.mode = 'hang'; st.after(() => release.resolve())
    const launched = launch(st, f, c, { async renew(lease) {
      trace.push('renew-start'); renewing.resolve(); await release.promise
      await f.store.renew(lease); trace.push('renew-end')
    }, async finish(lease, outcome) { trace.push('finish'); return f.store.finish(lease, outcome) } })
    await Promise.all([c.route.callStarted.promise, renewing.promise])
    let stopped = false; const stop = launched.worker.stop().then(() => { stopped = true })
    await c.route.networkClosed.promise
    assert.equal(stopped, false); assert(!trace.includes('finish'))
    release.resolve(); await Promise.all([stop, launched.run])
    assert.deepEqual(trace, ['renew-start', 'renew-end', 'finish'])
    assert.equal((await f.row(c)).state, 'uncertain'); assert.equal(c.route.calls, 1)
  })
  await t.test('stop waits for a finish transaction and never renews or rewrites the terminal epoch', async st => {
    const c = await f.context(st), finishing = deferred(), release = deferred(), trace = []
    st.after(() => release.resolve())
    const launched = launch(st, f, c, { async renew(lease) {
      assert(!trace.includes('finish-start')); return f.store.renew(lease)
    }, async finish(lease, outcome) {
      trace.push('finish-start'); const receipt = await f.store.finish(lease, outcome)
      finishing.resolve(); await release.promise; trace.push('finish-end'); return receipt
    } })
    await finishing.promise
    let stopped = false; const stop = launched.worker.stop().then(() => { stopped = true })
    await turn(); assert.equal(stopped, false); assert.equal((await f.row(c)).state, 'succeeded')
    release.resolve(); await Promise.all([stop, launched.run])
    assert.deepEqual(trace, ['finish-start', 'finish-end']); assert.equal(c.route.calls, 1)
    assert.equal(await f.continuationCount(c), 1)
  })
  await t.test('a lost finish COMMIT acknowledgement rejects the run without a replacement result', async st => {
    const c = await f.context(st); let finishes = 0
    const launched = launch(st, f, c, { async finish(lease, outcome) {
      finishes++; await f.store.finish(lease, outcome); throw new Error('private result COMMIT acknowledgement lost')
    } })
    await assert.rejects(launched.run, workerError('mcp_action_finish_uncertain'))
    assert.equal((await f.row(c)).state, 'succeeded'); assert.equal(finishes, 1)
    assert.equal(launched.stats.claims, 1); assert.equal(c.route.calls, 1); assert.equal(await f.continuationCount(c), 1)
  })
  await Promise.all(f.closes)
})

test('poll errors delay retries, abort wakes waiting, and one worker cannot run twice', async t => {
  const controller = new AbortController(), times = []
  const port = { async claim() {
    times.push(performance.now()); if (times.length === 3) { controller.abort(); return null }
    throw new Error('private database URL')
  }, async renew() { assert.fail('no lease') }, async preparation() { assert.fail('no lease') },
  async authorizeDispatch() { assert.fail('no lease') }, async finish() { assert.fail('no lease') } }
  const options = { ownerId: mcpLeaseOwnerId.parse(randomUUID()), pollMs: 50, renewMs: 25,
    budgets, networkPolicy: {}, snapshot: async () => { assert.fail('no lease') } }
  const worker = new McpActionWorker(port, options)
  const run = worker.run(controller.signal); run.catch(() => {})
  t.after(async () => { controller.abort(); await worker.stop(); await run })
  await assert.rejects(worker.run(controller.signal), workerError('mcp_action_worker_running'))
  await run
  assert.equal(times.length, 3); assert(times[1] - times[0] >= 40); assert(times[2] - times[1] >= 40)
  await worker.run(controller.signal); assert.equal(times.length, 3)
  for (const invalid of [{ pollMs: 0 }, { renewMs: Number.NaN }, { snapshot: undefined }]) {
    assert.throws(() => new McpActionWorker(port, { ...options, ...invalid }), workerError('mcp_action_worker_config_invalid'))
  }
})
