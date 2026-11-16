/** Finite 010 acceptance consumer over the original account, Session and native tools. */
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {symbols} from '@deepseek-ai/cordis'
import {ToolCallId,createToolResultMessage} from '@deepseek-ai/dsh-llm'

const T='/tmp/dsh-feature-home/sdk-validation'
const fixture='/opt/dsh-features/arm-native-01/web_service_010.py'
const fixtureSha='80d9371210e0934cdb605890d232e57862182363adfffc64915e6bcc18478238'

/** Wait for one explicit start and one explicit stop; no model or alternative execution provider. */
export async function runPreviewValidation(ctx,signal) {
  const wait=async name=>{while(!fs.existsSync(T+'/'+name)){signal.throwIfAborted();await delay(250,undefined,{signal})}return JSON.parse(fs.readFileSync(T+'/'+name))}
  const request=await wait('PREVIEW010-PREPARE.json')
  const result={status:'running',accountId:request.accountId,steps:[],usedModel:false}
  const persist=()=>fs.writeFileSync(T+'/preview010-results.json',JSON.stringify(result,null,2)+'\n',{mode:0o600})
  fs.writeFileSync(T+'/preview010-results.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600})
  const use=await ctx.peAccountRuntime.acquireAccount(request.accountId,signal)
  let finishObservation=()=>{}
  try {
    const account=use.context,registered=account.workspaceRegistry.list().find(x=>x.path.endsWith('/default-workspace'))
    if(!registered)throw Error('Original default Workspace required')
    const adopted=await account.workspaceController.create({path:registered.path})
    const created=await account.sessionController.create({workspaceId:adopted.workspace.workspaceId,agentPreset:'standard'})
    const agent=account.agents.get(created.sessionId)
    if(!agent)throw Error('Original Native Agent required')
    result.sessionId=created.sessionId;result.workspaceId=adopted.workspace.workspaceId;persist()
    let sequence=0
    const call=async(label,name,args)=>{
      use.assertCurrent();result.stage=label;persist()
      const callId=ToolCallId('preview010-'+label),step=++sequence
      const callEvent=agent.session.append('tool/call',{turn:0,step,callId,name,arguments:JSON.stringify(args)})
      const outcome=await account.agents.withInitiator(agent,()=>agent.ctx.tools.execute({callId,name,arguments:args,agent,signal}))
      agent.session.append('tool/result',{turn:0,step,message:createToolResultMessage({callId,content:outcome.content,isError:outcome.isError}),
        ...(outcome.error?.info?{error:outcome.error.info}:{}),...(outcome.meta!==undefined?{meta:outcome.meta}:{})},
      {surfaceOp:'append',sourceEventSeqs:[callEvent.seq]})
      result.steps.push({label,name,outcome});persist()
      if(outcome.isError||typeof outcome.value?.exitCode==='number'&&outcome.value.exitCode!==0)throw Error('Original tool refused '+label)
      return outcome
    }
    const bytes=fs.readFileSync(fixture)
    if(createHash('sha256').update(bytes).digest('hex')!==fixtureSha)throw Error('Exact public fixture required')
    if(request.fixtureAlreadyPrepared!==true)await call('fixture-write','write',{file_path:'web_service_010.py',content:bytes.toString('utf8')})
    await call('fixture-hash','bash',{command:'sha256sum web_service_010.py',description:'Read back the exact public fixture hash'})
    result.status='fixture-prepared-awaiting-explicit-start';persist()
    const start=await wait('PREVIEW010-START.json')
    if(start.sessionId!==result.sessionId)throw Error('Exact prepared Session required')
    const original=value=>Reflect.get(value,symbols.original)??value
    let coordinator,auth
    try {coordinator=original(ctx.get('peSandboxCoordinator'));auth=original(ctx.get('peAuth'))}catch(error){result.observerUnavailable={name:error?.name,message:error?.message};persist()}
    const observations={bufferPoolSize:Buffer.poolSize,rows:[],readOnlyOriginalOwner:true}
    let previous=''
    const sample=()=>{
      try {
      if(!coordinator||!auth)return
      const row={global:{active:coordinator.state.active,resident:coordinator.state.resident,bytes:coordinator.state.bytes,requests:coordinator.state.requests},
        accounts:[...coordinator.accounts].map(([accountId,work])=>({accountId,...work.capacity})),
        ingress:[...auth.ingress.operations.values()].filter(x=>x.application).map(x=>({method:x.request.method,path:x.request.url?.split('?')[0],
          forwardedHeaderEntries:Object.keys(x.request.headers).filter(name=>['accept','accept-language','if-none-match','if-modified-since','range','content-type'].includes(name)).length}))}
      const key=JSON.stringify(row)
      if(key!==previous&&observations.rows.length<1024){previous=key;observations.rows.push({at:new Date().toISOString(),...row});fs.writeFileSync(T+'/preview010-owner-observations.json',JSON.stringify(observations)+'\n',{mode:0o600})}
      }catch(error){if(observations.unavailable)return;observations.unavailable={name:error?.name,message:error?.message};fs.writeFileSync(T+'/preview010-owner-observations.json',JSON.stringify(observations)+'\n',{mode:0o600})}
    }
    sample();const timer=setInterval(sample,1);const finish=()=>{clearInterval(timer);sample()};signal.addEventListener('abort',finish,{once:true})
    finishObservation=()=>{finish();signal.removeEventListener('abort',finish)}
    const started=await call('service-start','dev_service',{action:'start',script:'web_service_010.py'})
    result.serviceHandle=started.value?.serviceHandle
    if(typeof result.serviceHandle!=='string')throw Error('Original service handle required')
    result.status='service-submitted-awaiting-browser';persist()
    const stop=await wait('PREVIEW010-STOP.json')
    if(stop.sessionId!==result.sessionId||stop.serviceHandle!==result.serviceHandle)throw Error('Exact original stop selection required')
    await call('service-stop','dev_service',{action:'stop',serviceHandle:result.serviceHandle})
    result.status='service-stop-returned-physical-release-not-inferred';persist();finish();signal.removeEventListener('abort',finish)
  } catch(error) {
    result.status='failed-retained';result.errorName=error?.name;result.errorCode=error?.code;result.errorMessage=error?.message;persist();throw error
  } finally {finishObservation();use.release()}
}
