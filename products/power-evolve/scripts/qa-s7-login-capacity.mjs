/** Disposable dual-Platform login probe with aggregate-only capacity and abuse evidence. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '../application/lib/platform/identity.js'
import { seedNewUser } from '../application/lib/platform/account-settings.js'

const { Pool } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const trialScript = fileURLToPath(new URL('./trial.mjs', import.meta.url))
const name = `s7login-${randomBytes(4).toString('hex')}`
const privateDir = join(homedir(), '.config/power-evolve', `shared-host-${name}`)
const outputDir = join(root, '.artifacts/power-evolve', name)
const execFileAsync = promisify(execFile)
const accountCount = 128
const models = [{ id: 'deepseek-flash', label: 'Flash', maxTokens: 256, enabled: true }]
const settings = { model: 'deepseek-flash', maxTokens: 128, revision: 1 }
const users = Array.from({ length: accountCount + 2 }, (_, index) => ({
  username: `login-cap-${String(index).padStart(4, '0')}`,
  password: randomBytes(24).toString('base64url'), settings, models,
}))

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const portNames = ['PE_DATABASE_PORT', 'PE_HOST_PORT', 'PE_PLATFORM_PORT', 'PE_PLATFORM_SECOND_PORT',
  'PE_PLATFORM_LOAD_BALANCER_PORT', 'PE_TARGET_PORT']
const portValues = await Promise.all(portNames.map(freePort))
assert.equal(new Set(portValues).size, portValues.length)
const ports = Object.fromEntries(portNames.map((key, index) => [key, String(portValues[index])]))
const networkName = `pe-${name}`
const env = { ...process.env, ...ports, PE_TRIAL_NAME: name, PE_PRIVATE_DIR: privateDir,
  PE_MULTI_PLATFORM: '1', PE_MULTI_HOST: '0', PE_MODEL_URL: 'http://127.0.0.1:9/model',
  PE_MCP_ENABLED: '0', PE_SSH_ENABLED: '0', PE_DEVICE_ENABLED: '0',
  PE_COMPOSE_EXTERNAL_NETWORK: networkName }
const composeFiles = ['-f', 'products/power-evolve/compose.yaml',
  '-f', 'products/power-evolve/compose.external-network.yaml']
const origin = `http://127.0.0.1:${ports.PE_PLATFORM_LOAD_BALANCER_PORT}`
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const latency = values => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95),
  p99: percentile(values, 0.99), max: Math.max(...values) })
const peak = values => values.length ? Math.max(...values) : null

function trial(command) {
  const result = spawnSync(process.execPath, [trialScript, command], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000,
  })
  if (result.status !== 0) throw new Error(`Isolated trial ${command} failed; inspect ${outputDir}`)
}
function docker(...args) {
  const result = spawnSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) throw new Error(`Isolated Docker ${args[0]} failed; inspect ${outputDir}`)
  return result.stdout.trim()
}
function memoryMiB(value) {
  const match = /^([0-9.]+)(B|KiB|MiB|GiB)/.exec(value)
  if (!match) return null
  return Number(match[1]) * ({ B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 })[match[2]]
}
async function httpLogin(user, headers = {}) {
  const started = performance.now()
  const response = await fetch(`${origin}/identity/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: user.username, password: user.password }),
    signal: AbortSignal.timeout(60_000) })
  await response.arrayBuffer()
  return { status: response.status, ms: Math.round(performance.now() - started),
    backend: response.headers.get('x-pe-trial-platform') }
}
async function malformedLogin() {
  const started = performance.now()
  const response = await fetch(`${origin}/identity/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{', signal: AbortSignal.timeout(60_000) })
  await response.arrayBuffer()
  return { status: response.status, ms: Math.round(performance.now() - started) }
}
async function controlRequest() {
  const started = performance.now()
  const response = await fetch(`${origin}/config`, { signal: AbortSignal.timeout(60_000) })
  await response.arrayBuffer()
  return { status: response.status, ms: Math.round(performance.now() - started),
    backend: response.headers.get('x-pe-trial-platform') }
}

let started = false, networkCreated = false, pool, sampler, statsSampler
let sampling = false, dockerSampling = false, phase = 'setup'
const samples = [], postgresSamples = []
try {
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  await writeFile(join(privateDir, 'users.json'), `${JSON.stringify(users.slice(0, 2))}\n`,
    { mode: 0o600, flag: 'wx' })
  await writeFile(join(privateDir, 'model.env'),
    `DEEPSEEK_API_KEY=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
  for (let octet = 240; octet <= 255 && !networkCreated; octet++) {
    const result = spawnSync('docker', ['network', 'create', '--driver', 'bridge',
      '--subnet', `172.31.${octet}.0/28`, networkName], { encoding: 'utf8', timeout: 10_000 })
    networkCreated = result.status === 0
  }
  if (!networkCreated) throw new Error('No explicit /28 subnet available for isolated trial')
  started = true
  trial('up')
  pool = new Pool({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim(), max: 3 })
  for (const user of users.slice(2)) {
    await seedNewUser(pool, user.username, await hashPassword(user.password), user.settings, user.models)
  }
  const ready = await Promise.all(['platform', 'platform-b', 'platform-lb'].map(async component =>
    JSON.parse(await readFile(join(outputDir, 'trial', component, 'ready.json'), 'utf8'))))
  const health = await (await fetch(`${origin}/health`)).json()
  assert.equal(health.backends.filter(item => item.healthy).length, 2)
  const container = docker('compose', '-p', `pe-shared-host-${name}`, ...composeFiles,
    'ps', '-q', 'postgres')
  assert(container, 'Isolated PostgreSQL container was not found')
  const sampleDocker = async () => {
    if (dockerSampling) return
    dockerSampling = true
    const sampledPhase = phase
    try {
      const { stdout } = await execFileAsync('docker',
        ['stats', '--no-stream', '--format', '{{json .}}', container], { timeout: 10_000 })
      const value = JSON.parse(stdout.trim())
      postgresSamples.push({ phase: sampledPhase, cpuPercent: Number(value.CPUPerc?.replace('%', '')),
        memoryMiB: memoryMiB(value.MemUsage), at: Date.now() })
    } catch { /* Resource samples are separate from admission assertions. */ }
    finally { dockerSampling = false }
  }
  await sampleDocker()
  statsSampler = setInterval(() => void sampleDocker(), 1000)
  const completeDockerSample = async () => {
    while (dockerSampling) await new Promise(resolve => setTimeout(resolve, 25))
    await sampleDocker()
  }
  const processNames = ['platform', 'platformB', 'platformLB']
  const processPids = ready.map(item => item.pid)
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const [activity, ps] = await Promise.all([
        pool.query(`SELECT count(*) FILTER (WHERE datname=current_database())::integer AS connections,
          count(*) FILTER (WHERE datname=current_database() AND wait_event_type='Lock')::integer AS lock_waiters
          FROM pg_stat_activity`),
        execFileAsync('ps', ['-p', processPids.join(','), '-o', 'pid=,pcpu=,rss=']),
      ])
      const processes = Object.fromEntries(ps.stdout.trim().split('\n').map(line => {
        const [pid, cpu, rss] = line.trim().split(/\s+/)
        return [processNames[processPids.indexOf(Number(pid))], {
          cpuPercent: Number(cpu), memoryMiB: Number(rss) / 1024 }]
      }))
      samples.push({ phase, at: Date.now(), ...activity.rows[0], processes })
    } catch { /* Sampling must not change the admission result. */ }
    finally { sampling = false }
  }
  await sample()
  sampler = setInterval(() => void sample(), 100)
  const run = async (label, jobs) => {
    phase = label
    const began = performance.now()
    const responses = await Promise.all(jobs.map(job => job()))
    const batchMs = Math.round(performance.now() - began)
    await sample()
    await completeDockerSample()
    return { requests: responses.length, statusCounts: Object.fromEntries(
      [...new Set(responses.map(item => item.status))].map(status =>
        [status, responses.filter(item => item.status === status).length])),
    latencyMs: latency(responses.map(item => item.ms)), batchMs,
    backendCounts: Object.fromEntries(['platform', 'platform-b'].map(backend =>
      [backend, responses.filter(item => item.backend === backend).length])) }
  }
  const control = await run('control', Array.from({ length: accountCount }, () => controlRequest))
  assert.equal(control.statusCounts[200], accountCount)
  const distinct = await run('distinct', users.slice(2).map(user => () => httpLogin(user)))
  assert.equal(distinct.statusCounts[200], accountCount)
  assert(distinct.backendCounts.platform > 0 && distinct.backendCounts['platform-b'] > 0)
  const malformed = await run('malformed', Array.from({ length: accountCount }, () => malformedLogin))
  assert.equal(malformed.statusCounts[400], accountCount)
  const oneAccount = await run('one-account', Array.from({ length: 20 }, (_, index) => () =>
    httpLogin(users[0], { 'x-forwarded-for': `198.51.100.${index + 1}` })))
  assert.equal(oneAccount.statusCounts[200], 20)
  assert.equal((await httpLogin(users[0], { 'x-forwarded-for': '203.0.113.250' })).status, 429)
  const policy = (await pool.query('SELECT login_global_attempts_per_window AS limit FROM pe_platform_admission_policy')).rows[0]
  await pool.query('UPDATE pe_login_global_window SET attempts=$1 WHERE singleton=true', [policy.limit])
  assert.equal((await httpLogin(users[1])).status, 429)
  await pool.query("UPDATE pe_login_global_window SET window_since=clock_timestamp()-interval '61 seconds'")
  assert.equal((await httpLogin(users[1])).status, 200)
  const trackedBefore = (await pool.query('SELECT count(*)::integer AS count FROM pe_login_attempt_windows')).rows[0].count
  const expiredRows = 10_000
  await pool.query(`INSERT INTO pe_login_attempt_windows(account_digest,window_since,attempts)
    SELECT md5('probe-a-'||number::text)||md5('probe-b-'||number::text),
      clock_timestamp()-interval '61 seconds',1 FROM generate_series(1,$1::integer) AS number`, [expiredRows])
  await pool.query(`UPDATE pe_login_global_window SET tracked_accounts=
    (SELECT count(*)::integer FROM pe_login_attempt_windows) WHERE singleton=true`)
  await pool.query("UPDATE pe_login_attempt_windows SET window_since=clock_timestamp()-interval '61 seconds'")
  phase = 'expired-cleanup'
  const cleanupBegan = performance.now()
  assert.equal((await httpLogin(users[1])).status, 200)
  const expiredCleanupMs = Math.round(performance.now() - cleanupBegan)
  await sample()
  await completeDockerSample()
  const trackedAfter = (await pool.query('SELECT count(*)::integer AS count FROM pe_login_attempt_windows')).rows[0].count
  assert.equal(trackedAfter, 1)
  const metrics = label => {
    const values = samples.filter(item => item.phase === label)
    const pg = postgresSamples.filter(item => item.phase === label)
    return { sampleCount: values.length, pgConnectionsPeak: peak(values.map(item => item.connections)),
      pgLockWaitersPeak: peak(values.map(item => item.lock_waiters)),
      processCpuPercentPeak: Object.fromEntries(processNames.map(key =>
        [key, peak(values.map(item => item.processes[key]?.cpuPercent).filter(Number.isFinite))])),
      processMemoryMiBPeak: Object.fromEntries(processNames.map(key =>
        [key, peak(values.map(item => item.processes[key]?.memoryMiB).filter(Number.isFinite))])),
      postgresCpuPercentPeak: peak(pg.map(item => item.cpuPercent).filter(Number.isFinite)),
      postgresMemoryMiBPeak: peak(pg.map(item => item.memoryMiB).filter(Number.isFinite)) }
  }
  phase = 'done'
  clearInterval(sampler); sampler = undefined
  clearInterval(statsSampler); statsSampler = undefined
  const report = { scenario: 's7-dual-platform-login-capacity', distinctAccounts: accountCount,
    platforms: 2, entry: 'real trial Platform LB', postgres: 'isolated Docker PostgreSQL 17',
    control: { ...control, metrics: metrics('control') },
    distinct: { ...distinct, successRate: distinct.statusCounts[200] / accountCount,
      metrics: metrics('distinct') },
    malformed: { ...malformed, metrics: metrics('malformed') },
    oneAccount: { ...oneAccount, excessStatus: 429, forgedForwardedForIgnored: true,
      metrics: metrics('one-account') },
    globalOverloadStatus: 429, globalRecoveryStatus: 200,
    expiration: { injectedExpiredRows: expiredRows, deletedRows: trackedBefore + expiredRows,
      cleanupHttpMs: expiredCleanupMs, remainingRows: trackedAfter,
      metrics: metrics('expired-cleanup') } }
  await writeFile(join(outputDir, 'login-capacity.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.log(`Evidence: ${join(outputDir, 'login-capacity.json')}`)
} finally {
  if (sampler) clearInterval(sampler)
  if (statsSampler) clearInterval(statsSampler)
  await pool?.end().catch(() => {})
  if (started) {
    try { trial('stop') } catch { console.error(`Isolated trial cleanup requires inspection: ${outputDir}`) }
    try { docker('compose', '-p', `pe-shared-host-${name}`, ...composeFiles,
      'down', '-v', '--remove-orphans') }
    catch { console.error(`Isolated PostgreSQL cleanup requires inspection: ${outputDir}`) }
  }
  if (networkCreated) {
    try { docker('network', 'rm', networkName) }
    catch { console.error(`Isolated Docker network cleanup requires inspection: ${networkName}`) }
  }
  await rm(privateDir, { recursive: true, force: true })
}
