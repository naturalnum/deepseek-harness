/** Warm native archive cancellation through actual Composer, confirmation, named Profiles, PG5 and Chrome. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { transaction, CURRENT_SCHEMA_VERSION, initializeDatabase } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword } from '../lib/platform/identity.js'
import { readInputHistory } from '../lib/native-input-ledger-records.js'
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

test('stop and archive a streaming native turn, retire queued inputs, restore history and complete a new task', { timeout: 180000 }, async () => {
  const parent = process.env.PE_E2E_EVIDENCE_DIR
  if (!parent) throw new Error('PE_E2E_EVIDENCE_DIR is required; this case never silently skips')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidence = await mkdtemp(join(parent, 'run-'))
  const home = await mkdtemp(join(tmpdir(), 'pe-employee2-browser-archive-'))
  const stages = [], requests = [], browserErrors = [], network = [], children = [], streams = new Set()
  const nativeActions = [], nativeStreams = [], evidenceReads = new Set(), modelControls = []
  const workerId = randomUUID(), username = 'browser-archive-owner', password = randomUUID()
  const messages = { first: 'E2E archive active A.', queuedB: 'E2E archive pending B.',
    queuedC: 'E2E archive pending C.', restoredD: 'E2E restored session new task D.' }
  let pool, admin, databaseName, page, browser, sessionId, expectedSessionId, userId, failure
  let created = false, currentStage = 'preflight', archiveProof
  const mock = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return }
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const requestNumber = requests.length
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (event) => { res.write('data: ' + JSON.stringify(event) + '\n\n') }
        send({ type: 'message_start', message: { id: 'owned_' + requestNumber, model: 'deepseek-flash',
          usage: { input_tokens: 3, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        const text = requestNumber === 1 ? 'E2E streaming response. ' : 'E2E follow-up response ' + requestNumber + '. '
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        const timer = setInterval(() => {
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Still responding. ' } })
        }, 1000)
        const stream = { res, timer, send, requestNumber }; streams.add(stream)
        res.once('close', () => {
          clearInterval(timer); streams.delete(stream)
          modelControls.push({ at: new Date().toISOString(), requestNumber, action: 'external-model-SSE-closed' })
        })
      } catch (_invalidFixtureRequest) { res.writeHead(500).end() }
    })
  })
  function finishModel(requestNumber) {
    const stream = [...streams].find(item => item.requestNumber === requestNumber)
    assert(stream && !stream.res.destroyed, 'owned model stream ' + requestNumber + ' must still be active')
    clearInterval(stream.timer)
    stream.send({ type: 'content_block_stop', index: 0 })
    stream.send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    stream.send({ type: 'message_stop' }); stream.res.end(); streams.delete(stream)
    modelControls.push({ at: new Date().toISOString(), requestNumber, action: 'complete-external-model-SSE' })
  }
  const sessionRow = () => page.locator('[data-row-key="session:' + sessionId + '"]')
  async function promptReceipt(text) {
    let action
    await waitUntil(() => {
      action = nativeActions.find(item => item.path === '/native/api/session/prompt'
        && item.request.payload.args.request.content.some(part => part.type === 'text' && part.text === text))
      return action !== undefined
    }, 'actual Composer prompt receipt ' + text)
    assert.equal(action.status, 200); assert.equal(action.response.result.ok, true)
    assert.equal(action.response.result.value.accepted, true)
    assert.equal(action.request.payload.args.request.sessionId, sessionId)
    return action.request.payload.args.request.requestId
  }
  async function nativeHistory() {
    return transaction(pool, client => readInputHistory(client, sessionId, { maxHistoryEvents: 10000, maxHistoryBytes: 16777216 }))
  }
  async function immutableInputs() {
    const captured = {}
    for (const table of ['pe_native_input_origins', 'pe_native_input_claims', 'pe_native_input_cohorts']) {
      captured[table] = (await pool.query('SELECT * FROM ' + table + ' WHERE session_id=$1 ORDER BY 1', [sessionId])).rows
    }
    captured.inputs = (await pool.query('SELECT request_id,submitted,admitted FROM pe_native_prompt_inputs WHERE session_id=$1 ORDER BY request_id', [sessionId])).rows
    return captured
  }
  async function stopMarker() {
    return (await pool.query('SELECT value,revision,updated_at FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
      [userId, 'session-archive-stop:' + sessionId])).rows[0]
  }
  async function assertStopped() {
    const marker = await stopMarker()
    assert.equal(marker.value.status, 'complete'); assert.equal(marker.value.purpose, 'archive')
    assert.equal(marker.value.sessionId, sessionId)
    const history = await nativeHistory()
    assert.equal(history.turn, null); assert.equal(history.step, null)
    assert.equal(history.inbox['next-step'].length, 0); assert.equal(history.inbox['next-turn'].length, 0)
    const operations = (await pool.query('SELECT request_id,state,error_code,attempts,mcp_chain_cancelled_at FROM pe_operations WHERE session_id=$1', [sessionId])).rows
    assert.equal(operations.length, 3)
    for (const operation of operations) {
      assert.equal(operation.state, 'failed'); assert.equal(operation.error_code, 'turn_user')
      assert(operation.mcp_chain_cancelled_at !== null)
      assert.equal(operation.attempts, operation.request_id === archiveProof.requestIds.A ? 1 : 0)
    }
    const attempts = (await pool.query('SELECT a.operation_id,a.epoch,a.ended_at FROM pe_attempts a JOIN pe_operations o ON o.id=a.operation_id WHERE o.session_id=$1', [sessionId])).rows
    assert.equal(attempts.length, 1); assert(attempts[0].ended_at !== null)
    const session = (await pool.query('SELECT lease_until,grant_digest IS NOT NULL AS grant_present FROM pe_sessions WHERE id=$1', [sessionId])).rows[0]
    assert.deepEqual(session, { lease_until: null, grant_present: false })
    const writers = (await pool.query('SELECT worker_id,epoch,expires_at FROM pe_native_writers WHERE session_id=$1', [sessionId])).rows
    assert.equal(writers.length, 1); assert.equal(writers[0].worker_id, workerId); assert.equal(writers[0].expires_at, null)
    assert.deepEqual(await immutableInputs(), archiveProof.before, 'archive cancellation must retain original accepted inputs, permanent A claim and cohort exactly')
    const turnEnds = history.events.filter(event => event.type === 'turn/end')
    assert.equal(turnEnds.length, 1); assert.deepEqual(turnEnds[0].data.reason, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(history.events.filter(event => event.type === 'step/end').length, 1)
    const canceled = history.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
    assert.equal(canceled.reduce((count, event) => count + event.data.removedCount, 0), 2)
    assert(canceled.every(event => event.data.inserted.length === 0))
    await waitUntil(() => modelControls.some(item => item.requestNumber === 1 && item.action === 'external-model-SSE-closed'),
      'actual external model SSE closure after archive cancellation')
    assert.equal(requests.length, 1)
    assert(modelControls.some(item => item.requestNumber === 1 && item.action === 'external-model-SSE-closed'))
    assert(!modelControls.some(item => item.requestNumber === 1 && item.action === 'complete-external-model-SSE'))
    archiveProof.completed = { marker, operations, attempts, writers, session, history }
  }
  async function snapshot(label) {
    if (!page || page.isClosed()) return
    await writeFile(join(evidence, label + '.aria.txt'), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: join(evidence, label + '.png'), fullPage: true })
  }
  async function databaseSnapshot() {
    const captured = {}
    if (!pool || !created) return captured
    for (const [name, sql] of [['schema', 'SELECT family,version FROM pe_schema'],
      ['sessions', 'SELECT id,workspace_id,header,event_count,lease_until,grant_digest IS NOT NULL AS operation_grant_present FROM pe_sessions ORDER BY created_at'],
      ['workspaces', 'SELECT id,title,is_default FROM pe_workspaces ORDER BY created_at'],
      ['history', 'SELECT session_id,seq,event FROM pe_events ORDER BY session_id,seq'],
      ['operations', 'SELECT id,session_id,request_id,state,error_code,attempts FROM pe_operations ORDER BY created_at'],
      ['preferences', 'SELECT namespace,value,revision FROM pe_native_preferences ORDER BY namespace'],
      ['inputs', 'SELECT session_id,request_id,submitted,admitted FROM pe_native_prompt_inputs'],
      ['origins', 'SELECT * FROM pe_native_input_origins'],
      ['claims', 'SELECT * FROM pe_native_input_claims'],
      ['cohorts', 'SELECT * FROM pe_native_input_cohorts'],
      ['attempts', 'SELECT operation_id,epoch,worker_id,started_at,ended_at FROM pe_attempts'],
      ['writers', 'SELECT session_id,worker_id,epoch,expires_at FROM pe_native_writers']]) {
      try { captured[name] = { state: 'read', rows: (await pool.query(sql)).rows } }
      catch (error) {
        captured[name] = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
        failure ??= error
      }
    }
    return captured
  }
  async function stage(name, action) {
    currentStage = name
    const item = { name, startedAt: new Date().toISOString(), state: 'running' }; stages.push(item)
    await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2))
    try { await action(); item.state = 'passed' }
    catch (error) { item.state = 'failed'; item.error = error instanceof Error ? error.message : String(error); throw error }
    finally { await snapshot(name); await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2)) }
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
    }, role + ' Profile readiness', 40000)
  }
  try {
    await writeFile(join(evidence, 'case-source.mjs'), await readFile(fileURLToPath(import.meta.url)))
    const assets = JSON.parse(await readFile(join(repository, 'products/power-evolve/cloud-web/dist/asset-list.json'), 'utf8'))
    assert(assets.includes('index.html')); assert(assets.some(path => path.startsWith('plugins/')))
    const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
    if (!urlFile) throw new Error('PE_TEST_DATABASE_URL_FILE is required for an exclusive real PG database')
    const address = new URL((await readFile(urlFile, 'utf8')).trim())
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'This case requires the owned local PG test service')
    databaseName = 'pe_employee2_archive_' + randomUUID().replaceAll('-', '')
    const target = new URL(address); target.pathname = '/' + databaseName
    admin = new Pool({ connectionString: address.href, max: 1 })
    pool = new Pool({ connectionString: target.href, max: 8 })
    await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true
    await initializeDatabase(pool)
    assert.deepEqual((await pool.query('SELECT family,version FROM pe_schema')).rows, [{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
    await seedNewUser(pool, username, await hashPassword(password), { model: 'deepseek-flash', maxTokens: 1000, revision: 1 })
    userId = (await pool.query('SELECT id FROM pe_users WHERE username=$1', [username])).rows[0].id
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
    const modelAddress = mock.address(); assert(modelAddress && typeof modelAddress !== 'string')
    const hostPort = await unusedPort(), platformPort = await unusedPort()
    const hostOrigin = 'http://127.0.0.1:' + hostPort, platformOrigin = 'http://127.0.0.1:' + platformPort
    const privateDir = join(home, 'private'), dshHome = join(home, 'dsh-home')
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
      } },
      platform: { 'web-server': { port: platformPort }, 'power-evolve-platform': {
        modelUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1/messages',
        connectorUrl: 'http://127.0.0.1:' + modelAddress.port + '/unused-connector',
        modelTimeoutMs: 120000,
        nativeInputOwnerRoutingFile: routingFile,
        seedUsersFile: '', accountManagementFile: '', preinstalledSkills: [],
      } } } }
    const platform = await renderProfile('platform', config), host = await renderProfile('host', config)
    await writeFile(join(evidence, 'ownership.json'), JSON.stringify({ databaseName, home, hostOrigin, platformOrigin, workerId, routingFile,
      modelOrigin: 'http://127.0.0.1:' + modelAddress.port, profiles: [platform, host], assetCount: assets.length }, null, 2))
    await stage('named-profiles', async () => { await boot('platform', platform, privateDir); await boot('host', host, privateDir) })
    browser = await chromium.launch({ executablePath: chrome, headless: process.env.PE_E2E_HEADLESS !== '0' })
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    await context.tracing.start({ screenshots: true, snapshots: true })
    page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', (error) => { browserErrors.push(error.message) })
    page.on('response', (response) => {
      const url = new URL(response.url())
      network.push({ origin: url.origin, path: url.pathname, status: response.status(), method: response.request().method() })
      if (!['session/create', 'session/prompt', 'workspace/archiveSession', 'workspace/unarchiveSession'].some(method => url.pathname === '/native/api/' + method)) return
      const read = (async () => {
        try {
          nativeActions.push({ at: new Date().toISOString(), path: url.pathname, status: response.status(),
            request: response.request().postDataJSON(), response: await response.json() })
        } catch (error) { browserErrors.push('native action evidence: ' + String(error)) }
      })()
      evidenceReads.add(read); void read.finally(() => { evidenceReads.delete(read) })
    })
    page.on('websocket', (socket) => {
      const observed = new Map()
      function record(direction, payload) {
        let frame
        try { frame = JSON.parse(String(payload)) } catch (_nonJsonFrame) { return }
        if (direction === 'sent' && frame.type === 'open'
          && ['workspace/follow', 'session/follow', 'session/control'].includes(frame.endpoint)) {
          observed.set(frame.streamId, frame.endpoint)
        }
        const endpoint = observed.get(frame.streamId)
        if (endpoint) nativeStreams.push({ at: new Date().toISOString(), direction, endpoint, frame })
      }
      socket.on('framesent', ({ payload }) => { record('sent', payload) })
      socket.on('framereceived', ({ payload }) => { record('received', payload) })
    })
    await stage('login', async () => {
      await page.goto(platformOrigin + '/login')
      await page.locator('#username').fill(username); await page.locator('#password').fill(password)
      await page.locator('#submit').click()
      await page.waitForURL(hostOrigin + '/native/')
      await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor()
    })
    await stage('create-session', async () => {
      await page.getByRole('dialog', { name: 'Preview Notice', exact: true }).getByRole('button', { name: 'Continue', exact: true }).click()
      await waitUntil(() => nativeActions.some(action => action.path === '/native/api/session/create'), 'initial native Session creation')
      const before = nativeActions.filter(action => action.path === '/native/api/session/create').length
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      await waitUntil(() => nativeActions.filter(action => action.path === '/native/api/session/create').length > before,
        'actual New session creation response')
      const createdSession = nativeActions.filter(action => action.path === '/native/api/session/create').at(-1)
      assert.equal(createdSession.response.result.ok, true)
      const newSessionId = createdSession.response.result.value.sessionId
      expectedSessionId = newSessionId
      await waitUntil(() => nativeStreams.some((item) => {
        if (item.direction !== 'received' || item.endpoint !== 'workspace/follow') return false
        const update = item.frame.value
        return update?.type === 'upsert' && update.workspace.sessionIds.includes(newSessionId)
          || update?.type === 'baseline' && update.value.items.some(workspace => workspace.sessionIds.includes(newSessionId))
      }), 'actual workspace membership update for the new native Session')
      await page.locator('[data-composer-input]').waitFor({ state: 'visible' })
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    })
    await stage('actual-A-streaming', async () => {
      sessionId = expectedSessionId
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.first)
      await page.locator('[data-composer-input]').press('Enter')
      const A = await promptReceipt(messages.first)
      await waitUntil(() => requests.length === 1, 'actual external model stream for A')
      await page.getByText('E2E streaming response.', { exact: false }).first().waitFor()
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state='running'", [sessionId])).rows[0].count, 1)
      archiveProof = { requestIds: { A } }
    })
    await stage('actual-B-C-queue-while-A-streams', async () => {
      for (const [label, text] of [['B', messages.queuedB], ['C', messages.queuedC]]) {
        await page.locator('[data-composer-input][contenteditable="true"]').fill(text)
        await page.getByRole('button', { name: 'Queue message', exact: true }).click()
        archiveProof.requestIds[label] = await promptReceipt(text)
      }
      await waitUntil(async () => (await nativeHistory()).inbox['next-turn'].length === 2, 'canonical pending B and C while A streams')
      archiveProof.before = await immutableInputs()
      assert.equal(archiveProof.before.pe_native_input_origins.length, 3)
      assert.equal(archiveProof.before.pe_native_input_claims.length, 1)
      assert.equal(archiveProof.before.pe_native_input_cohorts.length, 1)
      const A = archiveProof.before.pe_native_input_origins.find(origin => origin.original_request_id === archiveProof.requestIds.A)
      assert.equal(archiveProof.before.pe_native_input_claims[0].origin_input_id, A.origin_input_id)
      assert.equal(requests.length, 1)
      assert(!requests.some(request => JSON.stringify(request.messages).includes(messages.queuedB)
        || JSON.stringify(request.messages).includes(messages.queuedC)))
    })
    await stage('official-archive-and-stop-confirmation', async () => {
      await sessionRow().hover()
      await sessionRow().getByRole('button', { name: 'Archive session', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Stop and archive this session?', exact: true })
      await dialog.waitFor(); await dialog.getByText('The turn in progress', { exact: true }).waitFor()
      const refused = nativeActions.find(action => action.path === '/native/api/workspace/archiveSession'
        && action.request.payload.args.request.stopActivity !== true)
      assert(refused); assert.equal(refused.status, 200)
      assert.equal(refused.response.result.ok, false); assert.equal(refused.response.result.error.code, 'workspace/session-active')
      await dialog.getByRole('button', { name: 'Stop and archive', exact: true }).click()
      let archived
      await waitUntil(() => {
        archived = nativeActions.find(action => action.path === '/native/api/workspace/archiveSession'
          && action.request.payload.args.request.stopActivity === true)
        return archived !== undefined
      }, 'actual SDK stopActivity archive receipt')
      assert.equal(archived.status, 200); assert.equal(archived.response.result.ok, true)
      assert.equal(archived.request.payload.args.request.sessionId, sessionId)
      assert(archived.response.result.value.archivedSessionIds.includes(sessionId))
      archiveProof.archiveReceipt = archived
      await dialog.waitFor({ state: 'hidden' })
    })
    await stage('native-canceled-closers-pending-cleanup-marker-and-release', async () => {
      await waitUntil(async () => {
        const marker = await stopMarker()
        const writer = (await pool.query('SELECT expires_at FROM pe_native_writers WHERE session_id=$1', [sessionId])).rows[0]
        return marker?.value.status === 'complete' && writer?.expires_at === null
      }, 'actual complete archive marker and released native Writer', 45000)
      await assertStopped()
    })
    await stage('refresh-archived-group-and-preserved-canonical-history', async () => {
      await page.getByRole('button', { name: 'View options', exact: true }).click()
      await page.getByText('Archived only', { exact: true }).click()
      await sessionRow().waitFor({ state: 'visible' })
      assert.equal(await sessionRow().getAttribute('aria-description'), 'Archived sessions cannot be opened. Unarchive it to view.')
      const before = (await nativeHistory()).events
      await page.reload()
      await sessionRow().waitFor({ state: 'visible' })
      assert.equal(await sessionRow().getAttribute('aria-description'), 'Archived sessions cannot be opened. Unarchive it to view.')
      assert.deepEqual((await nativeHistory()).events, before)
      await assertStopped()
    })
    await stage('official-unarchive-and-restored-native-history', async () => {
      await sessionRow().hover()
      await sessionRow().getByRole('button', { name: 'Unarchive session', exact: true }).click()
      let restored
      await waitUntil(() => {
        restored = nativeActions.find(action => action.path === '/native/api/workspace/unarchiveSession')
        return restored !== undefined
      }, 'actual SDK unarchive receipt')
      assert.equal(restored.status, 200); assert.equal(restored.response.result.ok, true)
      assert(!restored.response.result.value.archivedSessionIds.includes(sessionId))
      await page.getByRole('button', { name: 'View options', exact: true }).click()
      await page.getByText('All conversations (show archived)', { exact: true }).click()
      await sessionRow().click()
      await page.getByText(messages.first, { exact: true }).first().waitFor()
      await page.reload()
      await page.getByText(messages.first, { exact: true }).first().waitFor()
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
      await assertStopped()
      archiveProof.restoredBeforeD = { marker: await stopMarker(), modelRequestCount: requests.length }
    })
    await stage('new-D-completes-without-reviving-A-B-C', async () => {
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.restoredD)
      await page.locator('[data-composer-input]').press('Enter')
      archiveProof.requestIds.D = await promptReceipt(messages.restoredD)
      await waitUntil(() => requests.length === 2, 'actual new D model request after archive completion')
      assert(JSON.stringify(requests[1].messages).includes(messages.restoredD))
      for (const text of [messages.queuedB, messages.queuedC]) {
        assert(!requests.some(request => JSON.stringify(request.messages).includes(text)))
      }
      const D = (await pool.query('SELECT created_at FROM pe_operations WHERE session_id=$1 AND request_id=$2', [sessionId, archiveProof.requestIds.D])).rows[0]
      assert(D.created_at > new Date(archiveProof.restoredBeforeD.marker.updated_at), 'D must enter after the original stop completed')
      finishModel(2)
      await waitUntil(async () => (await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [sessionId])).rows[0].count === 0,
        'actual completed D with pending zero')
      const operations = (await pool.query('SELECT request_id,state,error_code,attempts FROM pe_operations WHERE session_id=$1', [sessionId])).rows
      assert.equal(operations.length, 4)
      assert.deepEqual(operations.find(operation => operation.request_id === archiveProof.requestIds.D),
        { request_id: archiveProof.requestIds.D, state: 'completed', error_code: null, attempts: 1 })
      for (const operation of operations.filter(item => item.request_id !== archiveProof.requestIds.D)) {
        assert.equal(operation.state, 'failed'); assert.equal(operation.error_code, 'turn_user')
        assert.equal(operation.attempts, operation.request_id === archiveProof.requestIds.A ? 1 : 0)
      }
      const facts = await immutableInputs()
      assert.equal(facts.pe_native_input_origins.length, 4); assert.equal(facts.pe_native_input_claims.length, 2)
      for (const original of archiveProof.before.pe_native_input_origins) {
        assert.deepEqual(facts.pe_native_input_origins.find(origin => origin.origin_input_id === original.origin_input_id), original)
      }
      for (const original of archiveProof.before.pe_native_input_claims) {
        assert.deepEqual(facts.pe_native_input_claims.find(claim => claim.origin_input_id === original.origin_input_id), original)
      }
      for (const label of ['B', 'C']) {
        const origin = facts.pe_native_input_origins.find(item => item.original_request_id === archiveProof.requestIds[label])
        assert(!facts.pe_native_input_claims.some(claim => claim.origin_input_id === origin.origin_input_id))
      }
      const history = await nativeHistory()
      assert.equal(history.turn, null); assert.equal(history.step, null)
      assert.equal(history.inbox['next-step'].length, 0); assert.equal(history.inbox['next-turn'].length, 0)
      const user = history.events.filter(event => event.type === 'user/message')
      assert.equal(user.length, 2)
      for (const text of [messages.first, messages.restoredD]) assert.equal(user.filter(event => event.data.content.some(part => part.type === 'text' && part.text === text)).length, 1)
      const marker = await stopMarker()
      assert.deepEqual(marker, archiveProof.restoredBeforeD.marker)
      await page.reload(); await page.getByText(messages.first, { exact: true }).first().waitFor()
      await page.getByText(messages.restoredD, { exact: true }).first().waitFor()
      assert.equal(requests.length, 2); assert.deepEqual(browserErrors, [])
      archiveProof.final = { operations, facts, marker, history, modelRequestCount: requests.length }
    })
  } catch (error) { failure = error; await snapshot('failure').catch(() => {}); throw error
  } finally {
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
    for (const stream of streams) { clearInterval(stream.timer); stream.res.end() }
    if (mock.listening) await new Promise((done) => { mock.close(done); mock.closeAllConnections() })
    if (pool) await pool.end()
    try { if (created) await admin.query('DROP DATABASE "' + databaseName + '"') }
    finally { if (admin) await admin.end(); await rm(home, { recursive: true, force: true }) }
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ state: failure ? 'failed' : 'passed', currentStage, stages,
      error: failure instanceof Error ? failure.message : undefined, databaseEvidence, archiveProof,
      browserErrors, network, nativeActions, nativeStreams, modelControls, modelRequests: requests, exits, resourcesCleaned: true,
      scope: 'Actual browser/PG5/built named Profiles/native Remote/Session. Composer A streams, B/C queue, the official archive confirmation stops them, canonical history and archived grouping survive refresh, and restored D completes. PG reads verify outcomes and never produce state. Only external model SSE is substituted.' }, null, 2), { mode: 0o600 })
    console.log('Employee2 warm native archive browser E2E evidence: ' + evidence)
    if (failure) throw failure
  }
})
