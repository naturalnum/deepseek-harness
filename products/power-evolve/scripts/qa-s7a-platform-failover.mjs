/** Disposable local S7a drill: native Web, two Hosts, two Platforms, real PG/POSIX and note API. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const trialScript = fileURLToPath(new URL('./trial.mjs', import.meta.url))
const name = `s7a-${randomBytes(4).toString('hex')}`
const privateDir = join(homedir(), '.config/power-evolve', `shared-host-${name}`)
const outputDir = join(root, '.artifacts/power-evolve', name)
const hold = Promise.withResolvers(), holdSeen = Promise.withResolvers()
const modelRequests = []
let heldCalls = 0

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function eventually(probe, accept, label, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(150)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 500)}`)
}
function sse(response, model, toolText, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = toolText === null ? [
    { type: 'message_start', message: { id: 's7a-model', model,
      usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [
    { type: 'message_start', message: { id: 's7a-model', model,
      usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use',
      id: `call_${randomUUID()}`, name: 'trial_notes_append', input: { text: toolText } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}
const model = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const last = body.messages.at(-1)
    const prompt = last?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    const toolText = prompt.startsWith('TOOL_APPEND:') ? prompt.slice('TOOL_APPEND:'.length) : null
    modelRequests.push({ kind: prompt === 'HOLD' ? 'hold' : toolText ? 'proposal' : 'reply' })
    if (prompt === 'HOLD') {
      heldCalls++
      holdSeen.resolve()
      await hold.promise
    }
    const continuation = body.messages.findLast(message => message.role === 'user'
      && message.content?.some(block => block.type === 'text'
        && block.text.includes('可信平台操作结果')))
    const resultText = continuation ? 'confirmed:approved-note' : `reply:${prompt.slice(0, 120)}`
    if (!response.destroyed) sse(response, body.model, toolText, resultText)
  } catch (_aborted) { response.destroy() }
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const modelPort = model.address().port
const portNames = ['PE_DATABASE_PORT', 'PE_HOST_PORT', 'PE_HOST_SECOND_PORT', 'PE_LOAD_BALANCER_PORT',
  'PE_PLATFORM_PORT', 'PE_PLATFORM_SECOND_PORT', 'PE_PLATFORM_LOAD_BALANCER_PORT', 'PE_TARGET_PORT']
const values = await Promise.all(portNames.map(freePort))
if (new Set([...values, modelPort]).size !== values.length + 1) throw new Error('Could not reserve distinct trial ports')
const ports = Object.fromEntries(portNames.map((key, index) => [key, String(values[index])]))
const env = { ...process.env, ...ports, PE_TRIAL_NAME: name, PE_PRIVATE_DIR: privateDir,
  PE_MULTI_HOST: '1', PE_MULTI_PLATFORM: '1', PE_MODEL_URL: `http://127.0.0.1:${modelPort}/v1/messages`,
  PE_COMPOSE_EXTERNAL_NETWORK: process.env.PE_COMPOSE_EXTERNAL_NETWORK,
  DEEPSEEK_API_KEY: randomBytes(32).toString('base64url'), PE_TARGET_DROP_AFTER_PERSIST: '1',
  PE_MCP_ENABLED: '0', PE_SSH_ENABLED: '0', PE_DEVICE_ENABLED: '0' }
const hostOrigin = `http://127.0.0.1:${ports.PE_LOAD_BALANCER_PORT}`
const platformOrigin = `http://127.0.0.1:${ports.PE_PLATFORM_LOAD_BALANCER_PORT}`
const targetOrigin = `http://127.0.0.1:${ports.PE_TARGET_PORT}`

function trial(...args) {
  const result = spawnSync(process.execPath, [trialScript, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000,
  })
  if (result.status !== 0) throw new Error(`Isolated trial ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message).slice(-1200)}`)
}
async function lbStatus(origin) { return (await (await fetch(`${origin}/health`)).json()) }
async function backendState(origin, names) {
  return eventually(() => lbStatus(origin), value => names.every(([name, healthy]) =>
    value.backends.find(item => item.name === name)?.healthy === healthy), 'load balancer backends')
}
async function killVerified(component) {
  const path = join(outputDir, 'trial', component, 'ready.json')
  const ready = JSON.parse(await readFile(path, 'utf8'))
  const health = await (await fetch(`${ready.url}/health`)).json()
  assert.equal(health.instanceId, ready.instanceId)
  assert.equal(health.ready, true)
  process.kill(ready.pid, 'SIGKILL')
  await eventually(async () => {
    try { await fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(300) }); return false }
    catch { return true }
  }, Boolean, `${component} stopped`)
}
async function rpc(page, method, request) {
  return page.evaluate(async ({ method, request }) => {
    const response = await fetch(`/api/powerEvolve/${method}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { method, request })
}
async function send(page, text) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  try { await composer.waitFor({ timeout: 20_000 }) }
  catch (error) {
    await page.screenshot({ path: join(outputDir, 's7a-composer-failed.png') })
    throw new Error(`Native composer unavailable at ${page.url()}: ${(await page.locator('body').innerText()).slice(0, 500)}`,
      { cause: error })
  }
  await composer.fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

let started = false, browser, db
await mkdir(privateDir, { mode: 0o700 })
try {
  await writeFile(join(privateDir, 'model.env'), `DEEPSEEK_API_KEY=${env.DEEPSEEK_API_KEY}\n`, { mode: 0o600 })
  await readFile(join(root, 'products/power-evolve/cloud-web/dist/asset-list.json'))
  started = true
  trial('up')
  db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
  await db.connect()
  browser = await chromium.launch({ headless: true })
  const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8'))[0]
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${platformOrigin}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  try { await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 20_000 }) }
  catch (error) {
    await page.screenshot({ path: join(outputDir, 's7a-login-failed.png') })
    throw new Error(`Native login stayed at ${page.url()}: ${(await page.locator('body').innerText()).slice(0, 300)}`, { cause: error })
  }
  const first = await fetch(`${platformOrigin}/config`)
  const second = await fetch(`${platformOrigin}/config`)
  assert.deepEqual(new Set([first.headers.get('x-pe-trial-platform'),
    second.headers.get('x-pe-trial-platform')]), new Set(['platform', 'platform-b']))
  const before = await lbStatus(hostOrigin)
  for (let index = 0; index < 4; index++) assert.equal((await rpc(page, 'me', {})).status, 200)
  const both = await lbStatus(hostOrigin)
  assert(both.backends.every((item, index) => item.served > before.backends[index].served))
  console.log('Two Hosts and two Platforms answered through separate loopback balancers')

  trial('stop-one', 'platform-b')
  await backendState(platformOrigin, [['platform', true], ['platform-b', false]])
  await page.getByRole('button', { name: 'New session', exact: true })
    .filter({ hasText: 'New Session' }).click()
  await send(page, 'HOLD')
  await Promise.race([holdSeen.promise, delay(30_000).then(() => { throw new Error('Model did not receive HOLD') })])
  const admitted = await eventually(async () => (await db.query(
    "SELECT id,session_id,state FROM pe_operations WHERE input='HOLD' ORDER BY created_at DESC LIMIT 1"
  )).rows[0], Boolean, 'accepted native input')
  assert.equal(heldCalls, 1)
  await killVerified('platform')
  await backendState(platformOrigin, [['platform', false], ['platform-b', false]])
  trial('start-one', 'platform-b')
  await backendState(platformOrigin, [['platform', false], ['platform-b', true]])
  hold.resolve()
  const interrupted = await eventually(async () => (await db.query(
    'SELECT state FROM pe_operations WHERE id=$1', [admitted.id])).rows[0]?.state,
  value => value === 'failed' || value === 'completed', 'accepted input after Platform loss', 75_000)
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM pe_operations WHERE input='HOLD'"))
    .rows[0].n, 1)
  assert.equal(modelRequests.filter(item => item.kind === 'hold').length, 1)
  await page.reload()
  await send(page, 'after-platform-failure')
  await eventually(async () => (await db.query(
    "SELECT state FROM pe_operations WHERE session_id=$1 AND input='after-platform-failure'",
    [admitted.session_id])).rows[0]?.state, value => value === 'completed', 'same Session on Platform B')
  const fileBytes = Buffer.from(`s7a:${name}\n`)
  const write = await rpc(page, 'filesPut', { sessionId: admitted.session_id, requestId: randomUUID(),
    path: 's7a/probe.txt', baseRevision: null, data: fileBytes.toString('base64') })
  assert.equal(write.status, 200)
  const read = await rpc(page, 'filesRead', { sessionId: admitted.session_id, path: 's7a/probe.txt' })
  assert.equal(read.status, 200)
  assert.deepEqual(Buffer.from(read.body.data, 'base64'), fileBytes)
  console.log(`Accepted input survived Platform A loss (${interrupted}); Platform B continued the same native Session and POSIX file`)

  trial('start-one', 'platform')
  await backendState(platformOrigin, [['platform', true], ['platform-b', true]])
  trial('stop-one', 'platform-b')
  await backendState(platformOrigin, [['platform', true], ['platform-b', false]])
  const noteText = `s7a-approved-${name}`
  await send(page, `TOOL_APPEND:${noteText}`)
  const action = await eventually(async () => (await db.query(
    `SELECT id,state,session_id FROM pe_connector_actions
     WHERE request->>'text'=$1 ORDER BY created_at DESC LIMIT 1`, [noteText])).rows[0],
  value => value?.state === 'pending', 'exact note proposal')
  assert.equal(action.session_id, admitted.session_id)
  const approvalContext = await browser.newContext()
  const approvalPage = await approvalContext.newPage()
  await approvalPage.goto(`${platformOrigin}/approval`)
  await approvalPage.locator('#username').fill(user.username)
  await approvalPage.locator('#password').fill(user.password)
  await approvalPage.locator('#login-button').click()
  const card = approvalPage.locator('#actions article').filter({ hasText: noteText })
  await card.waitFor({ timeout: 15_000 })
  await card.getByRole('button', { name: '批准本次写入' }).click()
  await eventually(async () => {
    try { return JSON.parse(await readFile(join(privateDir, 'trial-api-notes.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }, notes => notes.some(note => note.actionId === action.id), 'remote note persisted before response loss')
  await killVerified('platform')
  trial('start-one', 'platform-b')
  await backendState(platformOrigin, [['platform', false], ['platform-b', true]])
  const settled = await eventually(async () => (await db.query(
    'SELECT state,attempts FROM pe_connector_actions WHERE id=$1', [action.id])).rows[0],
  row => row?.state === 'succeeded', 'Platform B remote result reconciliation', 75_000)
  const continuation = await eventually(async () => (await db.query(
    'SELECT session_id,state FROM pe_operations WHERE source_action_id=$1', [action.id])).rows[0],
  row => row?.state === 'completed', 'original Session continuation', 75_000)
  assert.equal(continuation.session_id, admitted.session_id)
  assert(settled.attempts >= 2)
  const notes = JSON.parse(await readFile(join(privateDir, 'trial-api-notes.json'), 'utf8'))
  assert.deepEqual(notes.filter(note => note.actionId === action.id).map(note => note.text), [noteText])
  const target = await lbStatus(targetOrigin)
  assert.equal(target.notePostAttempts, 1, 'a lost response must reconcile by GET without replaying POST')
  const history = await rpc(page, 'page', { sessionId: admitted.session_id, after: -1, limit: 200 })
  assert.equal(history.status, 200)
  assert(history.body.events.some(event => event.type === 'user/message'
    && event.data.source?.kind === 'power-evolve-action'
    && event.data.source.actionId === action.id))
  console.log('Remote note persisted once; Platform B reconciled the lost response and resumed the original Session')

  await killVerified('host')
  await eventually(() => lbStatus(hostOrigin), value => !value.backends[0].healthy
    && value.backends[1].healthy, 'Host B failover')
  await page.reload()
  const afterHost = await rpc(page, 'page', { sessionId: admitted.session_id, after: -1, limit: 200 })
  assert.equal(afterHost.status, 200)
  assert(afterHost.body.events.some(event => event.type === 'user/message'
    && event.data.source?.actionId === action.id))
  await send(page, 'after-host-failure')
  await eventually(async () => (await db.query(
    "SELECT state FROM pe_operations WHERE session_id=$1 AND input='after-host-failure'",
    [admitted.session_id])).rows[0]?.state, value => value === 'completed', 'same Session on Host B')
  trial('start-one', 'host')
  await eventually(() => lbStatus(hostOrigin), value => value.backends.every(item => item.healthy),
    'Host A rejoined')
  const probe = await rpc(page, 'filesRead', { sessionId: admitted.session_id, path: 's7a/probe.txt' })
  assert.equal(probe.status, 200)
  assert.deepEqual(Buffer.from(probe.body.data, 'base64'), fileBytes)
  console.log('Host B restored the same native transcript; Host A rejoined without changing the POSIX file')

  const report = { scenario: 'local-s7a-platform-failover', trialName: name,
    sessionId: admitted.session_id, acceptedOperationId: admitted.id, acceptedOutcome: interrupted,
    actionId: action.id, remotePostAttempts: target.notePostAttempts, remoteRows: notes.length,
    connectorAttempts: settled.attempts, continuationSessionId: continuation.session_id,
    hostBalancers: await lbStatus(hostOrigin), platformBalancers: await lbStatus(platformOrigin) }
  await writeFile(join(outputDir, 's7a-evidence.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`S7a local failure drill passed; evidence: ${join(outputDir, 's7a-evidence.json')}`)
} finally {
  hold.resolve()
  await browser?.close().catch(() => {})
  await db?.end().catch(() => {})
  if (started && process.env.PE_S7A_KEEP_TRIAL !== '1') {
    try { trial('stop') } catch (error) { console.error(`Trial stop failed: ${error.message}`) }
    const compose = ['compose', '-p', `pe-shared-host-${name}`, '-f', 'products/power-evolve/compose.yaml',
      ...(env.PE_COMPOSE_EXTERNAL_NETWORK ? ['-f', 'products/power-evolve/compose.external-network.yaml'] : []),
      'down', '-v', '--remove-orphans']
    const stopped = spawnSync('docker', compose, { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
    if (stopped.status !== 0) console.error(`Disposable PG cleanup failed for ${name}`)
  }
  if (process.env.PE_S7A_KEEP_TRIAL !== '1') await rm(privateDir, { recursive: true, force: true })
  await new Promise(resolve => model.close(resolve))
}
