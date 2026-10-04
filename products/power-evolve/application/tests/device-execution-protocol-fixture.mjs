/** Reusable real-PG Device fixture; container identities are synthetic and no Docker is started. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Pool } from 'pg'
import { DeviceService } from '../lib/platform/devices.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { taskCredential } from './task-credential-fixture.mjs'

const limits = { maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 16,
  maxActivePerUser: 4, executionEnabled: true }
/** Bounded synthetic terminal output. */
export const deviceResult = { state: 'succeeded', exitCode: 0, stdout: 'synthetic device output', stderr: '',
  stdoutTruncated: false, stderrTruncated: false, timedOut: false }
/** Build synthetic exact-container ownership for one real Platform dispatch.
 * @param device Enrolled Device and persistent enrollment identity.
 * @param claim Original Platform dispatch.
 * @returns Synthetic immutable Docker receipt; this does not assert a real container exists.
 */
export const receiptFor = (device, claim) => ({ containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`,
  owner: { deviceId: device.deviceId, enrollmentId: device.instanceId, executionId: claim.executionId,
    creationId: claim.dispatchId, requestDigest: claim.digest } })
/** Build the original process registration request.
 * @param device Enrolled Device identity.
 * @param claim Original process-bound dispatch.
 * @param receipt Immutable ownership receipt, synthetic by default.
 * @returns Registration DTO for the original dispatch.
 */
export const registrationFor = (device, claim, receipt = receiptFor(device, claim)) => ({
  instanceId: device.instanceId, executionId: claim.executionId, processId: claim.processId,
  dispatchId: claim.dispatchId, receipt,
})
/** Build a fresh stable stop request with an observation matching the supplied output.
 * @param device Enrolled Device identity.
 * @param claim Original process-bound dispatch.
 * @param output Terminal or unknown output.
 * @param receipt Immutable ownership receipt, synthetic by default.
 * @returns Stop DTO to save and reuse unchanged when testing retries.
 */
export const finishFor = (device, claim, output = deviceResult, receipt = receiptFor(device, claim)) => ({
  instanceId: device.instanceId, executionId: claim.executionId, processId: claim.processId,
  dispatchId: claim.dispatchId, requestId: randomUUID(), observation: { receipt, Running: false,
    ExitCode: output.exitCode ?? 0, Status: 'exited', StartedAt: '2026-10-04T00:00:00Z', FinishedAt: '2026-10-04T00:00:01Z' },
  result: output,
})

/** Create an isolated current-schema database and arrange automatic teardown of only that database.
 * @param t Node test context owning the database teardown.
 * @returns Actual Device/Task services and bounded fixture methods; it never starts Docker.
 */
export async function deviceProtocolFixture(t) {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-cloud-candidate')
  const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const database = `pe_device_protocol_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 15000 })
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 15000 })
  await initializeDatabase(pool)
  const users = ['alice', 'bob'].map(username => ({ userId: randomUUID(), username }))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,$2,$2,64)',
      [user.userId, 'fixture'])
  }
  const tasks = new TaskStore(pool, limits)
  const devices = new DeviceService(tasks, 1234, {})
  const enroll = async user => {
    const pair = await devices.pair(user, await taskCredential(pool, user)), instanceId = randomUUID()
    const device = await devices.enroll(pair.code, 'Synthetic device', instanceId)
    const directory = await devices.directory(device.token, 'Synthetic directory')
    return { ...device, ...directory, instanceId }
  }
  const operation = async (user, device) => {
    const token = await taskCredential(pool, user), requestId = randomUUID()
    const { sessionId } = await tasks.create(user, randomUUID(), token)
    const accepted = await tasks.accept(user, sessionId, requestId, 'Synthetic Device protocol test', token,
      { kind: 'desktop', deviceId: device.deviceId, directoryId: device.directoryId })
    const grant = await tasks.claim(randomUUID())
    assert.equal(grant.operationId, accepted.operationId)
    return { sessionId, grant }
  }
  const accepted = async (user, device) => {
    const op = await operation(user, device)
    const execution = await devices.propose(op.grant.token, 'synthetic-call', 'printf synthetic', '.')
    return { ...op, execution }
  }
  const claimed = async (user, device) => {
    const op = await accepted(user, device)
    const claim = await devices.claim(device.token, device.instanceId, op.execution.executionId, randomUUID())
    return { ...op, claim }
  }
  const row = async id => (await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [id])).rows[0]
  const continuations = async id => (await pool.query(`SELECT count(*)::integer AS n FROM pe_operations
    WHERE source='desktop_result' AND source_desktop_execution_id=$1`, [id])).rows[0].n
  return { pool, tasks, devices, alice: users[0], bob: users[1], enroll, operation, accepted, claimed, row, continuations }
}
