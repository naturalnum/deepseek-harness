/** Actual Composer image intake over built named Profiles, PG5, SDK storage and the native Agent. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { Pool } from 'pg'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { requestImageHandleText } from '@deepseek-ai/dsh-llm'
import { CURRENT_SCHEMA_VERSION, initializeDatabase } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword } from '../lib/platform/identity.js'
import { nativeInputRecordDigest } from '../lib/native-input-ledger-records.js'
import { renderProfile } from '../../deploy/start.mjs'

const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const { chromium } = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))('playwright')
const chrome = process.env.PE_E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function waitUntil(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(label + ' deadline')
}

async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  await new Promise((done) => { server.close(done) })
  return address.port
}

/** Compare only image-storage objects; never inspect credential or unrelated deployment files. */
async function storageObjects(root) {
  const objects = []
  async function visit(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      assert(!entry.isSymbolicLink(), 'the owned image store must not contain a symlink')
      if (entry.isDirectory()) await visit(path)
      else {
        assert(entry.isFile())
        const bytes = await readFile(path)
        objects.push({ path: relative(root, path), bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await visit(root)
  return objects.sort((a, b) => a.path.localeCompare(b.path))
}

test('reject a partial image batch, attach a real PNG in Composer and finish one native image turn', { timeout: 180000 }, async () => {
  const parent = process.env.PE_E2E_EVIDENCE_DIR
  if (!parent) throw new Error('PE_E2E_EVIDENCE_DIR is required; this case never silently skips')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidence = await mkdtemp(join(parent, 'run-'))
  const home = await mkdtemp(join(tmpdir(), 'pe-employee2-browser-image-'))
  const stages = [], requests = [], browserErrors = [], network = [], nativeActions = [], nativeStreams = []
  const evidenceReads = new Set(), children = [], modelControls = []
  const workerId = randomUUID(), username = 'browser-image-owner', password = randomUUID()
  const text = 'E2E describe the PNG attached through the official Composer.'
  const imageName = 'composer-original.png', answer = 'E2E native PNG response.'
  let pool, admin, databaseName, page, browser, sessionId, userId, requestId, attachmentRoot, stream, failure
  let created = false, currentStage = 'preflight', imageProof
  const mock = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return }
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (event) => { res.write('data: ' + JSON.stringify(event) + '\n\n') }
        send({ type: 'message_start', message: { id: 'owned_image_' + requests.length, model: 'deepseek-flash',
          usage: { input_tokens: 3, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } })
        stream = { res, send }
      } catch (_invalidFixtureRequest) { res.writeHead(500).end() }
    })
  })

  async function snapshot(label) {
    if (!page || page.isClosed()) return
    await writeFile(join(evidence, label + '.aria.txt'), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: join(evidence, label + '.png'), fullPage: true })
  }
  async function stage(name, action) {
    currentStage = name
    const item = { name, startedAt: new Date().toISOString(), state: 'running' }; stages.push(item)
    await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2))
    try { await action(); item.state = 'passed' }
    catch (error) { item.state = 'failed'; item.error = String(error); throw error }
    finally { await snapshot(name); await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2)) }
  }
  async function databaseSnapshot() {
    const captured = {}
    if (!pool || !created) return captured
    for (const [name, sql] of [['schema', 'SELECT family,version FROM pe_schema'],
      ['sessions', 'SELECT id,workspace_id,header,event_count FROM pe_sessions ORDER BY created_at'],
      ['history', 'SELECT session_id,seq,event FROM pe_events ORDER BY session_id,seq'],
      ['operations', 'SELECT id,session_id,request_id,state,error_code,attempts FROM pe_operations ORDER BY created_at'],
      ['promptInputs', 'SELECT session_id,request_id,submitted,admitted FROM pe_native_prompt_inputs'],
      ['origins', 'SELECT origin_input_id,session_id,origin_operation_id,original_request_id,message_id FROM pe_native_input_origins'],
      ['cohorts', 'SELECT cohort_id,session_id,execution_operation_id,operation_epoch,writer_epoch,owner_origin_input_id,claim_count FROM pe_native_input_cohorts'],
      ['claims', 'SELECT origin_input_id,session_id,cohort_id,claim_splice_seq,cohort_ordinal FROM pe_native_input_claims'],
      ['images', "SELECT namespace,value,revision FROM pe_native_preferences WHERE namespace LIKE 'native-images:%'"]]) {
      try { captured[name] = { state: 'read', rows: (await pool.query(sql)).rows } }
      catch (error) { captured[name] = { state: 'failed', error: String(error) }; failure ??= error }
    }
    return captured
  }
  async function boot(role, profile, privateDir) {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'NODE_PATH'].includes(key) || key.startsWith('LC_')))
    const child = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', profile.name], {
      cwd: repository, env: { ...environment, DSH_HOME: join(home, 'dsh-home'), PE_PRIVATE_DIR: privateDir,
        DSH_TELEMETRY_DISABLED: '1', pnpm_config_verify_deps_before_run: 'error' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const item = { role, child, output: '', error: undefined,
      closed: new Promise((done) => { child.once('close', (code, signal) => { done({ code, signal }) }) }) }
    children.push(item)
    child.once('error', (error) => { item.error = error })
    child.stdout.on('data', (chunk) => { item.output += String(chunk) })
    child.stderr.on('data', (chunk) => { item.output += String(chunk) })
    await waitUntil(async () => {
      if (item.error) throw item.error
      if (child.exitCode !== null) throw new Error(role + ' Profile exited before readiness')
      try { await readFile(profile.readyFile); return true }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, role + ' named Profile readiness', 40000)
  }
  try {
    await writeFile(join(evidence, 'case-source.mjs'), await readFile(fileURLToPath(import.meta.url)))
    const assets = JSON.parse(await readFile(join(repository, 'products/power-evolve/cloud-web/dist/asset-list.json'), 'utf8'))
    assert(assets.includes('index.html')); assert(assets.some(path => path.startsWith('plugins/')))
    const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
    if (!urlFile) throw new Error('PE_TEST_DATABASE_URL_FILE is required for an exclusive real PG database')
    const address = new URL((await readFile(urlFile, 'utf8')).trim())
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'This case requires the owned local PG test service')
    databaseName = 'pe_employee2_image_' + randomUUID().replaceAll('-', '')
    const target = new URL(address); target.pathname = '/' + databaseName
    admin = new Pool({ connectionString: address.href, max: 1 }); pool = new Pool({ connectionString: target.href, max: 8 })
    await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true
    await initializeDatabase(pool)
    assert.deepEqual((await pool.query('SELECT family,version FROM pe_schema')).rows, [{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
    await seedNewUser(pool, username, await hashPassword(password), { model: 'deepseek-flash', maxTokens: 1000, revision: 1 })
    const owner = (await pool.query('SELECT id,settings FROM pe_users WHERE username=$1', [username])).rows[0]
    userId = owner.id; assert.equal(owner.settings.model, 'deepseek-flash')
    assert.deepEqual((await pool.query('SELECT model_id,max_tokens,enabled FROM pe_user_models WHERE user_id=$1', [userId])).rows,
      [{ model_id: 'deepseek-flash', max_tokens: 1000, enabled: true }])
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
    const modelAddress = mock.address(); assert(modelAddress && typeof modelAddress !== 'string')
    const hostPort = await unusedPort(), platformPort = await unusedPort()
    const hostOrigin = 'http://127.0.0.1:' + hostPort, platformOrigin = 'http://127.0.0.1:' + platformPort
    const privateDir = join(home, 'private'), dshHome = join(home, 'dsh-home')
    attachmentRoot = join(privateDir, 'attachments')
    await mkdir(privateDir, { mode: 0o700 }); await mkdir(dshHome, { mode: 0o700 })
    for (const name of ['worker-token', 'model-key', 'connector-key']) await writeFile(join(privateDir, name), randomUUID(), { mode: 0o600 })
    await writeFile(join(privateDir, 'native-intent-key'), randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' })
    await writeFile(join(privateDir, 'database-url'), target.href, { mode: 0o600 })
    const routingFile = join(privateDir, 'native-input-owner-routing.json')
    await writeFile(routingFile, JSON.stringify({ workerOrigins: { [workerId]: hostOrigin },
      timeoutMs: 15000, maxResponseBytes: 1048576 }), { mode: 0o600 })
    const config = { mode: 'local-http', privateDir, dshHome, hostOrigin, platformOrigin, platformInternalUrl: platformOrigin,
      rows: { host: { 'web-server': { port: hostPort }, 'power-evolve-runtime': { workerId }, 'power-evolve-host': {
        concurrency: 1, pollMs: 100, operationTimeoutMs: 150000,
      } }, platform: { 'web-server': { port: platformPort }, 'power-evolve-platform': {
        modelUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1/messages',
        connectorUrl: 'http://127.0.0.1:' + modelAddress.port + '/unused-connector',
        modelTimeoutMs: 120000, nativeInputOwnerRoutingFile: routingFile, attachmentRoot,
        seedUsersFile: '', accountManagementFile: '', preinstalledSkills: [],
      } } } }
    const platform = await renderProfile('platform', config), host = await renderProfile('host', config)
    await writeFile(join(evidence, 'ownership.json'), JSON.stringify({ databaseName, home, userId, workerId,
      hostOrigin, platformOrigin, attachmentRoot, routingFile, profiles: [platform, host], assetCount: assets.length }, null, 2))
    const original = await readFile(new URL('./fixtures/native-image-original.png', import.meta.url))
    assert.equal(original.readUInt32BE(16), 2); assert.equal(original.readUInt32BE(20), 2)
    assert.deepEqual([...original.subarray(24, 29)], [8, 2, 0, 0, 0], 'the fixture is a non-interlaced 8-bit RGB PNG')
    const idat = []
    for (let offset = 8; offset < original.length;) {
      const length = original.readUInt32BE(offset)
      if (original.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(original.subarray(offset + 8, offset + 8 + length))
      offset += length + 12
    }
    const decoded = inflateSync(Buffer.concat(idat)), fixturePixels = []
    assert.equal(decoded.length, 14)
    for (let row = 0; row < 2; row++) {
      assert.equal(decoded[row * 7], 0, 'the fixture uses unfiltered RGB scanlines')
      for (let column = 0; column < 2; column++) {
        const offset = row * 7 + 1 + column * 3
        fixturePixels.push(...decoded.subarray(offset, offset + 3), 255)
      }
    }
    const imagePath = join(evidence, imageName)
    await writeFile(imagePath, original, { mode: 0o600 })
    const rawImage = { type: 'image', mediaType: 'image/png', data: original.toString('base64'), name: imageName }
    await stage('named-profiles', async () => { await boot('platform', platform, privateDir); await boot('host', host, privateDir) })
    browser = await chromium.launch({ executablePath: chrome, headless: process.env.PE_E2E_HEADLESS !== '0' })
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    await context.tracing.start({ screenshots: true, snapshots: true })
    page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', (error) => { browserErrors.push(error.message) })
    page.on('response', (response) => {
      const url = new URL(response.url())
      network.push({ origin: url.origin, path: url.pathname, status: response.status(), method: response.request().method() })
      if (!['session/create', 'session/prompt', 'session/attachment'].some(method => url.pathname === '/native/api/' + method)) return
      const read = (async () => {
        try { nativeActions.push({ path: url.pathname, status: response.status(),
          request: response.request().postDataJSON(), response: await response.json() }) }
        catch (error) { browserErrors.push('native action evidence: ' + String(error)) }
      })()
      evidenceReads.add(read); void read.finally(() => { evidenceReads.delete(read) })
    })
    page.on('websocket', (socket) => {
      const observed = new Map()
      function record(direction, payload) {
        let frame
        try { frame = JSON.parse(String(payload)) } catch (_nonJsonFrame) { return }
        if (direction === 'sent' && frame.type === 'open'
          && ['workspace/follow', 'session/follow', 'session/control'].includes(frame.endpoint)) observed.set(frame.streamId, frame.endpoint)
        const endpoint = observed.get(frame.streamId)
        if (endpoint) nativeStreams.push({ direction, endpoint, frame })
      }
      socket.on('framesent', ({ payload }) => { record('sent', payload) })
      socket.on('framereceived', ({ payload }) => { record('received', payload) })
    })
    await stage('login-create-session', async () => {
      await page.goto(platformOrigin + '/login')
      await page.locator('#username').fill(username); await page.locator('#password').fill(password)
      await page.locator('#submit').click(); await page.waitForURL(hostOrigin + '/native/')
      await page.getByRole('dialog', { name: 'Preview Notice', exact: true }).getByRole('button', { name: 'Continue', exact: true }).click()
      await waitUntil(() => nativeActions.some(action => action.path === '/native/api/session/create'), 'initial native Session creation')
      const before = nativeActions.filter(action => action.path === '/native/api/session/create').length
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      await waitUntil(() => nativeActions.filter(action => action.path === '/native/api/session/create').length > before, 'actual New session response')
      const action = nativeActions.filter(item => item.path === '/native/api/session/create').at(-1)
      assert.equal(action.response.result.ok, true); sessionId = action.response.result.value.sessionId
      await waitUntil(() => nativeStreams.some(item => item.direction === 'received' && item.endpoint === 'workspace/follow'
        && (item.frame.value?.type === 'upsert' && item.frame.value.workspace.sessionIds.includes(sessionId)
          || item.frame.value?.type === 'baseline' && item.frame.value.value.items.some(workspace => workspace.sessionIds.includes(sessionId)))),
      'actual workspace membership of the created Session')
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    })
    await stage('supplemental-rpc-reject-partial-image-batch', async () => {
      const before = await storageObjects(attachmentRoot), rejectedId = randomUUID()
      const carrier = { type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: {
        sessionId, requestId: rejectedId, mode: 'queue', clientTimeZone: 'Asia/Shanghai',
        content: [rawImage, { ...rawImage, data: rawImage.data + '\n', name: 'bad-second.png' }, { type: 'text', text: 'Reject the complete image batch.' }],
      } } } }
      const rejected = await page.evaluate(async (request) => {
        const response = await fetch('/native/api/session/prompt', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
        return { status: response.status, response: await response.json() }
      }, carrier)
      assert.equal(rejected.status, 200); assert.equal(rejected.response.rpcId, carrier.rpcId)
      assert.equal(rejected.response.result.ok, false)
      assert.equal(rejected.response.result.error.code, 'session/attachment-invalid')
      assert.equal(rejected.response.result.error.details.reason, 'INVALID_IMAGE_BASE64')
      for (const table of ['pe_operations', 'pe_native_prompt_inputs', 'pe_native_input_origins', 'pe_native_input_cohorts', 'pe_native_input_claims']) {
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM ' + table + ' WHERE session_id=$1', [sessionId])).rows[0].count, 0,
          'rejected image batch must leave no row in ' + table)
      }
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
        [userId, 'native-images:' + sessionId])).rows[0].count, 0)
      assert.deepEqual(await storageObjects(attachmentRoot), before, 'a bad second image must not publish the valid first image')
      assert.equal(requests.length, 0)
    })
    await stage('composer-attach-png-and-submit', async () => {
      await page.locator('input[type="file"]').setInputFiles(imagePath)
      const preview = page.getByRole('img', { name: imageName, exact: true }).first()
      await preview.waitFor({ state: 'visible' })
      await waitUntil(() => preview.evaluate(image => image.complete && image.naturalWidth === 2 && image.naturalHeight === 2), 'real Composer PNG preview')
      await page.getByRole('button', { name: 'Remove image ' + imageName, exact: true }).waitFor()
      await page.locator('[data-composer-input][contenteditable="true"]').fill(text)
      await page.locator('[data-composer-input]').press('Enter')
      await waitUntil(() => nativeActions.some(action => action.path === '/native/api/session/prompt' && action.response.result.ok), 'actual accepted Composer prompt')
      const accepted = nativeActions.find(action => action.path === '/native/api/session/prompt' && action.response.result.ok)
      assert.equal(accepted.status, 200); assert.equal(accepted.response.result.value.accepted, true)
      const input = accepted.request.payload.args.request
      requestId = input.requestId; assert.equal(input.sessionId, sessionId)
      assert.deepEqual(input.content, [rawImage, { type: 'text', text }], 'the actual Composer preserves attachment-before-text ordering and raw PNG bytes')
      await waitUntil(() => requests.length > 0, 'real Platform Messages model request')
      await page.getByText(answer, { exact: false }).first().waitFor()
    })
    await stage('verify-sdk-original-native-binding-and-model-codec', async () => {
      assert.equal(requests.length, 1)
      const inputs = (await pool.query('SELECT submitted,admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [sessionId, requestId])).rows
      assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].submitted, [rawImage, { type: 'text', text }])
      const admitted = inputs[0].admitted
      assert.deepEqual(admitted.map(part => part.type), ['image', 'text']); assert.deepEqual(admitted[1], { type: 'text', text })
      const ref = admitted[0].attachment
      assert.equal(ref.name, imageName); assert.equal(ref.width, 2); assert.equal(ref.height, 2)
      const stored = await readImageFile(join(attachmentRoot, userId, sessionId, 'attachments', 'v1'), ref)
      assert.deepEqual(stored.ref, ref)
      assert.equal(ref.attachmentId, 'sha256:' + createHash('sha256').update(stored.data).digest('hex'))
      assert.equal(ref.bytes, stored.data.length)
      assert.deepEqual(Buffer.from(stored.data), original, 'this small clean PNG must pass the official normalization policy byte-for-byte')
      const rows = (await pool.query('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [userId, 'native-images:' + sessionId])).rows
      assert.equal(rows.length, 1)
      assert.deepEqual(rows[0].value.bindings, [{ image: ref, storageSessionId: sessionId,
        sourceRequestId: requestId, acceptedContentDigest: nativeInputRecordDigest(admitted) }])
      const users = requests[0].messages.filter(message => message.role === 'user')
      assert.equal(users.length, 1)
      assert.deepEqual(users[0].content, [
        { type: 'text', text: requestImageHandleText(ref, { width: ref.width, height: ref.height }) },
        { type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: Buffer.from(stored.data).toString('base64') } },
        { type: 'text', text },
      ], 'actual Messages content must carry the official metadata handle, exact SDK bytes and following Composer text')
      imageProof = { rawBytes: original.length, admitted: ref, storageObjects: await storageObjects(attachmentRoot),
        sourceRequestId: requestId, acceptedContentDigest: nativeInputRecordDigest(admitted), modelUser: users[0] }
    })
    await stage('complete-native-turn-and-prove-unique-claim', async () => {
      assert(stream && !stream.res.destroyed, 'the controlled external model stream must remain active')
      stream.send({ type: 'content_block_stop', index: 0 })
      stream.send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      stream.send({ type: 'message_stop' }); stream.res.end()
      modelControls.push({ action: 'complete-external-model-SSE', requestNumber: 1 })
      await waitUntil(async () => (await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [sessionId])).rows[0].count === 0,
        'complete native image operation with pending zero')
      const operations = (await pool.query('SELECT id,request_id,state,error_code FROM pe_operations WHERE session_id=$1', [sessionId])).rows
      assert.equal(operations.length, 1); assert.equal(operations[0].request_id, requestId)
      assert.equal(operations[0].state, 'completed'); assert.equal(operations[0].error_code, null)
      const origins = (await pool.query('SELECT origin_input_id,origin_operation_id,original_request_id,message_id FROM pe_native_input_origins WHERE session_id=$1', [sessionId])).rows
      const cohorts = (await pool.query('SELECT cohort_id,execution_operation_id,owner_origin_input_id,claim_count FROM pe_native_input_cohorts WHERE session_id=$1', [sessionId])).rows
      const claims = (await pool.query('SELECT origin_input_id,cohort_id FROM pe_native_input_claims WHERE session_id=$1', [sessionId])).rows
      assert.equal(origins.length, 1); assert.equal(cohorts.length, 1); assert.equal(claims.length, 1)
      assert.equal(origins[0].original_request_id, requestId); assert.equal(origins[0].origin_operation_id, operations[0].id)
      assert.equal(cohorts[0].execution_operation_id, operations[0].id); assert.equal(cohorts[0].claim_count, 1)
      assert.equal(cohorts[0].owner_origin_input_id, origins[0].origin_input_id)
      assert.deepEqual(claims, [{ origin_input_id: origins[0].origin_input_id, cohort_id: cohorts[0].cohort_id }])
      const events = (await pool.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [sessionId])).rows.map(row => row.event)
      const messages = events.filter(event => event.type === 'user/message')
      assert.equal(messages.length, 1); assert.equal(messages[0].data.id, origins[0].message_id)
      assert.deepEqual(messages[0].data.content, [{ type: 'image', attachment: imageProof.admitted }, { type: 'text', text }])
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
      assert.equal(requests.length, 1); assert.deepEqual(browserErrors, [])
    })
    await stage('refresh-completed-session-gallery-and-original', async () => {
      await Promise.all([...evidenceReads])
      const before = nativeActions.length
      await page.reload()
      await page.getByText(text, { exact: true }).first().waitFor()
      await page.getByText(answer, { exact: false }).first().waitFor()
      const thumbnail = page.getByRole('button', { name: imageName + ', click to view original', exact: true }).first()
      const image = thumbnail.getByRole('img', { name: imageName, exact: true })
      await image.waitFor({ state: 'visible' })
      await waitUntil(() => image.evaluate(img => img.complete && img.naturalWidth === 2 && img.naturalHeight === 2),
        'reloaded canonical historical PNG thumbnail')
      let read
      await waitUntil(() => {
        read = nativeActions.slice(before).find(action => action.path === '/native/api/session/attachment'
          && action.request.payload.args.request.sessionId === sessionId
          && action.request.payload.args.request.attachmentId === imageProof.admitted.attachmentId)
        return read !== undefined
      }, 'actual gallery session/attachment response after native completion')
      assert.equal(read.status, 200); assert.equal(read.response.result.ok, true)
      assert.deepEqual(read.request.payload.args.request, { sessionId, attachmentId: imageProof.admitted.attachmentId },
        'historical image reads use Session ownership and attachment identity without an operation grant')
      assert.deepEqual(read.response.result.value, { attachment: imageProof.admitted, data: original.toString('base64') })
      await thumbnail.click()
      const dialog = page.getByRole('dialog', { name: 'Original image preview', exact: true })
      const fullImage = dialog.getByRole('img', { name: imageName, exact: true })
      await fullImage.waitFor({ state: 'visible' })
      await waitUntil(() => fullImage.evaluate(img => img.complete && img.naturalWidth === 2 && img.naturalHeight === 2),
        'actual original-image lightbox PNG')
      const thumbnailSource = await image.evaluate(img => img.currentSrc)
      const displayed = await fullImage.evaluate((img) => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
        const drawing = canvas.getContext('2d')
        if (drawing === null) throw new Error('Browser canvas context unavailable')
        drawing.drawImage(img, 0, 0)
        return { source: img.currentSrc, width: img.naturalWidth, height: img.naturalHeight,
          complete: img.complete, pixels: [...drawing.getImageData(0, 0, canvas.width, canvas.height).data] }
      })
      assert(thumbnailSource.startsWith('blob:'), 'the refreshed gallery must display the canonical SDK response as a browser image URL')
      assert.deepEqual(displayed, { source: thumbnailSource, width: 2, height: 2, complete: true, pixels: fixturePixels },
        'the clicked original must display the same successfully decoded canonical image as the refreshed gallery')
      imageProof.historicalRead = { request: read.request.payload.args.request,
        value: read.response.result.value, displayed, fixturePixels }
      await dialog.getByRole('button', { name: 'Close original image preview', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [sessionId])).rows[0].count, 0)
      for (const table of ['pe_operations', 'pe_native_input_origins', 'pe_native_input_cohorts', 'pe_native_input_claims']) {
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM ' + table + ' WHERE session_id=$1', [sessionId])).rows[0].count, 1)
      }
      assert.equal(requests.length, 1, 'refresh and historical image reads must not replay completed input')
      assert.deepEqual(browserErrors, [])
    })
  } catch (error) { failure = error; await snapshot('failure').catch(() => {}); throw error }
  finally {
    const databaseEvidence = await databaseSnapshot()
    await Promise.all([...evidenceReads])
    if (browser) {
      for (const context of browser.contexts()) await context.tracing.stop({ path: join(evidence, 'browser-trace.zip') }).catch(() => {})
      await browser.close()
    }
    for (const item of children) item.child.kill('SIGTERM')
    const exits = await Promise.all(children.map(async (item) => {
      const timeout = setTimeout(() => { item.child.kill('SIGKILL') }, 5000)
      try { const exit = await item.closed; await writeFile(join(evidence, item.role + '.log'), item.output, { mode: 0o600 }); return { role: item.role, ...exit } }
      finally { clearTimeout(timeout) }
    }))
    if (stream) stream.res.end()
    if (mock.listening) await new Promise((done) => { mock.close(done); mock.closeAllConnections() })
    if (pool) await pool.end()
    try { if (created) await admin.query('DROP DATABASE "' + databaseName + '"') }
    finally { if (admin) await admin.end(); await rm(home, { recursive: true, force: true }) }
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ state: failure ? 'failed' : 'passed', currentStage, stages,
      error: failure instanceof Error ? failure.message : undefined, databaseEvidence, imageProof,
      browserErrors, network, nativeActions, nativeStreams, modelControls, modelRequests: requests, exits, resourcesCleaned: true,
      scope: 'Actual Chrome Composer attachment and submit, built named Host/Platform, PG5, native Agent and official SDK image storage; completed-Session refresh, gallery and original-image lightbox use canonical session/attachment reads. Invalid canonical-base64 rejection uses supplemental same-browser native session/prompt RPC, not UI acceptance. Only external model SSE is substituted.' }, null, 2), { mode: 0o600 })
    console.log('Employee2 native image browser E2E evidence: ' + evidence)
    if (failure) throw failure
  }
})
