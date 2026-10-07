/** Isolated real PG checks V29 without migrating any fixed trial or inventing legacy writer identities. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import * as predecessors from '../lib/platform/schema.js'
import { schemaV27 } from '../lib/platform/storage-binding-schema.js'
import { schemaV28 } from '../lib/platform/execution-resolution-schema.js'
import { schemaV29 } from '../lib/platform/device-execution-schema.js'
import { schemaV30 } from '../lib/platform/device-resolution-schema.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'

test('V29 through V31 retain legacy facts without fabricating Device capture or closure', { timeout: 30000 }, async () => {
  const config = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-cloud-candidate')
  const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(config, 'database-url'), 'utf8')).trim()
  const name = `pe_device_v29_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 0 })
  let pool, created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true
    const url = new URL(databaseUrl); url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 2, idleTimeoutMillis: 0 })
    await transaction(pool, async client => {
      await client.query(predecessors.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (let version = 2; version <= 26; version++) await client.query(predecessors[`schemaV${version}`])
      await client.query(schemaV27); await client.query(schemaV28)
    })
    const user = randomUUID(), workspace = randomUUID(), session = randomUUID(), operation = randomUUID()
    const device = randomUUID(), directory = randomUUID(), execution = randomUUID(), enrollment = randomUUID()
    const output = { state: 'uncertain', stdout: 'preserve\0结果😀', exitCode: null }
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user, 'migration-fixture', 'fixture-only', {}])
    await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspace, user])
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [session, user, workspace, randomUUID(), {}])
    await pool.query('INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,$4,$5,$6)',
      [operation, session, randomUUID(), 'migration fixture', {}, 'completed'])
    await pool.query('INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id) VALUES($1,$2,$3,$4,$5)',
      [device, user, 'fixture-device', 'fixture-token-digest', enrollment])
    await pool.query('INSERT INTO pe_device_directories(id,device_id,user_id,label) VALUES($1,$2,$3,$4)',
      [directory, device, user, 'fixture-directory'])
    await pool.query(`INSERT INTO pe_desktop_executions(id,user_id,session_id,operation_id,device_id,directory_id,
      call_id,command,cwd,request_digest,state,device_instance_id,result)
      VALUES($1,$2,$3,$4,$5,$6,'legacy-call','echo legacy','','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'uncertain',$7,$8::json)`, [execution, user, session, operation, device, directory, enrollment, JSON.stringify(output)])
    const before = (await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [execution])).rows[0]
    await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,source,source_desktop_execution_id)
      VALUES($1,$2,$3,'prior continuation','{}','completed','desktop_result',$4)`,
    [randomUUID(), session, before.continuation_request_id, execution])
    await transaction(pool, client => client.query(schemaV29))
    const after = (await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [execution])).rows[0]
    assert.deepEqual(after, { ...before, dispatch_request: null, dispatch_id: null, dispatch_process_id: null,
      container_receipt: null, start_authorized_at: null, stop_request_id: null, stop_record_digest: null,
      stop_observation: null, continuation_queued: true })
    await transaction(pool, client => client.query(schemaV30))
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 30)
    assert.deepEqual((await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [execution])).rows[0], after)
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, predecessors.CURRENT_SCHEMA_VERSION)
    assert.deepEqual((await pool.query('SELECT * FROM pe_desktop_executions WHERE id=$1', [execution])).rows[0],
      { ...after, execution_kind: 'legacy_command', execution_target: 'desktop', origin_kind: 'operation',
        task_version: null, stdio_phase: null, stdio_task: null, stdio_action_id: null })
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_device_execution_resolutions')).rows[0].n, 0)
    assert.equal((await pool.query(`SELECT data_type FROM information_schema.columns
      WHERE table_name='pe_device_execution_resolutions' AND column_name='snapshot'`)).rows[0].data_type, 'json')
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_device_claim_closures')).rows[0].n, 0)
    const closureColumns = await pool.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_name='pe_device_claim_closures' AND column_name IN ('request','receipt') ORDER BY column_name`)
    assert.deepEqual(closureColumns.rows, [{ column_name: 'receipt', data_type: 'json' }, { column_name: 'request', data_type: 'json' }])
    await assert.rejects(pool.query('UPDATE pe_desktop_executions SET dispatch_id=$2 WHERE id=$1',
      [execution, randomUUID()]), { code: '23514' })
    await assert.rejects(pool.query('UPDATE pe_desktop_executions SET container_receipt=$2 WHERE id=$1',
      [execution, {}]), { code: '23514' })
    await assert.rejects(pool.query('UPDATE pe_desktop_executions SET start_authorized_at=now() WHERE id=$1',
      [execution]), { code: '23514' })
    await assert.rejects(pool.query('UPDATE pe_desktop_executions SET stop_request_id=$2 WHERE id=$1',
      [execution, randomUUID()]), { code: '23514' })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${name}"`) }
    finally { await admin.end() }
  }
})
