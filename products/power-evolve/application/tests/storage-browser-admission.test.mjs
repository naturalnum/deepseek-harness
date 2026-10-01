/** Real Platform HTTP admission, isolated PostgreSQL and POSIX; barriers control body and account-lock timing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import * as platform from '../lib/platform/index.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { transaction } from '../lib/platform/database.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { FileService } from '../lib/platform/files.js'
import { StorageBindingService } from '../lib/platform/storage-bindings.js'
import { WORKSPACE_BINDING_ROUTES } from '@power-evolve/contracts/workspace-binding'

const options = { timeout: 30000 }
const password = 'synthetic-storage-admission-password'
const passwordHash = hashPassword(password)
const deferred = () => Promise.withResolvers()
async function bounded(promise) {
  const stop = new AbortController()
  try {
    return await Promise.race([promise, delay(5000, undefined, { signal: stop.signal }).then(() => {
      throw new Error('Admission barrier timed out')
    })])
  } finally { stop.abort() }
}

async function isolated(run) {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s3-account-v25-qa')
  const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const name = `pe_storage_admission_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-storage-admission-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  const ctx = new Context()
  let pool, handler
  const server = createServer((req, res) => {
    assert(handler, 'Production Platform fallback must be registered')
    void handler(req, res)
  })
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl); url.pathname = `/${name}`
    url.searchParams.set('application_name', name)
    pool = new Pool({ connectionString: url.href, max: 8 })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    ctx.provide('webServer')
    ctx.set('webServer', { host: '127.0.0.1', port: server.address().port,
      registerFallback(value) { handler = value; return () => { handler = undefined } } })
    const config = platform.Config({
      databaseUrlFile: join(root, 'database-url'), workerTokenFile: join(root, 'worker-token'),
      modelKeyFile: join(root, 'model-key'), connectorKeyFile: join(root, 'connector-key'),
      workspaceRoot: join(root, 'workspaces'), artifactRoot: join(root, 'artifacts'),
      modelUrl: `${origin}/unused-model`, connectorUrl: `${origin}/unused-connector`,
      hostOrigin: origin, platformOrigin: origin, readyFile: join(root, 'ready'),
      connectorTimeoutMs: 1000, connectorPollMs: 60000, workspaceRecoveryPollMs: 60000,
      leaseMs: 5000, tokenLifetimeMs: 3600000, maxPendingPerUser: 10, maxActivePerUser: 1,
      maxHistoryBytes: 1048576, maxHistoryEvents: 100, maxEventBytes: 65536, maxRequestBytes: 65536,
      modelTimeoutMs: 1000, maxModelResponseBytes: 65536, databasePoolSize: 8, databaseTimeoutMs: 10000,
      loginWindowMs: 60000, loginAttemptsPerWindow: 20, loginTrackedAccounts: 100, loginGlobalAttemptsPerWindow: 100,
    })
    await Promise.all([
      writeFile(config.databaseUrlFile, url.href, { mode: 0o600 }),
      ...[config.workerTokenFile, config.modelKeyFile, config.connectorKeyFile]
        .map(path => writeFile(path, 'synthetic-test-only', { mode: 0o600 })),
    ])
    await ctx.plugin(platform, config)
    assert(handler, 'Production Platform fallback must be registered')
    const files = new FileService(pool, config.workspaceRoot); await files.init()
    const identities = new IdentityService(pool, config.tokenLifetimeMs)
    const user = { userId: randomUUID(), username: `admission-${randomUUID()}` }
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, await passwordHash, { model: 'fixture', maxTokens: 100, revision: 1 }])
    // Login traverses the real HTTP password endpoint and issues a normal Agent bearer.
    const login = await post(origin, '/identity/login', '', { username: user.username, password })
    assert.equal(login.status, 200)
    const token = login.body.token
    assert.equal(typeof token, 'string')
    const space = (await files.bindings.spaces(user)).items.find(value => value.isDefault)
    const rootKey = (await pool.query('SELECT root_key FROM pe_storage_spaces WHERE id=$1', [space.spaceId])).rows[0].root_key
    const workspaceId = randomUUID()
    await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,false)',
      [workspaceId, user.userId, 'Admission workspace'])
    await files.workspaceForId(user.userId, workspaceId)
    await run({ pool, root, origin, user, token, identities, files, space, rootKey, workspaceId })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await ctx.fiber.dispose()
    await pool?.end()
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
}

function pendingPost(origin, path, token, input) {
  const body = JSON.stringify(input), done = deferred()
  const req = request(origin + path, { method: 'POST', headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } }, res => {
    let text = ''
    res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
    res.on('end', () => {
      try { done.resolve({ status: res.statusCode, body: JSON.parse(text) }) }
      catch (error) { done.reject(error) }
    })
  })
  req.on('error', done.reject)
  req.flushHeaders()
  return { response: done.promise, release: () => req.end(body), destroy: () => req.destroy() }
}
function post(origin, path, token, input) {
  const pending = pendingPost(origin, path, token, input); pending.release(); return pending.response
}

async function afterInitialAuthentication(c, path, input, revoke) {
  const authenticated = deferred(), original = IdentityService.prototype.authenticate
  IdentityService.prototype.authenticate = async function (...args) {
    const user = await original.apply(this, args)
    if (args[0] === c.token) authenticated.resolve()
    return user
  }
  const pending = pendingPost(c.origin, path, c.token, input)
  try {
    await bounded(authenticated.promise)
    await revoke()
    pending.release()
    return await bounded(pending.response)
  } finally {
    IdentityService.prototype.authenticate = original
    pending.destroy()
  }
}

async function rotate(c, client) {
  const operation = async connection => {
    await lockAccountAuthorities(connection, [c.user.userId], 'update')
    // Credential-version rotation revokes the token even if its digest row remains present.
    await connection.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [c.user.userId])
  }
  if (client) await operation(client)
  else await transaction(c.pool, operation)
}
async function waitForAccountLock(c) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const blocked = await c.pool.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pe_users%FOR NO KEY UPDATE%'`)
    if (blocked.rowCount) return
    await delay(10)
  }
  throw new Error('Browser admission did not wait for the held account lock')
}

test('a committed mkdir intent continues after logout before the POSIX transaction starts', options, async () => {
  await isolated(async c => {
    const accepted = deferred(), resume = deferred(), input = inputFor(c, 'mkdir')
    // Pause only after real COMMIT releases the acceptance account lock.
    const gatedPool = { async connect() {
      const client = await c.pool.connect()
      let inserted = false
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args) => {
          const result = await target.query(...args)
          if (String(args[0]).includes('INSERT INTO pe_storage_directory_requests')) inserted = true
          if (args[0] === 'COMMIT' && inserted) { accepted.resolve(); await resume.promise }
          return result
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
    const bindings = new StorageBindingService(gatedPool, c.files.safe)
    const continuation = bindings.createDirectory(c.user, input, c.token)
    try {
      await bounded(accepted.promise)
      assert.equal((await c.pool.query('SELECT state FROM pe_storage_directory_requests WHERE request_id=$1', [input.requestId])).rows[0].state, 'accepted')
      assert.equal((await post(c.origin, '/identity/logout', c.token, {})).status, 200)
      resume.resolve()
      assert.deepEqual(await bounded(continuation), { name: input.name, path: input.name })
      assert.equal((await c.pool.query('SELECT state FROM pe_storage_directory_requests WHERE request_id=$1', [input.requestId])).rows[0].state, 'completed')
      assert.equal((await post(c.origin, routeFor('mkdir'), c.token, input)).status, 401)
    } finally { resume.resolve(); await continuation }
  })
})

test('a recovery accepted through HTTP completes after logout while browser replay is denied', options, async () => {
  await isolated(async c => {
    const input = inputFor(c, 'restore')
    const acceptance = await post(c.origin, routeFor('restore'), c.token, input)
    assert.equal(acceptance.status, 200); assert.equal(acceptance.body.state, 'accepted')
    assert.equal((await post(c.origin, '/identity/logout', c.token, {})).status, 200)
    assert.equal((await post(c.origin, routeFor('restore'), c.token, input)).status, 401)
    assert.equal(await c.files.bindings.poll(async () => {
      throw new Error('Proven free mount needs no Kubernetes stop')
    }, new AbortController().signal, { ownerId: randomUUID(), leaseMs: 5000 }), true)
    const receipt = await c.files.bindings.status(c.user, { requestId: input.requestId })
    assert.equal(receipt.state, 'completed'); assert.equal(receipt.bindingGeneration, 2)
    assert.equal((await c.pool.query('SELECT count(*)::int AS count FROM pe_workspace_binding_requests WHERE request_id=$1', [input.requestId])).rows[0].count, 1)
  })
})
function inputFor(c, kind) {
  return kind === 'mkdir'
    ? { requestId: randomUUID(), spaceId: c.space.spaceId, parentPath: '', name: 'denied-directory' }
    : { requestId: randomUUID(), workspaceId: c.workspaceId, spaceId: c.space.spaceId,
      rootRelativePath: '', expectedGeneration: 1 }
}
const routeFor = kind => kind === 'mkdir' ? WORKSPACE_BINDING_ROUTES.storageDirectoryCreate : WORKSPACE_BINDING_ROUTES.workspaceBindingRestore
async function effects(c, input) {
  const directory = (await c.pool.query('SELECT request_id FROM pe_storage_directory_requests WHERE request_id=$1', [input.requestId])).rowCount
  const recovery = (await c.pool.query('SELECT request_id FROM pe_workspace_binding_requests WHERE request_id=$1', [input.requestId])).rowCount
  let pathCreated = false
  try { await access(join(c.root, 'workspaces', c.rootKey, 'denied-directory')); pathCreated = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const workspace = (await c.pool.query('SELECT binding_generation,binding_state,recovery_request_id FROM pe_workspaces WHERE id=$1', [c.workspaceId])).rows[0]
  return { directory, recovery, pathCreated, workspace }
}
async function denied(c, input, response) {
  const observed = await effects(c, input)
  assert([401, 403].includes(response.status), `Expected denied admission; observed ${JSON.stringify({ status: response.status, ...observed })}`)
  assert.deepEqual(observed, { directory: 0, recovery: 0, pathCreated: false,
    workspace: { binding_generation: '1', binding_state: 'ready', recovery_request_id: null } })
}

for (const kind of ['mkdir', 'restore']) {
  for (const revocation of ['logout', 'credential rotation']) {
    test(`${kind} rejects ${revocation} while the real HTTP body is delayed`, options, async () => {
      await isolated(async c => {
        const input = inputFor(c, kind)
        const response = await afterInitialAuthentication(c, routeFor(kind), input, async () => {
          if (revocation === 'logout') assert.equal((await post(c.origin, '/identity/logout', c.token, {})).status, 200)
          else await rotate(c)
        })
        await denied(c, input, response)
      })
    })
  }
  test(`${kind} rechecks credentials after waiting for the real account lock`, options, async () => {
    await isolated(async c => {
      const input = inputFor(c, kind), lock = await c.pool.connect()
      const authenticated = deferred(), original = IdentityService.prototype.authenticate
      IdentityService.prototype.authenticate = async function (...args) {
        const user = await original.apply(this, args)
        if (args[0] === c.token) authenticated.resolve()
        return user
      }
      const pending = pendingPost(c.origin, routeFor(kind), c.token, input)
      try {
        await bounded(authenticated.promise)
        await lock.query('BEGIN')
        await lockAccountAuthorities(lock, [c.user.userId], 'update')
        pending.release()
        await waitForAccountLock(c)
        await rotate(c, lock)
        await lock.query('COMMIT')
        await denied(c, input, await bounded(pending.response))
      } finally {
        await lock.query('ROLLBACK'); lock.release()
        IdentityService.prototype.authenticate = original
        pending.destroy()
      }
    })
  })
}
