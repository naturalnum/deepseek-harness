/** Real PG migration and opaque JSON roundtrips; no command or model is executed. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('V20 opaque records survive V21 and preserve NUL, escapes and Unicode', { timeout: 30000 }, async t => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const database = `pe_lossless_${randomBytes(10).toString('hex')}`
  let pool, created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 1 })
  await pool.query(migrations.schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (let version = 2; version <= 20; version++) await pool.query(migrations[`schemaV${version}`])
  const user = randomUUID(), workspace = randomUUID(), session = randomUUID(), operation = randomUUID()
  const device = randomUUID(), directory = randomUUID()
  await pool.query("INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,'fixture','fixture','{}')", [user])
  await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspace, user])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
    VALUES($1,$2,$3,$4,'{}')`, [session, user, workspace, randomUUID()])
  await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
    VALUES($1,$2,$3,'fixture','{}','completed')`, [operation, session, randomUUID()])
  await pool.query(`INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id)
    VALUES($1,$2,'fixture','digest',$3)`, [device, user, randomUUID()])
  await pool.query(`INSERT INTO pe_device_directories(id,device_id,user_id,label)
    VALUES($1,$2,$3,'fixture')`, [directory, device, user])
  const original = { stdout: 'old output 表😀', stderr: 'literal \\u0000', exitCode: 0 }
  const executions = ['pe_cloud_executions', 'pe_desktop_executions']
  for (const table of executions) {
    const extraColumns = table === 'pe_desktop_executions' ? ',device_id,directory_id' : ''
    const extraValues = table === 'pe_desktop_executions' ? ',$6,$7' : ''
    await pool.query(`INSERT INTO ${table}(id,user_id,session_id,operation_id,call_id,command,cwd,
      request_digest,state,result${extraColumns}) VALUES($1,$2,$3,$4,'fixture','true','','digest','succeeded',$5${extraValues})`,
    [randomUUID(), user, session, operation, JSON.stringify(original),
      ...(table === 'pe_desktop_executions' ? [device, directory] : [])])
  }
  await pool.query(`INSERT INTO pe_connector_actions(id,user_id,session_id,operation_id,call_id,action,
    request,request_digest,state,result) VALUES($1,$2,$3,$4,'fixture','trial_note_append','{}','digest','succeeded',$5)`,
  [randomUUID(), user, session, operation, JSON.stringify(original)])
  await pool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)', [session, { seq: 0, type: 'session/end-seed', time: 1, data: {} }])
  const columns = [...executions.map(table => [table, 'result']), ['pe_connector_actions', 'result'], ['pe_events', 'event']]
  const before = await Promise.all(columns.map(async ([table, column]) =>
    (await pool.query(`SELECT ${column} AS value FROM ${table}`)).rows[0].value))
  const payload = { stdout: '\u0000表😀', stderr: 'literal \\u0000; lone \ud800', exitCode: 0 }
  await assert.rejects(pool.query('SELECT $1::jsonb', [JSON.stringify(payload)]), { code: '22P05' })
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 24)
  for (const [index, [table, column]] of columns.entries()) {
    const migrated = (await pool.query(`SELECT ${column} AS value,pg_typeof(${column})::text AS type FROM ${table}`)).rows[0]
    assert.equal(migrated.type, 'json')
    assert.deepEqual(migrated.value, before[index])
    await pool.query(`UPDATE ${table} SET ${column}=$1`, [JSON.stringify(payload)])
    assert.deepEqual((await pool.query(`SELECT ${column} AS value FROM ${table}`)).rows[0].value, payload)
  }
})
