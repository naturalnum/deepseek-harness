/** Artifact plane: built lib, real Chrome/PG6 and four named Profiles; only external model SSE is controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { seedNewUser } from '../lib/platform/account-settings.js'
import { hashPassword } from '../lib/platform/identity.js'
import { readInputHistory } from '../lib/native-input-ledger-records.js'
import { renderProfile } from '../../deploy/start.mjs'

const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const { chromium } = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))('playwright')
const helperDir = process.env.PE_E2E_REPLICAS_HELPERS_DIR
if (!helperDir) throw new Error('PE_E2E_REPLICAS_HELPERS_DIR is required; private preparation helpers are explicit inputs')
const { replicaPlan } = await import(pathToFileURL(join(helperDir, 'replica-plan.mjs')))
const { createFaultProxy } = await import(pathToFileURL(join(helperDir, 'fault-proxy.mjs')))
const { materializeNativeIntentKeys } = await import(pathToFileURL(join(helperDir, 'native-intent-key.mjs')))
const { compareOriginalRows, compareFrameIdentity, compareJournalIdentity, retainedJournalSnapshotSql } =
  await import(pathToFileURL(join(helperDir, 'identity-evidence.mjs')))

async function waitUntil(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(label + ' deadline')
}

async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  await new Promise(done => server.close(done)); return address.port
}

async function runScenario(kind) {
  const parent = process.env.PE_E2E_EVIDENCE_DIR, urlFile = process.env.PE_TEST_DATABASE_URL_FILE
  const buildLog = process.env.PE_E2E_BUILD_LOG
  assert(parent && urlFile && buildLog, 'Explicit evidence, private PG URL file and selected build log are required')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidence = await mkdtemp(join(parent, kind + '-'))
  const home = await mkdtemp(join(tmpdir(), 'pe-employee2-replicas-'))
  const stages = [], children = [], actions = [], frames = [], network = [], browserErrors = [], pendingReads = new Set()
  const requests = [], controls = [], modelStreams = new Map(), proxies = [], proofs = {}
  const users = [1, 2].map(number => ({ username: 'replicas-user-' + number, password: randomUUID() }))
  const text = { A: 'E2E replicas original active A.', B: 'E2E replicas queued original B.',
    editedB: 'E2E replicas edited pending B.', X: 'E2E replicas independent user two X.', D: 'E2E replicas fresh task D.' }
  let pool, admin, databaseName, created = false, browser, plan, currentStage = 'preflight', failure
  let ownerId, otherId, sessionId, sender, peer, second, contextOne
  const model = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const content = body.messages.filter(message => message.role === 'user').at(-1)?.content
        // Native repair can leave adjacent user inputs; the provider retains them as ordered text blocks in one user message.
        const lastUserText = typeof content === 'string' ? content : content.filter(part => part.type === 'text').at(-1)?.text
        const number = requests.length + 1; requests.push({ number, lastUserText, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = event => res.write('data: ' + JSON.stringify(event) + '\n\n')
        send({ type: 'message_start', message: { id: 'replicas_' + number, model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Replica stream ' + number + '. ' } })
        const timer = setInterval(() => send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Still streaming. ' } }), 1000)
        modelStreams.set(number, { res, send, timer })
        res.once('close', () => { clearInterval(timer); modelStreams.delete(number); controls.push({ action: 'external-SSE-closed', number, at: new Date().toISOString() }) })
      } catch (_invalidExternalRequest) { res.destroy() }
    })
  })
  function finish(textValue) {
    const request = requests.find(item => item.lastUserText === textValue); assert(request)
    const stream = modelStreams.get(request.number); assert(stream)
    clearInterval(stream.timer); stream.send({ type: 'content_block_stop', index: 0 })
    stream.send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    stream.send({ type: 'message_stop' }); stream.res.end()
    controls.push({ action: 'fixture-complete-external-SSE', number: request.number, at: new Date().toISOString() })
  }
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows
  const history = () => transaction(pool, async (client) => {
    // readInputHistory requires the Session lock while reading its event watermark and prefix.
    await client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', [sessionId])
    return readInputHistory(client, sessionId, { maxHistoryEvents: 10000, maxHistoryBytes: 16777216 })
  })
  async function inputRows() {
    const captured = {}
    for (const table of ['pe_native_input_origins', 'pe_native_input_revisions', 'pe_native_input_commands',
      'pe_native_input_cohorts', 'pe_native_input_claims']) captured[table] = await query('SELECT * FROM ' + table + ' WHERE session_id=$1 ORDER BY 1', [sessionId])
    return captured
  }
  async function stage(name, action) {
    currentStage = name
    const item = { name, startedAt: new Date().toISOString(), state: 'running' }; stages.push(item)
    await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2))
    try { await action(); item.state = 'passed' }
    catch (error) { item.state = 'failed'; item.error = String(error); throw error }
    finally {
      for (const [id, page] of [['sender', sender], ['peer', peer], ['second', second]]) if (page && !page.isClosed()) {
        try {
          await writeFile(join(evidence, name + '-' + id + '.aria.txt'), await page.locator('body').ariaSnapshot())
          await page.screenshot({ path: join(evidence, name + '-' + id + '.png'), fullPage: true })
        } catch (error) { network.push({ stage: name, page: id, snapshotError: error.name }) }
      }
      await writeFile(join(evidence, 'progress.json'), JSON.stringify({ currentStage, stages }, null, 2))
    }
  }
  async function boot(id, profile, config) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'NODE_PATH'].includes(key) || key.startsWith('LC_')))
    const child = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', profile.name], {
      cwd: repository, env: { ...env, DSH_HOME: config.dshHome, PE_PRIVATE_DIR: config.privateDir,
        DSH_TELEMETRY_DISABLED: '1', pnpm_config_verify_deps_before_run: 'error' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const item = { id, child, output: '', error: undefined, profile, closed: new Promise(done => child.once('close', (code, signal) => done({ code, signal }))) }
    children.push(item); child.once('error', (error) => { item.error = error })
    child.stdout.on('data', (chunk) => { item.output += String(chunk) }); child.stderr.on('data', (chunk) => { item.output += String(chunk) })
    await waitUntil(async () => {
      if (item.error) throw item.error
      if (child.exitCode !== null) throw new Error(id + ' exited before readiness')
      try { item.ready = JSON.parse(await readFile(profile.readyFile, 'utf8')); assert.equal(item.ready.pid, child.pid); return true }
      catch (error) {
        if (error.code === 'ENOENT') return false
        // The ready file becomes visible before its asynchronous write completes.
        if (error instanceof SyntaxError) {
          proofs.incompleteReadiness ??= []
          proofs.incompleteReadiness.push({ id, at: new Date().toISOString(), error: error.message })
          return false
        }
        throw error
      }
    }, id + ' actual named Profile readiness', 40000)
  }
  async function observe(context, id) {
    const page = await context.newPage(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => browserErrors.push({ page: id, message: error.message }))
    page.on('response', (response) => {
      const url = new URL(response.url()); network.push({ page: id, origin: url.origin, path: url.pathname, status: response.status() })
      if (!url.pathname.startsWith('/native/api/') || response.request().method() !== 'POST') return
      const read = (async () => {
        try { actions.push({ page: id, at: new Date().toISOString(), origin: url.origin, path: url.pathname, status: response.status(),
          request: response.request().postDataJSON(), response: await response.json() }) }
        catch (error) { network.push({ page: id, evidenceReadError: error.name }) }
      })()
      pendingReads.add(read); void read.finally(() => pendingReads.delete(read))
    })
    page.on('websocket', (socket) => {
      const endpoints = new Map()
      function record(direction, payload) {
        let frame; try { frame = JSON.parse(String(payload)) } catch (_nonJsonFrame) { return }
        if (direction === 'sent' && frame.type === 'open' && ['workspace/follow', 'session/follow', 'session/control'].includes(frame.endpoint)) endpoints.set(frame.streamId, frame.endpoint)
        const endpoint = endpoints.get(frame.streamId)
        if (endpoint) frames.push({ page: id, at: new Date().toISOString(), direction, endpoint, frame })
      }
      socket.on('framesent', ({ payload }) => record('sent', payload)); socket.on('framereceived', ({ payload }) => record('received', payload))
    })
    return page
  }
  async function preview(page) {
    await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    if (await notice.count()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  async function login(page, number) {
    await page.goto(plan.origins['p' + number] + '/login')
    await page.locator('#username').fill(users[number - 1].username); await page.locator('#password').fill(users[number - 1].password)
    await page.locator('#submit').click(); await page.waitForURL(plan.origins['h' + number] + '/native/'); await preview(page)
  }
  async function newSession(page, id) {
    await waitUntil(() => actions.some(item => item.page === id && item.path === '/native/api/session/create'), 'initial native create')
    const before = actions.filter(item => item.page === id && item.path === '/native/api/session/create').length
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await waitUntil(() => actions.filter(item => item.page === id && item.path === '/native/api/session/create').length > before, 'actual new Session RPC')
    const receipt = actions.filter(item => item.page === id && item.path === '/native/api/session/create').at(-1)
    assert.equal(receipt.response.result.ok, true)
    const result = receipt.response.result.value.sessionId
    await waitUntil(() => frames.some(item => item.page === id && item.direction === 'received' && item.endpoint === 'workspace/follow'
      && (item.frame.value?.type === 'upsert' && item.frame.value.workspace.sessionIds.includes(result)
        || item.frame.value?.type === 'baseline' && item.frame.value.value.items.some(workspace => workspace.sessionIds.includes(result)))), 'native workspace membership')
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor(); return result
  }
  async function openSession(page, host, target) {
    await page.goto(plan.origins[host] + '/native/'); await preview(page)
    const row = page.locator('[data-row-key="session:' + target + '"]'); await row.waitFor(); await row.click()
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
  }
  async function send(page, message, queue = false) {
    await page.locator('[data-composer-input][contenteditable="true"]').fill(message)
    if (queue) await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    else await page.locator('[data-composer-input]').press('Enter')
    let receipt
    await waitUntil(() => {
      receipt = actions.find(item => item.path === '/native/api/session/prompt'
        && item.request.payload.args.request.content.some(part => part.type === 'text' && part.text === message))
      return receipt !== undefined
    }, 'actual prompt accepted ' + message)
    assert.equal(receipt.response.result.ok, true); assert.equal(receipt.response.result.value.accepted, true)
    return receipt.request.payload.args.request.requestId
  }
  async function waitModel(message) { await waitUntil(() => requests.some(item => item.lastUserText === message), 'actual model entry ' + message, 65000) }
  async function drained(target = sessionId) {
    await waitUntil(async () => (await query("SELECT count(*)::int AS count FROM pe_operations WHERE session_id=$1 AND state IN ('queued','running')", [target]))[0].count === 0,
      'actual native operations settle and park', 65000)
  }
  async function nativePost(page, method, request) {
    return page.evaluate(async ({ method, request, rpcId }) => {
      const response = await fetch('/native/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }) })
      return { status: response.status, response: await response.json() }
    }, { method, request, rpcId: randomUUID() })
  }
  try {
    await writeFile(join(evidence, 'case-source.mjs'), await readFile(fileURLToPath(import.meta.url)))
    for (const name of ['replica-plan.mjs', 'fault-proxy.mjs', 'native-intent-key.mjs', 'identity-evidence.mjs']) await writeFile(join(evidence, name), await readFile(join(helperDir, name)))
    const build = await readFile(buildLog, 'utf8')
    proofs.artifact = { package: JSON.parse(await readFile(join(repository, 'products/power-evolve/application/package.json'), 'utf8')).version,
      buildLog, summary: build.split('\n').find(line => line.includes('files, total:')),
      webAssets: JSON.parse(await readFile(join(repository, 'products/power-evolve/cloud-web/dist/asset-list.json'), 'utf8')).length,
      webScope: 'existing native web bundle; no MCP/PDF new-client-byte acceptance' }
    const address = new URL((await readFile(urlFile, 'utf8')).trim()); assert(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
    databaseName = 'pe_employee2_replicas_' + randomUUID().replaceAll('-', '')
    const target = new URL(address); target.pathname = '/' + databaseName
    admin = new Pool({ connectionString: address.href, max: 1 }); pool = new Pool({ connectionString: target.href, max: 12 })
    await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true; await initializeDatabase(pool)
    assert.deepEqual(await query('SELECT family,version FROM pe_schema'), [{ family: 'cloud-native', version: 6 }])
    assert.equal((await query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"))[0].count, 82)
    for (const user of users) await seedNewUser(pool, user.username, await hashPassword(user.password), { model: 'deepseek-flash', maxTokens: 1000, revision: 1 })
    proofs.userOneId = (await query('SELECT id FROM pe_users WHERE username=$1', [users[0].username]))[0].id
    model.listen(0, '127.0.0.1'); await once(model, 'listening'); const modelAddress = model.address(); assert(modelAddress && typeof modelAddress !== 'string')
    const ports = {}; for (const id of ['h1', 'h2', 'p1', 'p2', 'proxy1', 'proxy2']) ports[id] = await unusedPort()
    plan = replicaPlan({ home, workerIds: [randomUUID(), randomUUID()], ports,
      modelUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1/messages', connectorUrl: 'http://127.0.0.1:' + modelAddress.port + '/unused-connector' })
    proofs.key = await materializeNativeIntentKeys(home)
    const workerToken = randomUUID(), modelKey = randomUUID(), connectorKey = randomUUID()
    for (const [id, files] of Object.entries(plan.privateFiles)) {
      await mkdir(plan.configs[id].config.privateDir, { recursive: true, mode: 0o700 })
      for (const [name, file] of Object.entries(files)) {
        if (name === 'native-intent-key') continue
        await writeFile(file, name === 'database-url' ? target.href : name === 'model-key' ? modelKey : name === 'connector-key' ? connectorKey : workerToken, { mode: 0o600 })
      }
    }
    await mkdir(join(home, 'operator'), { mode: 0o700 }); await writeFile(plan.routingFile, JSON.stringify(plan.routing), { mode: 0o600 })
    for (const options of plan.proxies) proxies.push(await createFaultProxy(options))
    await writeFile(join(evidence, 'ownership.json'), JSON.stringify({ databaseName, home, origins: plan.origins,
      workerIds: plan.routing.workerOrigins, keyPaths: proofs.key.paths }, null, 2))
    await stage('four-named-profiles-schema6', async () => {
      for (const id of ['p1', 'p2', 'h1', 'h2']) { const item = plan.configs[id]; await boot(id, await renderProfile(item.role, item.config), item.config) }
      proofs.profileInstances = children.map(item => ({ id: item.id, pid: item.child.pid, ready: item.ready,
        profile: item.profile, workerId: plan.configs[item.id].config.rows.host?.['power-evolve-runtime'].workerId }))
    })
    browser = await chromium.launch({ executablePath: process.env.PE_E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: process.env.PE_E2E_HEADLESS !== '0' })
    contextOne = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    const contextTwo = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    await contextOne.tracing.start({ screenshots: true, snapshots: true })
    await contextTwo.tracing.start({ screenshots: true, snapshots: true })
    sender = await observe(contextOne, 'sender'); second = await observe(contextTwo, 'second')
    await stage('two-users-login-and-real-native-models', async () => {
      await login(sender, 1); sessionId = await newSession(sender, 'sender')
      proofs.A = await send(sender, text.A); await waitModel(text.A)
      await sender.getByText('Replica stream 1.', { exact: false }).first().waitFor()
      const owner = (await query('SELECT worker_id FROM pe_native_writers WHERE session_id=$1 AND expires_at>clock_timestamp()', [sessionId]))[0]
      assert(owner); ownerId = ['h1', 'h2'].find(id => plan.configs[id].config.rows.host['power-evolve-runtime'].workerId === owner.worker_id)
      assert(ownerId); otherId = ownerId === 'h1' ? 'h2' : 'h1'; proofs.owner = { ownerId, otherId, workerId: owner.worker_id }
      await login(second, 2); proofs.secondSession = await newSession(second, 'second')
      proofs.X = await send(second, text.X); await waitModel(text.X); finish(text.X); await drained(proofs.secondSession)
      assert.equal(await second.getByText(text.A, { exact: true }).count(), 0)
      const denied = await nativePost(second, 'session/page', { address: { kind: 'session', sessionId }, throughSeq: -1, maxMessages: 1 })
      assert.equal(denied.status, 200); assert.equal(denied.response.result.ok, false); assert.equal(denied.response.result.error.code, 'session/not-found')
      proofs.crossUserRefusal = denied
    })
    await stage('non-owner-follows-and-queues-original-B', async () => {
      peer = await observe(contextOne, 'peer'); await openSession(peer, otherId, sessionId)
      await peer.getByText(text.A, { exact: true }).first().waitFor()
      await peer.getByText('Replica stream 1.', { exact: false }).first().waitFor()
      proofs.B = await send(peer, text.B, true)
      await peer.locator('[data-queue-dock]').getByText(text.B, { exact: true }).waitFor()
      await waitUntil(async () => (await history()).inbox['next-turn'].length === 1, 'actual admitted pending B')
      assert.equal(requests.filter(item => item.lastUserText === text.A).length, 1)
      assert.equal(requests.filter(item => item.lastUserText === text.B).length, 0)
    })
    if (kind === 'authority') {
      await stage('actual-owner-routed-edit-and-original-nonce-replay', async () => {
        const row = peer.locator('[data-queue-dock]').getByRole('listitem').filter({ hasText: text.B })
        await row.getByRole('button', { name: 'Edit queued message', exact: true }).click()
        await peer.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill(text.editedB)
        await peer.getByRole('button', { name: 'Save queued message', exact: true }).click()
        let action
        await waitUntil(() => { action = actions.find(item => item.page === 'peer' && item.path === '/native/api/session/updateQueue'
          && item.request.payload.args.request.action.kind === 'edit'); return action !== undefined }, 'actual queue edit response')
        assert.equal(action.response.result.ok, true)
        const before = await query("SELECT seq,event FROM pe_events WHERE session_id=$1 AND event->>'type'='agent/inbox/spliced' ORDER BY seq", [sessionId])
        const replay = await peer.evaluate(async (request) => { const response = await fetch('/native/api/session/updateQueue', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
        return { status: response.status, response: await response.json() } }, action.request)
        assert.equal(replay.status, action.status); assert.deepEqual(replay.response, action.response)
        assert.deepEqual(await query("SELECT seq,event FROM pe_events WHERE session_id=$1 AND event->>'type'='agent/inbox/spliced' ORDER BY seq", [sessionId]), before)
        const queue = await query("SELECT worker_id,state FROM pe_native_retained_intents WHERE session_id=$1 AND family='queue'", [sessionId])
        assert.equal(queue.length, 1); assert.equal(queue[0].worker_id, proofs.owner.workerId); assert.equal(queue[0].state, 'committed')
        proofs.editReplay = { action, replay, queue }
        finish(text.A); await waitModel(text.editedB); finish(text.editedB); await drained()
      })
      await stage('official-sign-out-revokes-same-credential-on-both-hosts', async () => {
        const cookies = await contextOne.cookies(); const credential = cookies.find(cookie => cookie.name === 'pe_agent')?.value; assert(credential)
        await peer.locator('[data-power-evolve-account-launcher] button[aria-haspopup="menu"]').click()
        await peer.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
        await peer.waitForURL(plan.origins['p' + otherId.slice(1)] + '/login')
        const refusals = []
        for (const host of ['h1', 'h2']) {
          const response = await fetch(plan.origins[host] + '/api/powerEvolve/me', { method: 'POST',
            headers: { origin: plan.origins[host], cookie: 'pe_agent=' + credential, 'content-type': 'application/json' }, body: JSON.stringify({ request: {} }) })
          assert.equal(response.status, 401); refusals.push({ host, status: response.status, response: await response.json() })
        }
        const independent = await second.evaluate(async () => { const response = await fetch('/api/powerEvolve/me', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: {} }) })
        return { status: response.status, response: await response.json() } })
        assert.equal(independent.status, 200); assert.equal(independent.response.username, users[1].username)
        proofs.revocation = { refusals, independent }
        await login(sender, 1); await openSession(sender, 'h1', sessionId); peer = sender
      })
    } else {
      await stage('actual-publication-commit-lost-reply-and-owner-process-exit', async () => {
        const originalFrame = (await query('SELECT frame_json FROM pe_native_turn_frames WHERE session_id=$1 ORDER BY operation_epoch', [sessionId]))[0].frame_json
        assert.equal(originalFrame.phase, 'claimed')
        proofs.before = { inputs: await inputRows(), frame: originalFrame, history: await history() }
        const proxy = proxies[Number(ownerId.slice(1)) - 1]
        const ruleId = proxy.arm({ path: '/runtime/native-intents/execute', mode: 'hold-response', family: 'publication' })
        let captured
        await waitUntil(() => { captured = proxy.snapshot().find(item => item.ruleId === ruleId && item.action === 'actual-upstream-response-complete'); return captured !== undefined }, 'actual publication reply withheld')
        assert.equal(captured.status, 200)
        const execute = proxy.snapshot().find(item => item.ruleId === ruleId && item.action === 'actual-request')
        const observedJournal = await query(retainedJournalSnapshotSql, [sessionId, 1000])
        const original = observedJournal.find(item => item.intent_id === execute.identity.intentId)
        assert(original); assert.equal(original.family, 'publication'); assert.equal(original.state, 'committed')
        assert.equal(original.has_sealed_request, true)
        const owner = children.find(item => item.id === ownerId)
        proofs.fault = { ruleId, captured, original, process: { id: owner.id, pid: owner.child.pid, ready: owner.ready },
          originalModelRequests: requests.length }
        owner.child.kill('SIGKILL'); proofs.fault.ownerExit = await owner.closed
        assert.equal(proofs.fault.ownerExit.signal, 'SIGKILL'); proxy.release(ruleId, 'drop')
        await waitUntil(() => controls.some(item => item.number === 1 && item.action === 'external-SSE-closed'), 'old actual external model request abort')
        assert(!controls.some(item => item.number === 1 && item.action === 'fixture-complete-external-SSE'))
      })
      await stage('different-worker-journal-scan-reconciles-A-and-executes-B-once', async () => {
        await waitModel(text.B)
        assert.equal(requests.filter(item => item.lastUserText === text.A).length, 1)
        assert.equal(requests.filter(item => item.lastUserText === text.B).length, 1)
        const attempt = await query('SELECT worker_id,epoch FROM pe_attempts WHERE operation_id=(SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2) ORDER BY epoch', [sessionId, proofs.B])
        assert.equal(attempt.length, 1); assert.equal(attempt[0].worker_id, plan.configs[otherId].config.rows.host['power-evolve-runtime'].workerId)
        await peer.getByText(text.B, { exact: true }).first().waitFor(); finish(text.B); await drained()
        const original = proofs.fault.original
        await waitUntil(async () => {
          const found = (await query(retainedJournalSnapshotSql, [sessionId, 1000])).find(row => row.intent_id === original.intent_id)
          return found?.has_sealed_request === false
        },
        'new worker resolves old retired journal without receiving its sealed credentials', 45000)
        const current = (await query(retainedJournalSnapshotSql, [sessionId, 1000])).find(row => row.intent_id === original.intent_id)
        proofs.journalComparison = compareJournalIdentity(original, current)
        assert.equal(proofs.journalComparison.identityEqual, true); assert.equal(proofs.journalComparison.terminalReceiptUnchanged, true)
        assert.equal(proofs.journalComparison.terminalStateUnchanged, true); assert.equal(proofs.journalComparison.sealedCleanupValid, true)
        const currentInputs = await inputRows()
        const keys = { pe_native_input_origins: ['origin_input_id'], pe_native_input_revisions: ['origin_input_id', 'input_revision'],
          pe_native_input_commands: ['session_id', 'command_id'], pe_native_input_cohorts: ['cohort_id'], pe_native_input_claims: ['origin_input_id'] }
        proofs.inputComparison = Object.fromEntries(Object.entries(keys).map(([table, key]) => [table,
          compareOriginalRows(proofs.before.inputs[table], currentInputs[table], key)]))
        assert(Object.values(proofs.inputComparison).every(item => item.originalRowsEqual))
        const currentFrame = (await query('SELECT frame_json FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
          [proofs.before.frame.operationId, proofs.before.frame.operationEpoch]))[0].frame_json
        proofs.frameComparison = compareFrameIdentity(proofs.before.frame, currentFrame)
        assert.equal(proofs.frameComparison.identityEqual, true)
        assert.equal(currentFrame.phase, 'settled'); assert.equal(currentFrame.errorCode, 'turn_interrupted')
        const operations = await query('SELECT request_id,state,error_code,attempts FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [sessionId])
        assert.deepEqual(operations.find(item => item.request_id === proofs.A), { request_id: proofs.A, state: 'failed', error_code: 'turn_interrupted', attempts: 2 })
        assert.deepEqual(operations.find(item => item.request_id === proofs.B), { request_id: proofs.B, state: 'completed', error_code: null, attempts: 1 })
        proofs.recoveryOperations = operations
        const observer = proxies[Number(otherId.slice(1)) - 1].snapshot()
        assert(observer.some(item => item.path === '/runtime/native-intents/reconcile' && item.action === 'actual-upstream-response-complete'
          && item.responseIdentity?.items?.some(value => value.intentId === original.intent_id && value.workerId === original.worker_id && value.outcome.state === 'committed')))
        proofs.differentWorkerScan = observer.filter(item => item.path === '/runtime/native-intents/reconcile')
      })
    }
    await stage('refresh-original-history-and-complete-new-D', async () => {
      await openSession(peer, kind === 'authority' ? 'h1' : otherId, sessionId); await peer.reload()
      await peer.getByText(text.A, { exact: true }).first().waitFor()
      await peer.getByText(kind === 'authority' ? text.editedB : text.B, { exact: true }).first().waitFor()
      proofs.D = await send(peer, text.D); await waitModel(text.D); finish(text.D); await drained()
      await peer.reload(); await peer.getByText(text.D, { exact: true }).first().waitFor()
      const final = await history(); assert.equal(final.turn, null); assert.equal(final.step, null)
      assert.deepEqual(final.inbox, { 'next-turn': [], 'next-step': [] })
      const messages = final.events.filter(event => event.type === 'user/message')
      for (const value of [text.A, kind === 'authority' ? text.editedB : text.B, text.D]) assert.equal(messages.filter(event => event.data.content.some(part => part.type === 'text' && part.text === value)).length, 1)
      for (const value of [text.A, kind === 'authority' ? text.editedB : text.B, text.X, text.D]) assert.equal(requests.filter(item => item.lastUserText === value).length, 1)
      assert.equal(requests.length, 4)
      const writers = await query('SELECT worker_id,epoch,expires_at FROM pe_native_writers WHERE session_id=$1', [sessionId]); assert(writers.every(writer => writer.expires_at === null))
      proofs.final = { history: final, writers, modelRequestCount: requests.length, operations: await query('SELECT request_id,state,error_code,attempts FROM pe_operations WHERE session_id=$1', [sessionId]),
        session: await query('SELECT lease_until,grant_digest IS NOT NULL AS grant_present FROM pe_sessions WHERE id=$1', [sessionId]) }
      assert.equal(proofs.final.session[0].lease_until, null); assert.equal(proofs.final.session[0].grant_present, false)
      assert.deepEqual(browserErrors, [])
    })
  } catch (error) { failure = error }
  finally {
    if (pool && created) {
      try { proofs.database = { schema: await query('SELECT family,version FROM pe_schema'),
        operations: await query('SELECT id,session_id,request_id,state,error_code,attempts FROM pe_operations ORDER BY created_at'),
        attempts: await query('SELECT operation_id,epoch,worker_id,started_at,ended_at FROM pe_attempts ORDER BY started_at'),
        journal: sessionId ? await query(retainedJournalSnapshotSql, [sessionId, 1000]) : [] } }
      catch (error) { proofs.databaseReadError = String(error); failure ??= error }
    }
    await Promise.all([...pendingReads])
    if (browser) {
      let index = 0
      for (const context of browser.contexts()) await context.tracing.stop({ path: join(evidence, 'browser-' + ++index + '-trace.zip') }).catch(() => {})
      await browser.close()
    }
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGTERM')
    const exits = await Promise.all(children.map(async (item) => {
      const timeout = setTimeout(() => item.child.kill('SIGKILL'), 5000)
      try { const exit = await item.closed; await writeFile(join(evidence, item.id + '.log'), item.output, { mode: 0o600 }); return { id: item.id, ...exit } }
      finally { clearTimeout(timeout) }
    }))
    const transport = proxies.map(proxy => proxy.snapshot()); for (const proxy of proxies) await proxy.close()
    for (const stream of modelStreams.values()) { clearInterval(stream.timer); stream.res.end() }
    if (model.listening) await new Promise((done) => { model.close(done); model.closeAllConnections() })
    if (pool) await pool.end()
    try { if (created) await admin.query('DROP DATABASE "' + databaseName + '"') }
    finally { if (admin) await admin.end(); await rm(home, { recursive: true, force: true }) }
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ state: failure ? 'failed' : 'passed', scenario: kind, currentStage, stages,
      error: failure instanceof Error ? failure.message : undefined, proofs, nativeActions: actions, nativeFrames: frames, transport,
      network, browserErrors, modelRequests: requests, modelControls: controls, exits, resourcesCleaned: true,
      scope: 'Actual Chrome, two users, formal PG6/82 tables and four named built Profiles. Only external model SSE controlled. Existing web bytes; excludes MCP/PDF new client acceptance.' }, null, 2), { mode: 0o600 })
    console.log('Employee2 replicas ' + kind + ' evidence: ' + evidence)
  }
  if (failure) throw failure
}

const selectedScenario = process.env.PE_E2E_REPLICAS_SCENARIO
assert(selectedScenario === undefined || ['authority', 'recovery'].includes(selectedScenario), 'Unknown replicas scenario')
if (selectedScenario === undefined || selectedScenario === 'authority') {
  test('two users follow across Hosts, mutate at the actual owner, replay one nonce and revoke the login on both replicas',
    { timeout: 240000 }, () => runScenario('authority'))
}
if (selectedScenario === undefined || selectedScenario === 'recovery') {
  test('a different worker resolves a committed lost reply, reconciles consumed A without model replay, completes queued B and new D',
    { timeout: 240000 }, () => runScenario('recovery'))
}
