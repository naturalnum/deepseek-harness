/** Real isolated PG with synthetic rows; no approval API, executor, model or user program runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import * as previous from '../lib/platform/schema.js'
import { schemaV27 } from '../lib/platform/storage-binding-schema.js'
import { schemaV28 } from '../lib/platform/execution-resolution-schema.js'
import { schemaV29 } from '../lib/platform/device-execution-schema.js'
import { schemaV30 } from '../lib/platform/device-resolution-schema.js'
import { schemaV31 } from '../lib/platform/device-claim-closure-schema.js'
import { schemaV32 } from '../lib/platform/office-preview-schema.js'
import { schemaV33 } from '../lib/platform/office-artifact-schema.js'
import { schemaV34 } from '../lib/platform/stdio-v2-schema.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'

const digest = 'a'.repeat(64), fingerprint = 'b'.repeat(64)
const raw = JSON.parse('{"10":"十","2":"二","_meta":{"literal":"a\\u0000b"},"__proto__":{"literal":true}}')
const added = ['execution_kind','execution_target','origin_kind','task_version','stdio_phase','stdio_task','stdio_action_id']
const stripAdded = row => Object.fromEntries(Object.entries(row).filter(([key]) => !added.includes(key)))
const table = target => target === 'cloud' ? 'pe_cloud_executions' : 'pe_desktop_executions'

async function bootstrapV33(pool) {
  await transaction(pool, async client => {
    await client.query(previous.schema); await client.query('INSERT INTO pe_schema VALUES(1)')
    for (let version=2; version<=26; version++) await client.query(previous[`schemaV${version}`])
    for (const sql of [schemaV27,schemaV28,schemaV29,schemaV30,schemaV31,schemaV32,schemaV33]) await client.query(sql)
  })
}
async function account(pool, label) {
  const user=randomUUID(), workspace=randomUUID(), session=randomUUID(), operation=randomUUID()
  const device=randomUUID(), directory=randomUUID()
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user,label,'synthetic-only',{}])
  await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)',[workspace,user])
  await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
    [session,user,workspace,randomUUID(),{}])
  await pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'fixture','{}','completed')",
    [operation,session,randomUUID()])
  await pool.query('INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id) VALUES($1,$2,$3,$4,$5)',
    [device,user,label,randomUUID(),randomUUID()])
  await pool.query('INSERT INTO pe_device_directories(id,user_id,device_id,label) VALUES($1,$2,$3,$4)',
    [directory,user,device,label])
  return {user,workspace,session,operation,device,directory}
}
async function connection(pool, actor) {
  const id=randomUUID()
  await transaction(pool, async client => {
    await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision) VALUES($1,$2,1)',[id,actor.user])
    await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,1,$3,$4)',
      [id,actor.user,JSON.stringify({invocation:{program:'node',argv:['server.mjs'],cwd:'.'},raw}),digest])
  })
  return id
}
function action(actor, connectionId, phase='discover', target='cloud') {
  const id=randomUUID(), execution=randomUUID(), request=phase==='discover'?randomUUID():null
  const continuation=phase==='call'?randomUUID():null, operation=phase==='call'?actor.operation:null
  const call=phase==='call'?randomUUID():null
  // The SQL fixture does not assert DTO validation; task/Prepared parsing has its own bounded tests.
  const task={formatVersion:2,actionId:id,phase,userId:actor.user,sessionId:actor.session,raw}
  return {id,execution,request,continuation,operation,call,task,actor,connectionId,phase,target}
}
async function insertAction(client, row, overrides={}) {
  const r={...row,...overrides}
  if (r.request) await client.query(`INSERT INTO pe_stdio_v2_management_requests
    (user_id,request_id,purpose,request,request_digest,receipt) VALUES($1,$2,'check',$3,$4,'{}')`,
  [r.actor.user,r.request,JSON.stringify(raw),digest])
  await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,
    phase,execution_target,execution_id,request_id,operation_id,root_operation_id,call_id,task,task_digest,state,continuation_request_id)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$10,$11,$12,$5,'queued',$13)`,
  [r.id,r.actor.user,r.actor.session,r.connectionId,digest,r.phase,r.target,r.execution,r.request,r.operation,r.call,
    JSON.stringify(r.task),r.continuation])
}
async function insertExecution(client, row, overrides={}) {
  const r={...row,...overrides}, desktop=r.target==='desktop'
  await client.query(`INSERT INTO ${table(r.target)}(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,
    state,execution_kind,origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id
    ${desktop?',device_id,directory_id':''}) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,'queued','stdio_v2',$7,$8,$9,$10,$11,$12
    ${desktop?',$13,$14':''})`,
  [r.execution,r.actor.user,r.actor.session,r.operation,r.call,digest,
    r.phase==='discover'?'stdio_discovery':'operation',r.taskVersion===undefined?2:r.taskVersion,
    r.phase,JSON.stringify(r.task),r.id,r.continuation,...(desktop?[r.actor.device,r.actor.directory]:[])])
}
async function insertPair(pool, row, executionOverride={}) {
  return transaction(pool, async client => { await insertAction(client,row); await insertExecution(client,row,executionOverride) })
}
async function prepare(pool, row) {
  await pool.query(`INSERT INTO pe_stdio_v2_preparations(action_id,user_id,session_id,phase,execution_target,execution_id,
    task_digest,prepared,prepared_digest,approval_binding,fingerprint,approval_epoch,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,$9,1,'2030-01-01T00:00:00Z')`,
  [row.id,row.actor.user,row.actor.session,row.phase,row.target,row.execution,digest,JSON.stringify(raw),fingerprint])
}

test('V34 and adjacent V35 preserve original tasks and bind generic execution, approval and continuation records', {timeout:30000}, async t => {
  assert.equal(previous.CURRENT_SCHEMA_VERSION,35)
  const databaseUrl=process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(process.env.PE_PRIVATE_DIR,'database-url'),'utf8')).trim()
  const name=`pe_stdio_v34_${randomBytes(10).toString('hex')}`
  const admin=new Pool({connectionString:databaseUrl,max:1,idleTimeoutMillis:0})
  let pool,created=false
  try {
    await admin.query(`CREATE DATABASE "${name}"`);created=true
    const url=new URL(databaseUrl);url.pathname=`/${name}`
    pool=new Pool({connectionString:url.href,max:2,idleTimeoutMillis:0})
    await bootstrapV33(pool)
    const alice=await account(pool,'v34-alice'),bob=await account(pool,'v34-bob')
    const before=[]
    for (const target of ['cloud','desktop']) {
      const desktop=target==='desktop',id=randomUUID()
      await pool.query(`INSERT INTO ${table(target)}(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,result
        ${desktop?',device_id,directory_id':''}) VALUES($1,$2,$3,$4,$5,'printf literal','',$6,'succeeded',$7
        ${desktop?',$8,$9':''})`,[id,alice.user,alice.session,alice.operation,target,digest,JSON.stringify(raw),
        ...(desktop?[alice.device,alice.directory]:[])])
      before.push({target,id,row:(await pool.query(`SELECT * FROM ${table(target)} WHERE id=$1`,[id])).rows[0]})
    }
    await pool.query(schemaV34)
    const originalActor=await account(pool,'v34-original')
    const originalTask=action(originalActor,await connection(pool,originalActor))
    await insertPair(pool,originalTask);await prepare(pool,originalTask)
    const originalTables=['pe_stdio_v2_actions','pe_stdio_v2_preparations','pe_cloud_executions']
    const originalRows=await Promise.all(originalTables.map(async tableName=>
      (await pool.query(`SELECT row_to_json(saved)::text AS literal FROM ${tableName} saved ORDER BY ${tableName==='pe_stdio_v2_preparations'?'action_id':'id'}`)).rows))
    await t.test('V34 to V35 and repeated startup leave complete originals and legacy rows unchanged',async()=>{
      await initializeDatabase(pool);await initializeDatabase(pool)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version,35)
      for(let index=0;index<originalTables.length;index++) {
        const tableName=originalTables[index]
        assert.deepEqual((await pool.query(`SELECT row_to_json(saved)::text AS literal FROM ${tableName} saved ORDER BY ${tableName==='pe_stdio_v2_preparations'?'action_id':'id'}`)).rows,originalRows[index])
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_observations')).rows[0].n,0)
      for (const {target,id,row} of before) {
        const after=(await pool.query(`SELECT * FROM ${table(target)} WHERE id=$1`,[id])).rows[0]
        assert.deepEqual(stripAdded(after),row)
        assert.equal(after.execution_kind,'legacy_command');assert.equal(after.execution_target,target)
        assert.equal(after.origin_kind,'operation')
        for (const field of added.slice(3)) assert.equal(after[field],null)
      }
    })
    const aConnection=await connection(pool,alice),bConnection=await connection(pool,bob)
    const discover=action(alice,aConnection),call=action(bob,bConnection,'call','desktop')
    await t.test('same-transaction discovery and call bind the original two execution targets',async()=>{
      await insertPair(pool,discover);await insertPair(pool,call)
      assert.equal((await pool.query('SELECT operation_id FROM pe_cloud_executions WHERE id=$1',[discover.execution])).rows[0].operation_id,null)
      assert.equal((await pool.query('SELECT command FROM pe_desktop_executions WHERE id=$1',[call.execution])).rows[0].command,null)
    })
    await t.test('SQL NULL cannot bypass a task-version branch and incomplete owner linkage cannot commit',async()=>{
      const bad=action(alice,aConnection)
      await assert.rejects(transaction(pool,async client=>{
        await insertAction(client,bad);await insertExecution(client,bad,{taskVersion:null})
      }),{code:'23514'})
      await assert.rejects(transaction(pool,client=>insertAction(client,action(alice,aConnection))),{code:'23503'})
      const foreign=action(alice,bConnection)
      await assert.rejects(insertPair(pool,foreign),{code:'23503'})
      const foreignDevice=action(alice,aConnection,'discover','desktop')
      await assert.rejects(insertPair(pool,foreignDevice,{actor:{...alice,device:bob.device,directory:bob.directory}}),{code:'23503'})
    })
    await t.test('full raw task and original operation must match, including escaped NUL and metadata',async()=>{
      const bad=action(bob,bConnection)
      await assert.rejects(insertPair(pool,bad,{task:{...bad.task,raw:{replacement:true}}}),{code:'23514'})
      const badCall=action(bob,bConnection,'call')
      await assert.rejects(insertPair(pool,badCall,{operation:alice.operation}),{code:'23514'})
      const saved=(await pool.query('SELECT task::text AS raw FROM pe_stdio_v2_actions WHERE id=$1',[discover.id])).rows[0].raw
      assert.equal(saved,JSON.stringify(discover.task));assert.deepEqual(JSON.parse(saved).raw,raw)
      for (const [tableName,column] of [['pe_stdio_v2_actions','task'],['pe_stdio_v2_preparations','prepared'],
        ['pe_stdio_v2_catalogs','raw_catalog'],['pe_stdio_v2_results','result'],['pe_operations','stdio_v2_selection'],
        ['pe_cloud_executions','stdio_task'],['pe_desktop_executions','stdio_task']]) {
        assert.equal((await pool.query(`SELECT data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,[tableName,column])).rows[0].data_type,'json')
      }
    })
    await t.test('accepted action and generic execution cannot replace original identity or task',async()=>{
      await assert.rejects(pool.query("UPDATE pe_stdio_v2_actions SET task='{}' WHERE id=$1",[discover.id]),{code:'23514'})
      await assert.rejects(pool.query("UPDATE pe_cloud_executions SET execution_kind='legacy_command' WHERE id=$1",[discover.execution]),{code:'23514'})
      await pool.query("UPDATE pe_stdio_v2_actions SET state='preparing' WHERE id=$1",[discover.id])
      await pool.query('UPDATE pe_cloud_executions SET cancel_requested=true WHERE id=$1',[discover.execution])
    })
    await prepare(pool,discover);await prepare(pool,call)
    await t.test('Prepared and decision bind the same owner and cannot be renewed or replaced',async()=>{
      await assert.rejects(pool.query('UPDATE pe_stdio_v2_preparations SET approval_epoch=2 WHERE action_id=$1',[call.id]),{code:'23514'})
      await assert.rejects(pool.query(`INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision)
        VALUES($1,$2,$3,'once')`,[call.id,alice.user,fingerprint]),{code:'23503'})
      await pool.query(`INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,'once')`,
        [call.id,bob.user,fingerprint])
      await pool.query(`INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,'reject')`,
        [discover.id,alice.user,fingerprint])
      await assert.rejects(pool.query('DELETE FROM pe_stdio_v2_decisions WHERE action_id=$1',[call.id]),{code:'23514'})
    })
    const permitSql=`INSERT INTO pe_stdio_v2_start_permits(action_id,permit_id,authorization_request_id,execution_id,
      task_digest,prepared_digest,fingerprint,decision,executor_owner,permit,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$5,$6,'once',$7,$7,'2029-01-01T00:00:00Z','2030-01-01T00:00:00Z')`
    const permitArgs=r=>[r.id,randomUUID(),randomUUID(),r.execution,digest,fingerprint,JSON.stringify(raw)]
    await t.test('rejected action cannot issue a permit; a successful action has one immutable permit and dispatch',async()=>{
      await assert.rejects(pool.query(permitSql,permitArgs(discover)),{code:'23503'})
      await pool.query(permitSql,permitArgs(call))
      await assert.rejects(pool.query(permitSql,permitArgs(call)),{code:'23505'})
      await assert.rejects(pool.query('UPDATE pe_stdio_v2_start_permits SET authorization_request_id=$2 WHERE action_id=$1',
        [call.id,randomUUID()]),{code:'23514'})
      await pool.query('INSERT INTO pe_stdio_v2_dispatches(action_id,dispatch,dispatch_digest) VALUES($1,$2,$3)',
        [call.id,JSON.stringify(raw),digest])
      await assert.rejects(pool.query("UPDATE pe_stdio_v2_dispatches SET dispatch='{}' WHERE action_id=$1",[call.id]),{code:'23514'})
    })
    await t.test('catalog preserves raw bytes and cannot attach a foreign owner or call phase',async()=>{
      await pool.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$2,$2)',
        [discover.id,JSON.stringify(raw),digest])
      const catalog=randomUUID()
      await pool.query(`INSERT INTO pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision,config_digest,action_id,
        session_id,phase,raw_catalog,image_expectation,catalog_digest) VALUES($1,$2,$3,1,$4,$5,$6,'discover',$7,$8,$4)`,
      [catalog,alice.user,aConnection,digest,discover.id,alice.session,JSON.stringify([raw]),JSON.stringify(raw)])
      await assert.rejects(pool.query('UPDATE pe_stdio_v2_connections SET current_catalog_id=$2 WHERE id=$1',
        [bConnection,catalog]),{code:'23503'})
      assert.equal((await pool.query('SELECT raw_catalog::text AS raw FROM pe_stdio_v2_catalogs WHERE id=$1',[catalog])).rows[0].raw,JSON.stringify([raw]))
    })
    const continuationSql=`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state,source,source_stdio_v2_action_id,
      source_stdio_v2_phase) VALUES($1,$2,$3,'fixture continuation','{}','queued','stdio_v2_result',$4,'call')`
    await t.test('discovery cannot continue; call continues only under its original unique request and immutable source',async()=>{
      await assert.rejects(pool.query(continuationSql,[randomUUID(),alice.session,randomUUID(),discover.id]),{code:'23503'})
      await assert.rejects(pool.query(continuationSql,[randomUUID(),bob.session,randomUUID(),call.id]),{code:'23503'})
      const operation=randomUUID()
      await assert.rejects(pool.query(continuationSql,[operation,bob.session,call.continuation,call.id]),{code:'23503'})
      await pool.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$2,$2)',
        [call.id,JSON.stringify(raw),digest])
      await pool.query(continuationSql,[operation,bob.session,call.continuation,call.id])
      await assert.rejects(pool.query(continuationSql,[randomUUID(),bob.session,call.continuation,call.id]),{code:'23505'})
      await assert.rejects(pool.query('UPDATE pe_operations SET request_id=$2 WHERE id=$1',[operation,randomUUID()]),{code:'23514'})
      await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[operation])
    })
    await t.test('current startup refuses a future schema without changing accepted tasks',async()=>{
      await pool.query('UPDATE pe_schema SET version=36 WHERE version=35')
      await assert.rejects(initializeDatabase(pool),/Unsupported PowerEvolve schema version/u)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version,36)
      assert.equal((await pool.query('SELECT task::text AS raw FROM pe_stdio_v2_actions WHERE id=$1',[call.id])).rows[0].raw,JSON.stringify(call.task))
    })
  } finally {
    await pool?.end()
    try {if(created) await admin.query(`DROP DATABASE "${name}"`)} finally {await admin.end()}
  }
})
