/** Real built DSH Profiles/HTTP and isolated PG. Execution rows are explicit fixtures, verified against real files; no k3s or model execution. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { Pool } from 'pg'
import { runnerFileChanges, executionFilesView, type ExecutionFilesView } from '../../contracts/src/execution-files.ts'
import { FileService } from '../src/platform/files.ts'
import { ExecutionFileFactsService } from '../src/platform/execution-file-facts.ts'
import { userId } from '../src/contracts.ts'

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const runtimeRoot = resolve(process.env.PE_EXECUTION_FILES_TEST_RUNTIME_ROOT ?? sourceRoot)
const product = join(runtimeRoot, 'products/power-evolve')
const privateDir = process.env.PE_EXECUTION_FILES_TEST_PRIVATE_DIR
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
type Browser = { cookie: string; userId: string }
type Session = { sessionId: string; workspaceId: string }
type Artifact = { artifactId: string; sessionId: string; workspaceId: string; sourcePath: string; sha256: string; sizeBytes: number }
type BundleRow = { id: string; config?: Record<string, unknown> }

async function eventually<T>(check: () => Promise<T | false>, label: string): Promise<T> {
  const deadline = Date.now() + 30000
  do {
    const value = await check()
    if (value !== false) return value
    await pause(25)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-execution-files-http-'))
  await chmod(temporary, 0o700)
  const source = new URL((await readFile(join(privateDir!, 'database-url'), 'utf8')).trim())
  const database = `pe_execution_http_e2_${randomBytes(10).toString('hex')}`
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
  const url = new URL(source); url.pathname = `/${database}`
  const admin = new Pool({ connectionString: adminUrl.href, max: 1, idleTimeoutMillis: 0 })
  const pool = new Pool({ connectionString: url.href, max: 4, idleTimeoutMillis: 0 })
  let created = false, egressCalls = 0
  const children = new Set<ChildProcess>()
  const egress = createServer((_request, response) => {
    egressCalls += 1
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unexpected_test_egress"}')
  })
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(force) }
    }
    egress.closeAllConnections()
    if (egress.listening) await new Promise<void>(done => egress.close(() => done()))
    await pool.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
    await rm(temporary, { recursive: true, force: true })
    assert.equal(egressCalls, 0, 'Facts and publication must not call model/connector fixtures')
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  await new Promise<void>(done => egress.listen(0, '127.0.0.1', done))
  const address = egress.address(); assert.ok(address && typeof address !== 'string')
  const egressUrl = `http://127.0.0.1:${address.port}`
  // Logical public origins model a proxy deployment; actual Profile sockets bind port 0 atomically.
  const hostOrigin = 'http://localhost', platformOrigin = 'http://127.0.0.1'
  const users = ['alice', 'bob'].map(username => ({ username, password: randomBytes(24).toString('base64url'),
    settings: { model: 'files-http-fixture', maxTokens: 64, revision: 1 } }))
  const privateFiles = { 'database-url': url.href, 'users.json': JSON.stringify(users),
    'worker-token': randomBytes(32).toString('base64url'), 'model-key': randomBytes(32).toString('base64url'),
    'connector-key': randomBytes(32).toString('base64url') }
  for (const [name, value] of Object.entries(privateFiles)) await writeFile(join(temporary, name), value, { mode: 0o600 })

  async function start(name: 'platform' | 'host', platformUrl?: string): Promise<string> {
    const home = join(temporary, name), profileName = `power-evolve-execution-files-${name}`
    const profile = join(home, 'profiles', profileName), readyFile = join(home, 'ready.json')
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
      dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'),
      { schema: manifestSchema }) as { insert: BundleRow[] }[]
    const update = (id: string, fields: Record<string, unknown>) => {
      const row = bundle[0]!.insert.find(row => row.id === id)
      assert.ok(row, `Product bundle must declare ${id}`)
      return { id, config: { ...row.config, ...fields } }
    }
    const patch = [update('web-server', { host: '127.0.0.1', port: 0 })]
    if (name === 'platform') patch.push(update('power-evolve-platform', {
      databaseUrlFile: join(temporary, 'database-url'), workerTokenFile: join(temporary, 'worker-token'),
      seedUsersFile: join(temporary, 'users.json'), modelKeyFile: join(temporary, 'model-key'),
      connectorKeyFile: join(temporary, 'connector-key'), accountManagementFile: '', accountBootstrapFile: '',
      workspaceRoot: join(temporary, 'workspaces'), artifactRoot: join(temporary, 'artifacts'),
      skillLibraryRoot: join(temporary, 'skill-library'), preinstalledSkills: [],
      sandboxKubeconfigFile: '', sandboxKeyFile: '', sandboxNamespace: '', sandboxImage: '',
      sandboxLocalRoot: '', sandboxNodeRoot: '', sandboxVolumeClaimName: '',
      modelUrl: `${egressUrl}/model`, connectorUrl: `${egressUrl}/connector`,
      hostOrigin, platformOrigin, readyFile, databasePoolSize: 4, loginAttemptsPerWindow: 100,
    }))
    else patch.push(update('power-evolve-runtime', { platformUrl,
      workerTokenFile: join(temporary, 'worker-token') }), update('power-evolve-host', {
      origin: hostOrigin, platformOrigin, readyFile, pollMs: 100, concurrency: 1,
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const log = openSync(join(temporary, `${name}.log`), 'a', 0o600)
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', profileName], {
      cwd: runtimeRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: temporary },
      stdio: ['ignore', log, log],
    })
    closeSync(log); children.add(child)
    let startupError = false
    child.once('error', () => { startupError = true })
    const ready = await eventually(async () => {
      if (startupError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${name} Profile exited before readiness; its test log is private`)
      }
      try { return JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number; url: string } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false
        throw error
      }
    }, `${name} Profile readiness`).catch(async (failure: unknown) => {
      let diagnostic = (await readFile(join(temporary, `${name}.log`), 'utf8')).slice(-12000)
      const secrets = [source.href, source.password, decodeURIComponent(source.password), url.href,
        ...Object.values(privateFiles), ...users.map(user => user.password)].filter(Boolean).sort((a, b) => b.length - a.length)
      for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, '[redacted]')
      diagnostic = diagnostic.replace(/Bearer\s+\S+/giu, 'Bearer [redacted]').replace(/[a-z0-9_-]{32,}/giu, '[opaque]')
      throw new Error(`${failure instanceof Error ? failure.message : 'Profile startup failed'}\n${diagnostic}`)
    })
    assert.equal(ready.pid, child.pid)
    const endpoint = new URL(ready.url)
    assert.equal(endpoint.hostname, '127.0.0.1')
    assert.ok(Number(endpoint.port) > 0)
    assert.equal((await fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(2000) })).status, 200)
    return ready.url
  }
  const platformUrl = await start('platform'), hostUrl = await start('host', platformUrl)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 26)
  const browsers: Browser[] = []
  for (const user of users) {
    const login = await fetch(`${platformUrl}/identity/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: user.password }) })
    assert.equal(login.status, 200)
    const identity = await login.json() as { token: string; user: { userId: string } }
    const exchanged = await fetch(`${hostUrl}/auth/exchange`, { method: 'POST',
      headers: { origin: platformOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ token: identity.token }) })
    assert.equal(exchanged.status, 200)
    const cookie = exchanged.headers.getSetCookie().find(value => value.includes('Path=/api/powerEvolve'))?.split(';')[0]
    assert.ok(cookie)
    browsers.push({ cookie, userId: identity.user.userId })
  }
  const rpcResponse = (browser: Browser | undefined, method: string, request: unknown) => fetch(`${hostUrl}/api/powerEvolve/${method}`, {
    method: 'POST', headers: { origin: hostOrigin, 'content-type': 'application/json', ...(browser ? { cookie: browser.cookie } : {}) },
    body: JSON.stringify({ request }), signal: AbortSignal.timeout(10000),
  })
  async function rpc<T>(browser: Browser, method: string, request: unknown): Promise<T> {
    const response = await rpcResponse(browser, method, request)
    assert.equal(response.status, 200, `${method} status`)
    return response.json() as Promise<T>
  }
  async function create(browser: Browser, workspaceId?: string): Promise<Session> {
    const created = await rpc<{ sessionId: string }>(browser, 'create', { requestId: randomUUID(), ...(workspaceId ? { workspaceId } : {}) })
    const row = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2',
      [created.sessionId, browser.userId])
    return { sessionId: created.sessionId, workspaceId: row.rows[0]!.workspace_id }
  }
  async function put(browser: Browser, session: Session, path: string, bytes: Buffer): Promise<void> {
    await rpc(browser, 'filesPut', { sessionId: session.sessionId, requestId: randomUUID(), path, baseRevision: null, data: bytes.toString('base64') })
  }
  const files = new FileService(pool, join(temporary, 'workspaces')); await files.init()
  const verification = new ExecutionFileFactsService(pool, files)
  async function executionFixture(browser: Browser, session: Session, path: string, bytes: Buffer) {
    const id = randomUUID(), operationId = randomUUID(), callId = `fixture-cloud-call-${randomUUID()}`
    const verifiedFiles = await verification.verify(userId.parse(browser.userId), session.sessionId,
      runnerFileChanges.parse({ status: 'complete', files: [{ path, sizeBytes: bytes.length, sha256: hash(bytes) }], reasons: [] }))
    assert.equal(verifiedFiles.status, 'complete')
    await pool.query('INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,$4,$5,$6)',
      [operationId, session.sessionId, randomUUID(), 'Explicit HTTP execution fixture', { model: 'files-http-fixture', maxTokens: 64, revision: 1 }, 'completed'])
    await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,result)
      VALUES($1,$2,$3,$4,$5,'fixture-only','',$6,'succeeded',$7)`,
    [id, browser.userId, session.sessionId, operationId, callId, hash('fixture-only'), { exitCode: 0, stdout: '', verifiedFiles }])
    return { id, callId, verifiedFiles }
  }
  async function facts(browser: Browser, session: Session, ids: string[]): Promise<ExecutionFilesView> {
    return executionFilesView.parse(await rpc(browser, 'executionFiles', { sessionId: session.sessionId, executionIds: ids }))
  }
  const content = (browser: Browser | undefined, id: string) => fetch(`${hostUrl}/api/powerEvolve/artifacts/${id}/content`, {
    headers: { ...(browser ? { cookie: browser.cookie } : {}), 'sec-fetch-site': 'same-origin' }, signal: AbortSignal.timeout(10000),
  })
  return { pool, temporary, browsers, rpc, rpcResponse, create, put, executionFixture, facts, content, platformUrl,
    file: (session: Session, path: string) => join(temporary, 'workspaces', session.workspaceId, path) }
}

async function error(response: Response, status: number, code?: string): Promise<void> {
  assert.equal(response.status, status)
  const value = await response.json() as { error: string }
  assert.deepEqual(Object.keys(value), ['error'])
  if (code) assert.equal(value.error, code)
}

test('Host/Platform real HTTP preserves Session facts, dual-user isolation and conditional immutable publication', {
  skip: privateDir ? false : 'Set PE_EXECUTION_FILES_TEST_PRIVATE_DIR to existing PG configuration', timeout: 90000,
}, async t => {
  const f = await fixture(t), alice = f.browsers[0]!, bob = f.browsers[1]!
  const aliceSession = await f.create(alice), bobSession = await f.create(bob)
  const projectResponse = await fetch(`${f.platformUrl}/workspaces/create`, { method: 'POST',
    headers: { authorization: `Bearer ${alice.cookie.slice('pe_agent='.length)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), title: 'HTTP fixture project' }), signal: AbortSignal.timeout(10000) })
  assert.equal(projectResponse.status, 200)
  const project = await projectResponse.json() as { workspaceId: string }
  const aliceOther = await f.create(alice, project.workspaceId)
  const path = '报告/result.bin'
  const aliceBytes = Buffer.from([0, 255, 128, 1, 2, 3]), bobBytes = Buffer.from('bob owned bytes')
  const otherBytes = Buffer.from('other Alice Workspace')
  await f.put(alice, aliceSession, path, aliceBytes)
  await f.put(bob, bobSession, path, bobBytes)
  await f.put(alice, aliceOther, path, otherBytes)
  const a = await f.executionFixture(alice, aliceSession, path, aliceBytes)
  const b = await f.executionFixture(bob, bobSession, path, bobBytes)
  const other = await f.executionFixture(alice, aliceOther, path, otherBytes)
  const counts = async () => (await f.pool.query(`SELECT
    (SELECT count(*) FROM pe_artifacts)::int AS artifacts,
    (SELECT count(*) FROM pe_operations)::int AS operations,
    (SELECT count(*) FROM pe_cloud_executions)::int AS executions,
    (SELECT count(*) FROM pe_sandbox_instances)::int AS sandboxes,
    (SELECT count(*) FROM pe_file_mutations)::int AS mutations`)).rows[0]
  const baseline = await counts()
  let published: Artifact

  await t.test('facts retain both users and same-name private Workspaces, with repeat reads and exact call identity', async () => {
    for (const [browser, session, row, expected] of [
      [alice, aliceSession, a, aliceBytes], [bob, bobSession, b, bobBytes], [alice, aliceOther, other, otherBytes],
    ] as const) {
      const view = await f.facts(browser, session, [row.id])
      assert.equal(view.sessionId, session.sessionId)
      assert.equal(view.workspaceId, session.workspaceId)
      assert.equal(view.items[0]!.executionId, row.id)
      assert.equal(view.items[0]!.callId, row.callId)
      assert.equal(view.items[0]!.state, 'succeeded')
      assert.equal(view.items[0]!.status, 'complete')
      assert.deepEqual(view.items[0]!.files, [{ path, sizeBytes: expected.length, sha256: hash(expected) }])
      assert.deepEqual(await f.facts(browser, session, [row.id]), view)
      assert.equal(JSON.stringify(view).includes(f.temporary), false)
    }
    assert.deepEqual(await counts(), baseline)
  })

  await t.test('missing authority, foreign Sessions and mixed execution sets fail through actual Host and Platform', async () => {
    const query = { sessionId: aliceSession.sessionId, executionIds: [a.id] }
    await error(await f.rpcResponse(undefined, 'executionFiles', query), 401)
    await error(await f.rpcResponse(bob, 'executionFiles', query), 404)
    for (const executionIds of [[a.id, b.id], [a.id, other.id], [a.id, randomUUID()]]) {
      await error(await f.rpcResponse(alice, 'executionFiles', { sessionId: aliceSession.sessionId, executionIds }), 404)
    }
    await error(await f.rpcResponse(alice, 'executionFiles', { sessionId: aliceOther.sessionId, executionIds: [a.id] }), 404)
    await error(await f.rpcResponse(alice, 'executionFiles', { ...query, executionIds: [a.id, a.id] }), 400)
    await error(await fetch(`${f.platformUrl}/executions/files`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) }), 401)
    await error(await fetch(`${f.platformUrl}/executions/files`, { method: 'POST', headers: {
      authorization: `Bearer ${bob.cookie.slice('pe_agent='.length)}`, 'content-type': 'application/json',
    }, body: JSON.stringify(query) }), 404)
    assert.deepEqual(await counts(), baseline)
  })

  await t.test('conditional publication repeats one request and serves the exact immutable original content', async () => {
    const request = { sessionId: aliceSession.sessionId, requestId: randomUUID(), path, expectedRevision: hash(aliceBytes) }
    await error(await f.rpcResponse(undefined, 'artifactsPublish', request), 401)
    await error(await f.rpcResponse(bob, 'artifactsPublish', request), 404)
    published = await f.rpc<Artifact>(alice, 'artifactsPublish', request)
    assert.equal(published.sessionId, aliceSession.sessionId)
    assert.equal(published.workspaceId, aliceSession.workspaceId)
    assert.equal(published.sha256, hash(aliceBytes))
    assert.deepEqual(await f.rpc(alice, 'artifactsPublish', request), published)
    await error(await f.rpcResponse(alice, 'artifactsPublish', { ...request, expectedRevision: hash('another version') }), 409, 'request_id_conflict')
    await error(await f.rpcResponse(alice, 'artifactsPublish', { ...request, expectedRevision: undefined }), 409, 'request_id_conflict')
    const response = await f.content(alice, published.artifactId)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(aliceBytes.length))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), aliceBytes)
    await error(await f.content(undefined, published.artifactId), 401)
    await error(await f.content(bob, published.artifactId), 404)
    const list = await f.rpc<{ items: Artifact[] }>(alice, 'artifactsList', { sessionId: aliceSession.sessionId, limit: 10 })
    assert.deepEqual(list.items.map(item => item.artifactId), [published.artifactId])
  })

  await t.test('a changed source returns 409 without a new artifact; refreshing old facts does not silently rescan', async () => {
    const updated = Buffer.from('modified after verified completion')
    await writeFile(f.file(aliceSession, path), updated)
    const before = await counts()
    await error(await f.rpcResponse(alice, 'artifactsPublish', { sessionId: aliceSession.sessionId,
      requestId: randomUUID(), path, expectedRevision: hash(aliceBytes) }), 409, 'artifact_source_changed')
    assert.deepEqual(await counts(), before)
    const old = await f.facts(alice, aliceSession, [a.id])
    assert.equal(old.items[0]!.files[0]!.sha256, hash(aliceBytes))
    assert.deepEqual(Buffer.from(await (await f.content(alice, published.artifactId)).arrayBuffer()), aliceBytes)
    // A second explicit execution fixture is freshly verified, rather than upgrading the old stored fact.
    const newer = await f.executionFixture(alice, aliceSession, path, updated)
    const latest = await f.facts(alice, aliceSession, [newer.id, a.id])
    assert.deepEqual(latest.items.map(item => item.executionId), [newer.id, a.id])
    assert.deepEqual(latest.items.map(item => item.files[0]!.sha256), [hash(updated), hash(aliceBytes)])
    const retry = await f.rpc<Artifact>(alice, 'artifactsPublish', { sessionId: aliceSession.sessionId,
      requestId: randomUUID(), path, expectedRevision: latest.items[0]!.files[0]!.sha256 })
    assert.deepEqual(Buffer.from(await (await f.content(alice, retry.artifactId)).arrayBuffer()), updated)
  })

  await t.test('Bob publishes his same-name file with his own digest and cannot publish Alice facts in his Workspace', async () => {
    const before = await counts()
    await error(await f.rpcResponse(bob, 'artifactsPublish', { sessionId: bobSession.sessionId,
      requestId: randomUUID(), path, expectedRevision: hash(aliceBytes) }), 409, 'artifact_source_changed')
    assert.deepEqual(await counts(), before)
    const bobArtifact = await f.rpc<Artifact>(bob, 'artifactsPublish', { sessionId: bobSession.sessionId,
      requestId: randomUUID(), path, expectedRevision: hash(bobBytes) })
    assert.equal(bobArtifact.workspaceId, bobSession.workspaceId)
    assert.deepEqual(Buffer.from(await (await f.content(bob, bobArtifact.artifactId)).arrayBuffer()), bobBytes)
    await error(await f.content(alice, bobArtifact.artifactId), 404)
  })

  await t.test('current account disable denies facts, publication and content without affecting Bob', async () => {
    const before = await counts()
    await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.userId])
    await error(await f.rpcResponse(alice, 'executionFiles', { sessionId: aliceSession.sessionId, executionIds: [a.id] }), 401)
    await error(await f.rpcResponse(alice, 'artifactsPublish', { sessionId: aliceSession.sessionId,
      requestId: randomUUID(), path, expectedRevision: hash(aliceBytes) }), 401)
    await error(await f.content(alice, published.artifactId), 401)
    assert.equal((await f.facts(bob, bobSession, [b.id])).items[0]!.status, 'complete')
    assert.deepEqual(await counts(), before)
  })
  assert.equal((await counts()).sandboxes, 0)
})
