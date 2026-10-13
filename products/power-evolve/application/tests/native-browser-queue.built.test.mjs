/** Real Chrome queue flow over named built Host/Platform Profiles and an exclusive formal schema-five database. */
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
import { CURRENT_SCHEMA_VERSION, initializeDatabase } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword } from '../lib/platform/identity.js'
import { renderProfile } from '../../deploy/start.mjs'

const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const { chromium } = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))('playwright')
const chrome = process.env.PE_E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const holdOnFailure = process.env.PE_E2E_HOLD_ON_FAILURE === '1'

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

test('login, create and send, edit/remove/steer while streaming, advance the next native turn and recover on refresh', {
  timeout: holdOnFailure ? 86400000 : 180000,
}, async () => {
  const parent = process.env.PE_E2E_EVIDENCE_DIR
  if (!parent) throw new Error('PE_E2E_EVIDENCE_DIR is required; no implicit or skipped E2E run')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidence = await mkdtemp(join(parent, 'run-'))
  const home = await mkdtemp(join(tmpdir(), 'pe-employee2-browser-'))
  const stages = [], requests = [], browserErrors = [], network = [], children = [], streams = new Set()
  const nativeActions = [], nativeStreams = [], evidenceReads = new Set()
  const modelControls = [], workerId = randomUUID()
  const username = 'browser-queue-owner', password = randomUUID()
  const messages = { first: 'E2E active response: please continue.', queued: 'E2E queued message original.',
    edited: 'E2E queued message edited.', removed: 'E2E remove this queued message.',
    nextTurn: 'E2E continue in the next native turn.' }
  let pool, admin, databaseName, page, browser, currentStage = 'preflight', sessionId, expectedSessionId, removedRequestId, sessionCount, created = false
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
        res.once('close', () => { clearInterval(timer); streams.delete(stream) })
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
  function queuedRow(text) {
    return page.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: text })
  }
  async function userMessages(text) {
    return (await pool.query("SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='user/message'", [sessionId])).rows
      .filter(({ event }) => event.data.content.some(part => part.type === 'text' && part.text === text))
  }
  async function assertRemovedRetired() {
    assert.equal(typeof removedRequestId, 'string', 'the removed origin must retain its actual accepted request identity')
    assert.deepEqual((await pool.query('SELECT state,error_code,attempts FROM pe_operations WHERE session_id=$1 AND request_id=$2',
      [sessionId, removedRequestId])).rows, [{ state: 'failed', error_code: 'native_input_removed', attempts: 0 }],
    'removed input must retire in the remove transaction without any runtime claim')
  }
  async function queueReceipt(kind) {
    let action
    await waitUntil(() => {
      action = nativeActions.find(item => item.path === '/native/api/session/updateQueue'
        && item.request.payload.args.request.action.kind === kind)
      return action !== undefined
    }, 'actual browser queue ' + kind + ' response')
    assert.equal(action.status, 200)
    assert.equal(action.response.result.ok, true)
    assert.equal(action.response.result.value.accepted, true)
    return action
  }
  async function replayQueue(action) {
    const before = (await pool.query("SELECT count(*)::int AS count FROM pe_events WHERE session_id=$1 AND event->>'type'='agent/inbox/spliced'", [sessionId])).rows[0].count
    const replay = await page.evaluate(async (request) => {
      const response = await fetch('/native/api/session/updateQueue', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
      return { status: response.status, response: await response.json() }
    }, action.request)
    assert.equal(replay.status, action.status)
    assert.deepEqual(replay.response, action.response, 'the original browser carrier nonce must replay the original result')
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM pe_events WHERE session_id=$1 AND event->>'type'='agent/inbox/spliced'", [sessionId])).rows[0].count,
      before, 'original-nonce replay must not append a second native inbox mutation')
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
      ['sessions', 'SELECT id,workspace_id,header,event_count FROM pe_sessions ORDER BY created_at'],
      ['workspaces', 'SELECT id,title,is_default FROM pe_workspaces ORDER BY created_at'],
      ['history', 'SELECT session_id,seq,event FROM pe_events ORDER BY session_id,seq'],
      ['operations', 'SELECT id,session_id,request_id,state,error_code,attempts FROM pe_operations ORDER BY created_at'],
      ['preferences', 'SELECT namespace,value,revision FROM pe_native_preferences ORDER BY namespace']]) {
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
  let failure
  try {
    await writeFile(join(evidence, 'case-source.mjs'), await readFile(fileURLToPath(import.meta.url)))
    const assets = JSON.parse(await readFile(join(repository, 'products/power-evolve/cloud-web/dist/asset-list.json'), 'utf8'))
    assert(assets.includes('index.html')); assert(assets.some(path => path.startsWith('plugins/')))
    const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
    if (!urlFile) throw new Error('PE_TEST_DATABASE_URL_FILE is required for an exclusive real PG database')
    const address = new URL((await readFile(urlFile, 'utf8')).trim())
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'This case requires the owned local PG test service')
    databaseName = 'pe_employee2_browser_' + randomUUID().replaceAll('-', '')
    const target = new URL(address); target.pathname = '/' + databaseName
    admin = new Pool({ connectionString: address.href, max: 1 })
    pool = new Pool({ connectionString: target.href, max: 8 })
    await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true
    await initializeDatabase(pool)
    assert.deepEqual((await pool.query('SELECT family,version FROM pe_schema')).rows, [{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
    await seedNewUser(pool, username, await hashPassword(password), { model: 'deepseek-flash', maxTokens: 1000, revision: 1 })
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
        concurrency: 1, pollMs: 100, operationTimeoutMs: holdOnFailure ? 3600000 : 150000,
      } },
      platform: { 'web-server': { port: platformPort }, 'power-evolve-platform': {
        modelUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1/messages',
        connectorUrl: 'http://127.0.0.1:' + modelAddress.port + '/unused-connector',
        modelTimeoutMs: holdOnFailure ? 3600000 : 120000,
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
      if (!['session/create', 'session/prompt', 'session/updateQueue'].some(method => url.pathname === '/native/api/' + method)) return
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
    await stage('send-streaming', async () => {
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.first)
      await page.locator('[data-composer-input]').press('Enter')
      await waitUntil(() => requests.length > 0, 'real Platform model SSE request')
      await page.getByText('E2E streaming response.', { exact: false }).first().waitFor()
      const rows = (await pool.query("SELECT DISTINCT session_id AS id FROM pe_operations WHERE state='running'")).rows
      assert.equal(rows.length, 1); sessionId = rows[0].id
      assert.equal(sessionId, expectedSessionId, 'the active operation must belong to the Session created through New session')
      sessionCount = (await pool.query('SELECT count(*)::int AS count FROM pe_sessions')).rows[0].count
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state='running'", [sessionId])).rows[0].count, 1)
    })
    await stage('queue-during-stream', async () => {
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.queued)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
      await page.locator('[data-queue-dock]').getByText(messages.queued, { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Edit queued message', exact: true }).waitFor({ state: 'visible' })
      assert.equal(requests.length, 1, 'queuing must not start a parallel model turn')
    })
    await stage('edit-queued-message', async () => {
      await queuedRow(messages.queued).getByRole('button', { name: 'Edit queued message', exact: true }).click()
      await page.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill(messages.edited)
      await page.getByRole('button', { name: 'Save queued message', exact: true }).click()
      await queueReceipt('edit')
      await page.locator('[data-queue-dock]').getByText(messages.edited, { exact: true }).waitFor()
      assert.equal(await page.locator('[data-queue-dock]').getByText(messages.queued, { exact: true }).count(), 0)
    })
    await stage('remove-queued-message', async () => {
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.removed)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
      await page.locator('[data-queue-dock] button[aria-expanded="false"]').click()
      await queuedRow(messages.removed).getByRole('button', { name: 'Remove queued message', exact: true }).click()
      const removed = await queueReceipt('remove')
      await queuedRow(messages.removed).waitFor({ state: 'hidden' })
      await queuedRow(messages.edited).waitFor({ state: 'visible' })
      assert.equal((await userMessages(messages.removed)).length, 0)
      await waitUntil(() => {
        const accepted = nativeActions.find(action => action.path === '/native/api/session/prompt'
          && action.request.payload.args.request.content.some(part => part.type === 'text' && part.text === messages.removed))
        removedRequestId = accepted?.request.payload.args.request.requestId
        return typeof removedRequestId === 'string'
      }, 'original accepted removed input identity')
      await assertRemovedRetired()
      await replayQueue(removed)
      await assertRemovedRetired()
      assert.equal(requests.length, 1, 'removing queued input must keep the original model stream active')
    })
    await stage('refresh-recover-queue', async () => {
      const url = page.url(); await page.reload()
      await page.locator('[data-queue-dock]').getByText(messages.edited, { exact: true }).waitFor()
      assert.equal(page.url(), url)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM pe_sessions')).rows[0].count, sessionCount)
      assert.equal(requests.length, 1, 'refresh must not replay the original active input')
    })
    await stage('steer-queued-message', async () => {
      await queuedRow(messages.edited).getByRole('button', { name: 'Steer queued message', exact: true }).click()
      await queueReceipt('steer')
      await page.locator('[data-queue-dock]').getByText(messages.edited, { exact: true }).waitFor({ state: 'hidden' })
      assert.equal(requests.length, 1, 'steering must retain the active response until its model boundary')
      finishModel(1)
      await waitUntil(() => requests.length >= 2, 'next native step after completing the original SSE')
      assert.equal(requests.length, 2)
      assert(JSON.stringify(requests[1].messages).includes(messages.edited), 'the next actual model request must contain the edited input')
      assert(!JSON.stringify(requests[1].messages).includes(messages.removed), 'removed input must not reach the next model request')
      await waitUntil(async () => (await userMessages(messages.edited)).length === 1, 'durable edited user input after steering')
      await page.getByText('E2E follow-up response 2.', { exact: false }).first().waitFor()
    })
    await stage('advance-next-native-turn', async () => {
      await page.locator('[data-composer-input][contenteditable="true"]').fill(messages.nextTurn)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
      await queuedRow(messages.nextTurn).getByRole('button', { name: 'Edit queued message', exact: true }).waitFor()
      await waitUntil(async () => (await pool.query("SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='agent/inbox/spliced'", [sessionId])).rows
        .some(({ event }) => event.data.inserted.some(message => message.content.some(part => part.type === 'text' && part.text === messages.nextTurn))),
      'canonical admission of the next-turn input while the second model stream is active')
      assert.equal(requests.length, 2)
      finishModel(2)
      await waitUntil(() => requests.length >= 3, 'actual model request in the following native turn')
      assert.equal(requests.length, 3)
      assert(JSON.stringify(requests[2].messages).includes(messages.nextTurn))
      assert(!JSON.stringify(requests[2].messages).includes(messages.removed))
      await waitUntil(async () => (await userMessages(messages.nextTurn)).length === 1, 'one durable next-turn user message')
      const turns = (await pool.query("SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='turn/start' ORDER BY seq", [sessionId])).rows
      assert.equal(turns.length, 2)
      assert(turns[1].event.data.turn > turns[0].event.data.turn)
      finishModel(3)
      await waitUntil(async () => (await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [sessionId])).rows[0].count === 0,
        'settlement of completed turns and removed accepted input without a remaining queued/running operation')
    })
    await stage('refresh-recover-history', async () => {
      await page.reload()
      await page.getByText(messages.first, { exact: true }).first().waitFor()
      await page.getByText(messages.edited, { exact: true }).first().waitFor()
      await page.getByText(messages.nextTurn, { exact: true }).first().waitFor()
      for (const text of [messages.first, messages.edited, messages.nextTurn]) assert.equal((await userMessages(text)).length, 1)
      assert.equal((await userMessages(messages.queued)).length, 0)
      assert.equal((await userMessages(messages.removed)).length, 0)
      await assertRemovedRetired()
      assert(!requests.some(request => JSON.stringify(request.messages).includes(messages.removed)), 'removed text must never reach any model request')
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM pe_sessions')).rows[0].count, sessionCount)
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [sessionId])).rows[0].count, 0)
      assert.equal(requests.length, 3, 'refresh must not replay any completed model input')
    })
  } catch (error) {
    failure = error
    await snapshot('failure').catch(() => {})
    if (holdOnFailure) {
      await Promise.all([...evidenceReads])
      for (const context of browser?.contexts() ?? []) {
        await context.tracing.stop({ path: join(evidence, 'live-browser-trace.zip') })
        await context.tracing.start({ screenshots: true, snapshots: true })
      }
      for (const item of children) await writeFile(join(evidence, item.role + '-live.log'), item.output, { mode: 0o600 })
      await writeFile(join(evidence, 'live-failure.json'), JSON.stringify({ state: 'failed', currentStage, stages,
        error: error instanceof Error ? error.message : String(error), sessionId, databaseEvidence: await databaseSnapshot(),
        nativeActions, nativeStreams, modelControls, modelRequestCount: requests.length, browserErrors, network,
        resourcesCleaned: false, testPid: process.pid, profiles: children.map(({ role, child }) => ({ role, pid: child.pid })),
        releaseFile: join(evidence, 'release'), pageUrl: page?.url(),
      }, null, 2), { mode: 0o600 })
      console.log('Employee2 browser E2E live failure: ' + evidence)
      await waitUntil(async () => {
        try { await readFile(join(evidence, 'release')); return true }
        catch (readError) { if (readError.code === 'ENOENT') return false; throw readError }
      }, 'owned live fixture release', 82800000)
    }
    throw error
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
      error: failure instanceof Error ? failure.message : undefined, databaseEvidence,
      browserErrors, network, nativeActions, nativeStreams, modelControls, modelRequests: requests, exits, resourcesCleaned: true,
      scope: 'Actual browser/PG5/built Platform/native Remote/Session. Queue mutations use the UI; original-nonce replay uses the same browser fetch and production entry. Only external model SSE is substituted.' }, null, 2), { mode: 0o600 })
    console.log('Employee2 browser E2E evidence: ' + evidence)
    if (failure) throw failure
  }
})
