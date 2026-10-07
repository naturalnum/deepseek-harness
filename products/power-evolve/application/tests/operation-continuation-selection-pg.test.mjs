/** Real PG continuation methods preserve all frozen selections; seeded terminal rows do not run external tools. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { ConnectorService } from '../lib/platform/connectors.js'
import { ExecutionService } from '../lib/platform/executions.js'
import { DeviceService } from '../lib/platform/devices.js'
import { StdioMcpService } from '../lib/platform/stdio-mcp.js'
import { SshExecuteService } from '../lib/platform/ssh-execute.js'
import { McpActionStore } from '../lib/platform/mcp-actions.js'

const columns=['settings','skill_selection','mcp_selection','stdio_mcp_selection','ssh_selection',
  'remote_mcp_selection','stdio_v2_selection','execution_target']
const digest='a'.repeat(64)
const opaque='{ "10": "十", "2": "二", "_meta": {"literal":"a\\u0000b"}, "__proto__": {"kept":true} }'
const snapshotSql=columns.map(column=>`${column}::text AS ${column}`).join(',')

test('six real continuation methods copy every original selection and target across two owners and retries',
  {timeout:60000},async t=>{
    const databaseUrl=process.env.PE_TEST_DATABASE_URL??(await readFile(join(process.env.PE_PRIVATE_DIR,'database-url'),'utf8')).trim()
    const database=`pe_continuation_selection_${randomBytes(10).toString('hex')}`
    const admin=new Pool({connectionString:databaseUrl,max:1});let pool,created=false
    try {
      await admin.query(`CREATE DATABASE "${database}"`);created=true
      const url=new URL(databaseUrl);url.pathname=`/${database}`
      pool=new Pool({connectionString:url.href,max:4,statement_timeout:10000});await initializeDatabase(pool)
      const tasks=new TaskStore(pool,{maxEventBytes:524288,leaseMs:60000,maxPendingPerUser:20,maxActivePerUser:1})
      const worker=randomUUID(),key=randomBytes(32).toString('base64url')
      const connectors=new ConnectorService(tasks,'http://unused.invalid','synthetic',1000,100)
      const executions=new ExecutionService(tasks,{}, {service:{},timeoutMs:1000},1,100,1000,1000)
      const devices=new DeviceService(tasks,1000,{})
      const stdio=new StdioMcpService(tasks,null,worker,60000,100)
      const ssh=new SshExecuteService(tasks,{}, {}, {},key,worker,60000,100)
      const mcp=new McpActionStore(tasks,key,{maxArgumentBytes:32768,maxResultBytes:32768,maxCallsPerChain:5,
        maxPendingPerUser:10,chainLifetimeMs:60000,approvalLifetimeMs:60000,leaseMs:60000,listLimit:10})
      let serial=0
      async function seed(label,kind){
        const user=randomUUID(),workspace=randomUUID(),session=randomUUID(),operation=randomUUID(),id=randomUUID()
        const device=randomUUID(),directory=randomUUID()
        await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',[user,`${label}-${++serial}`,'seed-only',{}])
        await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)',[workspace,user])
        await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',[session,user,workspace,randomUUID(),{}])
        await pool.query('INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id) VALUES($1,$2,$3,$4,$5)',[device,user,label,randomUUID(),randomUUID()])
        await pool.query('INSERT INTO pe_device_directories(id,user_id,device_id,label) VALUES($1,$2,$3,$4)',[directory,user,device,label])
        const target={kind:'desktop',deviceId:device,directoryId:directory}
        const selectors=columns.slice(1,-1).map(column=>JSON.stringify([{kind:column,owner:user,nested:{unicode:'表😀',number:serial}}]))
        selectors[4]=`[${opaque}]`;selectors[5]=`[${opaque}, { "owner":"${user}", "ordered": [3,2,1] }]`
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,${columns.join(',')},state)
          VALUES($1,$2,$3,'seed-only',$4,$5,$6,$7,$8,$9,$10,$11,'completed')`,
        [operation,session,randomUUID(),{model:'seed-only',revision:serial},...selectors,target])
        const original=(await pool.query(`SELECT ${snapshotSql} FROM pe_operations WHERE id=$1`,[operation])).rows[0]
        let row
        if(kind==='platform_action') row=(await pool.query(`INSERT INTO pe_connector_actions
          (id,user_id,session_id,operation_id,call_id,action,request,request_digest,state)
          VALUES($1,$2,$3,$4,'seed','trial_note_append',$5,$6,'rejected') RETURNING *`,[id,user,session,operation,{text:label},digest])).rows[0]
        if(kind==='sandbox_result'||kind==='desktop_result') {
          const desktop=kind==='desktop_result',table=desktop?'pe_desktop_executions':'pe_cloud_executions'
          row=(await pool.query(`INSERT INTO ${table}(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,result
            ${desktop?',device_id,directory_id':''}) VALUES($1,$2,$3,$4,'seed','unused','',$5,'succeeded',$6
            ${desktop?',$7,$8':''}) RETURNING *`,[id,user,session,operation,digest,JSON.stringify({stdout:'result\0kept'}),...(desktop?[device,directory]:[])])).rows[0]
        }
        if(kind==='stdio_mcp_result') {
          const connection=randomUUID()
          await pool.query(`INSERT INTO pe_stdio_mcp_connections(id,user_id,install_request_id,name) VALUES($1,$2,$3,$4)`,[connection,user,randomUUID(),label])
          row=(await pool.query(`INSERT INTO pe_stdio_mcp_calls(id,user_id,operation_id,connection_id,connection_revision,call_key,state,lease_owner,lease_epoch,lease_until)
            VALUES($1,$2,$3,$4,1,'seed','preparing',$5,1,clock_timestamp()+interval '1 minute') RETURNING *`,[id,user,operation,connection,worker])).rows[0]
        }
        if(kind==='ssh_execute_result') {
          const connection=randomUUID()
          await transaction(pool,async client=>{
            await client.query(`INSERT INTO pe_ssh_connections(id,user_id,install_request_id,install_digest,display_name,host,port,username,
              host_key_sha256,credential_kind,encrypted_credential) VALUES($1,$2,$3,$4,$5,'unused.invalid',22,'seed',$6,'password',$7)`,
            [connection,user,randomUUID(),digest,label,`SHA256:${'A'.repeat(43)}`,Buffer.alloc(32)])
            await client.query(`INSERT INTO pe_ssh_credential_versions(connection_id,user_id,credential_revision,
              credential_kind,format_version,encrypted_credential) VALUES($1,$2,1,'password',2,$3)`,[connection,user,Buffer.alloc(32)])
            await client.query(`INSERT INTO pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision,
              display_name,host,port,username,host_key_sha256) VALUES($1,$2,1,1,$3,'unused.invalid',22,'seed',$4)`,
            [connection,user,label,`SHA256:${'A'.repeat(43)}`])
          })
          row=(await pool.query(`INSERT INTO pe_ssh_execute_actions(id,user_id,session_id,operation_id,call_key,connection_id,
            connection_revision,credential_revision,command_sealed,request_digest,state) VALUES($1,$2,$3,$4,'seed',$5,1,1,$6,$7,'rejected') RETURNING *`,
          [id,user,session,operation,connection,Buffer.alloc(32),digest])).rows[0]
        }
        if(kind==='remote_mcp_result') {
          await pool.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,max_calls,expires_at)
            VALUES($1,$2,$3,5,clock_timestamp()+interval '1 minute')`,[operation,user,session])
          row=(await pool.query(`INSERT INTO pe_mcp_actions(id,user_id,session_id,operation_id,root_operation_id,call_key,
            tool,arguments,request_digest,state,expires_at,continuation_request_id)
            VALUES($1,$2,$3,$4,$4,'seed','{}','{}',$5,'pending',clock_timestamp()+interval '1 minute',$6) RETURNING *`,
          [id,user,session,operation,digest,randomUUID()])).rows[0]
        }
        return {row,original,operation,session}
      }
      for(const kind of ['platform_action','sandbox_result','desktop_result','stdio_mcp_result','ssh_execute_result','remote_mcp_result']) {
        await t.test(kind,async()=>{
          for(const label of ['alice','bob']) {
            const f=await seed(label,kind)
            const apply=()=>transaction(pool,async client=>{
              if(kind==='platform_action') await connectors.enqueueContinuation(client,f.row)
              if(kind==='sandbox_result') assert.equal(await executions.enqueueContinuation(client,f.row),true)
              if(kind==='desktop_result') assert.equal(await devices.continue(client,f.row),true)
              if(kind==='ssh_execute_result') await ssh.enqueue(client,f.row,null)
              if(kind==='remote_mcp_result') await mcp.end(client,f.row,'rejected',null)
            })
            if(kind==='stdio_mcp_result') await stdio.settle({id:f.row.id,epoch:1},'succeeded','seed-only',null)
            else {await apply();await apply()}
            const saved=await pool.query(`SELECT ${snapshotSql},source,mcp_root_operation_id,request_id,session_id FROM pe_operations WHERE source=$1 AND session_id=$2`,[kind,f.session])
            assert.equal(saved.rows.length,1);const row=saved.rows[0]
            assert.deepEqual(Object.fromEntries(columns.map(column=>[column,row[column]])),f.original)
            assert.equal(row.request_id,f.row.continuation_request_id);assert.equal(row.mcp_root_operation_id,f.operation)
            assert.equal(row.session_id,f.session)
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_actions')).rows[0].n,0)
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances')).rows[0].n,0)
            if(kind==='stdio_mcp_result') {
              await assert.rejects(stdio.settle({id:f.row.id,epoch:1},'succeeded','seed-only',null),{code:'stdio_mcp_lease_lost'})
              assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_operations WHERE session_id=$1',[f.session])).rows[0].n,2)
            }
          }
        })
      }
    } finally {
      await pool?.end();try{if(created)await admin.query(`DROP DATABASE "${database}"`)}finally{await admin.end()}
    }
  })
