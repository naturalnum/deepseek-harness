/** Real unique PG databases with explicit Kubernetes/Runner substitutes; no real kubelet stop is asserted here. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createSandboxFixture } from './sandbox-binding-fixture.mjs'
import { taskCredential, disableFixtureAccount } from './task-credential-fixture.mjs'
import { ExecutionService } from '../lib/platform/executions.js'
import { CloudExecutionResolutionService } from '../lib/platform/cloud-execution-resolution.js'
import { cloudRequestDigest as digest } from '../lib/platform/cloud-execution-resolution-types.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { FileService } from '../lib/platform/files.js'
import { join } from 'node:path'
const options = { timeout: 30000 }
const signal = () => new AbortController().signal

async function setup(t,{ outcome = null, legacy = false, timeoutMs = 2000, workerTimeoutMs = timeoutMs, unknown = false } = {}) {
  const f = await createSandboxFixture(t,{readyTimeoutMs:600},4)
  const userId = await f.createUser(), session = await f.createSession(userId)
  const user = {userId,username:`test-${userId}`}
  const ready = await f.manager.ensureReady(session.sessionId,userId,async () => {})
  const operationId = randomUUID(), executionId = randomUUID()
  await f.pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'synthetic fixture','{}','completed')",
    [operationId,session.sessionId,randomUUID()])
  const request = {id:executionId,command:'printf synthetic',cwd:'',timeoutMs,instanceId:ready.runnerInstanceId}
  await f.pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state,
    sandbox_name,pod_uid,runner_instance_id,dispatch_request) VALUES($1,$2,$3,$4,'synthetic-call',$5,$6,$7,'uncertain',$8,$9,$10,$11)`,
  [executionId,userId,session.sessionId,operationId,request.command,request.cwd,digest({command:request.command,cwd:request.cwd,timeoutMs}),
    ready.name,ready.podUid,ready.runnerInstanceId,legacy ? null : JSON.stringify(request)])
  if (unknown) await f.manager.quarantine(session.sessionId,userId)
  const original = (await f.pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[executionId])).rows[0]
  const calls = [], call = f.kube.call.bind(f.kube)
  f.kube.call = async (method,path,body) => {
    if(path.includes('/proxy/') && path.includes('/executions/')) {
      calls.push({method,path,body})
      if(method!=='GET') throw new Error('Resolution must never dispatch or cancel a Runner command')
      if(!outcome) throw new KubernetesError(404,'not recorded')
      return {id:executionId,state:outcome,instanceId:ready.runnerInstanceId,digest:digest(request),exitCode:outcome==='succeeded'?0:1,
        stdout:'synthetic\0result',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false}
    }
    return call(method,path,body)
  }
  const service = new ExecutionService({pool:f.pool},f.manager,{service:{verify:async () => ({status:'complete',files:[],reasons:[]})},timeoutMs:5000},2,10,100000,workerTimeoutMs,5000)
  const approval = await taskCredential(f.pool,user,'approval')
  const inspect = await service.inspectResolution(user,executionId)
  const input = {requestId:randomUUID(),executionId,target:'cloud',fingerprint:inspect.fingerprint,note:'synthetic reconciliation'}
  return {...f,...session,userId,user,ready,service,executionId,operationId,request,original,calls,approval,input,inspect}
}
async function accept(f) { return f.service.resolveUncertain(f.user,f.input,f.approval) }
async function run(f) { return f.service.resolutions.poll(signal()) }
async function receipt(f) { return (await f.service.resolutionStatus(f.user,f.input.requestId)).receipt }
async function state(f) { return (await f.pool.query('SELECT state,result,lease_owner,error_code FROM pe_cloud_executions WHERE id=$1',[f.executionId])).rows[0] }
async function continued(f) { return (await f.pool.query('SELECT * FROM pe_operations WHERE source_execution_id=$1',[f.executionId])).rows }
async function expire(f) { await f.pool.query('UPDATE pe_cloud_execution_resolutions SET lease_until=clock_timestamp()-interval \'1 second\' WHERE request_id=$1',[f.input.requestId]) }
async function exactFree(f) {
  const slot = (await f.pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1',[f.userId])).rows[0]
  const instance = (await f.pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1',[f.sessionId])).rows[0]
  assert.equal(slot.state,'free'); assert.equal(instance.state,'deleted')
  for(const row of [slot,instance]) {
    assert.equal(row.stop_pod_uid,f.ready.podUid)
    assert.equal(row.stop_evidence.status,'KUBELET_STOPPED')
    assert.equal(row.stop_evidence.sessionId,f.sessionId)
    assert.equal(row.stop_evidence.runnerInstanceId,f.ready.runnerInstanceId)
    assert.deepEqual(row.stop_evidence.bindingSnapshot,f.ready.binding)
  }
}

test('approval authority, owner denial, exact fingerprint and immutable request retries',options,async t => {
  const f = await setup(t), otherId = await f.createUser(), other = {userId:otherId,username:`test-${otherId}`}
  assert.equal(f.inspect.canStop,true); assert.equal(f.inspect.item.cwd,'.')
  await assert.rejects(f.service.resolveUncertain(f.user,f.input,await taskCredential(f.pool,f.user)),{code:'account_unauthorized'})
  await assert.rejects(f.service.resolveUncertain(f.user,f.input,await taskCredential(f.pool,other,'approval')),{code:'unauthorized'})
  await assert.rejects(f.service.inspectResolution(other,f.executionId),{code:'execution_not_found'})
  assert.deepEqual(await f.service.resolutionStatus(other,f.input.requestId),{receipt:null})
  await assert.rejects(f.service.resolveUncertain(f.user,{...f.input,fingerprint:'a'.repeat(64)},f.approval),{code:'execution_identity_changed'})
  const first = await accept(f)
  assert.deepEqual(await accept(f),first)
  await assert.rejects(f.service.resolveUncertain(f.user,{...f.input,note:'different'},f.approval),{code:'request_id_conflict'})
  await assert.rejects(f.service.resolveUncertain(f.user,{...f.input,requestId:randomUUID()},f.approval),{code:'execution_resolution_exists'})
  assert.equal((await f.service.inspectResolution(f.user,f.executionId)).canStop,false)
  assert.equal((await f.service.listResolutions(f.user,{sessionId:f.sessionId})).items[0].resolution.state,'accepted')
  assert.equal((await f.pool.query('SELECT count(*) FROM pe_cloud_execution_resolutions')).rows[0].count,'1')
})

test('exact stopped unknown writer closes unknown and queues the original continuation once',options,async t => {
  const f = await setup(t,{unknown:true})
  await accept(f); await run(f)
  assert.equal((await state(f)).state,'closed_unknown'); assert.equal((await state(f)).result,null)
  const r = await receipt(f)
  assert.equal(r.state,'completed'); assert.equal(r.finalState,'closed_unknown'); assert.equal(r.stopConfirmed,true); assert.equal(r.continuationQueued,true)
  await exactFree(f)
  const rows = await continued(f)
  assert.equal(rows.length,1); assert.equal(rows[0].request_id,f.original.continuation_request_id)
  const expected = await readFile(new URL('./expected/cloud-execution-closed-unknown.txt',import.meta.url),'utf8')
  assert.equal(rows[0].input.replace(f.executionId,'<execution-id>'),expected.trimEnd())
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0)
  assert.equal(await run(f),false)
  assert.deepEqual(await accept(f),r); assert.equal((await continued(f)).length,1)
  const next = await f.manager.ensureReady(f.sessionId,f.userId,async () => {})
  assert.notEqual(next.generation,f.ready.generation); assert.notEqual(next.podUid,f.ready.podUid)
})

test('verified terminal result survives exact stop and JSON preserves NUL',options,async t => {
  for(const outcome of ['succeeded','failed','cancelled']) await t.test(outcome,async t => {
    const f = await setup(t,{outcome})
    await accept(f); await run(f)
    const row = await state(f)
    assert.equal(row.state,outcome); assert.equal(row.result.stdout,'synthetic\0result')
    assert.equal((await receipt(f)).finalState,outcome); await exactFree(f)
    assert.equal((await continued(f)).length,1)
    const intent = (await f.pool.query('SELECT * FROM pe_cloud_execution_resolutions')).rows[0]
    assert.equal(intent.execution_request_digest,f.original.request_digest)
    assert.equal(intent.runner_request_digest,digest(f.request))
    assert.equal(intent.observed_result.stdout,'synthetic\0result')
  })
})

test('legacy NULL request is verifiable only when admission digest matches the reconstructed timeout',options,async t => {
  for(const workerTimeoutMs of [2000,9000]) await t.test(String(workerTimeoutMs),async t => {
    const f = await setup(t,{outcome:'succeeded',legacy:true,workerTimeoutMs})
    await accept(f); await run(f)
    assert.equal((await state(f)).state,workerTimeoutMs===2000?'succeeded':'closed_unknown')
    assert.equal(f.calls.some(c=>c.method!=='GET'),false)
  })
  await t.test('persisted request survives changed configuration',async t => {
    const f = await setup(t,{outcome:'succeeded',workerTimeoutMs:9000})
    await accept(f); await run(f); assert.equal((await state(f)).state,'succeeded')
  })
})

test('ordinary worker loses claim/assert/defer/settle authority when approval wins; a settled result wins admission first',options,async t => {
  for(const approvedFirst of [true,false]) await t.test(String(approvedFirst),async t => {
    const f = await setup(t)
    const leased = await f.service.claim(); assert.equal(leased.id,f.executionId)
    if(approvedFirst) {
      await accept(f)
      await f.service.defer(leased,'running',null)
      await f.service.settle(leased,'succeeded',{stdout:'late old result'},null)
      await f.service.processLeased(leased)
      assert.equal((await state(f)).state,'uncertain'); assert.equal((await state(f)).lease_owner,null)
      assert.equal(await f.service.claim(),null); assert.equal((await continued(f)).length,0)
      await run(f); assert.equal((await state(f)).state,'closed_unknown')
    } else {
      await f.service.settle(leased,'succeeded',{stdout:'real old result'},null)
      await assert.rejects(accept(f),{code:'execution_not_uncertain'})
      assert.equal((await continued(f)).length,1)
    }
  })
})

test('Pod absence and a delete acknowledgement without kubelet stop never release the slot',options,async t => {
  for(const absent of [false,true]) await t.test(String(absent),async t => {
    const f = await setup(t); await accept(f)
    if(absent) { f.kube.resources.delete(`pods/${f.ready.name}`); f.kube.resources.delete(`sandboxes/${f.ready.name}`) }
    else f.kube.supplyStopProof=false
    await run(f)
    assert.equal((await state(f)).state,'uncertain'); assert.equal((await receipt(f)).state,'stopping')
    assert.equal((await receipt(f)).stopConfirmed,false); assert.equal((await continued(f)).length,0)
    assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots')).rows[0].state,'stopping')
  })
})

test('changed Pod identity permanently blocks the original intent without rebind or force',options,async t => {
  const f = await setup(t); await accept(f)
  const pod = f.kube.resource('pods',f.ready.name); pod.metadata.uid=randomUUID()
  await run(f)
  const r = await receipt(f)
  assert.equal(r.state,'blocked'); assert.match(r.errorCode,/identity_changed/)
  assert.equal((await state(f)).state,'uncertain'); assert.equal((await continued(f)).length,0)
  const mutations = f.kube.mutations.length
  assert.deepEqual(await accept(f),r); assert.equal(await run(f),false)
  assert.equal(f.kube.mutations.length,mutations)
  await assert.rejects(f.manager.ensureReady(f.sessionId,f.userId,async () => {}),{code:'execution_resolution_owns_cleanup'})
})

test('creating without full identity is ineligible and does not imply no writer',options,async t => {
  const f = await setup(t)
  await f.pool.query('UPDATE pe_cloud_executions SET pod_uid=NULL,runner_instance_id=NULL WHERE id=$1',[f.executionId])
  const inspection = await f.service.inspectResolution(f.user,f.executionId)
  assert.equal(inspection.canStop,false); assert.equal(inspection.fingerprint,null)
  await assert.rejects(accept(f),{code:'mount_resolution_identity_incomplete'})
  assert.equal((await f.pool.query('SELECT count(*) FROM pe_cloud_execution_resolutions')).rows[0].count,'0')
})

test('expired owner cannot persist proof or remove finalizer; next epoch takes over exact Pod',options,async t => {
  const f = await setup(t); await accept(f)
  const call=f.kube.call.bind(f.kube); let once=false
  f.kube.call = async (method,path,body) => {
    const result = await call(method,path,body)
    if(!once && method==='GET' && path.endsWith(`/pods/${f.ready.name}`) && result.status?.phase==='Failed') {
      once=true; await expire(f)
    }
    return result
  }
  await run(f)
  assert.equal((await f.pool.query('SELECT stop_evidence FROM pe_mount_slots')).rows[0].stop_evidence,null)
  assert(f.kube.resource('pods',f.ready.name).metadata.finalizers.includes('powerevolve.dev/retain-stop-observation'))
  assert.equal((await continued(f)).length,0)
  const replacement = new CloudExecutionResolutionService(f.pool,f.manager,(client,row)=>f.service.enqueueContinuation(client,row),2000,5000,10)
  await replacement.poll(signal()); assert.equal((await state(f)).state,'closed_unknown')
  assert.equal((await f.pool.query('SELECT lease_epoch FROM pe_cloud_execution_resolutions')).rows[0].lease_epoch,'2')
  await exactFree(f)
})

test('shutdown after double proof retains stopping identity and a successor completes once',options,async t => {
  const f = await setup(t); await accept(f)
  const abort = new AbortController(), call=f.kube.call.bind(f.kube); let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once && method==='PATCH' && path.endsWith(`/pods/${f.ready.name}`) && body.metadata.finalizers.length===0){once=true;abort.abort()}
    return result
  }
  await f.service.resolutions.poll(abort.signal)
  assert.equal((await state(f)).state,'uncertain'); assert.equal((await continued(f)).length,0)
  const slot=(await f.pool.query('SELECT state,stop_evidence FROM pe_mount_slots')).rows[0]
  assert.equal(slot.state,'stopping'); assert.equal(slot.stop_evidence.status,'KUBELET_STOPPED')
  assert.equal((await f.pool.query('SELECT lease_owner,lease_until FROM pe_cloud_execution_resolutions')).rows[0].lease_owner,null)
  const replacement=new CloudExecutionResolutionService(f.pool,f.manager,(client,row)=>f.service.enqueueContinuation(client,row),2000,5000,10)
  await replacement.poll(signal()); await exactFree(f)
  assert.equal((await continued(f)).length,1)
})

test('finalization rollback retains proof and mount fence until terminal state, receipt and continuation commit together',options,async t => {
  const f=await setup(t);await accept(f)
  let fail=true
  const resolver=new CloudExecutionResolutionService(f.pool,f.manager,async(client,row)=>{
    const result=await f.service.enqueueContinuation(client,row)
    if(fail)throw new Error('synthetic failure after enqueue')
    return result
  },2000,5000,10)
  await resolver.poll(signal())
  assert.equal((await state(f)).state,'uncertain');assert.equal((await continued(f)).length,0)
  assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots')).rows[0].state,'stopping')
  assert.equal((await receipt(f)).state,'stopping')
  fail=false;await expire(f);await resolver.poll(signal());await exactFree(f)
  assert.equal((await continued(f)).length,1);assert.equal((await receipt(f)).state,'completed')
})

test('resolution owns cleanup against recycler, other Session admission and binding recovery even after account disable',options,async t=>{
  const f=await setup(t);await accept(f)
  const otherSession=await f.createSession(f.userId)
  const files=new FileService(f.pool,join(f.localRoot,'workspaces'));await files.init()
  await assert.rejects(files.bindings.restore(f.user,{requestId:randomUUID(),workspaceId:f.workspaceId,spaceId:f.ready.binding.spaceId,
    rootRelativePath:'',expectedGeneration:1},await taskCredential(f.pool,f.user)),{code:'execution_resolution_owns_cleanup'})
  await assert.rejects(f.manager.ensureReady(otherSession.sessionId,f.userId,async()=>{}),{code:'execution_resolution_owns_cleanup'})
  const mutations=f.kube.mutations.length
  await f.manager.recycleIdle(0);assert.equal(f.kube.mutations.length,mutations)
  await disableFixtureAccount(f.pool,f.user)
  await f.manager.recycleIdle(0);assert.equal(f.kube.mutations.length,mutations)
  await run(f);await exactFree(f)
  assert.equal((await state(f)).error_code,'account_disabled');assert.equal((await continued(f)).length,0)
  const intent=(await f.pool.query('SELECT state,continuation_queued FROM pe_cloud_execution_resolutions')).rows[0]
  assert.deepEqual(intent,{state:'completed',continuation_queued:false})
})

test('an already-stopping recycler cannot release or mutate a newly captured resolution writer',options,async t=>{
  const f=await setup(t)
  // Existing disabled-account cleanup is eligible, then the still-enabled owner accepts resolution.
  await f.pool.query("UPDATE pe_cloud_executions SET cancel_requested=true,error_code='account_disabled' WHERE id=$1",[f.executionId])
  let reached,release;const entered=new Promise(r=>{reached=r}),held=new Promise(r=>{release=r})
  const call=f.kube.call.bind(f.kube);let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once&&method==='GET'&&path.endsWith(`/sandboxes/${f.ready.name}`)){once=true;reached();await held}
    return result
  }
  const recycler=f.manager.recycleIdle(0).then(()=>null,error=>error)
  await entered
  try {
    await accept(f)
    const mutations=f.kube.mutations.length
    release();assert.equal((await recycler)?.code,'execution_resolution_owns_cleanup')
    assert.equal(f.kube.mutations.length,mutations)
    await run(f);await exactFree(f)
  } finally {release();await recycler}
})

test('a resolution-fenced oldest slot does not starve another owner idle writer',options,async t=>{
  const f=await setup(t);await accept(f)
  const other=await f.createUser(),session=await f.createSession(other)
  const ready=await f.manager.ensureReady(session.sessionId,other,async()=>{})
  await f.pool.query("UPDATE pe_sandbox_instances SET last_used_at='2000-01-01' WHERE session_id=$1",[f.sessionId])
  await f.pool.query("UPDATE pe_sandbox_instances SET last_used_at='2001-01-01' WHERE session_id=$1",[session.sessionId])
  await f.manager.recycleIdle(0)
  assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots WHERE user_id=$1',[other])).rows[0].state,'free')
  assert(f.kube.resource('pods',f.ready.name));assert.equal(f.kube.resource('pods',ready.name),undefined)
})

test('ordinary dispatch persists complete request before wire and restart retains original timeout',options,async t=>{
  const f=await setup(t)
  await f.pool.query('UPDATE pe_cloud_executions SET state=\'starting\',dispatch_request=NULL WHERE id=$1',[f.executionId])
  const leased=await f.service.claim(),posted=[]
  f.manager.runner=async(name,token,method,path,body)=>{
    if(path==='/health')return{ready:true,instanceId:f.ready.runnerInstanceId}
    if(method==='GET')throw new KubernetesError(404,'not dispatched')
    const persisted=(await f.pool.query('SELECT dispatch_request FROM pe_cloud_executions WHERE id=$1',[f.executionId])).rows[0].dispatch_request
    assert.deepEqual(persisted,body);posted.push(body)
    return{id:f.executionId,state:'running',instanceId:f.ready.runnerInstanceId,digest:digest(body),exitCode:null,
      stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false}
  }
  await f.service.process(leased,async()=>{})
  assert.equal(posted.length,1)
  const row=(await f.pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[f.executionId])).rows[0]
  await f.pool.query("UPDATE pe_cloud_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.executionId])
  const replacement=new ExecutionService({pool:f.pool},f.manager,{service:{verify:async()=>({status:'complete',files:[],reasons:[]})},timeoutMs:1000},2,10,10000,9000,5000)
  f.manager.runner=async(name,token,method,path)=>{
    assert.equal(method,'GET')
    if(path==='/health')return{ready:true,instanceId:f.ready.runnerInstanceId}
    return{id:f.executionId,state:'succeeded',instanceId:f.ready.runnerInstanceId,digest:digest(row.dispatch_request),exitCode:0,
      stdout:'restored',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false}
  }
  await replacement.process(await replacement.claim(),async()=>{})
  assert.equal((await state(f)).state,'succeeded');assert.equal(posted.length,1)
})

test('single-sided or wrong-generation stop evidence cannot finalize an absent Pod',options,async t=>{
  for(const corrupt of ['missing-instance','wrong-generation','missing-identity'])await t.test(corrupt,async t=>{
    const f=await setup(t);await accept(f)
    const call=f.kube.call.bind(f.kube);let once=false
    f.kube.call=async(method,path,body)=>{
      const result=await call(method,path,body)
      if(!once&&method==='PATCH'&&path.endsWith(`/pods/${f.ready.name}`)&&body.metadata.finalizers.length===0){
        once=true
        if(corrupt==='missing-instance')await f.pool.query('UPDATE pe_sandbox_instances SET stop_evidence=NULL WHERE session_id=$1',[f.sessionId])
        else {
          const evidence=(await f.pool.query('SELECT stop_evidence FROM pe_mount_slots WHERE user_id=$1',[f.userId])).rows[0].stop_evidence
          if(corrupt==='wrong-generation')evidence.generation='999';else delete evidence.runnerInstanceId
          for(const [table,key,id] of [['pe_mount_slots','user_id',f.userId],['pe_sandbox_instances','session_id',f.sessionId]]) {
            await f.pool.query(`UPDATE ${table} SET stop_evidence=$2 WHERE ${key}=$1`,[id,JSON.stringify(evidence)])
          }
        }
      }
      return result
    }
    await run(f)
    assert.equal((await state(f)).state,'uncertain');assert.equal((await continued(f)).length,0)
    assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots')).rows[0].state,'stopping')
  })
})

test('expired finalizing epoch cannot free a proven writer; next owner commits the original continuation',options,async t=>{
  const f=await setup(t);await accept(f)
  const call=f.kube.call.bind(f.kube);let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once&&method==='DELETE'&&path.endsWith(`/secrets/${f.ready.name}`)){once=true;await expire(f)}
    return result
  }
  await run(f)
  assert.equal((await state(f)).state,'uncertain');assert.equal((await continued(f)).length,0)
  assert.equal((await f.pool.query('SELECT state FROM pe_mount_slots')).rows[0].state,'stopping')
  const replacement=new CloudExecutionResolutionService(f.pool,f.manager,(client,row)=>f.service.enqueueContinuation(client,row),2000,5000,10)
  await replacement.poll(signal());await exactFree(f)
  assert.equal((await continued(f)).length,1)
})

test('transient lost delete response retains intent and reconciles the same stopped writer without command replay',options,async t=>{
  const f=await setup(t);await accept(f)
  const call=f.kube.call.bind(f.kube);let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once&&method==='DELETE'&&path.endsWith(`/sandboxes/${f.ready.name}`)){once=true;throw new Error('synthetic lost response')}
    return result
  }
  await run(f)
  assert.equal((await receipt(f)).state,'stopping');assert.equal((await state(f)).state,'uncertain')
  await expire(f);await run(f);await exactFree(f)
  assert.equal((await state(f)).state,'closed_unknown');assert.equal(f.calls.some(c=>c.method!=='GET'),false)
})

test('two Platform owners fence a late observation from an expired epoch after successor completion',options,async t=>{
  const f=await setup(t,{outcome:'succeeded'});await accept(f)
  let reached,release;const entered=new Promise(r=>{reached=r}),held=new Promise(r=>{release=r})
  const call=f.kube.call.bind(f.kube);let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once&&method==='GET'&&path.includes(`/executions/${f.executionId}`)){once=true;reached();await held}
    return result
  }
  const old=f.service.resolutions.poll(signal())
  await entered
  try {
    await expire(f)
    const successor=new CloudExecutionResolutionService(f.pool,f.manager,(client,row)=>f.service.enqueueContinuation(client,row),2000,5000,10)
    await successor.poll(signal());await exactFree(f)
    const completed=await receipt(f)
    release();await old
    assert.deepEqual(await receipt(f),completed)
    assert.equal(completed.finalState,'succeeded');assert.equal((await continued(f)).length,1)
    assert.equal((await f.pool.query('SELECT lease_epoch FROM pe_cloud_execution_resolutions')).rows[0].lease_epoch,'2')
  } finally {release();await old}
})

test('disablement refuses new intent and forbids model continuation when it wins immediately before finalization',options,async t=>{
  for(const beforeIntent of [true,false])await t.test(String(beforeIntent),async t=>{
    const f=await setup(t,{outcome:'succeeded'})
    if(beforeIntent){
      await disableFixtureAccount(f.pool,f.user)
      await assert.rejects(accept(f),error=>error.status===401)
      assert.equal((await f.pool.query('SELECT count(*) FROM pe_cloud_execution_resolutions')).rows[0].count,'0')
      return
    }
    await accept(f)
    const call=f.kube.call.bind(f.kube);let once=false
    f.kube.call=async(method,path,body)=>{
      const result=await call(method,path,body)
      if(!once&&method==='DELETE'&&path.endsWith(`/secrets/${f.ready.name}`)){once=true;await disableFixtureAccount(f.pool,f.user)}
      return result
    }
    await run(f);await exactFree(f)
    assert.equal((await state(f)).state,'succeeded');assert.equal((await state(f)).error_code,'account_disabled')
    assert.equal((await continued(f)).length,0)
    assert.equal((await f.pool.query('SELECT continuation_queued FROM pe_cloud_execution_resolutions')).rows[0].continuation_queued,false)
  })
})

test('a same-name replacement Sandbox cannot be deleted using the old Pod stop proof',options,async t=>{
  const f=await setup(t);await accept(f)
  const abort=new AbortController(),call=f.kube.call.bind(f.kube),saved=structuredClone(f.kube.resource('sandboxes',f.ready.name));let once=false
  f.kube.call=async(method,path,body)=>{
    const result=await call(method,path,body)
    if(!once&&method==='PATCH'&&path.endsWith(`/pods/${f.ready.name}`)&&body.metadata.finalizers.length===0){once=true;abort.abort()}
    return result
  }
  await f.service.resolutions.poll(abort.signal)
  saved.metadata.uid=randomUUID();f.kube.resources.set(`sandboxes/${f.ready.name}`,saved)
  const mutations=f.kube.mutations.length
  await run(f)
  assert.equal((await receipt(f)).state,'blocked');assert.equal((await state(f)).state,'uncertain')
  assert.equal(f.kube.mutations.length,mutations)
  assert.equal((await continued(f)).length,0)
})

test('a retained unconfirmed resolution does not starve another owner command in the actual worker loop',options,async t=>{
  const f=await setup(t);await accept(f)
  f.kube.resources.delete(`pods/${f.ready.name}`);f.kube.resources.delete(`sandboxes/${f.ready.name}`)
  const other=await f.createUser(),session=await f.createSession(other),operation=randomUUID(),id=randomUUID()
  await f.pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'synthetic fixture','{}','completed')",[operation,session.sessionId,randomUUID()])
  await f.pool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
    VALUES($1,$2,$3,$4,'other-owner','printf other','',$5,'queued')`,[id,other,session.sessionId,operation,digest({command:'printf other',cwd:'',timeoutMs:2000})])
  let posted=0
  f.manager.runner=async(name,token,method,path,body)=>{
    if(path==='/health')return{ready:true,instanceId:f.kube.instances.get(name)}
    if(method==='GET')throw new KubernetesError(404,'not recorded')
    posted++;assert.equal(body.id,id)
    return{id,state:'succeeded',instanceId:body.instanceId,digest:digest(body),exitCode:0,
      stdout:'other owner result',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false}
  }
  f.service.start()
  try {
    const deadline=Date.now()+5000
    let completed=false
    while(Date.now()<deadline){
      if((await f.pool.query('SELECT state FROM pe_cloud_executions WHERE id=$1',[id])).rows[0].state==='succeeded'){completed=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(completed,true);assert.equal(posted,1)
    assert.equal((await state(f)).state,'uncertain');assert.equal((await receipt(f)).state,'stopping')
  } finally {await f.service.close()}
})

test('a missing parent cannot acquire a replacement Sandbox UID while persisting old Pod proof',options,async t=>{
  const f=await setup(t);await accept(f)
  const original=f.kube.resource('sandboxes',f.ready.name),replacement=structuredClone(original)
  replacement.metadata.uid=randomUUID()
  const call=f.kube.call.bind(f.kube)
  await call('DELETE',f.kube.resourcePath('s2-test','sandboxes',f.ready.name),{preconditions:{uid:original.metadata.uid}})
  f.kube.resources.delete(`sandboxes/${f.ready.name}`)
  // The old Pod is terminated but retained by its finalizer; its old parent has already disappeared.
  assert.equal(f.kube.resource('pods',f.ready.name).metadata.ownerReferences[0].uid,original.metadata.uid)
  assert.equal(f.kube.resource('pods',f.ready.name).status.phase,'Failed')
  let missingReads=0
  f.kube.call=async(method,path,body)=>{
    try {
      const result=await call(method,path,body)
      if(method==='PATCH'&&path.endsWith(`/pods/${f.ready.name}`)&&body.metadata.finalizers.length===0){
        // Kubernetes GC of the old Pod does not delete the unrelated replacement parent CR.
        f.kube.resources.set(`sandboxes/${f.ready.name}`,replacement)
      }
      return result
    } catch(error) {
      if(error instanceof KubernetesError&&error.status===404&&method==='GET'&&path.endsWith(`/sandboxes/${f.ready.name}`)){
        missingReads++
        // First read is the advisory observation; the next is the initial stop snapshot.
        if(missingReads===2)f.kube.resources.set(`sandboxes/${f.ready.name}`,replacement)
      }
      throw error
    }
  }
  const mutations=f.kube.mutations.length
  await run(f)
  assert.equal(missingReads,2)
  const slot=(await f.pool.query('SELECT state,stop_evidence FROM pe_mount_slots WHERE user_id=$1',[f.userId])).rows[0]
  const instance=(await f.pool.query('SELECT stop_evidence FROM pe_sandbox_instances WHERE session_id=$1',[f.sessionId])).rows[0]
  assert.notEqual(slot.stop_evidence?.sandboxUid,replacement.metadata.uid)
  assert.equal(slot.stop_evidence,null)
  assert.equal(instance.stop_evidence,null)
  assert.equal(slot.state,'stopping');assert.equal((await state(f)).state,'uncertain')
  assert.equal((await receipt(f)).state,'blocked')
  assert.equal(f.kube.resource('sandboxes',f.ready.name).metadata.uid,replacement.metadata.uid)
  assert.equal(f.kube.mutations.length,mutations)
  assert.equal((await continued(f)).length,0)
  assert.equal(await run(f),false)
})
