/** Disposable shared-Host conversation load probe; reports observed limits, never extrapolates. */
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
import { hashPassword, IdentityService } from '../application/lib/platform/identity.js'
import { seedNewUser } from '../application/lib/platform/account-settings.js'

const { Pool } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const usersCount = Number(process.env.PE_CAP_USERS ?? 64)
if (!Number.isInteger(usersCount) || usersCount < 2 || usersCount > 500) {
  throw new Error('PE_CAP_USERS must be between 2 and 500')
}
const name = `s7cap-${randomBytes(4).toString('hex')}`
const privateDir = join(homedir(), '.config/power-evolve', `shared-host-${name}`)
const outputDir = join(root, '.artifacts/power-evolve', name)
const trialScript = fileURLToPath(new URL('./trial.mjs', import.meta.url))
const users = Array.from({ length: usersCount }, (_, index) => ({
  username: `cap${String(index).padStart(4, '0')}`,
  password: randomBytes(20).toString('base64url'),
  settings: { model: 'deepseek-flash', maxTokens: 64, revision: 1 },
  models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash', maxTokens: 64, enabled: true }],
}))
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const result = server.address().port
  await new Promise(resolve => server.close(resolve))
  return result
}
const model = createServer(async (request, response) => {
  for await (const _part of request) { /* Drain the real Host model request. */ }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of [
    { type: 'message_start', message: { id: randomUUID(), model: 'deepseek-flash',
      usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const names = ['PE_DATABASE_PORT', 'PE_HOST_PORT', 'PE_HOST_SECOND_PORT', 'PE_LOAD_BALANCER_PORT',
  'PE_PLATFORM_PORT', 'PE_PLATFORM_SECOND_PORT', 'PE_PLATFORM_LOAD_BALANCER_PORT', 'PE_TARGET_PORT']
const ports = Object.fromEntries(await Promise.all(names.map(async key => [key, String(await freePort())])))
assert.equal(new Set(Object.values(ports)).size, names.length)
const env = { ...process.env, ...ports, PE_TRIAL_NAME: name, PE_PRIVATE_DIR: privateDir,
  PE_MULTI_HOST: '1', PE_MULTI_PLATFORM: '1', PE_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1/messages`,
  DEEPSEEK_API_KEY: randomBytes(32).toString('base64url'), PE_MCP_ENABLED: '0',
  PE_SSH_ENABLED: '0', PE_DEVICE_ENABLED: '0' }
const platform = `http://127.0.0.1:${ports.PE_PLATFORM_LOAD_BALANCER_PORT}`
const host = `http://127.0.0.1:${ports.PE_LOAD_BALANCER_PORT}`
function trial(command) {
  const result = spawnSync(process.execPath, [trialScript, command], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000,
  })
  if (result.status !== 0) throw new Error(`Trial ${command} failed: ${
    (result.stderr || result.stdout || result.error?.message).slice(-1000)}`)
}
async function rpc(token, method, request) {
  const response = await fetch(`${host}/api/powerEvolve/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ request }), signal: AbortSignal.timeout(30_000) })
  const body = await response.json()
  if (!response.ok) throw new Error(`${method}: ${response.status} ${body.error ?? 'failed'}`)
  return body
}
const rss = pid => {
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
  return result.status === 0 ? Number(result.stdout.trim()) / 1024 : null
}
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
let started = false, pool, sampler
try {
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  // Start the standard trial with two accounts; seed load-only accounts after startup so
  // the trial's readiness deadline measures service startup rather than password hashing.
  await writeFile(join(privateDir, 'users.json'), `${JSON.stringify(users.slice(0, 2))}\n`,
    { mode: 0o600, flag: 'wx' })
  await writeFile(join(privateDir, 'model.env'), `DEEPSEEK_API_KEY=${env.DEEPSEEK_API_KEY}\n`,
    { mode: 0o600, flag: 'wx' })
  started = true
  trial('up')
  pool = new Pool({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim(), max: 8 })
  for (let index = 2; index < users.length; index++) {
    const user = users[index]
    await seedNewUser(pool, user.username, await hashPassword(user.password), user.settings, user.models)
  }
  const identity = new IdentityService(pool, 60 * 60_000)
  const ready = await Promise.all(['host', 'host-b', 'platform', 'platform-b'].map(async component =>
    JSON.parse(await readFile(join(outputDir, 'trial', component, 'ready.json'), 'utf8'))))
  const samples = []
  const sample = () => samples.push(Object.fromEntries(ready.map((item, index) =>
    [['host', 'hostB', 'platform', 'platformB'][index], rss(item.pid)])))
  sample()
  const tokens = []
  for (let index = 0; index < users.length; index += 4) {
    tokens.push(...await Promise.all(users.slice(index, index + 4).map(user =>
      identity.login(user.username, user.password).then(value => value.token))))
  }
  const sessions = await Promise.all(tokens.map(token =>
    rpc(token, 'create', { requestId: randomUUID() }).then(value => value.sessionId)))
  assert.equal(new Set(sessions).size, usersCount)
  const denied = await fetch(`${host}/api/powerEvolve/page`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[0]}` },
    body: JSON.stringify({ request: { sessionId: sessions[1], after: -1, limit: 10 } }) })
  assert.equal(denied.status, 404)
  const sandboxBefore = (await pool.query('SELECT count(*)::integer AS count FROM pe_sandbox_instances')).rows[0].count
  const health = await (await fetch(`${platform}/health`)).json()
  assert.equal(health.service, 'platform-load-balancer')
  let peakConnections = 0
  sampler = setInterval(() => {
    sample()
    void pool.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database()')
      .then(result => { peakConnections = Math.max(peakConnections, result.rows[0].count) }).catch(() => {})
  }, 500)
  const acceptedAt = Date.now()
  const accepted = await Promise.all(tokens.map((token, index) =>
    rpc(token, 'prompt', { sessionId: sessions[index], requestId: randomUUID(), text: 'hi' })))
  const acceptedLatencyMs = Date.now() - acceptedAt
  const operationIds = accepted.map(value => value.operationId)
  const deadline = Date.now() + 180_000
  let rows
  do {
    rows = (await pool.query('SELECT id,state,completed_at FROM pe_operations WHERE id=ANY($1::uuid[])',
      [operationIds])).rows
    if (rows.length === usersCount && rows.every(row => row.state === 'completed')) break
    if (rows.some(row => row.state === 'failed')) throw new Error('A simple conversation failed under load')
    await delay(500)
  } while (Date.now() < deadline)
  assert.equal(rows.length, usersCount)
  assert(rows.every(row => row.state === 'completed'), 'Conversation completion timed out')
  const completionMs = rows.map(row => row.completed_at.getTime() - acceptedAt)
  const lookup = new Map(rows.map(row => [row.id, row]))
  assert(operationIds.every(id => lookup.has(id)))
  for (let index = 0; index < usersCount; index++) {
    const page = await rpc(tokens[index], 'page', { sessionId: sessions[index], after: -1, limit: 100 })
    assert(page.events.some(event => event.type === 'assistant/message'))
  }
  const idleUntil = Date.now() + 30_000
  let idle = false
  while (Date.now() < idleUntil) {
    const statuses = await Promise.all(ready.slice(0, 2).map(item => fetch(`${item.url}/health`).then(value => value.json())))
    idle = statuses.every(item => item.activeAgents === 0 && item.loadedSessions === 0 && item.activeGrants === 0)
    if (idle) break
    await delay(500)
  }
  assert(idle, 'Host Agent/Session objects did not return to idle')
  const sandboxAfter = (await pool.query('SELECT count(*)::integer AS count FROM pe_sandbox_instances')).rows[0].count
  assert.equal(sandboxAfter, sandboxBefore, 'hi created a Sandbox')
  clearInterval(sampler); sampler = undefined
  sample()
  const report = { scenario: 's7-simple-conversation-capacity', users: usersCount, hosts: 2, platforms: 2,
    model: 'deterministic SSE fixture', acceptedBatchMs: acceptedLatencyMs,
    completionMs: { p50: percentile(completionMs, 0.5), p95: percentile(completionMs, 0.95),
      p99: percentile(completionMs, 0.99), max: Math.max(...completionMs) },
    peakConnections, memoryMiB: { baseline: samples[0], peak: Object.fromEntries(
      Object.keys(samples[0]).map(key => [key, Math.max(...samples.map(item => item[key] ?? 0))])),
    idle: samples.at(-1) }, sandboxRowsBefore: sandboxBefore, sandboxRowsAfter: sandboxAfter,
    crossUserPage: denied.status, hostIdle: idle }
  await writeFile(join(outputDir, 'simple-conversation-capacity.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Capacity probe passed: ${usersCount} users, completion p95=${report.completionMs.p95} ms; `
    + `evidence: ${join(outputDir, 'simple-conversation-capacity.json')}`)
} finally {
  if (sampler) clearInterval(sampler)
  await pool?.end().catch(() => {})
  if (started) {
    try { trial('stop') } catch (error) { console.error(error.message) }
    const compose = ['compose', '-p', `pe-shared-host-${name}`, '-f', 'products/power-evolve/compose.yaml',
      ...(env.PE_COMPOSE_EXTERNAL_NETWORK ? ['-f', 'products/power-evolve/compose.external-network.yaml'] : []),
      'down', '-v', '--remove-orphans']
    const result = spawnSync('docker', compose, { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
    if (result.status !== 0) console.error(`Could not clean isolated capacity PG for ${name}`)
  }
  await rm(privateDir, { recursive: true, force: true })
  await new Promise(resolve => model.close(resolve))
}
