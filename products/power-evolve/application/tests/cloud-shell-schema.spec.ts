/** Real owned PostgreSQL validates adjacent foreground-delivery schema and immutable admission. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { initializeDatabase } from '../src/platform/database.ts'
import { cloudFixture } from './cloud-fixture.ts'

async function execution(pool: Pool, userId: string, native = false): Promise<{ id: string; sessionId: string; operationId: string }> {
  const workspaceId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID(), id = randomUUID()
  await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,false)', [workspaceId, userId, workspaceId])
  await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
    [sessionId, userId, workspaceId, randomUUID(), { id: sessionId, version: 4, createdAt: Date.now(), isSeeded: false }])
  await pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'schema test',$4,'completed')",
    [operationId, sessionId, randomUUID(), { model: 'owned-model', maxTokens: 1024, revision: 1 }])
  if (native) {
    await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,
      result_delivery,requested_timeout_ms,command_timeout_ms,native_tool_grant_digest,native_tool_credential_version)
      VALUES($1,$2,$3,$4,$5,'true','','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','queued',
        'native_tool',5000,3000,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1)`,
    [id, userId, sessionId, operationId, randomUUID()])
  } else {
    await pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
      VALUES($1,$2,$3,$4,$5,'true','','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','queued')`,
    [id, userId, sessionId, operationId, randomUUID()])
  }
  return { id, sessionId, operationId }
}

test('an empty database reaches schema 7 and repeated initialization preserves legacy delivery', () =>
  cloudFixture(async ({ pool, alice }) => {
    expect((await pool.query('SELECT version,family FROM pe_schema')).rows).toEqual([{ version: 7, family: 'cloud-native' }])
    const row = await execution(pool, alice.user.userId)
    await initializeDatabase(pool)
    expect((await pool.query('SELECT result_delivery,command_timeout_ms,native_tool_grant_digest FROM pe_cloud_executions WHERE id=$1', [row.id])).rows)
      .toEqual([{ result_delivery: 'continuation', command_timeout_ms: null, native_tool_grant_digest: null }])
  }))

test('schema 6 upgrades transactionally without inventing an old execution timeout', () =>
  cloudFixture(async ({ pool, alice }) => {
    await pool.query(`DROP TRIGGER pe_cloud_execution_keep_delivery ON pe_cloud_executions;
      DROP FUNCTION pe_cloud_execution_keep_delivery();
      DROP TRIGGER pe_operation_require_continuation_delivery ON pe_operations;
      DROP FUNCTION pe_operation_require_continuation_delivery();
      ALTER TABLE pe_cloud_executions DROP COLUMN result_delivery CASCADE,
        DROP COLUMN requested_timeout_ms CASCADE,DROP COLUMN command_timeout_ms CASCADE,
        DROP COLUMN native_tool_grant_digest CASCADE,DROP COLUMN native_tool_credential_version CASCADE,
        DROP COLUMN native_tool_stop_request_id CASCADE,DROP COLUMN native_tool_stop_target CASCADE;
      UPDATE pe_schema SET version=6`)
    const row = await execution(pool, alice.user.userId)
    const before = (await pool.query('SELECT command,cwd,request_digest FROM pe_cloud_executions WHERE id=$1', [row.id])).rows[0]
    await initializeDatabase(pool)
    const after = (await pool.query('SELECT command,cwd,request_digest,result_delivery,command_timeout_ms FROM pe_cloud_executions WHERE id=$1', [row.id])).rows[0]
    expect(after).toEqual({ ...before, result_delivery: 'continuation', command_timeout_ms: null })
    expect((await pool.query('SELECT version FROM pe_schema')).rows).toEqual([{ version: 7 }])
  }))

test('native admission identity and its exact stop target stay immutable while lifecycle advances', () =>
  cloudFixture(async ({ pool, alice }) => {
    const row = await execution(pool, alice.user.userId, true)
    for (const sql of ["result_delivery='continuation'", 'requested_timeout_ms=6000', 'command_timeout_ms=4000',
      "native_tool_grant_digest=repeat('c',64)", 'native_tool_credential_version=2', "command='false'"]) {
      await expect(pool.query(`UPDATE pe_cloud_executions SET ${sql} WHERE id=$1`, [row.id]))
        .rejects.toMatchObject({ code: '23514' })
    }
    await pool.query("UPDATE pe_cloud_executions SET state='running',native_tool_stop_request_id=$2,native_tool_stop_target=$3 WHERE id=$1",
      [row.id, randomUUID(), { podUid: randomUUID() }])
    await expect(pool.query('UPDATE pe_cloud_executions SET native_tool_stop_target=$2 WHERE id=$1', [row.id, { podUid: randomUUID() }]))
      .rejects.toMatchObject({ code: '23514' })
    await pool.query("UPDATE pe_cloud_executions SET state='closed_unknown' WHERE id=$1", [row.id])
  }))

test('native results cannot create a continuation even through an older SQL caller', () =>
  cloudFixture(async ({ pool, alice }) => {
    const row = await execution(pool, alice.user.userId, true)
    await expect(pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,source,source_execution_id)
      SELECT $1,session_id,$2,'unexpected native continuation',settings,'queued','sandbox_result',$3
      FROM pe_operations WHERE id=$4`, [randomUUID(), randomUUID(), row.id, row.operationId]))
      .rejects.toMatchObject({ code: '23514', message: 'Native tool results cannot create continuation operations' })
    expect((await pool.query('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [row.id])).rows)
      .toEqual([{ count: 0 }])
  }))
