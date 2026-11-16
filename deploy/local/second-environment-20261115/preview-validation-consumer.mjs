/** Finite 010 acceptance consumer over the original account, Session and native tools. */
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {ToolCallId,createToolResultMessage} from '@deepseek-ai/dsh-llm'

const T='/tmp/dsh-feature-home/sdk-validation'
const fixture='/opt/dsh-features/arm-native-01/web_service_010.py'
const fixtureSha='80d9371210e0934cdb605890d232e57862182363adfffc64915e6bcc18478238'
const shellArg=value=>"'"+value.replaceAll("'","'\\''")+"'"

/** Wait for one explicit start and one explicit stop; no model or alternative execution provider. */
export async function runPreviewValidation(ctx,signal) {
  const wait=async name=>{while(!fs.existsSync(T+'/'+name)){signal.throwIfAborted();await delay(250,undefined,{signal})}return JSON.parse(fs.readFileSync(T+'/'+name))}
  const request=await wait('PREVIEW010-START.json')
  const result={status:'running',accountId:request.accountId,steps:[],usedModel:false}
  const persist=()=>fs.writeFileSync(T+'/preview010-results.json',JSON.stringify(result,null,2)+'\n',{mode:0o600})
  fs.writeFileSync(T+'/preview010-results.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600})
  const use=await ctx.peAccountRuntime.acquireAccount(request.accountId,signal)
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
      const callEvent=agent.session.append('tool/call',{turn:0,step,callId,name,arguments:args})
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
    const program="import base64,hashlib,os; p='web_service_010.py'; b=base64.b64decode("+JSON.stringify(bytes.toString('base64'))+"); f=open(p,'xb'); f.write(b); f.flush(); os.fsync(f.fileno()); f.close(); print(hashlib.sha256(open(p,'rb').read()).hexdigest())"
    await call('fixture-write','bash',{command:'python3 -c '+shellArg(program),description:'Install the owned 010 public fixture through the original managed command'})
    const started=await call('service-start','dev_service',{action:'start',script:'web_service_010.py'})
    result.serviceHandle=started.value?.serviceHandle
    if(typeof result.serviceHandle!=='string')throw Error('Original service handle required')
    result.status='service-submitted-awaiting-browser';persist()
    const stop=await wait('PREVIEW010-STOP.json')
    if(stop.sessionId!==result.sessionId||stop.serviceHandle!==result.serviceHandle)throw Error('Exact original stop selection required')
    await call('service-stop','dev_service',{action:'stop',serviceHandle:result.serviceHandle})
    result.status='service-stop-returned-physical-release-not-inferred';persist()
  } catch(error) {
    result.status='failed-retained';result.errorName=error?.name;result.errorCode=error?.code;persist();throw error
  } finally {use.release()}
}
