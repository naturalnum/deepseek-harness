/** Durable cloud-execution state with a deterministic runner and real PostgreSQL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionService } from '../lib/platform/executions.js'
import { initializeDatabase } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { kubernetesPodStopStatus } from '../lib/platform/pod-stop-status.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function eventually(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`Timed out: ${label}`)
}

test('native Pod stop observation rejects absence and unknown node state', () => {
  const containerID = `containerd://${'a'.repeat(64)}`
  const pod = { metadata: { deletionTimestamp: '2026-09-28T00:00:00Z', generation: 1 },
    spec: { nodeName: 'node-1', containers: [{ name: 'runner' }] },
    status: { phase: 'Failed', conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
      containerStatuses: [{ name: 'runner', ready: false, restartCount: 0, containerID,
        state: { terminated: { containerID, exitCode: 0,
          startedAt: '2026-09-27T23:59:00Z', finishedAt: '2026-09-28T00:00:01Z' } } }] } }
  assert.equal(kubernetesPodStopStatus(pod), 'KUBELET_STOPPED')
  assert.equal(kubernetesPodStopStatus({ ...pod, metadata: { generation: 1 } }), null)
  assert.equal(kubernetesPodStopStatus({ ...pod, status: { ...pod.status, reason: 'NodeLost' } }), null)
  assert.equal(kubernetesPodStopStatus({ ...pod, status: { ...pod.status, containerStatuses: [] } }), null)
})

test('cloud execution persists acceptance and reconciles runner outcomes', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: databaseUrl })
  const name = `pe_test_${randomBytes(10).toString('hex')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(databaseUrl); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href })
  const workers = []
  t.after(async () => {
    await Promise.allSettled(workers.map(worker => worker.close()))
    await pool.end()
    await admin.query(`DROP DATABASE "${name}"`)
    await admin.end()
  })
  await pool.query(migrations.schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 20; version++) await pool.query(migrations[`schemaV${version}`])
  const userId = randomUUID(), otherId = randomUUID(), sessionId = randomUUID(), otherSessionId = randomUUID()
  const operationId = randomUUID(), otherOperationId = randomUUID()
  const slowSessionId = randomUUID(), slowOperationId = randomUUID()
  await pool.query(`INSERT INTO pe_users(id,username,password_hash,settings) VALUES
    ($1,'first','irrelevant','{}'),($2,'other','irrelevant','{}')`, [userId, otherId])
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID()
  await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2),($3,$4)',
    [workspaceId, userId, otherWorkspaceId, otherId])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,'{}')`,
    [sessionId, userId, workspaceId, randomUUID()])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,'{}')`,
    [otherSessionId, otherId, otherWorkspaceId, randomUUID()])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,'{}')`,
    [slowSessionId, userId, workspaceId, randomUUID()])
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'test','{}','running')`, [operationId, sessionId, randomUUID()])
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'test','{}','running')`, [otherOperationId, otherSessionId, randomUUID()])
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'test','{}','running')`, [slowOperationId, slowSessionId, randomUUID()])
  const tasks = { pool, async authorized(client, token) {
    const selected = token === 'current-grant' ? { session: sessionId, operation: operationId }
      : token === 'other-grant' ? { session: otherSessionId, operation: otherOperationId }
        : token === 'slow-grant' ? { session: slowSessionId, operation: slowOperationId } : null
    if (!selected) throw new Error('invalid grant')
    const result = await client.query('SELECT id,user_id FROM pe_sessions WHERE id=$1 FOR UPDATE', [selected.session])
    return { ...result.rows[0], operation_id: selected.operation, execution_target: { kind: 'cloud' } }
  } }
  const runnerInstanceId = randomUUID(), podUid = randomUUID()
  const rawOutput = 'done\u0000表😀 literal \\u0000'
  const records = new Map(), posted = []
  const sandbox = {
    name: id => `pe-sb-${id.replaceAll('-', '')}`,
    async matchesInstance(_sessionId, _userId, expectedPodUid, expectedRunnerId) {
      return expectedPodUid === podUid && expectedRunnerId === runnerInstanceId
    },
    async ensureReady(id, owner) {
      await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id)
        VALUES($1,$2,$3,'ready',$4,$5) ON CONFLICT(session_id) DO NOTHING`,
      [id, owner, this.name(id), podUid, runnerInstanceId])
      return { name: this.name(id), podUid, runnerInstanceId, token: 'runner',
        restartCount: 0, generation: '1', sessionId: id, userId: owner }
    },
    async assertCurrent() {},
    async quarantine(id) {
      await pool.query("UPDATE pe_sandbox_instances SET state='unknown' WHERE session_id=$1", [id])
    },
    async recycleIdle() {},
    async runner(_name, _token, method, path, value) {
      if (method === 'GET') {
        const found = records.get(path.split('/').at(-1))
        if (!found) throw new KubernetesError(404, 'absent')
        return found
      }
      if (path.endsWith('/cancel')) {
        const found = records.get(path.split('/')[2]); found.state = 'cancelled'; return found
      }
      assert.equal(value.instanceId, runnerInstanceId)
      posted.push(value)
      const state = value.command === 'wait' ? 'running' : value.command === 'fail' ? 'failed' : 'succeeded'
      const result = { id: value.id, state, digest: digest(value), exitCode: state === 'running' ? null : state === 'failed' ? 1 : 0,
        stdout: value.command === 'echo yes' ? rawOutput : state === 'succeeded' ? 'done' : '', stderr: '', stdoutTruncated: false,
        stderrTruncated: false, timedOut: false, instanceId: runnerInstanceId }
      records.set(value.id, result)
      return result
    },
  }
  const service = () => {
    const worker = new ExecutionService(tasks, sandbox, 4, 50, 1000, 2000)
    workers.push(worker)
    return worker
  }
  const identity = { userId, username: 'first', settings: {} }
  const other = { userId: otherId, username: 'other', settings: {} }
  const first = service()
  const accepted = await first.propose('current-grant', 'call-one', 'echo yes', '')
  assert.equal(accepted.state, 'queued')
  assert.deepEqual(await first.propose('current-grant', 'call-one', 'echo yes', ''), accepted)
  await assert.rejects(first.propose('current-grant', 'call-one', 'echo no', ''), /request_id_conflict/)
  await assert.rejects(first.propose('current-grant', 'call-two', 'wait', ''), /execution_busy/)
  assert.equal((await first.list(other)).items.length, 0)
  await assert.rejects(first.cancel(other, accepted.executionId), /execution_not_found/)

  // V20 cannot settle the observed NUL output. Migration must reconcile that exact execution.
  first.start()
  await eventually(async () => (await first.list(identity)).items.some(value =>
    value.executionId === accepted.executionId && value.state === 'uncertain'
      && value.errorCode === 'sandbox_or_runner_unavailable'), 'V20 NUL result storage failure')
  await first.close()
  assert.equal(posted.length, 1)
  assert.equal((await pool.query("SELECT count(*) FROM pe_operations WHERE source='sandbox_result'")).rows[0].count, '0')
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
  const replacement = service(); replacement.start()
  const finished = await eventually(async () => {
    const item = (await replacement.list(identity)).items.find(value => value.executionId === accepted.executionId)
    return item?.state === 'succeeded' ? item : null
  }, 'accepted command after restart')
  assert.equal(finished.result.stdout, rawOutput)
  assert.equal(posted.length, 1)
  assert.equal((await pool.query('SELECT count(*) FROM pe_operations WHERE source=$1', ['sandbox_result'])).rows[0].count, '1')
  const stored = (await pool.query('SELECT result FROM pe_cloud_executions WHERE id=$1', [accepted.executionId])).rows[0].result
  assert.equal(stored.stdout, rawOutput)
  const continued = (await pool.query('SELECT input FROM pe_operations WHERE source_execution_id=$1', [accepted.executionId])).rows[0].input
  assert(continued.includes(JSON.stringify(stored)))
  assert(!continued.includes('\u0000'))
  assert.equal((await replacement.propose('current-grant', 'call-one', 'echo yes', '')).result.stdout, rawOutput)

  const waiting = await replacement.propose('current-grant', 'call-wait', 'wait', '')
  await eventually(async () => (await replacement.list(identity)).items.some(value =>
    value.executionId === waiting.executionId && value.state === 'running'), 'running command')
  const parallel = await replacement.propose('other-grant', 'other-call', 'echo second', '')
  await eventually(async () => (await replacement.list(other)).items.some(value =>
    value.executionId === parallel.executionId && value.state === 'succeeded'), 'second user while first command runs')
  assert.equal((await replacement.list(identity)).items.find(value => value.executionId === waiting.executionId).state, 'running')
  await replacement.cancel(identity, waiting.executionId)
  await eventually(async () => (await replacement.list(identity)).items.some(value =>
    value.executionId === waiting.executionId && value.state === 'cancelled'), 'cancelled command')
  assert.equal((await pool.query('SELECT count(*) FROM pe_operations WHERE source=$1', ['sandbox_result'])).rows[0].count, '3')

  const failing = await replacement.propose('current-grant', 'call-fail', 'fail', '')
  await eventually(async () => (await replacement.list(identity)).items.some(value =>
    value.executionId === failing.executionId && value.state === 'failed'), 'failed command')

  await replacement.close()
  const beforeStart = await replacement.propose('current-grant', 'call-pre-cancel', 'never-start', '')
  await replacement.cancel(identity, beforeStart.executionId)
  const resumed = service(); resumed.start()
  await eventually(async () => (await resumed.list(identity)).items.some(value =>
    value.executionId === beforeStart.executionId && value.state === 'cancelled'), 'cancel before Sandbox creation')
  assert.equal(posted.filter(value => value.command === 'never-start').length, 0)

  const uncertain = await resumed.propose('current-grant', 'call-uncertain', 'do-not-replay', '')
  await pool.query(`UPDATE pe_cloud_executions SET state='running',pod_uid=$2,runner_instance_id=$3
    WHERE id=$1`, [uncertain.executionId, randomUUID(), randomUUID()])
  await eventually(async () => (await resumed.list(identity)).items.some(value =>
    value.executionId === uncertain.executionId && value.state === 'uncertain'), 'changed runner')
  assert.equal(posted.filter(value => value.command === 'do-not-replay').length, 0)
  assert.equal((await pool.query('SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])).rows[0].state, 'unknown')
  await resumed.close()

  // Two platform workers may share PG. A slow Sandbox start must retain its lease
  // so the other worker cannot claim the same command while the first is active.
  const slowSandbox = { ...sandbox, async ensureReady(id, owner, assertLease) {
    if (id === slowSessionId) await delay(5000)
    return sandbox.ensureReady(id, owner, assertLease)
  } }
  const slowFirst = new ExecutionService(tasks, slowSandbox, 2, 50, 10000, 2000, 3000)
  const slowSecond = new ExecutionService(tasks, slowSandbox, 2, 50, 10000, 2000, 3000)
  workers.push(slowFirst, slowSecond)
  const slowCommand = await slowFirst.propose('slow-grant', 'slow-call', 'slow-start-once', '')
  slowFirst.start(); slowSecond.start()
  await eventually(async () => (await slowFirst.list(identity)).items.some(value =>
    value.executionId === slowCommand.executionId && value.state === 'succeeded'), 'slow Sandbox start', 15000)
  assert.equal((await pool.query('SELECT attempts FROM pe_cloud_executions WHERE id=$1',
    [slowCommand.executionId])).rows[0].attempts, 1)
  assert.equal(posted.filter(value => value.command === 'slow-start-once').length, 1)
  await slowFirst.close(); await slowSecond.close()
})
