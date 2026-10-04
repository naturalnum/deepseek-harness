/** Device grants and desktop execution transitions against real PostgreSQL and POSIX storage. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DeviceFixtureService as DeviceService } from './task-credential-fixture.mjs'
import { FileService } from '../lib/platform/files.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { registrationFor, finishFor } from './device-execution-protocol-fixture.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('desktop device ownership, file transfer and durable result', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: databaseUrl })
  const name = `pe_test_${randomBytes(10).toString('hex')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(databaseUrl); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href })
  const root = await mkdtemp(join(tmpdir(), 'pe-device-test-'))
  t.after(async () => {
    await pool.end(); await admin.query(`DROP DATABASE "${name}"`); await admin.end()
    await rm(root, { recursive: true, force: true })
  })
  await initializeDatabase(pool)
  const alice = { userId: randomUUID(), username: 'alice' }, bob = { userId: randomUUID(), username: 'bob' }
  const sessionId = randomUUID(), operationId = randomUUID()
  for (const user of [alice, bob]) await pool.query(
    'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'irrelevant', '{}'])
  const workspaceId = randomUUID()
  await pool.query(`INSERT INTO pe_workspaces(id,user_id,title,is_default)
    VALUES($1,$2,'Workspace',true)`, [workspaceId, alice.userId])
  await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
    [sessionId, alice.userId, workspaceId, randomUUID(), '{}'])
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'desktop test','{}','running')`, [operationId, sessionId, randomUUID()])
  const tasks = { pool, async authorized(client, grant) {
    if (grant !== 'alice-grant') throw new Error('grant_denied')
    const result = await client.query('SELECT id,user_id FROM pe_sessions WHERE id=$1 FOR UPDATE', [sessionId])
    const target = (await client.query('SELECT execution_target FROM pe_operations WHERE id=$1', [operationId])).rows[0]
    return { ...result.rows[0], operation_id: operationId, execution_target: target.execution_target }
  } }
  const files = new FileService(pool, root); await files.init()
  const devices = new DeviceService(tasks, 3000, files)
  const paired = await devices.pair(alice)
  const instanceId = randomUUID(), enrollment = await devices.enroll(paired.code, 'test device', instanceId)
  await assert.rejects(devices.enroll(paired.code, 'again', randomUUID()), /pairing_invalid/)
  const dir = await devices.directory(enrollment.token, 'project')
  await assert.rejects(devices.directory('wrong-token', 'project'), /device_unauthorized/)
  assert.equal((await devices.list(bob)).items.length, 0)
  const bobPair = await devices.pair(bob)
  const bobDevice = await devices.enroll(bobPair.code, 'bob device', randomUUID())
  const bobDir = await devices.directory(bobDevice.token, 'bob project')
  await assert.rejects(devices.readCloud(bobDevice.token, dir.directoryId, 'source.txt'), /desktop_directory_unavailable/)
  await assert.rejects(devices.putCloud(enrollment.token, bobDir.directoryId, randomUUID(), 'leak.txt', 'eA=='), /desktop_directory_unavailable/)

  const content = Buffer.from('owner only\n').toString('base64')
  const uploaded = await devices.putCloud(enrollment.token, dir.directoryId, randomUUID(), 'source.txt', content)
  assert.equal(uploaded.size, 11)
  assert.equal((await devices.readCloud(enrollment.token, dir.directoryId, 'source.txt')).data, content)
  assert.equal((await Promise.all(Array.from({ length: 12 }, () =>
    devices.readCloud(enrollment.token, dir.directoryId, 'source.txt')))).length, 12)
  await assert.rejects(devices.putCloud(enrollment.token, dir.directoryId, randomUUID(), 'source.txt', content), /file_revision_conflict/)
  await assert.rejects(files.read(bob, 'source.txt'), /file_not_found/)

  await pool.query('UPDATE pe_operations SET execution_target=$2 WHERE id=$1',
    [operationId, JSON.stringify({ kind: 'desktop', deviceId: enrollment.deviceId, directoryId: dir.directoryId })])
  const accepted = await devices.propose('alice-grant', 'call-1', 'echo local', '')
  assert.equal(accepted.state, 'queued')
  assert.deepEqual(await devices.propose('alice-grant', 'call-1', 'echo local', ''), accepted)
  await assert.rejects(devices.propose('alice-grant', 'call-1', 'echo changed', ''), /request_id_conflict/)
  await assert.rejects(devices.propose('alice-grant', 'call-2', 'echo parallel', ''), /execution_busy/)
  await assert.rejects(devices.cancel(bob, accepted.executionId), /execution_not_found/)
  assert.equal((await devices.jobs(bobDevice.token, (await pool.query('SELECT instance_id FROM pe_devices WHERE id=$1', [bobDevice.deviceId])).rows[0].instance_id)).jobs.length, 0)
  await assert.rejects(devices.claim(enrollment.token, randomUUID(), accepted.executionId, randomUUID()), /device_instance_changed/)
  const enrolled = { ...enrollment, instanceId }, processId = randomUUID()
  const claimed = await devices.claim(enrollment.token, instanceId, accepted.executionId, processId)
  await devices.claim(enrollment.token, instanceId, accepted.executionId, processId)
  await devices.register(enrollment.token, registrationFor(enrolled, claimed))
  const result = { state: 'succeeded', exitCode: 0, stdout: 'local\u0000表😀\n', stderr: 'literal \\u0000',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false }
  const stopReport = finishFor(enrolled, claimed, result)
  const completed = await devices.finish(enrollment.token, stopReport)
  assert.equal(completed.state, 'succeeded')
  assert.deepEqual(completed.result, result)
  assert.equal((await devices.finish(enrollment.token, stopReport)).state, 'succeeded')
  await assert.rejects(devices.finish(enrollment.token,
    { ...stopReport, result: { ...result, stdout: 'different' } }), /stop_record_conflict/)
  assert.equal((await pool.query("SELECT count(*) FROM pe_operations WHERE source='desktop_result'")).rows[0].count, '1')
  assert.deepEqual((await pool.query('SELECT result FROM pe_desktop_executions WHERE id=$1', [accepted.executionId])).rows[0].result, result)
  const continuation = (await pool.query("SELECT input FROM pe_operations WHERE source='desktop_result'")).rows[0].input
  assert(continuation.includes(JSON.stringify(result)))
  assert(!continuation.includes('\u0000'))

  const queued = await devices.propose('alice-grant', 'call-queued', 'echo never', '')
  await devices.revokeDirectory(alice, dir.directoryId)
  assert.equal((await devices.executions(alice)).items.find(item => item.executionId === queued.executionId).state, 'cancelled')
  assert(!(await devices.jobs(enrollment.token, instanceId)).directories.includes(dir.directoryId))
  await assert.rejects(devices.readCloud(enrollment.token, dir.directoryId, 'source.txt'), /desktop_directory_unavailable/)
  await assert.rejects(devices.propose('alice-grant', 'call-after-revoke', 'echo no', ''), /desktop_target_unavailable/)
  const replacementDirectory = await devices.directory(enrollment.token, 'replacement project')
  await pool.query('UPDATE pe_operations SET execution_target=$2 WHERE id=$1',
    [operationId, JSON.stringify({ kind: 'desktop', deviceId: enrollment.deviceId,
      directoryId: replacementDirectory.directoryId })])
  const interrupted = await devices.propose('alice-grant', 'call-interrupted', 'echo maybe', '')
  const interruptedClaim = await devices.claim(enrollment.token, instanceId, interrupted.executionId, randomUUID())
  await devices.register(enrollment.token, registrationFor(enrolled, interruptedClaim))
  await devices.revokeDirectory(alice, replacementDirectory.directoryId)
  assert.equal((await devices.finish(enrollment.token, finishFor(enrolled, interruptedClaim, result))).state, 'uncertain')
  await devices.revoke(alice, enrollment.deviceId)
  await assert.rejects(devices.jobs(enrollment.token, instanceId), /device_unauthorized/)
})
