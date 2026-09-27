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
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP DATABASE "${name}"`)
    await admin.end()
  })
  await initializeDatabase(pool)
  const userId = randomUUID(), otherId = randomUUID(), sessionId = randomUUID(), otherSessionId = randomUUID()
  const operationId = randomUUID(), otherOperationId = randomUUID()
  const slowSessionId = randomUUID(), slowOperationId = randomUUID()
  await pool.query(`INSERT INTO pe_users(id,username,password_hash,settings) VALUES
    ($1,'first','irrelevant','{}'),($2,'other','irrelevant','{}')`, [userId, otherId])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES($1,$2,$3,'{}')`,
    [sessionId, userId, randomUUID()])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES($1,$2,$3,'{}')`,
    [otherSessionId, otherId, randomUUID()])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES($1,$2,$3,'{}')`,
    [slowSessionId, userId, randomUUID()])
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
  const records = new Map(), posted = [], removed = []
  const sandbox = {
    name: id => `pe-sb-${id.replaceAll('-', '')}`,
    async matchesInstance(_sessionId, _userId, expectedPodUid, expectedRunnerId) {
      return expectedPodUid === podUid && expectedRunnerId === runnerInstanceId
    },
    async ensureReady(id) { return { name: this.name(id), podUid, runnerInstanceId, token: 'runner', restartCount: 0 } },
    async remove(id) { removed.push(id) },
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
        stdout: state === 'succeeded' ? 'done' : '', stderr: '', stdoutTruncated: false,
        stderrTruncated: false, timedOut: false, instanceId: runnerInstanceId }
      records.set(value.id, result)
      return result
    },
  }
  const service = () => new ExecutionService(tasks, sandbox, 4, 50, 1000, 2000)
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

  // No worker ran before this restart. A replacement discovers the committed row.
  const replacement = service(); replacement.start()
  const finished = await eventually(async () => {
    const item = (await replacement.list(identity)).items.find(value => value.executionId === accepted.executionId)
    return item?.state === 'succeeded' ? item : null
  }, 'accepted command after restart')
  assert.equal(finished.result.stdout, 'done')
  assert.equal(posted.length, 1)
  assert.equal((await pool.query('SELECT count(*) FROM pe_operations WHERE source=$1', ['sandbox_result'])).rows[0].count, '1')

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
  assert.ok(removed.includes(sessionId))

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
  const slowSandbox = { ...sandbox, async ensureReady(id) {
    if (id === slowSessionId) await delay(1500)
    return sandbox.ensureReady(id)
  } }
  const slowFirst = new ExecutionService(tasks, slowSandbox, 2, 50, 10000, 2000, 450)
  const slowSecond = new ExecutionService(tasks, slowSandbox, 2, 50, 10000, 2000, 450)
  const slowCommand = await slowFirst.propose('slow-grant', 'slow-call', 'slow-start-once', '')
  slowFirst.start(); slowSecond.start()
  await eventually(async () => (await slowFirst.list(identity)).items.some(value =>
    value.executionId === slowCommand.executionId && value.state === 'succeeded'), 'slow Sandbox start', 5000)
  assert.equal((await pool.query('SELECT attempts FROM pe_cloud_executions WHERE id=$1',
    [slowCommand.executionId])).rows[0].attempts, 1)
  assert.equal(posted.filter(value => value.command === 'slow-start-once').length, 1)
  await slowFirst.close(); await slowSecond.close()
})
