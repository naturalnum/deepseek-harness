/** Bounded real-model, real-Sandbox trial: two users, concurrent commands, repeated recycle. */
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const { Pool } = require('pg')
const trialName = process.env.PE_TRIAL_NAME ?? 'slice6'
const rounds = Number(process.env.PE_PROBE_ROUNDS ?? 3)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('PE_PROBE_ROUNDS must be 1–20')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve', `shared-host-${trialName}`)
const root = resolve(new URL('../../..', import.meta.url).pathname)
const output = join(root, '.artifacts/power-evolve', trialName)
const [databaseUrl, users, sandbox] = await Promise.all([
  readFile(join(privateDir, 'database-url'), 'utf8'),
  readFile(join(privateDir, 'users.json'), 'utf8').then(JSON.parse),
  readFile(join(privateDir, 'sandbox.json'), 'utf8').then(JSON.parse),
])
const pool = new Pool({ connectionString: databaseUrl.trim(), max: 4 })
const ready = await Promise.all(['host', 'host-b', 'platform', 'lb'].map(async name =>
  JSON.parse(await readFile(join(output, 'trial', name, 'ready.json'), 'utf8'))))
const [hostA, hostB, platform, balancer] = ready
const post = async (url, token, value) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value), signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(`${new URL(url).pathname}: ${response.status} ${body.error ?? 'failed'}`)
  return body
}
const eventually = async (check, label, timeout = 120000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(500) }
  throw new Error(`Timed out: ${label}`)
}
const rssMiB = pid => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
const memory = () => ({ hostA: rssMiB(hostA.pid), hostB: rssMiB(hostB.pid), platform: rssMiB(platform.pid) })
const token = await Promise.all(users.slice(0, 2).map(async user =>
  (await post(`${platform.url}/identity/login`, null, { username: user.username, password: user.password })).token))
const rpc = (user, method, request) => post(`${balancer.url}/api/powerEvolve/${method}`, token[user], { request })
const session = await Promise.all([0, 1].map(async user =>
  (await rpc(user, 'create', { requestId: randomUUID() })).sessionId))
const fileName = `capacity-${randomBytes(6).toString('hex')}.txt`
const report = { trialName, users: 2, hosts: 2, plannedRounds: rounds, fileName, rounds: [], sandboxIdleMs: sandbox.idleMs,
  limits: { hostConcurrencyPerInstance: 4, activePerUser: 1, sandboxConcurrency: 4,
    sandboxCpu: '1', sandboxMemoryMiB: 768 }, baselineMiB: memory() }
try {
  for (let round = 1; round <= rounds; round++) {
    const started = Date.now()
    const requests = await Promise.all([0, 1].map(user => rpc(user, 'prompt', {
      sessionId: session[user], requestId: randomUUID(),
      text: `请用 cloud_exec 工具执行且只执行一次命令：printf 'capacity-${user}-${round}\\n' >> ${fileName} && cat ${fileName}。等待可信执行结果后简要回答。`,
    })))
    const operations = requests.map(item => item.operationId)
    const execution = await eventually(async () => {
      const result = await pool.query(
        `SELECT user_id,session_id,operation_id,id,state,attempts FROM pe_cloud_executions
         WHERE operation_id=ANY($1::uuid[])`, [operations])
      if (result.rows.length !== 2 || result.rows.some(row => row.state !== 'succeeded')) return null
      return result.rows
    }, `round ${round} cloud executions`)
    await eventually(async () => {
      const result = await pool.query(
        `SELECT source_execution_id,state FROM pe_operations WHERE source_execution_id=ANY($1::uuid[])`,
        [execution.map(row => row.id)])
      return result.rows.length === 2 && result.rows.every(row => row.state === 'completed')
    }, `round ${round} Agent continuations`)
    await eventually(async () => {
      const result = await pool.query('SELECT session_id,state FROM pe_sandbox_instances WHERE session_id=ANY($1::uuid[])', [session])
      return result.rows.length === 2 && result.rows.every(row => row.state === 'deleted')
    }, `round ${round} Sandbox recycle`)
    const bytes = await Promise.all([0, 1].map(async user => {
      const file = await rpc(user, 'fileRead', { path: fileName })
      return Buffer.from(file.data, 'base64').toString('utf8')
    }))
    for (let user = 0; user < 2; user++) {
      const lines = bytes[user].trimEnd().split('\n')
      if (lines.length !== round || lines.at(-1) !== `capacity-${user}-${round}`) {
        throw new Error(`Unexpected workspace bytes for user ${user}, round ${round}`)
      }
    }
    report.rounds.push({ round, elapsedMs: Date.now() - started,
      attempts: execution.map(row => row.attempts), memoryMiB: memory(),
      workspaceLines: bytes.map(value => value.trimEnd().split('\n').length) })
  }
  await eventually(async () => {
    const statuses = await Promise.all([hostA, hostB].map(item => fetch(`${item.url}/health`).then(response => response.json())))
    return statuses.every(status => status.activeAgents === 0 && status.loadedSessions === 0 && status.activeGrants === 0)
  }, 'idle host release')
  const status = await fetch(`${balancer.url}/health`).then(response => response.json())
  report.balancer = status.backends.map(backend => ({ healthy: backend.healthy, served: backend.served }))
  report.finalMiB = memory()
  await writeFile(join(output, `capacity-probe-${rounds}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await pool.end() }
