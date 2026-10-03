/** Real isolated PG verifies the adjacent migration; no Kubernetes or model runs in this test. */
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
import { initializeDatabase, transaction } from '../lib/platform/database.js'

test('V28 preserves V27 uncertainty and enforces owner, retry, result and cleanup records', { timeout: 30000 }, async () => {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-cloud-candidate')
  const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const name = `pe_resolution_v28_${randomBytes(10).toString('hex')}`
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
      await client.query(schemaV27)
    })
    const userId = randomUUID(), otherUserId = randomUUID(), sessionId = randomUUID()
    const workspaceId = randomUUID(), operationId = randomUUID(), executionId = randomUUID()
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4),($5,$6,$3,$4)',
      [userId, `alice-${randomUUID()}`, 'fixture-only', {}, otherUserId, `bob-${randomUUID()}`])
    await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, userId])
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [sessionId, userId, workspaceId, randomUUID(), { fixture: true }])
    await pool.query('INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,$4,$5,$6)',
      [operationId, sessionId, randomUUID(), 'migration fixture', {}, 'completed'])
    const podUid = randomUUID(), runnerId = randomUUID(), commandDigest = 'b'.repeat(64)
    const priorResult = { state: 'uncertain', stdout: 'before\0after' }
    await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,
      command,cwd,request_digest,state,result,sandbox_name,pod_uid,runner_instance_id)
      VALUES($1,$2,$3,$4,'migration-call','git status','.',$5,'uncertain',$6::json,'fixture-sandbox',$7,$8)`,
    [executionId, userId, sessionId, operationId, commandDigest, JSON.stringify(priorResult), podUid, runnerId])
    const before = (await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [executionId])).rows[0]
    await transaction(pool, client => client.query(schemaV28))
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 28)
    assert.deepEqual((await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1', [executionId])).rows[0],
      { ...before, dispatch_request: null })
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, predecessors.CURRENT_SCHEMA_VERSION)

    const requestId = randomUUID(), resolutionId = randomUUID()
    const binding = { workspaceId, spaceId: workspaceId, rootKey: workspaceId, rootRelativePath: '', generation: 1 }
    const insert = `INSERT INTO pe_cloud_execution_resolutions(id,request_id,user_id,session_id,execution_id,
      request_digest,fingerprint,workspace_id,mount_generation,sandbox_name,pod_uid,runner_instance_id,
      binding_snapshot,execution_request_digest,note,state,continuation_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,7,'fixture-sandbox',$9,$10,$11,$12,'','accepted',$13)`
    const values = [resolutionId, requestId, userId, sessionId, executionId, 'c'.repeat(64),
      'd'.repeat(64), workspaceId, podUid, runnerId, binding, commandDigest, before.continuation_request_id]
    const mismatched = [...values]; mismatched[2] = otherUserId
    await assert.rejects(pool.query(insert, mismatched), { code: '23503' })
    await pool.query(insert, values)
    const duplicate = [...values]; duplicate[0] = randomUUID(); duplicate[1] = randomUUID()
    await assert.rejects(pool.query(insert, duplicate), { code: '23505' })
    await assert.rejects(pool.query("UPDATE pe_cloud_execution_resolutions SET state='completed' WHERE id=$1", [resolutionId]),
      { code: '23514' })
    await assert.rejects(pool.query("UPDATE pe_cloud_execution_resolutions SET continuation_queued=true WHERE id=$1", [resolutionId]),
      { code: '23514' })
    const observed = { state: 'failed', stdout: '\0untrusted output', stderr: '', exitCode: 1 }
    await pool.query('UPDATE pe_cloud_execution_resolutions SET observed_result=$2::json WHERE id=$1',
      [resolutionId, JSON.stringify(observed)])
    assert.deepEqual((await pool.query('SELECT observed_result FROM pe_cloud_execution_resolutions WHERE id=$1',
      [resolutionId])).rows[0].observed_result, observed)
    await pool.query(`UPDATE pe_cloud_execution_resolutions SET state='completed',final_execution_state='closed_unknown',
      stop_evidence=$2,continuation_queued=true WHERE id=$1`, [resolutionId, { kind: 'fixture-only' }])
    // Structural constraints cannot authenticate Kubernetes evidence; the runtime must validate the captured stop proof.
    await pool.query("UPDATE pe_cloud_executions SET state='closed_unknown',result=NULL WHERE id=$1", [executionId])
    await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,
      command,cwd,request_digest,state) VALUES($1,$2,$3,$4,'new-input','git status','.',$5,'queued')`,
    [randomUUID(), userId, sessionId, operationId, 'e'.repeat(64)])
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM pe_cloud_executions WHERE session_id=$1 AND state='queued'",
      [sessionId])).rows[0].n, 1)
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${name}"`) }
    finally { await admin.end() }
  }
})
