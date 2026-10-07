/** Actual PG/POSIX selection and recovery; terminal discovery facts are seeded, with no Runner or model invocation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Pool} from 'pg'
import {initializeDatabase,transaction} from '../lib/platform/database.js'
import {lockAccountAuthorities} from '../lib/platform/account-authority.js'
import {FileService} from '../lib/platform/files.js'
import {StdioOperationAdmissionV2} from '../lib/platform/stdio-v2-operation-admission.js'
import {taskCredential,disableFixtureAccount,enableFixtureAccount} from './task-credential-fixture.mjs'
import {StdioAuthorizationServiceV2} from '../lib/platform/stdio-v2-authorization.js'
import {readStdioCallRootAuthorityV2} from '../lib/platform/stdio-v2-call-authority.js'
import {StdioCallAdmissionV2} from '../lib/platform/stdio-v2-call-admission.js'
import {TaskStore} from '../lib/platform/tasks.js'
import {digest} from '../lib/platform/identity.js'
import {StdioCallContinuationV2} from '../lib/platform/stdio-v2-continuations.js'
import {stdioDispatchV2,stdioPreparedV2,stdioTaskSchemasV2} from '@power-evolve/contracts/stdio-mcp'
import {stdioCatalogFingerprintV2,stdioSha256V2} from '@power-evolve/connector-runner/stdio-v2-digest'

const limits={runtimeMs:2000,requestMs:1000,stdinGraceMs:100,terminateGraceMs:100,killGraceMs:100,
  maxInputBytes:262144,maxMessageBytes:16384,maxProtocolBytes:262144,maxProtocolMessages:100,
  maxJsonDepth:40,maxJsonNodes:10000,maxPages:4,maxTools:10,maxCatalogBytes:32768,maxToolBytes:16384,
  maxResultBytes:16384,maxStderrBytes:4096}
const admission={maxConnections:10,maxTools:20,maxSnapshotBytes:524288,maxDescriptionBytes:8192}
const budget={maxDepth:40,maxNodes:10000,maxBytes:262144},sha=(domain,value)=>stdioSha256V2(domain,value,budget)
const pin={kind:'cloud',deploymentId:randomUUID(),protocolVersion:2,platform:{os:'linux',architecture:'arm64'},
  imageReference:`synthetic.invalid/runner@sha256:${'a'.repeat(64)}`,configImageId:`sha256:${'b'.repeat(64)}`,
  runtimeImageIds:[`containerd://sha256:${'a'.repeat(64)}`]}
const image={kind:'cloud',platform:pin.platform,imageReference:pin.imageReference,runtimeImageId:pin.runtimeImageIds[0]}
const facts={programStartAttempted:true,toolsCallAttempted:false,effectMayHaveOccurred:true,childPid:12345,
  childExitObserved:true,childCloseObserved:true,exitCode:0,signal:null,cleanupConfirmed:true,
  protocolBytes:200,protocolMessages:4,stderrBytes:0,stderr:''}
const rawCatalog=JSON.parse('[{"name":"echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"description":"literal\\u0000表😀","_meta":{"__proto__":{"retained":true}},"__proto__":{"extension":true}}]')

test('Cloud selections and call continuations retain original facts and resume only once in real PG',
  {timeout:60000},async t=>{
    const databaseUrl=process.env.PE_TEST_DATABASE_URL??(await readFile(join(process.env.PE_PRIVATE_DIR,'database-url'),'utf8')).trim()
    const database=`pe_stdio_operation_${randomBytes(10).toString('hex')}`,root=await mkdtemp(join(tmpdir(),'pe-stdio-operation-'))
    const admin=new Pool({connectionString:databaseUrl,max:1});let pool,created=false
    try {
      await admin.query(`CREATE DATABASE "${database}"`);created=true
      const url=new URL(databaseUrl);url.pathname=`/${database}`
      pool=new Pool({connectionString:url.href,max:4,statement_timeout:10000});await initializeDatabase(pool)
      const files=new FileService(pool,join(root,'workspaces'));await files.init()
      const options={limits,admission,maxReplyBytes:524288,cloudDeployment:pin}
      const selector=new StdioOperationAdmissionV2(files,options)
      let serial=0
      async function actor(label){
        const userId=randomUUID();await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',[userId,`${label}-${++serial}`,'seed-only',{}])
        const workspaceId=await files.defaultWorkspaceId(userId),sessionId=randomUUID()
        await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',[sessionId,userId,workspaceId,randomUUID(),{}])
        return {userId,workspaceId,sessionId}
      }
      async function discovered(owner,label,{fullScopeDigest}={}){
        const connectionId=randomUUID(),actionId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),catalogId=randomUUID()
        const binding=await files.bindingForId(owner.userId,owner.workspaceId)
        const configuration={name:label,invocation:{program:'node',argv:['synthetic.mjs'],cwd:'.'}},configDigest=sha('configuration',configuration)
        const scope={kind:'cloud',userId:owner.userId,workspaceId:owner.workspaceId,bindingGeneration:binding.generation,
          target:{spaceId:binding.spaceId,rootRelativePath:binding.rootRelativePath},home:{kind:'user',userId:owner.userId}}
        const task=stdioTaskSchemasV2(limits).task.parse({formatVersion:2,phase:'discover',actionId,userId:owner.userId,
          sessionId:owner.sessionId,connectionId,configRevision:1,configDigest,scopeBinding:scope,expectedDeploymentPin:pin,
          invocation:configuration.invocation,limits,origin:{kind:'stdio_discovery',requestId}})
        const taskDigest=sha('task',task),executionRef={kind:'cloud',executionId}
        const capture={kind:'cloud',podUid:randomUUID(),podName:'synthetic',namespace:'synthetic',nodeName:'synthetic',
          runnerInstanceId:randomUUID(),containerId:'containerd://synthetic',restartCount:0,mountGeneration:'1',
          workspaceMount:{claimName:'synthetic',subPath:'synthetic-workspace',mountPath:'/workspace',readOnly:false},
          homeMount:{claimName:'synthetic',subPath:'synthetic-home',mountPath:'/home/agent',readOnly:false}}
        const prepared=stdioPreparedV2.parse({formatVersion:2,actionId,executionRef,taskDigest,scopeBinding:scope,
          fullScopeDigest:fullScopeDigest??sha('scope',{scopeBinding:scope,workspaceMount:capture.workspaceMount,homeMount:capture.homeMount}),
          expectedDeploymentPin:pin,actualExecutorImage:image,capture,specDigest:sha('spec',{synthetic:true})})
        const outcome={state:'completed',phase:'discover',catalog:rawCatalog,pages:[{tools:rawCatalog}],initializeResult:{protocolVersion:'synthetic'},facts}
        const preparedDigest=sha('prepared',prepared),expiresAt='2030-01-01T00:00:00.000Z'
        await transaction(pool,async client=>{
          await client.query('INSERT INTO pe_stdio_v2_connections(id,user_id,revision,enabled) VALUES($1,$2,1,true)',[connectionId,owner.userId])
          await client.query('INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest) VALUES($1,$2,1,$3,$4)',[connectionId,owner.userId,JSON.stringify(configuration),configDigest])
          await client.query(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt) VALUES($1,$2,'check','{}',$3,'{}')`,[owner.userId,requestId,sha('management',{})])
          await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,execution_target,
            execution_id,request_id,task,task_digest,state) VALUES($1,$2,$3,$4,1,$5,'discover','cloud',$6,$7,$8,$9,'succeeded')`,
          [actionId,owner.userId,owner.sessionId,connectionId,configDigest,executionId,requestId,JSON.stringify(task),taskDigest])
          await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,request_digest,state,execution_kind,origin_kind,task_version,
            stdio_phase,stdio_task,stdio_action_id,continuation_request_id)
            VALUES($1,$2,$3,$4,'succeeded','stdio_v2','stdio_discovery',2,'discover',$5,$6,NULL)`,
          [executionId,owner.userId,owner.sessionId,taskDigest,JSON.stringify(task),actionId])
          await client.query(`INSERT INTO pe_stdio_v2_preparations(action_id,user_id,session_id,phase,execution_target,execution_id,task_digest,
            prepared,prepared_digest,approval_binding,fingerprint,approval_epoch,expires_at)
            VALUES($1,$2,$3,'discover','cloud',$4,$5,$6,$7,$8,$9,1,$10)`,[actionId,owner.userId,owner.sessionId,executionId,taskDigest,
            JSON.stringify(prepared),preparedDigest,JSON.stringify({actionId,taskDigest,preparedDigest,approvalEpoch:1,expiresAt}),'c'.repeat(64),expiresAt])
          await client.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$4,$4)',[actionId,JSON.stringify(outcome),sha('result',outcome),JSON.stringify({synthetic:true})])
          await client.query(`INSERT INTO pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision,config_digest,action_id,session_id,phase,
            raw_catalog,image_expectation,catalog_digest) VALUES($1,$2,$3,1,$4,$5,$6,'discover',$7,$8,$9)`,
          [catalogId,owner.userId,connectionId,configDigest,actionId,owner.sessionId,JSON.stringify(rawCatalog),JSON.stringify(image),stdioCatalogFingerprintV2(rawCatalog,limits)])
          await client.query('UPDATE pe_stdio_v2_connections SET current_catalog_id=$2 WHERE id=$1',[connectionId,catalogId])
        })
        return {connectionId,catalogId,task,prepared,configuration,owner}
      }
      const alice=await actor('alice'),bob=await actor('bob')
      const a=await discovered(alice,'Alice original'),b=await discovered(bob,'Bob original')
      const select=(service,owner,target={kind:'cloud'},reserved=[])=>transaction(pool,client=>service.select(client,owner.userId,owner.sessionId,target,reserved))
      let original
      await t.test('two owners get only their own complete catalogs without allocating a writer',async()=>{
        original=await select(selector,alice);const other=await select(selector,bob)
        assert.deepEqual(original.map(x=>x.connectionId),[a.connectionId]);assert.deepEqual(other.map(x=>x.connectionId),[b.connectionId])
        assert.deepEqual(original[0].rawCatalog,rawCatalog);assert.equal(Object.hasOwn(original[0].rawCatalog[0],'__proto__'),true)
        assert.equal(original[0].configuration.name,'Alice original');assert.equal(original[0].tools[0].model.name.length,63)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances')).rows[0].n,0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots')).rows[0].n,0)
        await assert.rejects(select(selector,{...alice,sessionId:bob.sessionId}),{code:'session_not_found'})
      })
      await t.test('another reviewed pin, desktop placement and changed binding generation select no generic tool',async()=>{
        const changed=new StdioOperationAdmissionV2(files,{...options,cloudDeployment:{...pin,deploymentId:randomUUID()}})
        assert.deepEqual(await select(changed,alice),[])
        assert.deepEqual(await select(selector,alice,{kind:'desktop',deviceId:randomUUID(),directoryId:randomUUID()}),[])
        await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1',[alice.workspaceId])
        assert.deepEqual(await select(selector,alice),[])
        await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation-1 WHERE id=$1',[alice.workspaceId])
      })
      await t.test('restoration ignores current disablement and catalog pointers, while a new admission excludes them',async()=>{
        await pool.query('UPDATE pe_stdio_v2_connections SET enabled=false,current_catalog_id=NULL WHERE id=$1',[a.connectionId])
        assert.deepEqual(selector.restore(original,[]),original);assert.deepEqual(await select(selector,alice),[])
        await pool.query('UPDATE pe_stdio_v2_connections SET enabled=true,current_catalog_id=$2 WHERE id=$1',[a.connectionId,a.catalogId])
      })
      await t.test('changing the frozen model map, tool name or original configuration is refused',async()=>{
        for(const alter of [x=>{x[0].tools[0].model.description='changed'},x=>{x[0].tools[0].model.name='changed'},x=>{x[0].configuration.name='changed'}]){
          const changed=structuredClone(original);alter(changed);assert.throws(()=>selector.restore(changed,[]),error=>error.status===409)
        }
        await assert.rejects(select(selector,alice,{kind:'cloud'},[original[0].tools[0].model.name]),{code:'stdio_v2_tool_name_conflict'})
      })
      await t.test('broken producer identity fails instead of silently dropping an enabled catalog',async()=>{
        await pool.query("UPDATE pe_stdio_v2_actions SET state='failed' WHERE id=$1",[a.task.actionId])
        await assert.rejects(select(selector,alice),{code:'stdio_v2_record_invalid'})
        await pool.query("UPDATE pe_stdio_v2_actions SET state='succeeded' WHERE id=$1",[a.task.actionId])
        assert.deepEqual(await select(selector,alice),original)
      })
      await t.test('a self-consistent Prepared hash with a wrong complete scope digest is rejected',async()=>{
        const bad=await actor('bad-scope')
        await discovered(bad,'Synthetic invalid scope',{fullScopeDigest:'f'.repeat(64)})
        await assert.rejects(select(selector,bad),{code:'stdio_v2_record_invalid'})
      })
      const continuation=new StdioCallContinuationV2({limits,admission,maxReplyBytes:524288})
      async function call(owner,{noStart=false,isError=false}={}) {
        const groups=await select(selector,owner),group=groups[0],operationId=randomUUID(),actionId=randomUUID(),executionId=randomUUID()
        const continuationRequest=randomUUID(),workerId=randomUUID(),requestId=randomUUID()
        const task=stdioTaskSchemasV2(limits).task.parse({formatVersion:2,phase:'call',actionId,userId:owner.userId,sessionId:owner.sessionId,
          connectionId:group.connectionId,configRevision:group.configRevision,configDigest:group.configDigest,
          scopeBinding:group.scopeBinding,expectedDeploymentPin:group.expectedDeploymentPin,invocation:group.configuration.invocation,limits,
          origin:{kind:'operation',operationId,rootOperationId:operationId,callKey:'original-call'},selection:{catalogId:group.catalogId,
            catalogDigest:group.catalogDigest,rawCatalog:group.rawCatalog,catalogImageExpectation:group.catalogImageExpectation,
            rawName:'echo',rawDescriptor:group.rawCatalog[0],arguments:{text:'original\0arguments'}}})
        const taskDigest=sha('task',task),executionRef={kind:'cloud',executionId},lease={actionId,workerId,leaseEpoch:1}
        const capture={...a.prepared.capture,podUid:randomUUID(),runnerInstanceId:randomUUID()}
        const prepared=stdioPreparedV2.parse({...a.prepared,actionId,executionRef,taskDigest,scopeBinding:group.scopeBinding,
          fullScopeDigest:sha('scope',{scopeBinding:group.scopeBinding,workspaceMount:capture.workspaceMount,homeMount:capture.homeMount}),capture})
        const preparedDigest=sha('prepared',prepared),expiresAt=new Date(Date.now()+60000).toISOString(),fingerprint='d'.repeat(64)
        const binding={actionId,taskDigest,preparedDigest,approvalEpoch:1,expiresAt}
        const permit={...binding,permitId:randomUUID(),authorizationRequestId:randomUUID(),executionRef,
          executorOwner:{kind:'cloud',runnerInstanceId:capture.runnerInstanceId},approvalFingerprint:fingerprint,issuedAt:new Date().toISOString()}
        const dispatch=stdioDispatchV2(limits).parse({formatVersion:2,task,taskDigest,executionRef,preparedDigest,permit})
        const dispatchDigest=sha('dispatch',dispatch)
        const outcome={state:'completed',phase:'call',catalog:group.rawCatalog,pages:[{tools:group.rawCatalog}],initializeResult:{protocolVersion:'synthetic'},
          facts:{...facts,toolsCallAttempted:true},result:{content:[{type:'text',text:'retained\0result'}],isError,
            _meta:JSON.parse('{"__proto__":{"retained":true}}')}}
        await transaction(pool,async client=>{
          await client.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,state)
            VALUES($1,$2,$3,'seed original call',$4,$5,'completed')`,[operationId,owner.sessionId,requestId,
            {model:'seed-only',maxTokens:64,revision:1},JSON.stringify(groups)])
          await client.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,calls,max_calls,expires_at)
            VALUES($1,$2,$3,1,5,$4)`,[operationId,owner.userId,owner.sessionId,expiresAt])
          await client.query(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
            execution_target,execution_id,operation_id,root_operation_id,call_id,task,task_digest,state,cancel_requested,
            continuation_request_id,lease_owner,lease_epoch,lease_until)
            VALUES($1,$2,$3,$4,1,$5,'call','cloud',$6,$7,$7,'original-call',$8,$9,$10,$11,$12,$13,1,$14)`,
          [actionId,owner.userId,owner.sessionId,group.connectionId,group.configDigest,executionId,operationId,JSON.stringify(task),taskDigest,
            noStart?'cancelled':'succeeded',noStart,continuationRequest,workerId,expiresAt])
          await client.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,
            execution_kind,origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id,
            cancel_requested,sandbox_name,pod_uid,runner_instance_id)
            VALUES($1,$2,$3,$4,'original-call',NULL,NULL,$5,$6,'stdio_v2','operation',2,'call',$7,$8,$9,$10,$11,$12,$13)`,
          [executionId,owner.userId,owner.sessionId,operationId,taskDigest,noStart?'cancelled':'succeeded',JSON.stringify(task),actionId,
            continuationRequest,noStart,noStart?null:capture.podName,noStart?null:capture.podUid,noStart?null:capture.runnerInstanceId])
          if(noStart) {
            const receipt={formatVersion:2,kind:'unstarted_closed',actionId,executionRef,taskDigest,preparedDigest:null,
              userId:owner.userId,sessionId:owner.sessionId,phase:'call',state:'cancelled',startNeverAuthorized:true,resource:{kind:'unallocated'}}
            await client.query(`INSERT INTO pe_stdio_v2_no_start_closures(action_id,user_id,session_id,phase,execution_target,execution_id,
              task_digest,worker_id,lease_epoch,receipt,receipt_digest) VALUES($1,$2,$3,'call','cloud',$4,$5,$6,1,$7,$8)`,
            [actionId,owner.userId,owner.sessionId,executionId,taskDigest,workerId,JSON.stringify(receipt),sha('no_start',receipt)])
          } else {
            await client.query(`INSERT INTO pe_stdio_v2_preparations(action_id,user_id,session_id,phase,execution_target,execution_id,
              task_digest,prepared,prepared_digest,approval_binding,fingerprint,approval_epoch,expires_at)
              VALUES($1,$2,$3,'call','cloud',$4,$5,$6,$7,$8,$9,1,$10)`,[actionId,owner.userId,owner.sessionId,executionId,taskDigest,
              JSON.stringify(prepared),preparedDigest,JSON.stringify(binding),fingerprint,expiresAt])
            await client.query(`INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,'once')`,[actionId,owner.userId,fingerprint])
            await client.query(`INSERT INTO pe_stdio_v2_start_permits(action_id,permit_id,authorization_request_id,execution_id,task_digest,
              prepared_digest,fingerprint,decision,executor_owner,permit,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'once',$8,$9,$10,$11)`,
            [actionId,permit.permitId,permit.authorizationRequestId,executionId,taskDigest,preparedDigest,fingerprint,
              JSON.stringify(permit.executorOwner),JSON.stringify(permit),permit.issuedAt,expiresAt])
            await client.query('INSERT INTO pe_stdio_v2_dispatches(action_id,dispatch,dispatch_digest) VALUES($1,$2,$3)',[actionId,JSON.stringify(dispatch),dispatchDigest])
            const view={formatVersion:2,instanceId:capture.runnerInstanceId,actionId,executionRef,taskDigest,dispatchDigest,
              state:'completed',writerStopConfirmed:true,outcome}
            const proof={formatVersion:2,kind:'cloud_uid_quiet',actionId,executionRef,taskDigest,dispatchDigest,preparedDigest,
              fullScopeDigest:prepared.fullScopeDigest,podUid:capture.podUid,runnerInstanceId:capture.runnerInstanceId,mountGeneration:capture.mountGeneration,
              observedAt:new Date().toISOString()}
            await client.query('INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence) VALUES($1,$2,$3,$4,$5)',
              [actionId,JSON.stringify(outcome),sha('result',outcome),JSON.stringify(view),JSON.stringify(proof)])
          }
        })
        return {lease,operationId,continuationRequest,owner,outcome,connectionId:group.connectionId,executionId}
      }
      const deliver=f=>transaction(pool,async client=>{
        // Production result/no-start writers hold these original locks before invoking the leaf.
        await lockAccountAuthorities(client,[f.owner.userId],'update')
        await client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE',[f.owner.sessionId])
        await client.query('SELECT id FROM pe_stdio_v2_connections WHERE id=$1 FOR UPDATE',[f.connectionId])
        await client.query('SELECT id FROM pe_stdio_v2_actions WHERE id=$1 FOR UPDATE',[f.lease.actionId])
        await client.query('SELECT id FROM pe_cloud_executions WHERE id=$1 FOR UPDATE',[f.executionId])
        return continuation.enqueueLeased(client,f.lease)
      })
      const continued=async f=>(await pool.query('SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2',
        [f.owner.sessionId,f.continuationRequest])).rows
      await t.test('two replicas deliver each owner result once; a cancelled root retains the already queued original',async()=>{
        for(const owner of [alice,bob]) {
          const f=await call(owner),replies=await Promise.all([deliver(f),deliver(f)])
          assert.deepEqual(replies.map(x=>x.disposition).sort(),['original','queued']);assert.equal(replies[0].operationId,replies[1].operationId)
          const rows=await continued(f);assert.equal(rows.length,1);const saved=rows[0],body=JSON.parse(saved.input)
          assert.equal(saved.source,'stdio_v2_result');assert.equal(saved.source_stdio_v2_no_start_action_id,null)
          assert.deepEqual(body.outcome,f.outcome);assert.equal(body.chainStopped,false)
          assert.equal(saved.stdio_v2_selection[0].scopeBinding.userId,owner.userId)
          await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1',[f.operationId])
          assert.equal((await deliver(f)).disposition,'original');assert.equal((await continued(f))[0].input,saved.input)
        }
      })
      await t.test('SDK isError stays completed and is preserved while its original automatic chain stops',async()=>{
        const f=await call(alice,{isError:true});assert.equal((await deliver(f)).disposition,'queued')
        const saved=(await continued(f))[0],body=JSON.parse(saved.input)
        assert.equal(body.state,'completed');assert.equal(body.outcome.result.isError,true);assert.deepEqual(body.outcome,f.outcome)
        assert.equal(body.chainStopped,true);assert.equal(body.errorCode,'stdio_v2_tool_error')
        const chain=(await pool.query('SELECT * FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0]
        assert(chain.stopped_at);assert.equal(chain.error_code,'stdio_v2_tool_error')
      })
      await t.test('formal no-start closure queues its independent source and creates no actual Runner result',async()=>{
        const f=await call(bob,{noStart:true});assert.equal((await deliver(f)).disposition,'queued');assert.equal((await deliver(f)).disposition,'original')
        const saved=(await continued(f))[0],body=JSON.parse(saved.input)
        assert.equal(saved.source,'stdio_v2_no_start');assert.equal(saved.source_stdio_v2_no_start_action_id,f.lease.actionId)
        assert.equal(saved.source_stdio_v2_action_id,null);assert.equal(body.startNeverAuthorized,true)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_results WHERE action_id=$1',[f.lease.actionId])).rows[0].n,0)
      })
      await t.test('root cancellation suppresses fresh continuation and an expired lease cannot mutate records',async()=>{
        const cancelled=await call(alice)
        await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1',[cancelled.operationId])
        assert.equal((await deliver(cancelled)).disposition,'suppressed');assert.deepEqual(await continued(cancelled),[])
        const expired=await call(bob)
        await pool.query("UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.lease.actionId])
        await assert.rejects(deliver(expired),{code:'stdio_v2_lease_lost'});assert.deepEqual(await continued(expired),[])
      })
      await t.test('a failed continuation insertion rolls back its chain stop and queued marker before a safe retry',async()=>{
        const f=await call(alice,{isError:true})
        await pool.query(`CREATE FUNCTION reject_stdio_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.source='stdio_v2_result' THEN RAISE EXCEPTION 'synthetic insertion failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_stdio_continuation BEFORE INSERT ON pe_operations FOR EACH ROW EXECUTE FUNCTION reject_stdio_continuation();`)
        await assert.rejects(deliver(f),/synthetic insertion failure/u);assert.deepEqual(await continued(f),[])
        assert.equal((await pool.query('SELECT stopped_at FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].stopped_at,null)
        assert.equal((await pool.query('SELECT continuation_queued FROM pe_stdio_v2_actions WHERE id=$1',[f.lease.actionId])).rows[0].continuation_queued,false)
        await pool.query('DROP TRIGGER reject_stdio_continuation ON pe_operations')
        assert.equal((await deliver(f)).disposition,'queued');assert.equal((await deliver(f)).disposition,'original')
      })
      const tasks=new TaskStore(pool,{maxEventBytes:1048576,leaseMs:60000,maxPendingPerUser:20,maxActivePerUser:2})
      const callOptions={limits,cloudDeployment:pin,maxPendingPerUser:20,maxCallsPerChain:4,chainLifetimeMs:60000,reservedNames:[]}
      const caller=(changes={},fileApi=files)=>new StdioCallAdmissionV2(tasks,selector,fileApi,{...callOptions,...changes})
      async function running(owner,groups){
        const sessionId=randomUUID(),operationId=randomUUID(),token=randomBytes(32).toString('hex')
        await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header,grant_digest,lease_epoch,lease_until)
          VALUES($1,$2,$3,$4,'{}',$5,1,clock_timestamp()+interval '1 minute')`,
        [sessionId,owner.userId,owner.workspaceId,randomUUID(),digest(token)])
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,state)
          VALUES($1,$2,$3,'synthetic root','{}',$4,'running')`,[operationId,sessionId,randomUUID(),JSON.stringify(groups)])
        return {...owner,sessionId,operationId,token,groups}
      }
      const proposed=f=>({callKey:'native-call-1',toolName:f.groups[0].tools[0].model.name,arguments:{text:'literal\0表😀'}})
      const callCount=async f=>(await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_actions WHERE operation_id=$1',[f.operationId])).rows[0].n
      await t.test('production call admission deduplicates two replicas and isolates both owners without starting a sandbox',async()=>{
        for(const [owner,groups] of [[alice,original],[bob,await select(selector,bob)]]){
          const f=await running(owner,groups),request=proposed(f)
          const replies=await Promise.all([caller().propose(f.token,request),caller().propose(f.token,request)])
          assert.deepEqual(replies[0],replies[1]);assert.equal(await callCount(f),1)
          const action=(await pool.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1',[replies[0].actionId])).rows[0]
          assert.equal(action.user_id,owner.userId);assert.equal(action.task.origin.rootOperationId,f.operationId)
          assert.deepEqual(action.task.selection.arguments,request.arguments);assert.deepEqual(action.task.selection.rawCatalog,rawCatalog)
          assert.equal(action.state,'queued');assert.equal(action.lease_owner,null)
          const execution=(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[replies[0].executionRef.executionId])).rows[0]
          assert.equal(execution.stdio_action_id,action.id);assert.equal(execution.request_digest,action.task_digest)
          assert.equal(execution.stdio_task.selection.arguments.text,request.arguments.text);assert.equal(execution.pod_uid,null)
          assert.equal((await pool.query('SELECT calls FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].calls,1)
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances')).rows[0].n,0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mount_slots')).rows[0].n,0)
      })
      await t.test('an accepted retry retains its receipt after revocation while new calls are refused',async()=>{
        const f=await running(alice,original),request=proposed(f),accepted=await caller().propose(f.token,request)
        await pool.query('UPDATE pe_stdio_v2_connections SET enabled=false WHERE id=$1',[a.connectionId])
        assert.deepEqual(await caller().propose(f.token,request),accepted)
        await assert.rejects(caller().propose(f.token,{...request,callKey:'new-call'}),{code:'stdio_v2_connection_revoked'})
        await assert.rejects(caller().propose(f.token,{...request,arguments:{text:'changed'}}),{code:'stdio_v2_request_conflict'})
        assert.equal(await callCount(f),1)
        await pool.query('UPDATE pe_stdio_v2_connections SET enabled=true WHERE id=$1',[a.connectionId])
      })
      await t.test('unknown names, invalid full arguments and another owners selection fail before consuming a call',async()=>{
        const f=await running(alice,original),request=proposed(f)
        await assert.rejects(caller().propose(f.token,{...request,toolName:'not-admitted'}),{code:'stdio_v2_tool_not_in_operation'})
        await assert.rejects(caller().propose(f.token,{...request,arguments:{text:42}}),{code:'stdio_v2_arguments_invalid'})
        assert.equal(await callCount(f),0)
        const wrong=await running(alice,await select(selector,bob))
        await assert.rejects(caller().propose(wrong.token,proposed(wrong)),{code:'stdio_v2_origin_changed'})
        assert.equal(await callCount(wrong),0)
      })
      await t.test('existing shared root budgets and expiry are retained instead of reset by a new STDIO call',async()=>{
        for(const expired of [false,true]){
          const f=await running(alice,original)
          await pool.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,calls,max_calls,expires_at)
            VALUES($1,$2,$3,$4,2,clock_timestamp()+$5::int*interval '1 second')`,
          [f.operationId,f.userId,f.sessionId,expired?0:2,expired?-1:30])
          await assert.rejects(caller().propose(f.token,proposed(f)),{code:expired?'mcp_chain_stopped':'mcp_chain_call_limit'})
          assert.equal(await callCount(f),0)
          assert.equal((await pool.query('SELECT max_calls FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].max_calls,2)
        }
      })
      await t.test('a root cancel marker and changed workspace generation prevent new execution admission',async()=>{
        const cancelled=await running(alice,original)
        await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1',[cancelled.operationId])
        await assert.rejects(caller().propose(cancelled.token,proposed(cancelled)),{code:'mcp_chain_stopped'})
        const stale=await running(alice,original)
        await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1',[alice.workspaceId])
        await assert.rejects(caller().propose(stale.token,proposed(stale)),{code:'stdio_v2_scope_changed'})
        await pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation-1 WHERE id=$1',[alice.workspaceId])
        assert.equal(await callCount(cancelled),0);assert.equal(await callCount(stale),0)
      })
      await t.test('expired grants during admission cannot commit action, execution or budget consumption',async()=>{
        const f=await running(alice,original)
        const slow={bindingForId:async(...args)=>{
          const result=await files.bindingForId(...args)
          await args[2].query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.sessionId])
          return result
        }}
        await assert.rejects(caller({},slow).propose(f.token,proposed(f)),{code:'lease_lost'})
        assert.equal(await callCount(f),0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].n,0)
      })
      await t.test('execution insert failure rolls back the whole accepted call and a retry consumes exactly one budget unit',async()=>{
        const f=await running(alice,original)
        await pool.query(`CREATE FUNCTION reject_stdio_call_execution() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.stdio_phase='call' THEN RAISE EXCEPTION 'synthetic call insertion failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_stdio_call_execution BEFORE INSERT ON pe_cloud_executions FOR EACH ROW EXECUTE FUNCTION reject_stdio_call_execution();`)
        await assert.rejects(caller().propose(f.token,proposed(f)),/synthetic call insertion failure/u)
        assert.equal(await callCount(f),0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].n,0)
        await pool.query('DROP TRIGGER reject_stdio_call_execution ON pe_cloud_executions')
        const accepted=await caller().propose(f.token,proposed(f));assert.equal(accepted.state,'queued');assert.equal(await callCount(f),1)
      })
      await t.test('a continuation spends the original root budget and retains its original expiry',async()=>{
        const f=await running(alice,original),nextId=randomUUID()
        await pool.query(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,calls,max_calls,expires_at)
          VALUES($1,$2,$3,1,2,clock_timestamp()+interval '30 seconds')`,[f.operationId,f.userId,f.sessionId])
        const before=(await pool.query('SELECT expires_at FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0].expires_at
        await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[f.operationId])
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,mcp_root_operation_id,state)
          VALUES($1,$2,$3,'synthetic continuation','{}',$4,$5,'running')`,[nextId,f.sessionId,randomUUID(),JSON.stringify(original),f.operationId])
        const accepted=await caller().propose(f.token,proposed(f))
        const action=(await pool.query('SELECT root_operation_id,operation_id FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0]
        assert.equal(action.root_operation_id,f.operationId);assert.equal(action.operation_id,nextId)
        const after=(await pool.query('SELECT calls,expires_at FROM pe_mcp_action_chains WHERE root_operation_id=$1',[f.operationId])).rows[0]
        assert.equal(after.calls,2);assert.equal(after.expires_at.toISOString(),before.toISOString())
        await assert.rejects(caller().propose(f.token,{...proposed(f),callKey:'next-call'}),{code:'mcp_chain_call_limit'})
      })
      function authorization(){
        return new StdioAuthorizationServiceV2(pool,{limits,approvalKey:new Uint8Array(32).fill(7),approvalLifetimeMs:120000,
          capture:async(_client,task,executionRef)=>{
            const capture={...a.prepared.capture,podUid:randomUUID(),runnerInstanceId:randomUUID()}
            return stdioPreparedV2.parse({...a.prepared,actionId:task.actionId,executionRef,taskDigest:sha('task',task),
              scopeBinding:task.scopeBinding,expectedDeploymentPin:task.expectedDeploymentPin,capture,
              fullScopeDigest:sha('scope',{scopeBinding:task.scopeBinding,workspaceMount:capture.workspaceMount,homeMount:capture.homeMount})})
          }})
      }
      await t.test('production approval expiry is capped by the admitted root and a completed Agent root remains eligible',async()=>{
        const f=await running(alice,original),accepted=await caller().propose(f.token,proposed(f))
        const task=(await pool.query('SELECT task FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0].task
        await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[f.operationId])
        const live=await transaction(pool,async client=>{
          await lockAccountAuthorities(client,[f.userId],'update')
          await client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE',[f.sessionId])
          return readStdioCallRootAuthorityV2(client,task)
        })
        assert.equal(live.active,true)
        const prepared=await authorization().prepare(accepted.actionId)
        assert.equal(prepared.expiresAt,live.expiresAt.toISOString())
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1',[accepted.actionId])).rows[0].n,0)
      })
      await t.test('root cancellation or chain expiry after admission rejects prepare without creating authority',async()=>{
        for(const expired of [false,true]){
          const f=await running(alice,original),accepted=await caller().propose(f.token,proposed(f))
          if(expired)await pool.query("UPDATE pe_mcp_action_chains SET expires_at=clock_timestamp()-interval '1 second' WHERE root_operation_id=$1",[f.operationId])
          else await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1',[f.operationId])
          await assert.rejects(authorization().prepare(accepted.actionId),{code:'mcp_chain_stopped'})
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_preparations WHERE action_id=$1',[accepted.actionId])).rows[0].n,0)
        }
      })
      await t.test('cancelled roots deny first start even after a fixture once decision',async()=>{
        const f=await running(alice,original),accepted=await caller().propose(f.token,proposed(f)),auth=authorization()
        const prepared=await auth.prepare(accepted.actionId)
        await pool.query("INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,'once')",[accepted.actionId,f.userId,prepared.fingerprint])
        await pool.query("UPDATE pe_stdio_v2_actions SET state='approved' WHERE id=$1",[accepted.actionId])
        await pool.query('UPDATE pe_operations SET mcp_chain_cancelled_at=clock_timestamp() WHERE id=$1',[f.operationId])
        await assert.rejects(auth.authorize(accepted.actionId,randomUUID(),{kind:'cloud',runnerInstanceId:prepared.prepared.capture.runnerInstanceId}),{code:'mcp_chain_stopped'})
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_start_permits WHERE action_id=$1',[accepted.actionId])).rows[0].n,0)
      })
      await t.test('production Session cancellation stops a background call after its turn completes and preserves the later user input',async()=>{
        const f=await running(alice,original),accepted=await caller().propose(f.token,proposed(f)),queuedId=randomUUID()
        const before=(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[accepted.executionRef.executionId])).rows[0]
        await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[f.operationId])
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
          VALUES($1,$2,$3,'later independent input','{}','queued')`,[queuedId,f.sessionId,randomUUID()])
        const user={userId:f.userId,username:'synthetic'},browserToken=await taskCredential(pool,user)
        const replies=await Promise.all([tasks.cancel(user,f.sessionId,browserToken),tasks.cancel(user,f.sessionId,browserToken)])
        assert.deepEqual(replies,[{accepted:true},{accepted:true}])
        const root=(await pool.query('SELECT state,mcp_chain_cancelled_at FROM pe_operations WHERE id=$1',[f.operationId])).rows[0]
        assert.equal(root.state,'completed');assert(root.mcp_chain_cancelled_at)
        const later=(await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1',[queuedId])).rows[0]
        assert.deepEqual(later,{state:'queued',error_code:null})
        const action=(await pool.query('SELECT cancel_requested FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0]
        assert.equal(action.cancel_requested,true)
        const after=(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[accepted.executionRef.executionId])).rows[0]
        assert.equal(after.cancel_requested,true);assert.equal(after.state,before.state)
        for(const key of ['id','stdio_action_id','pod_uid','runner_instance_id','lease_owner','lease_until','stdio_task'])assert.deepEqual(after[key],before[key])
      })
      await t.test('account reenable cannot revive a completed original root with an admitted background call',async()=>{
        const owner=await actor('revocation-root'),discovery=await discovered(owner,'revocation original'),groups=await select(selector,owner)
        const f=await running(owner,groups),accepted=await caller().propose(f.token,proposed(f)),user={userId:owner.userId,username:'synthetic'}
        await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[f.operationId])
        await disableFixtureAccount(pool,user);await enableFixtureAccount(pool,user)
        const root=(await pool.query('SELECT state,mcp_chain_cancelled_at FROM pe_operations WHERE id=$1',[f.operationId])).rows[0]
        assert.equal(root.state,'completed');assert(root.mcp_chain_cancelled_at)
        const task=(await pool.query('SELECT task FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0].task
        const authority=await transaction(pool,async client=>{
          await lockAccountAuthorities(client,[owner.userId],'update')
          await client.query('SELECT id FROM pe_sessions WHERE id=$1 FOR UPDATE',[f.sessionId])
          return readStdioCallRootAuthorityV2(client,task)
        })
        assert.equal(authority.active,false)
        assert.equal((await pool.query('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1',[accepted.executionRef.executionId])).rows[0].cancel_requested,true)
        assert.equal((await pool.query('SELECT enabled FROM pe_stdio_v2_connections WHERE id=$1',[discovery.connectionId])).rows[0].enabled,true)
      })
      await t.test('a child operation cannot become a new root that resets the original call budget',async()=>{
        const f=await running(alice,original),childId=randomUUID(),nextId=randomUUID()
        await pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1",[f.operationId])
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,mcp_root_operation_id,state)
          VALUES($1,$2,$3,'synthetic child','{}',$4,$5,'completed')`,[childId,f.sessionId,randomUUID(),JSON.stringify(original),f.operationId])
        await pool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,stdio_v2_selection,mcp_root_operation_id,state)
          VALUES($1,$2,$3,'synthetic invalid nested root','{}',$4,$5,'running')`,[nextId,f.sessionId,randomUUID(),JSON.stringify(original),childId])
        await assert.rejects(caller().propose(f.token,proposed(f)),{code:'stdio_v2_origin_changed'})
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_stdio_v2_actions WHERE operation_id=$1',[nextId])).rows[0].n,0)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_mcp_action_chains WHERE root_operation_id=$1',[childId])).rows[0].n,0)
      })
      // Earlier cases intentionally retained queued synthetic follow-ups; settle them before exercising the global worker claim.
      await pool.query("UPDATE pe_operations SET state='failed' WHERE state='queued'")
      const selectedTasks=new TaskStore(pool,{maxEventBytes:1048576,leaseMs:60000,maxPendingPerUser:20,maxActivePerUser:2,
        stdioV2Admission:{selection:selector,reservedNames:[]}})
      await t.test('production TaskStore accepts and claims two owner-scoped frozen selections through the Grant parser',async()=>{
        for(const label of ['grant-alice','grant-bob']){
          const owner=await actor(label);await discovered(owner,label)
          await pool.query('UPDATE pe_users SET settings=$2 WHERE id=$1',[owner.userId,{model:'fixture-model',maxTokens:64,revision:1}])
          await pool.query("INSERT INTO pe_user_models(user_id,model_id,label,max_tokens) VALUES($1,'fixture-model','Fixture',64)",[owner.userId])
          const user={userId:owner.userId,username:label},browserToken=await taskCredential(pool,user),requestId=randomUUID()
          const accepted=await selectedTasks.accept(user,owner.sessionId,requestId,'hi',browserToken)
          const saved=(await pool.query('SELECT stdio_v2_selection FROM pe_operations WHERE id=$1',[accepted.operationId])).rows[0].stdio_v2_selection
          const granted=await selectedTasks.claim(randomUUID())
          assert.equal(granted.operationId,accepted.operationId);assert.equal(granted.userId,owner.userId)
          assert.deepEqual(granted.stdioV2Connections,saved)
          assert.equal(Object.hasOwn(granted.stdioV2Connections[0].rawCatalog[0],'__proto__'),true)
          assert.deepEqual(granted.stdioV2Connections[0].rawCatalog,rawCatalog)
          assert.equal(granted.sourceStdioV2ActionId,null);assert.equal(granted.sourceStdioV2NoStartActionId,null)
          await selectedTasks.finish(granted.token,'completed',null)
          assert.equal((await selectedTasks.accept(user,owner.sessionId,requestId,'hi',browserToken)).operationId,accepted.operationId)
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_sandbox_instances')).rows[0].n,0)
      })
      await t.test('actual result and formal no-start follow-ups carry distinct source identities and original selections in claims',async()=>{
        for(const noStart of [false,true]){
          const owner=await actor(`grant-follow-${noStart}`);await discovered(owner,'follow original')
          const f=await call(owner,{noStart});assert.equal((await deliver(f)).disposition,'queued')
          const granted=await selectedTasks.claim(randomUUID())
          assert.equal(granted.sessionId,owner.sessionId);assert.equal(granted.source,noStart?'stdio_v2_no_start':'stdio_v2_result')
          assert.equal(granted.sourceStdioV2Phase,'call')
          assert.equal(granted.sourceStdioV2ActionId,noStart?null:f.lease.actionId)
          assert.equal(granted.sourceStdioV2NoStartActionId,noStart?f.lease.actionId:null)
          assert.deepEqual(granted.stdioV2Connections,await select(selector,owner))
          await selectedTasks.finish(granted.token,'completed',null)
        }
      })
      await t.test('unconfigured selection services and corrupt owner selections cannot issue a Grant or retain an attempt',async()=>{
        const owner=await actor('grant-closed'),discovery=await discovered(owner,'grant closed')
        const groups=await select(selector,owner),f=await running(owner,groups)
        await pool.query("UPDATE pe_operations SET state='queued' WHERE id=$1",[f.operationId])
        await pool.query('UPDATE pe_sessions SET lease_until=NULL,grant_digest=NULL WHERE id=$1',[f.sessionId])
        await assert.rejects(tasks.claim(randomUUID()),{code:'stdio_v2_admission_unavailable'})
        assert.equal((await pool.query('SELECT state,attempts FROM pe_operations WHERE id=$1',[f.operationId])).rows[0].attempts,0)
        assert.equal((await pool.query('SELECT lease_until FROM pe_sessions WHERE id=$1',[f.sessionId])).rows[0].lease_until,null)
        await pool.query("UPDATE pe_operations SET state='failed' WHERE id=$1",[f.operationId])
        const corrupt=await running(owner,original)
        await pool.query("UPDATE pe_operations SET state='queued' WHERE id=$1",[corrupt.operationId])
        await pool.query('UPDATE pe_sessions SET lease_until=NULL,grant_digest=NULL WHERE id=$1',[corrupt.sessionId])
        await assert.rejects(selectedTasks.claim(randomUUID()),{code:'stdio_v2_origin_changed'})
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pe_attempts WHERE operation_id=$1',[corrupt.operationId])).rows[0].n,0)
        assert.equal((await pool.query('SELECT lease_until FROM pe_sessions WHERE id=$1',[corrupt.sessionId])).rows[0].lease_until,null)
        assert.equal((await pool.query('SELECT enabled FROM pe_stdio_v2_connections WHERE id=$1',[discovery.connectionId])).rows[0].enabled,true)
      })
    } finally {
      await pool?.end();try{if(created)await admin.query(`DROP DATABASE "${database}"`)}finally{await admin.end();await rm(root,{recursive:true,force:true})}
    }
  })
