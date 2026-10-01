/** Real PG and built DSH Profiles. Model/connector egress is a rejecting fixture and must remain unused. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { closeSync, openSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { Pool } from 'pg'
import unzipper from 'unzipper'
import { FILE_DOWNLOAD_CONTENT_PATH, FILE_DOWNLOAD_MAX_URL_BYTES, FILE_DOWNLOAD_PLATFORM_PATH,
  fileDownloadContentRequest, fileDownloadUrl, fileDownloadView, type FileDownloadView } from '../../contracts/src/file-download.ts'
import { PlatformError } from '../src/contracts.ts'
import { parseFileDownloadQuery, proxyFileDownload, writeFileDownload } from '../src/file-download-http.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
// The source URL selects only the existing PG instance. Every test creates a different random database.
const privateDir = process.env.PE_FILE_DOWNLOAD_TEST_PRIVATE_DIR
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))

// A controllable socket adapter is used only by focused writer tests, never by the Profile integration below.
class SocketFixture extends EventEmitter {
  chunks: Uint8Array[] = []
  ended = false
  status = 0
  headers: Record<string, string> = {}
  block = false
  write(chunk: Uint8Array): boolean { this.chunks.push(chunk); return !this.block }
  end(): void { this.ended = true }
  writeHead(status: number, headers: Record<string, string>): void { this.status = status; this.headers = headers }
  get response(): ServerResponse { return this as unknown as ServerResponse }
}

test('actual content-query parser rejects duplicate authority, extra fields, malformed JSON and wire overflow', () => {
  const request = fileDownloadContentRequest.parse({ sessionId: randomUUID(), paths: ['报告/结果.txt', 'a.bin'], revision: 'a'.repeat(64) })
  const path = fileDownloadUrl(request), url = new URL(path, 'https://host.example.test')
  assert.deepEqual(parseFileDownloadQuery(url), request)
  assert.deepEqual(parseFileDownloadQuery(new URL(`${FILE_DOWNLOAD_PLATFORM_PATH}${url.search}`, 'https://platform.example.test')), request)
  for (const query of [`${path}&token=credential`, `${path}&root=/private`, `${path}&sessionId=${request.sessionId}`,
    `${path}&paths=%5B%22other%22%5D`, `${path}&revision=${request.revision}`, path.replace('&revision=', '&unexpected='),
    `${FILE_DOWNLOAD_CONTENT_PATH}?sessionId=${request.sessionId}&paths=%5B&revision=${request.revision}`]) {
    assert.throws(() => parseFileDownloadQuery(new URL(query, url)), { status: 400 })
  }
  for (const paths of ['null', '1', '{}', '["../a"]', '["a","a"]']) {
    const query = new URLSearchParams({ sessionId: request.sessionId, paths, revision: request.revision })
    assert.throws(() => parseFileDownloadQuery(new URL(`${FILE_DOWNLOAD_CONTENT_PATH}?${query}`, url)))
  }
  assert.throws(() => parseFileDownloadQuery(new URL(`${path}&extra=${'a'.repeat(FILE_DOWNLOAD_MAX_URL_BYTES)}`, url)),
    { status: 413, code: 'download_limit' })
})

test('writer waits for socket drain and rechecks authority before each further byte and completion', async () => {
  const socket = new SocketFixture(); socket.block = true
  let pulls = 0, checks = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++
    if (pulls <= 2) controller.enqueue(Uint8Array.of(pulls))
    else controller.close()
  } }, { highWaterMark: 0 })
  const writing = writeFileDownload(body, socket.response, 2, new AbortController().signal, async () => { checks++ })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pulls, 1, 'A blocked socket must stop the next source read')
  assert.equal(checks, 1)
  assert.equal(socket.ended, false)
  socket.block = false; socket.emit('drain')
  await writing
  assert.deepEqual(socket.chunks.map(chunk => [...chunk]), [[1], [2]])
  assert.equal(checks, 3)
  assert.equal(socket.ended, true)
  assert.equal(body.locked, false)
})

test('writer disconnect while waiting for drain cancels the source, releases its reader and emits no completion', async () => {
  const socket = new SocketFixture(); socket.block = true
  const abort = new AbortController()
  let cancelled = false, pulls = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(Uint8Array.of(1)) },
    cancel() { cancelled = true } }, { highWaterMark: 0 })
  const writing = writeFileDownload(body, socket.response, 2, abort.signal)
  await new Promise(resolve => setImmediate(resolve))
  abort.abort()
  await assert.rejects(writing, { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.equal(pulls, 1)
  assert.equal(socket.ended, false)
  assert.equal(body.locked, false)
})

test('writer rejects truncated, oversized and revoked output before claiming a complete attachment', async () => {
  for (const [actual, expected] of [[1, 2], [3, 2]]) {
    const socket = new SocketFixture()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(actual!)); controller.close() } })
    await assert.rejects(writeFileDownload(body, socket.response, expected!, new AbortController().signal),
      { status: 502, code: 'download_length_mismatch' })
    assert.equal(socket.ended, false)
    assert.equal(body.locked, false)
    if (actual! > expected!) assert.equal(socket.chunks.length, 0)
  }
  const socket = new SocketFixture()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Uint8Array.of(1)) },
    cancel() { cancelled = true } }, { highWaterMark: 0 })
  await assert.rejects(writeFileDownload(body, socket.response, 1, new AbortController().signal,
    async () => { throw new PlatformError(401, 'unauthorized') }), { status: 401 })
  assert.equal(cancelled, true)
  assert.equal(socket.chunks.length, 0)
  assert.equal(socket.ended, false)
})

test('Host proxy binds its credential-free query, safe headers, error codes and response byte ceiling', async t => {
  const request = fileDownloadContentRequest.parse({ sessionId: randomUUID(), paths: ['报告/result.bin'], revision: 'a'.repeat(64) })
  const token = randomBytes(32).toString('base64url')
  let mode = 'valid', observed = 0
  const upstream = createServer((incoming, response) => {
    observed++
    assert.equal(incoming.headers.authorization, `Bearer ${token}`)
    const url = new URL(incoming.url!, 'http://127.0.0.1')
    assert.equal(url.pathname, FILE_DOWNLOAD_PLATFORM_PATH)
    assert.deepEqual(parseFileDownloadQuery(url), request)
    assert.equal(url.href.includes(token), false)
    if (mode === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }).end(); return }
    if (mode === 'changed') { response.writeHead(409).end('{"error":"download_changed"}'); return }
    if (mode === 'private-error') { response.writeHead(404).end('{"error":"file_not_found","token":"must-not-pass"}'); return }
    if (mode === 'large-error') { response.writeHead(413).end('x'.repeat(1100)); return }
    if (mode === 'malformed-error') { response.writeHead(404).end('not JSON'); return }
    if (mode === 'unexpected-error') { response.writeHead(503).end('{"error":"private_internal_reason"}'); return }
    const headers = { 'content-type': mode === 'wrong-mime' ? 'text/plain' : 'application/octet-stream',
      'content-length': mode === 'too-large' ? String(2 * 1024 * 1024 + 1) : '4',
      'content-disposition': 'inline; filename="untrusted.html"', 'cache-control': 'public' }
    response.writeHead(200, headers)
    // Invalid headers are refused before the promised body can arrive.
    if (mode === 'too-large') { response.flushHeaders(); return }
    response.end(Buffer.from([0, 255, 128, 1]))
  })
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const socket = new SocketFixture()
  await proxyFileDownload(origin, token, request, socket.response, AbortSignal.timeout(2000))
  assert.equal(socket.status, 200)
  assert.deepEqual(Buffer.concat(socket.chunks), Buffer.from([0, 255, 128, 1]))
  assert.equal(socket.headers['content-disposition'], "attachment; filename*=UTF-8''result.bin")
  assert.equal(socket.headers['cache-control'], 'no-store')
  assert.equal(socket.headers['x-content-type-options'], 'nosniff')
  assert.equal(socket.ended, true)
  for (const [next, status, code] of [['changed', 409, 'download_changed'], ['private-error', 502, 'download_unavailable'],
    ['large-error', 502, 'download_unavailable'], ['malformed-error', 502, 'download_unavailable'],
    ['unexpected-error', 502, 'download_unavailable'], ['wrong-mime', 502, 'download_unavailable'],
    ['too-large', 502, 'download_unavailable']] as const) {
    mode = next
    const denied = new SocketFixture()
    await assert.rejects(proxyFileDownload(origin, token, request, denied.response, AbortSignal.timeout(2000)), { status, code })
    assert.equal(denied.status, 0)
    assert.equal(denied.chunks.length, 0)
  }
  mode = 'redirect'
  const before = observed
  await assert.rejects(proxyFileDownload(origin, token, request, new SocketFixture().response, AbortSignal.timeout(2000)))
  assert.equal(observed, before + 1, 'Redirect targets must never receive a request')
})

async function eventually<T>(check: () => Promise<T | false>, label: string, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await check()
    if (value !== false) return value
    await pause(25)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

async function port(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return address.port
}

type BundleRow = { id: string; config?: Record<string, unknown> }
type Profile = { process: ChildProcess; url: string }
type Browser = { cookie: string; userId: string; username: string; password: string }
type Session = { sessionId: string; workspaceId: string }

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-download-http-'))
  await chmod(temporary, 0o700)
  const source = new URL((await readFile(join(privateDir!, 'database-url'), 'utf8')).trim())
  const database = `pe_download_http_${randomBytes(10).toString('hex')}`
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
  const url = new URL(source); url.pathname = `/${database}`
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
  const pool = new Pool({ connectionString: url.href, max: 3 })
  let created = false, egressCalls = 0
  const children = new Set<ChildProcess>()
  const responses = new Set<IncomingMessage>()
  const egress = createServer((_request, response) => {
    egressCalls++
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unexpected_test_egress"}')
  })
  t.after(async () => {
    for (const response of responses) response.destroy()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await exited } finally { clearTimeout(force) }
    }
    egress.closeAllConnections()
    if (egress.listening) await new Promise<void>(resolve => egress.close(() => resolve()))
    await pool.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
    await rm(temporary, { recursive: true, force: true })
    assert.equal(egressCalls, 0, 'Download must never call the model or connector fixture')
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  await new Promise<void>(resolve => egress.listen(0, '127.0.0.1', resolve))
  const address = egress.address()
  assert.ok(address && typeof address !== 'string')
  const egressUrl = `http://127.0.0.1:${address.port}`
  const platformPort = await port(), hostPort = await port()
  const platformOrigin = `http://127.0.0.1:${platformPort}`, hostOrigin = `http://127.0.0.1:${hostPort}`
  const users = ['alice', 'bob'].map(username => ({ username, password: randomBytes(24).toString('base64url'),
    settings: { model: 'download-fixture', maxTokens: 64, revision: 1 } }))
  for (const [name, value] of Object.entries({ 'database-url': url.href, 'users.json': JSON.stringify(users),
    'worker-token': randomBytes(32).toString('base64url'), 'model-key': randomBytes(32).toString('base64url'),
    'connector-key': randomBytes(32).toString('base64url') })) {
    await writeFile(join(temporary, name), value, { mode: 0o600 })
  }

  async function start(name: 'platform' | 'host'): Promise<Profile> {
    const home = join(temporary, name), profileName = `power-evolve-download-${name}`
    const profile = join(home, 'profiles', profileName), readyFile = join(home, 'ready.json')
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
      dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'),
      { schema: manifestSchema }) as { insert: BundleRow[] }[]
    const rows = bundle[0]!.insert
    const update = (id: string, fields: Record<string, unknown>) => {
      const row = rows.find(row => row.id === id)
      assert.ok(row, `Product bundle must declare ${id}`)
      return { id, config: { ...row.config, ...fields } }
    }
    const patch = [update('web-server', { host: '127.0.0.1', port: name === 'platform' ? platformPort : hostPort })]
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
    else patch.push(update('power-evolve-runtime', { platformUrl: platformOrigin,
      workerTokenFile: join(temporary, 'worker-token') }), update('power-evolve-host', {
      origin: hostOrigin, platformOrigin, readyFile, pollMs: 100,
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const log = openSync(join(temporary, `${name}.log`), 'a', 0o600)
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', profileName], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: temporary },
      stdio: ['ignore', log, log],
    })
    closeSync(log); children.add(child)
    let startupError = false
    child.once('error', () => { startupError = true })
    const ready = await eventually(async () => {
      if (startupError || child.exitCode !== null || child.signalCode !== null) {
        // Logs remain private and are never dumped into test output.
        throw new Error(`${name} Profile exited before readiness; inspect its private test log`)
      }
      try { return JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number; url: string } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false
        throw error
      }
    }, `${name} Profile readiness`, 30000)
    assert.equal(ready.pid, child.pid)
    assert.equal(ready.url, name === 'platform' ? platformOrigin : hostOrigin)
    assert.equal((await fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(2000) })).status, 200)
    return { process: child, url: ready.url }
  }
  const platform = await start('platform'), host = await start('host')
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 25)
  const browsers: Browser[] = []
  for (const user of users) {
    const login = await fetch(`${platform.url}/identity/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: user.password }) })
    assert.equal(login.status, 200)
    const identity = await login.json() as { token: string; user: { userId: string } }
    const exchange = await fetch(`${host.url}/auth/exchange`, { method: 'POST',
      headers: { origin: platform.url, 'content-type': 'application/json' }, body: JSON.stringify({ token: identity.token }) })
    assert.equal(exchange.status, 200)
    const cookie = exchange.headers.getSetCookie().find(value => value.includes('Path=/api/powerEvolve'))?.split(';')[0]
    assert.ok(cookie)
    browsers.push({ ...user, cookie, userId: identity.user.userId })
  }

  function rpcResponse(browser: Browser | undefined, method: string, request: unknown, signal?: AbortSignal) {
    return fetch(`${host.url}/api/powerEvolve/${method}`, { method: 'POST',
      headers: { origin: host.url, 'content-type': 'application/json', ...(browser ? { cookie: browser.cookie } : {}) },
      body: JSON.stringify({ request }), signal: signal ?? AbortSignal.timeout(10000) })
  }
  async function rpc<T>(browser: Browser, method: string, request: unknown): Promise<T> {
    const response = await rpcResponse(browser, method, request)
    assert.equal(response.status, 200, `${method} status`)
    return response.json() as Promise<T>
  }
  async function create(browser: Browser, workspaceId?: string): Promise<Session> {
    const value = await rpc<{ sessionId: string }>(browser, 'create', { requestId: randomUUID(), ...(workspaceId ? { workspaceId } : {}) })
    const row = (await pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2',
      [value.sessionId, browser.userId])).rows[0] as { workspace_id: string }
    return { sessionId: value.sessionId, workspaceId: row.workspace_id }
  }
  async function put(browser: Browser, session: Session, path: string, data: Buffer): Promise<void> {
    await rpc(browser, 'filesPut', { sessionId: session.sessionId, requestId: randomUUID(), path,
      baseRevision: null, data: data.toString('base64') })
  }
  async function prepare(browser: Browser, session: Session, paths: string[]): Promise<FileDownloadView> {
    return fileDownloadView.parse(await rpc(browser, 'filesDownloadPrepare', { sessionId: session.sessionId, paths }))
  }
  function content(browser: Browser | undefined, path: string, signal?: AbortSignal) {
    return fetch(new URL(path, host.url), { headers: { ...(browser ? { cookie: browser.cookie } : {}),
      'sec-fetch-site': 'same-origin' }, signal: signal ?? AbortSignal.timeout(15000) })
  }
  async function pausedContent(browser: Browser, path: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(path, host.url), { headers: { cookie: browser.cookie, 'sec-fetch-site': 'same-origin' } }, response => {
        response.pause()
        response.on('error', () => { /* Assertions on the consuming request own aborted response errors. */ })
        responses.add(response)
        response.once('close', () => responses.delete(response))
        resolve(response)
      })
      request.once('error', reject)
      request.setTimeout(15000, () => request.destroy(new Error('HTTP test client timeout')))
      request.end()
    })
  }
  function file(session: Session, path: string) { return join(temporary, 'workspaces', session.workspaceId, path) }
  return { pool, temporary, host, platform, browsers, rpc, rpcResponse, create, put, prepare, content, pausedContent, file }
}

function headers(response: Response, view: FileDownloadView): void {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), view.contentType)
  assert.equal(response.headers.get('content-length'), String(view.totalBytes))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const disposition = response.headers.get('content-disposition')!
  assert.match(disposition, /^attachment;/u)
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1]
  assert.ok(encoded, 'Attachment name must support Unicode without header injection')
  assert.equal(decodeURIComponent(encoded), view.fileName)
}

async function error(response: Response, status: number, code?: string): Promise<void> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const value = await response.json() as { error: string }
  assert.deepEqual(Object.keys(value), ['error'])
  if (code) assert.equal(value.error, code)
  else assert.match(value.error, /^[a-z][a-z0-9_]*$/u)
}

test('workspace downloads cross real Host and Platform Profiles with V25 accounts and bounded cancellation',
  { skip: privateDir ? false : 'Set PE_FILE_DOWNLOAD_TEST_PRIVATE_DIR to an existing PG private configuration', timeout: 120000 }, async t => {
    const f = await fixture(t), [alice, bob] = f.browsers as [Browser, Browser]
    const aliceDefault = await f.create(alice), bobDefault = await f.create(bob)
    const projectResponse = await fetch(`${f.platform.url}/workspaces/create`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.cookie.slice('pe_agent='.length)}` },
      body: JSON.stringify({ requestId: randomUUID(), title: 'Download project' }) })
    assert.equal(projectResponse.status, 200)
    const project = await projectResponse.json() as { workspaceId: string }
    const aliceProject = await f.create(alice, project.workspaceId)
    const selected = new Map([
      ['报告/结果 #1%.txt', Buffer.from('带有换行的真实下载\nsecond line\n')],
      ['left/same.bin', Buffer.from([0, 255, 128, 13, 10, 0, 1])],
      ['right/same.bin', Buffer.from([1, 0, 254, 127])], ['empty.bin', Buffer.alloc(0)],
    ])
    for (const [path, data] of selected) await f.put(alice, aliceProject, path, data)
    await f.put(alice, aliceDefault, 'scope.txt', Buffer.from('default workspace'))
    await f.put(alice, aliceProject, 'scope.txt', Buffer.from('project workspace'))
    await f.put(bob, bobDefault, 'scope.txt', Buffer.from('bob workspace'))
    const counts = async () => (await f.pool.query(`SELECT
      (SELECT count(*)::integer FROM pe_sandbox_instances) AS sandboxes,
      (SELECT count(*)::integer FROM pe_artifacts) AS artifacts,
      (SELECT count(*)::integer FROM pe_file_mutations) AS mutations,
      (SELECT count(*)::integer FROM pe_sessions) AS sessions,
      (SELECT count(*)::integer FROM pe_operations) AS operations`)).rows[0]
    const baseline = await counts()

    await t.test('repeated preparation is read-only and each Session stays bound to its own Workspace', async () => {
      for (const [browser, session, expected] of [[alice, aliceDefault, 'default workspace'],
        [alice, aliceProject, 'project workspace'], [bob, bobDefault, 'bob workspace']] as const) {
        const view = await f.prepare(browser, session, ['scope.txt'])
        assert.equal(view.sessionId, session.sessionId)
        assert.equal(view.workspaceId, session.workspaceId)
        assert.deepEqual(await f.prepare(browser, session, ['scope.txt']), view)
        const response = await f.content(browser, view.downloadUrl)
        headers(response, view)
        assert.equal(await response.text(), expected)
      }
      assert.deepEqual(await counts(), baseline)
    })

    await t.test('single raw bytes and ZIP entries preserve exact text, binary, Unicode and relative basenames', async () => {
      for (const [path, bytes] of selected) {
        const view = await f.prepare(alice, aliceProject, [path])
        assert.equal(view.fileName, path.split('/').at(-1))
        assert.equal(view.sourceBytes, bytes.length)
        assert.equal(view.totalBytes, bytes.length)
        const response = await f.content(alice, view.downloadUrl)
        headers(response, view)
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
      }
      const paths = [...selected.keys()], view = await f.prepare(alice, aliceProject, paths)
      assert.equal(view.fileCount, paths.length)
      assert.equal(view.sourceBytes, [...selected.values()].reduce((sum, value) => sum + value.length, 0))
      const response = await f.content(alice, view.downloadUrl)
      headers(response, view)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.length, view.totalBytes)
      const archive = await unzipper.Open.buffer(bytes)
      assert.deepEqual(archive.files.map(entry => entry.path), paths)
      for (const entry of archive.files) {
        assert.equal(entry.type, 'File')
        assert.deepEqual(await entry.buffer(), selected.get(entry.path))
      }
      assert.equal(JSON.stringify(view).includes(f.temporary), false)
      assert.deepEqual(await counts(), baseline)
    })

    await t.test('every prepare and GET rejects missing authority, another user and an unknown Session', async () => {
      const paths = ['scope.txt'], view = await f.prepare(alice, aliceProject, paths)
      await error(await f.rpcResponse(undefined, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths }), 401)
      await error(await f.content(undefined, view.downloadUrl), 401)
      await error(await f.rpcResponse(bob, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths }), 404)
      await error(await f.content(bob, view.downloadUrl), 404)
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: randomUUID(), paths }), 404)
      const unknown = fileDownloadUrl(fileDownloadContentRequest.parse({ sessionId: randomUUID(), paths, revision: view.revision }))
      await error(await f.content(alice, unknown), 404)
      const direct = `${FILE_DOWNLOAD_PLATFORM_PATH}${view.downloadUrl.slice(FILE_DOWNLOAD_CONTENT_PATH.length)}`
      await error(await fetch(new URL(direct, f.platform.url)), 401)
      await error(await fetch(new URL(direct, f.platform.url), { headers: { authorization: `Bearer ${bob.cookie.slice('pe_agent='.length)}` } }), 404)
      const deniedOrigin = await fetch(new URL(view.downloadUrl, f.host.url), { headers: {
        cookie: alice.cookie, 'sec-fetch-site': 'cross-site', origin: 'https://outside.example' } })
      await error(deniedOrigin, 403)
    })

    await t.test('query ambiguity, traversal, invalid revision and configured resource ceilings are refused', async () => {
      const view = await f.prepare(alice, aliceProject, ['scope.txt'])
      for (const query of [`${view.downloadUrl}&sessionId=${aliceProject.sessionId}`, `${view.downloadUrl}&token=credential`,
        view.downloadUrl.replace(`revision=${view.revision}`, 'revision=invalid'),
        `${FILE_DOWNLOAD_CONTENT_PATH}?sessionId=${aliceProject.sessionId}&paths=%5B&revision=${view.revision}`,
        `${FILE_DOWNLOAD_CONTENT_PATH}?sessionId=${aliceProject.sessionId}&paths=null&revision=${view.revision}`]) {
        await error(await f.content(alice, query), 400)
      }
      for (const paths of [[], ['scope.txt', 'scope.txt'], ['../scope.txt'], ['/workspace/scope.txt'], ['a\\b'],
        Array.from({ length: 101 }, (_, i) => `file-${i}`)]) {
        await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths }), 400)
      }
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId,
        paths: ['scope.txt'], workspaceId: bobDefault.workspaceId }), 400)
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId,
        paths: Array.from({ length: 33 }, (_, i) => `file-${i}`) }), 413)
      const oversizedQuery = `${view.downloadUrl}&extra=${'a'.repeat(FILE_DOWNLOAD_MAX_URL_BYTES)}`
      await error(await f.content(alice, oversizedQuery), 413)
      await writeFile(f.file(aliceProject, 'oversized.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['oversized.bin'] }), 413)
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['missing.bin'] }), 404)
      const paths = Array.from({ length: 17 }, (_, i) => `total-limit-${i}.bin`)
      await writeFile(f.file(aliceProject, paths[0]!), Buffer.alloc(2 * 1024 * 1024))
      for (const path of paths.slice(1)) await link(f.file(aliceProject, paths[0]!), f.file(aliceProject, path))
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths }), 413)
    })

    await t.test('same-size replacement, deletion and ZIP order changes invalidate prepared revision; fresh prepare retries', async () => {
      const path = 'scope.txt', original = await f.prepare(alice, aliceProject, [path])
      await writeFile(f.file(aliceProject, path), Buffer.from('changed workspace'))
      await error(await f.content(alice, original.downloadUrl), 409, 'download_changed')
      const fresh = await f.prepare(alice, aliceProject, [path])
      assert.notEqual(fresh.revision, original.revision)
      assert.equal(await (await f.content(alice, fresh.downloadUrl)).text(), 'changed workspace')
      const paths = ['left/same.bin', 'right/same.bin'], zipped = await f.prepare(alice, aliceProject, paths)
      const reordered = fileDownloadUrl(fileDownloadContentRequest.parse({ sessionId: aliceProject.sessionId,
        paths: [...paths].reverse(), revision: zipped.revision }))
      await error(await f.content(alice, reordered), 409, 'download_changed')
      await rm(f.file(aliceProject, path))
      await error(await f.content(alice, fresh.downloadUrl), 409, 'download_changed')
      await writeFile(f.file(aliceProject, path), Buffer.from('retry available'))
      const retry = await f.prepare(alice, aliceProject, [path])
      assert.equal(await (await f.content(alice, retry.downloadUrl)).text(), 'retry available')
    })

    await t.test('backpressure retains bounded user slots; disconnect releases them and a new prepare succeeds', async () => {
      const paths = Array.from({ length: 16 }, (_, i) => `stream-${String(i).padStart(2, '0')}.bin`)
      const data = randomBytes(1024 * 1024)
      for (const path of paths) await writeFile(f.file(aliceProject, path), data)
      const abort = new AbortController()
      const interrupted = f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths }, abort.signal)
      const cancel = setTimeout(() => abort.abort(), 5)
      try { await assert.rejects(interrupted, { name: 'AbortError' }) } finally { clearTimeout(cancel) }
      await eventually(async () => {
        const probe = await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['scope.txt'] })
        if (probe.status === 429) { await probe.body?.cancel(); return false }
        assert.equal(probe.status, 200)
        await probe.body?.cancel()
        return true
      }, 'prepare admission released after cancellation')
      const view = await f.prepare(alice, aliceProject, paths)
      const first = await f.pausedContent(alice, view.downloadUrl), second = await f.pausedContent(alice, view.downloadUrl)
      try {
        assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200)
        await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['scope.txt'] }),
          429, 'download_busy')
        const bobView = await f.prepare(bob, bobDefault, ['scope.txt'])
        assert.equal(await (await f.content(bob, bobView.downloadUrl)).text(), 'bob workspace')
      } finally { first.destroy(); second.destroy() }
      await eventually(async () => {
        const response = await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['scope.txt'] })
        if (response.status === 429) { await response.body?.cancel(); return false }
        assert.equal(response.status, 200)
        const retry = fileDownloadView.parse(await response.json())
        return await (await f.content(alice, retry.downloadUrl)).text() === 'retry available'
      }, 'transfer slots released after disconnect')
      const retry = await f.prepare(alice, aliceProject, paths)
      const response = await f.content(alice, retry.downloadUrl)
      headers(response, retry)
      assert.equal((await response.arrayBuffer()).byteLength, retry.totalBytes)
    })

    await t.test('changing an unread late ZIP entry after headers aborts the HTTP body; retry produces a complete ZIP', async () => {
      const paths = Array.from({ length: 16 }, (_, i) => `stream-${String(i).padStart(2, '0')}.bin`)
      const view = await f.prepare(alice, aliceProject, paths)
      const response = await f.pausedContent(alice, view.downloadUrl)
      assert.equal(response.statusCode, 200)
      await writeFile(f.file(aliceProject, paths.at(-1)!), randomBytes(1024 * 1024))
      let received = 0
      await assert.rejects(async () => {
        for await (const chunk of response) received += (chunk as Buffer).length
      })
      assert.ok(received < view.totalBytes, 'Changing a late source cannot complete the prepared archive')
      const fresh = await f.prepare(alice, aliceProject, paths)
      assert.notEqual(fresh.revision, view.revision)
      const complete = await f.content(alice, fresh.downloadUrl)
      headers(complete, fresh)
      const bytes = Buffer.from(await complete.arrayBuffer())
      const archive = await unzipper.Open.buffer(bytes)
      assert.deepEqual(archive.files.map(entry => entry.path), paths)
      assert.deepEqual(await archive.files.at(-1)!.buffer(), await readFile(f.file(aliceProject, paths.at(-1)!)))
    })

    await t.test('credential revocation between prepare and GET is authoritative in Host and direct Platform', async () => {
      const view = await f.prepare(alice, aliceProject, ['scope.txt'])
      await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [alice.userId])
      await error(await f.content(alice, view.downloadUrl), 401)
      await error(await f.rpcResponse(alice, 'filesDownloadPrepare', { sessionId: aliceProject.sessionId, paths: ['scope.txt'] }), 401)
      const direct = `${FILE_DOWNLOAD_PLATFORM_PATH}${view.downloadUrl.slice(FILE_DOWNLOAD_CONTENT_PATH.length)}`
      await error(await fetch(new URL(direct, f.platform.url), { headers: { authorization: `Bearer ${alice.cookie.slice('pe_agent='.length)}` } }), 401)
      assert.equal(await (await f.content(bob, (await f.prepare(bob, bobDefault, ['scope.txt'])).downloadUrl)).text(), 'bob workspace')
    })
    assert.deepEqual(await counts(), baseline, 'Downloads must create no persistent mutation, artifact, operation or Sandbox')
  })
