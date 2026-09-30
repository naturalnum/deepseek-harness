/** Built Host/Platform profiles, real PG and HTTP sockets; model and remote MCP are deterministic fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import yaml from 'js-yaml'
import { loadMcpPlatformConfig, assertMcpPlatformEndpoint } from '../lib/platform/mcp-platform-config.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
const settings = (directory, origin) => ({ credentialKeyFile: join(directory, 'mcp-key'), pollMs: 40, renewMs: 100,
  cleanupMs: 1000, cleanupBatchSize: 8,
  management: { maxConnections: 4, maxPendingTickets: 4, maxActiveChecks: 4, maxDrafts: 4, maxDraftsPerHour: 10,
    maxTools: 8, maxCatalogBytes: 65536, maxToolBytes: 16384, ticketLifetimeMs: 60000,
    checkLifetimeMs: 60000, draftLifetimeMs: 60000, retentionMs: 60000, checkLeaseMs: 2000 },
  admission: { maxTools: 16, maxSnapshotBytes: 131072, maxToolBytes: 16384, maxDescriptionBytes: 8192 },
  actions: { maxArgumentBytes: 8192, maxResultBytes: 65536, maxCallsPerChain: 4, maxPendingPerUser: 8,
    chainLifetimeMs: 60000, approvalLifetimeMs: 60000, leaseMs: 2000, listLimit: 50 },
  transport: { timeoutMs: 5000, idleTimeoutMs: 1000, maxRequestBytes: 16384, maxResponseBytes: 65536,
    maxTotalResponseBytes: 262144, maxResponseHeaderBytes: 16384, maxRequests: 24,
    maxHeaderBytes: 8192, maxHeaders: 16, maxPages: 4, maxTools: 8, maxCatalogBytes: 65536 },
  internalExceptions: [{ origin, addresses: ['127.0.0.1'], allowHttp: true }],
})
async function eventually(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(25) }
  throw new Error(`Timed out: ${label}`)
}
const post = (url, token, body, headers = {}) => fetch(url, { method: 'POST', redirect: 'error',
  signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) })
async function json(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text())
  return response.json()
}

test('remote MCP private configuration fails before resources open and admission performs no HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pe-mcp-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'mcp-key'), randomBytes(32).toString('base64url'), { mode: 0o600 })
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.end() })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const path = join(directory, 'config.json'), valid = settings(directory, origin)
  await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
  const config = await loadMcpPlatformConfig(path)
  assert.equal(await loadMcpPlatformConfig(''), null)
  await assertMcpPlatformEndpoint(config, `${origin}/mcp`)
  assert.equal(requests, 0)
  await assert.rejects(assertMcpPlatformEndpoint(config, 'http://127.0.0.1:1/mcp'), { status: 400 })
  await assert.rejects(assertMcpPlatformEndpoint(config, `${origin}/mcp#fragment`), { status: 400 })
  const example = JSON.parse(await readFile(join(product, 'platform/remote-mcp.example.json'), 'utf8'))
  await writeFile(path, JSON.stringify({ ...example, credentialKeyFile: valid.credentialKeyFile }))
  assert.equal((await loadMcpPlatformConfig(path)).networkPolicy.internalExceptions.length, 0)
  const invalid = [
    { ...valid, renewMs: valid.actions.leaseMs }, { ...valid, pollMs: 0 },
    { ...valid, credentialKeyFile: 'relative-key' }, { ...valid, surprise: 'ignored-config' },
    { ...valid, transport: { ...valid.transport, idleTimeoutMs: valid.transport.timeoutMs + 1 } },
    { ...valid, internalExceptions: [{ ...valid.internalExceptions[0], origin: `${origin}/path` }] },
    { ...valid, internalExceptions: [{ ...valid.internalExceptions[0], allowHttp: false }] },
    { ...valid, internalExceptions: [valid.internalExceptions[0], valid.internalExceptions[0]] },
    { ...valid, internalExceptions: [{ ...valid.internalExceptions[0], addresses: ['localhost'] }] },
  ]
  for (const value of invalid) {
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(loadMcpPlatformConfig(path), { message: 'Invalid remote MCP platform configuration' })
  }
})

test('native Agent and trusted Platform compose owner-scoped discovery, approval, two-tool continuation and uncertain recovery',
  { timeout: 90000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pe-mcp-platform-'))
    const databaseUrl = (await readFile(join(process.env.PE_PRIVATE_DIR, 'database-url'), 'utf8')).trim()
    const database = `pe_mcp_profile_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
    const children = new Set(), servers = new Set()
    let pool, created = false
    const stop = async (child, signal = 'SIGTERM') => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const done = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 10000)
      child.kill(signal)
      try { await done } finally { clearTimeout(timer); children.delete(child) }
    }
    t.after(async () => {
      for (const child of children) await stop(child)
      for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE "${database}"`)
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    })
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const db = new URL(databaseUrl); db.pathname = `/${database}`
    pool = new Pool({ connectionString: db.href, max: 3 })
    const users = ['alice', 'bob'].map(username => ({ username, password: randomBytes(20).toString('base64url'),
      settings: { model: 'fixture', maxTokens: 1024, revision: 1 } }))
    const providerKey = randomBytes(32).toString('base64url'), workerKey = randomBytes(32).toString('base64url')
    for (const [name, value] of Object.entries({ 'database-url': db.href, 'worker-token': workerKey,
      'model-key': providerKey, 'connector-key': randomBytes(32).toString('base64url'),
      'mcp-key': randomBytes(32).toString('base64url'), 'users.json': JSON.stringify(users) })) {
      await writeFile(join(directory, name), value, { mode: 0o600 })
    }
    const listen = async handler => {
      const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => res.destroy()) })
      servers.add(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
      return `http://127.0.0.1:${server.address().port}`
    }
    const remoteCalls = [], requests = [], modelRequests = []
    const shutdownReply = Promise.withResolvers(), shutdownRequested = Promise.withResolvers()
    t.after(() => shutdownReply.resolve())
    const rawTools = owner => ['first', 'second'].map(name => ({ name, description: `FIXTURE_${owner}_${name}`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { owner: { type: 'string' }, step: { type: 'string' }, text: { type: 'string' } },
        required: ['owner', 'step', 'text'] } }))
    const remoteOrigin = await listen(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 204 : 405).end(); return }
      const owner = req.url.slice(1)
      assert(['alice', 'bob'].includes(owner))
      assert.equal(req.headers.authorization, `Bearer private-${owner}`)
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
      requests.push({ owner, method: body.method })
      if (body.id === undefined) { res.writeHead(202).end(); return }
      let result
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'controlled-profile-fixture', version: '1' } }
      else if (body.method === 'tools/list') result = { tools: rawTools(owner) }
      else if (body.method === 'tools/call') {
        remoteCalls.push({ owner, name: body.params.name, args: body.params.arguments })
        if (body.params.arguments.text === 'lose') { res.destroy(); return }
        if (body.params.arguments.text === 'shutdown') { shutdownRequested.resolve(); await shutdownReply.promise }
        const structuredContent = { owner, step: body.params.name, text: body.params.arguments.text }
        result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, extension: '\0retained' }
      } else { res.writeHead(400).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    const modelOrigin = await listen(async (req, res) => {
      assert.equal(req.headers['x-api-key'], providerKey)
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
      modelRequests.push(body)
      const last = body.messages.at(-1), text = last.content.filter(block => block.type === 'text').map(block => block.text).join('')
      let owner, step, args = { text: 'exact\0结果' }, final = 'Waiting for trusted approval.'
      if (text.startsWith('MCP_TWO_STEPS:')) { owner = text.split(':')[1]; step = 'first' }
      else if (text === 'MCP_LOSE') { owner = 'alice'; step = 'first'; args = { text: 'lose' } }
      else if (text === 'MCP_SHUTDOWN') { owner = 'alice'; step = 'first'; args = { text: 'shutdown' } }
      else if (text.startsWith('{')) {
        const outcome = JSON.parse(text)
        if (outcome.kind === 'remote_mcp_result' && outcome.state === 'succeeded') {
          owner = outcome.result.structuredContent.owner
          if (outcome.result.structuredContent.text === 'shutdown') final = 'Shutdown reply retained.'
          else if (outcome.result.structuredContent.step === 'first') step = 'second'
          else final = `Completed two MCP steps for ${owner}.`
        } else if (outcome.kind === 'remote_mcp_result') final = `MCP stopped: ${outcome.state}.`
      } else if (text === 'hi') final = 'Hello.'
      const tool = step && body.tools.find(value => value.description.includes(`FIXTURE_${owner}_${step}`))
      if (step) assert(tool, 'the admitted native tool must reach the real model proxy')
      const events = [
        { type: 'message_start', message: { id: randomUUID(), model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tool
          ? { type: 'tool_use', id: `call_${randomUUID()}`, name: tool.name, input: args }
          : { type: 'text', text: final } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    const privateConfig = settings(directory, remoteOrigin)
    await writeFile(join(directory, 'remote-mcp.json'), JSON.stringify(privateConfig), { mode: 0o600 })
    let platformTarget
    const platformOrigin = await listen((req, res) => {
      if (!platformTarget) { res.writeHead(503).end(); return }
      const upstream = httpRequest(new URL(req.url, platformTarget), { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end() })
      req.pipe(upstream)
    })
    const start = async (name, platformUrl, port = 0) => {
      const home = join(directory, name), profile = join(home, 'profiles', `pe-mcp-${name}`)
      await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
      try { await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir') }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
      const rows = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })[0].insert
      const update = (id, config) => ({ id, config: { ...rows.find(row => row.id === id).config, ...config } })
      const readyFile = join(home, 'ready.json'); await rm(readyFile, { force: true })
      const patch = [update('web-server', { port })]
      if (name === 'platform') patch.push(update('power-evolve-platform', {
        databaseUrlFile: join(directory, 'database-url'), workerTokenFile: join(directory, 'worker-token'),
        modelKeyFile: join(directory, 'model-key'), connectorKeyFile: join(directory, 'connector-key'),
        seedUsersFile: join(directory, 'users.json'), remoteMcpConfigFile: join(directory, 'remote-mcp.json'),
        platformOrigin,
        modelUrl: `${modelOrigin}/messages`, connectorUrl: `${modelOrigin}/unused`,
        workspaceRoot: join(directory, 'workspaces'), artifactRoot: join(directory, 'artifacts'),
        skillLibraryRoot: join(directory, 'skills'), preinstalledSkills: [],
        sandboxKubeconfigFile: '', sandboxKeyFile: '', sandboxLocalRoot: '', sandboxNodeRoot: '',
        databaseTimeoutMs: 2000, connectorPollMs: 200, readyFile, leaseMs: 10000,
      }))
      else patch.push(update('power-evolve-runtime', { platformUrl, workerTokenFile: join(directory, 'worker-token') }),
        update('power-evolve-host', { platformOrigin: platformUrl, readyFile, pollMs: 50, renewMs: 500 }))
      await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
      const logPath = join(directory, `${name}.log`), log = openSync(logPath, 'a', 0o600)
      const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', `pe-mcp-${name}`], {
        cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: directory },
        stdio: ['ignore', log, log],
      })
      closeSync(log); children.add(child)
      const ready = await eventually(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Profile ${name} exited: ${await readFile(logPath, 'utf8')}`)
        try { return JSON.parse(await readFile(readyFile, 'utf8')) }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
      }, `${name} ready`)
      if (name === 'platform') platformTarget = ready.url
      return { child, url: name === 'platform' ? platformOrigin : ready.url }
    }
    let platform = await start('platform')
    const host = await start('host', platform.url)
    const tokens = [], approvals = []
    for (const user of users) {
      const credentials = { username: user.username, password: user.password }
      tokens.push((await json(await post(`${platform.url}/identity/login`, null, credentials))).token)
      approvals.push((await json(await post(`${platform.url}/identity/approval-login`, null, credentials))).token)
    }
    const rpcResponse = (i, method, input) => post(`${host.url}/api/powerEvolve/${method}`, tokens[i], { request: input })
    const rpc = async (i, method, input) => json(await rpcResponse(i, method, input))
    const approve = async (i, action, decision) => json(await post(`${platform.url}/approvals/mcp/decide`, approvals[i],
      { actionId: action.actionId, fingerprint: action.fingerprint, decision }))
    const sessions = []
    for (let i = 0; i < 2; i++) sessions.push((await rpc(i, 'create', { requestId: randomUUID() })).sessionId)
    await rpc(0, 'prompt', { sessionId: sessions[0], requestId: randomUUID(), text: 'hi' })
    await eventually(async () => (await rpc(0, 'page', { sessionId: sessions[0], after: -1, limit: 200 }))
      .operations.some(row => row.state === 'completed'), 'hi completion')
    assert.equal(requests.length, 0)
    const connections = []
    for (let i = 0; i < 2; i++) {
      const configuration = { displayName: users[i].username, serverUrl: `${remoteOrigin}/${users[i].username}`,
        enabled: true, authentication: { kind: 'bearer', action: 'replace' } }
      const bytes = JSON.stringify({ formatVersion: 1, bearerToken: `private-${users[i].username}` })
      const requestId = randomUUID()
      const ticket = await rpc(i, 'mcpConnectionsTicket', { purpose: 'create', requestId, configuration, sizeBytes: Buffer.byteLength(bytes) })
      assert.equal(new URL(ticket.uploadUrl).pathname, '/mcp/connections/upload')
      const upload = origin => fetch(`${platform.url}/mcp/connections/upload`, { method: 'POST', headers: {
        origin, authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/octet-stream' }, body: bytes })
      assert.equal((await upload('https://foreign.invalid')).status, 403)
      const uploaded = await json(await upload('http://127.0.0.1:18880'), 201)
      connections.push(uploaded.item)
      assert.deepEqual((await rpc(i, 'mcpConnectionsReceipt', { requestId })).result, uploaded)
      const check = await rpc(i, 'mcpConnectionsCheck', { requestId: randomUUID(), sessionId: sessions[i],
        connectionId: uploaded.item.connectionId, baseRevision: uploaded.item.revision })
      const checked = await eventually(async () => {
        const value = await rpc(i, 'mcpConnectionsCheckStatus', { checkId: check.checkId })
        assert.notEqual(value.state, 'failed', value.errorCode)
        return value.state === 'succeeded' && value
      }, 'real discovery worker')
      assert.equal(checked.discoveredTools, 2)
      assert.equal((await rpc(1 - i, 'mcpConnectionsReceipt', { requestId })).result, null)
      assert.equal((await rpcResponse(1 - i, 'mcpConnectionsCheckStatus', { checkId: check.checkId })).status, 404)
    }
    assert.equal((await rpcResponse(0, 'mcpConnectionsList', { userId: randomUUID() })).status, 400)
    assert.equal((await rpcResponse(1, 'mcpConnectionsToggle', { requestId: randomUUID(),
      connectionId: connections[0].connectionId, baseRevision: 1, enabled: false })).status, 404)
    assert.equal((await post(`${platform.url}/approvals/mcp/list`, tokens[0], {})).status, 401)
    assert.equal((await post(`${platform.url}/mcp/connections/list`, approvals[0], {})).status, 401)
    assert.equal((await post(`${platform.url}/approvals/mcp/list`, approvals[0], {}, { origin: 'https://foreign.invalid' })).status, 403)
    const firstRequest = { sessionId: sessions[0], requestId: randomUUID(), text: 'MCP_TWO_STEPS:alice' }
    const accepted = await rpc(0, 'prompt', firstRequest), repeated = await rpc(0, 'prompt', firstRequest)
    assert.equal(accepted.accepted, true); assert.equal(repeated.accepted, true)
    assert.equal(accepted.operationId, repeated.operationId)
    const nextAction = (i, count) => eventually(async () => {
      const { items } = await json(await post(`${platform.url}/approvals/mcp/list`, approvals[i], {}))
      const pending = items.filter(item => item.state === 'pending')
      return items.length >= count && pending[0]
    }, 'pending MCP action')
    const first = await nextAction(0, 1)
    assert.equal(first.tool.raw.name, 'first'); assert.equal(first.arguments.text, 'exact\0结果')
    assert.equal((await post(`${platform.url}/approvals/mcp/decide`, approvals[1],
      { actionId: first.actionId, fingerprint: first.fingerprint, decision: 'once' })).status, 404)
    const firstApproved = await approve(0, first, 'once')
    assert.equal(firstApproved.state, 'approved')
    assert.equal((await approve(0, first, 'once')).actionId, first.actionId)
    const second = await nextAction(0, 2)
    assert.equal(second.tool.raw.name, 'second')
    await approve(0, second, 'session')
    await eventually(async () => {
      const page = await rpc(0, 'page', { sessionId: sessions[0], after: -1, limit: 200 })
      return JSON.stringify(page.events).includes('Completed two MCP steps for alice.')
        && page.operations.every(row => ['completed', 'failed'].includes(row.state))
    }, 'native continuation finishes the original task')
    assert.deepEqual(remoteCalls.map(value => [value.owner, value.name]), [['alice', 'first'], ['alice', 'second']])
    const saved = (await pool.query('SELECT result FROM pe_mcp_actions WHERE id=$1', [second.actionId])).rows[0].result
    assert.equal(saved.extension, '\0retained')
    assert.equal(saved.structuredContent.text, 'exact\0结果')
    const { items } = await json(await post(`${platform.url}/approvals/mcp/list`, approvals[0], {}))
    const permissionId = items.find(item => item.actionId === second.actionId).permissionId
    assert(permissionId)
    assert.equal((await post(`${platform.url}/approvals/mcp/revoke`, approvals[1], { permissionId })).status, 404)
    await json(await post(`${platform.url}/approvals/mcp/revoke`, approvals[0], { permissionId }))

    await rpc(1, 'prompt', { sessionId: sessions[1], requestId: randomUUID(), text: 'MCP_TWO_STEPS:bob' })
    const bobAction = await nextAction(1, 1)
    assert.equal(bobAction.configuration.displayName, 'bob')
    await approve(1, bobAction, 'reject')
    assert.equal(remoteCalls.length, 2)
    await rpc(0, 'prompt', { sessionId: sessions[0], requestId: randomUUID(), text: 'MCP_SHUTDOWN' })
    const shutdown = await nextAction(0, 3); await approve(0, shutdown, 'once')
    await shutdownRequested.promise
    const blocker = await pool.connect()
    let stopping
    try {
      await blocker.query('BEGIN')
      await blocker.query("SELECT id FROM pe_users WHERE username='alice' FOR NO KEY UPDATE")
      await eventually(async () => Number((await pool.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM pe_users%'
        AND pid<>pg_backend_pid()`, [database])).rows[0].n) > 0, 'in-flight renewal waits before the remote result arrives')
      // Finish must acquire a new client after the already-running renewal settles during shutdown.
      shutdownReply.resolve()
      await delay(100)
      stopping = stop(platform.child)
      await delay(100)
      assert.equal(platform.child.exitCode, null, 'Platform shutdown must wait for owned database work')
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    await stopping
    assert.equal((await pool.query('SELECT state FROM pe_mcp_actions WHERE id=$1', [shutdown.actionId])).rows[0].state,
      'succeeded', 'an observed remote result persists before the Cordis pool disposer closes PG')
    platform = await start('platform')
    await rpc(0, 'prompt', { sessionId: sessions[0], requestId: randomUUID(), text: 'MCP_LOSE' })
    const loss = await nextAction(0, 4); await approve(0, loss, 'once')
    await eventually(async () => (await json(await post(`${platform.url}/mcp/actions/status`, tokens[0],
      { actionId: loss.actionId }))).state === 'uncertain', 'lost response becomes uncertain')
    assert.equal(remoteCalls.length, 4)
    await stop(platform.child, 'SIGKILL')
    platform = await start('platform')
    assert.equal((await json(await post(`${platform.url}/mcp/actions/status`, tokens[0], { actionId: loss.actionId }))).state, 'uncertain')
    assert.equal((await approve(0, loss, 'once')).state, 'uncertain')
    await eventually(async () => Number((await pool.query("SELECT count(*) AS n FROM pe_operations WHERE state IN ('queued','running')")).rows[0].n) === 0,
      'recovered continuations settle')
    assert.equal(remoteCalls.length, 4, 'neither restart nor repeated approval repeats tools/call')
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n, 0)
    for (let i = 0; i < 2; i++) {
      const listed = await rpc(i, 'mcpConnectionsList', {})
      assert.equal(listed.available, true)
      assert.equal(listed.items.length, 1)
    }
    // The periodic production loop, not an explicit test call, reclaims expired discovery records.
    const userId = (await pool.query("SELECT id FROM pe_users WHERE username='bob'")).rows[0].id
    const expiredCheckId = randomUUID()
    await pool.query(`INSERT INTO pe_mcp_checks(id,user_id,session_id,connection_id,connection_revision,
      configuration_revision,credential_revision,state,created_at,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,'failed',now()-interval '3 hours',now()-interval '2 hours')`,
    [expiredCheckId, userId, sessions[1], connections[1].connectionId])
    await eventually(async () => (await pool.query('SELECT id FROM pe_mcp_checks WHERE id=$1', [expiredCheckId])).rowCount === 0,
      'production cleanup loop removes old discovery')
    assert(modelRequests.some(body => body.tools?.some(tool => tool.description.includes('FIXTURE_alice_first'))))
    assert(modelRequests.some(body => body.tools?.some(tool => tool.description.includes('FIXTURE_bob_first'))))
    assert(modelRequests.every(body => !(body.tools?.some(tool => tool.description.includes('FIXTURE_alice_'))
      && body.tools?.some(tool => tool.description.includes('FIXTURE_bob_')))))
  })
