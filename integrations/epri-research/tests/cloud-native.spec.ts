/** Real Loader/native Session/Gateway and independent account Stores; no deployment or external computation is certified. */
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {readFileSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {loadOverlayPatches} from '@deepseek-ai/dsh-app-boot'
import {expect,it,vi} from 'vitest'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {isJsonValue} from '@deepseek-ai/dsh-util-values'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ResearchSkills from '../plugins/deepscientist/index.mjs'
import {policyFixture} from '../../../packages/cloud/pe-cloud-runtime/tests/account-policy-fixture.ts'
import * as Cloud from '../plugins/cloud/index.ts'
import * as Airalogy from '../plugins/airalogy/index.mjs'
import * as Workbench from '../plugins/workbench/index.mjs'
import {workbenchBrowserApi} from './workbench-browser-fixture.mjs'
import {guardianEncodedBudget,guardianWorkingCopiesBudget} from '../../../packages/cloud/pe-opensandbox/src/agent-data/encoded-budget.ts'
import type {OperationSpec} from '../../../packages/cloud/pe-opensandbox/src/agent-data/types.ts'
import type {SkillWorld} from '../../../packages/cloud/pe-opensandbox/src/agent-data/skill-world.ts'
import {SLICE_LIMITS} from '../../../packages/cloud/pe-opensandbox/src/agent-data/constants.ts'

const limits={maxDatabaseBytes:1048576,maxRequestBytes:1048576,maxReplyBytes:1048576,maxPendingRequests:2,
  maxConcurrentResourcePreparations:1,maxSkillProviders:64,maxSkillFiles:1024,maxSkillBytes:33554432,maxSkillFileBytes:4194304,maxSkillPathBytes:256,executionTimeoutMs:10000,expectedPythonVersion:'3.13',expectedAiralogyVersion:'0.16.0',maxPayloadBytes:8388608,fileChunkBytes:65536,maxConcurrentFileTransfers:2,maxOutputBytes:32768,graceMs:1000,gitPath:'/usr/bin/git',pythonPath:'/usr/bin/python3'}
const endpoint={endpoint:'cloudResearch/action',handlerId:'native:cloudResearch',guard:'account-session' as const}
async function fixture(accountId:string,overrides:Partial<Cloud.Config>={},projectDirectoryName?:string,questions=false) {
  const options={defaultId:'research-suite',...projectDirectoryName===undefined?{}:{projectDirectoryName},declarations:[{entryId:'research-preset',selectable:true,config:{id:'research-suite',plugins:[
    {id:'persona',name:'cordis:m8z-persona',config:{prefix:'Research fixture.',complete:true,includeRuntimeContext:false}},
    {id:'research-tools',name:'deepscientist-harness-suite/airalogy'},
    {id:'research-skills',name:'deepscientist-harness-suite/research'},
    {id:'tool-skill',name:'@deepseek-ai/dsh-tool-skill'},
  ]}}],sourceModules:{'@deepseek-ai/dsh-skill':SkillRegistry,'@deepseek-ai/dsh-tool-skill':ToolSkill,'deepscientist-harness-suite/research':ResearchSkills,'deepscientist-harness-suite/cloud':Cloud,'deepscientist-harness-suite/airalogy':Airalogy,'deepscientist-harness-suite':Workbench},
  extraEntries:[{id:'skills',name:'@deepseek-ai/dsh-skill'},{id:'cloud-research',name:'deepscientist-harness-suite/cloud',config:{...limits,...overrides}},{id:'research-workbench',name:'deepscientist-harness-suite'}],
  researchStorage(binding:Cloud.CloudResearch['binding'],privateRoot:string){
    return {binding,directory:join(privateRoot,'research-suite'),assertCurrent(){binding.lifetime.throwIfAborted()}}
  }}
  const rpc=questions?[endpoint,{endpoint:'userQuestions/answer',handlerId:'native:userQuestions',guard:'account-session' as const}]:[endpoint]
  const f=policyFixture(rpc,undefined,accountId,{selected:[]},undefined,undefined,undefined,undefined,[],false,undefined,options)
  const graph=await f.start()
  await graph.api.auditPrepared(graph.ctx)
  const {sessionId}=await graph.ctx.sessionController.create({})
  const agent=graph.ctx.agents.get(sessionId)
  if(agent===undefined)throw new Error('Original Agent absent')
  const api=(op:string,args:Record<string,unknown>={},execute=false)=>graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',
    args:{request:{sessionId,op,args,execute}},peer:graph.localePeer})
  const tool=async(name:string,args:Record<string,unknown>={},signal=new AbortController().signal)=>graph.ctx.tools.execute({callId:ToolCallId(randomUUID()),name,arguments:args,agent,signal})
  return {f,graph,agent,api,tool}
}

it('replays a human-confirmed submission from its original request owner without new approval or cross-scope access',async()=>{
  const a=await fixture('research-submit-replay-a',{},undefined,true),b=await fixture('research-submit-replay-b',{},undefined,true)
  expect(await a.tool('research_protocol_put',{id:'replay',version:'1',content:'# Synthetic replay\n{{var|value: int, owner="agent"}}\n{{check|verified, checked_message="Verify synthetic data"}}',requestId:'replay-protocol'})).toMatchObject({isError:false})
  const made=await a.tool('research_record_create',{protocolId:'replay',protocolVersion:'1',requestId:'replay-record'})
  if(made.isError)throw new Error('Record fixture failed')
  const record=made.value as {id:string;revision:number;run:Record<string,unknown>}
  const saved=await a.tool('research_record_update',{id:record.id,expectedRevision:record.revision,requestId:'replay-data',run:{...record.run,status:'running',values:{value:42}}})
  if(saved.isError)throw new Error('Draft fixture failed')
  const draft=saved.value as {id:string;revision:number}
  const args={id:draft.id,expectedRevision:draft.revision,requestId:'exact-submission'}
  let asked=0,approve=false
  const release=a.agent.ctx.on('user-questions/request',async request=>{
    asked++
    const question=request.questions[0]
    if(question?.options?.length!==2)throw new Error('Native question absent')
    return {answers:[{id:question.id,selected:[question.options[approve?1:0]!.label]}]}
  })
  try {
    expect(await a.tool('research_record_submit_result',{...args,confirmChecks:true})).toMatchObject({isError:false,value:{found:false}})
    expect(await a.tool('research_record_submit',args)).toMatchObject({isError:false,value:{executed:false,status:'declined'}})
    expect(asked).toBe(1)
    expect(await a.tool('research_record_submit_result',{...args,confirmChecks:true})).toMatchObject({isError:false,value:{found:false}})
    expect(await a.api('record_get',{id:record.id})).toEqual(saved.value)
    approve=true
    const submitted=await a.tool('research_record_submit',args)
    expect(submitted).toMatchObject({isError:false,value:{status:'submitted',revision:draft.revision+1,run:{checks:{verified:true}}}})
    if(submitted.isError)throw new Error('Submission fixture failed')
    expect(asked).toBe(2)
    expect(await a.tool('research_record_submit',args)).toMatchObject({isError:false,value:submitted.value})
    expect(asked).toBe(2)
    expect(await a.api('record_submit_result',{...args,confirmChecks:true})).toEqual({found:true,result:submitted.value})
    for(const changed of [{...args,expectedRevision:draft.revision+1},{...args,confirmChecks:false}]) {
      expect(await a.tool('research_record_submit',changed)).toMatchObject({isError:true})
    }
    await expect(a.api('record_submit_result',{...args,expectedRevision:draft.revision+1,confirmChecks:true})).rejects.toMatchObject({code:'research/conflict'})
    expect(await a.tool('research_record_submit',{...args,requestId:'new-stale-submission'})).toMatchObject({isError:true})
    expect(asked).toBe(2)
    expect(await a.api('record_get',{id:record.id})).toEqual(submitted.value)
    expect(await b.tool('research_record_submit',args)).toMatchObject({isError:true})
    expect(await b.tool('research_record_submit_result',{...args,confirmChecks:true})).toMatchObject({isError:true})
    await expect(b.graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',args:{request:{sessionId:a.agent.session.id,op:'record_submit_result',args:{...args,confirmChecks:true}}},peer:b.graph.localePeer})).rejects.toBeDefined()
    const other=await a.graph.ctx.sessionController.create({}),otherAgent=a.graph.ctx.agents.get(other.sessionId)
    if(otherAgent===undefined)throw new Error('Second Session Agent absent')
    for(const name of ['research_record_submit','research_record_submit_result'])expect(await a.graph.ctx.tools.execute({callId:ToolCallId(randomUUID()),name,arguments:args,agent:otherAgent,signal:new AbortController().signal})).toMatchObject({isError:true})
    expect(asked).toBe(2)
    const reopened=await a.tool('research_record_reopen',{id:record.id,expectedRevision:draft.revision+1,reason:'Synthetic later edit',requestId:'replay-reopen'})
    expect(reopened).toMatchObject({isError:false,value:{status:'draft',revision:draft.revision+2}})
    if(reopened.isError)throw new Error('Later edit fixture failed')
    expect(asked).toBe(3)
    expect(await a.tool('research_record_submit',args)).toMatchObject({isError:false,value:submitted.value})
    expect(await a.api('record_get',{id:record.id})).toEqual(reopened.value)
    expect(asked).toBe(3)
  } finally { release() }
})

it('presents only saved versions in native research approval questions without changing their exact snapshot binding',async()=>{
  const a=await fixture('research-review-copy',{},undefined,true)
  const created=await a.tool('research_task_create',{objective:'Synthetic approval copy check',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:'create-review-copy'})
  expect(created,JSON.stringify(created)).toMatchObject({isError:false})
  if(created.isError)throw new Error('Task fixture failed')
  const task=created.value as {id:string}
  const before={task:await a.api('task_get',{id:task.id}),method:await a.api('method_get',{id:'power-data-quality-interactive',version:'1.0.0'})}
  const args={id:task.id,reason:'Inspect exact source before execution',requestId:'review-copy'}
  const fingerprint=createHash('sha256').update(JSON.stringify({op:'task_open',args,before})).digest('hex')
  const snapshots:Array<{header:string|undefined;question:string;intro:string[];options:unknown}>=[]
  const release=a.agent.ctx.on('user-questions/request',async request=>{
    expect(request.agent).toBe(a.agent)
    const question=request.questions[0]
    if(question===undefined)throw new Error('Native review question absent')
    expect(question.id).toBe('research-review-'+fingerprint)
    expect(question.detail).not.toContain('undefined')
    expect(question.detail).not.toContain('**版本**')
    snapshots.push({header:question.header,question:question.question,
      intro:question.detail!.split('\n\n').slice(0,7).map(line=>line.replaceAll(task.id.replaceAll('-','\\-'),'<task-id>')),options:question.options})
    return {answers:[{id:question.id,selected:[question.options![0]!.label]}]}
  })
  try{
    expect(await a.tool('research_task_open',args)).toMatchObject({isError:false,value:{executed:false,status:'declined'}})
    expect(snapshots).toMatchSnapshot('task approval without an invented generic version')
    expect(await a.api('task_get',{id:task.id})).toEqual(before.task)
  }finally{release()}
})

it('retains saved record revisions and requested package versions in native review headers',async()=>{
  const a=await fixture('research-review-versions',{},undefined,true)
  expect(await a.tool('research_protocol_put',{id:'review-protocol',version:'1',content:'# Review\n{{var|x: int}}',requestId:'protocol-copy'})).toMatchObject({isError:false})
  const recordResult=await a.tool('research_record_create',{protocolId:'review-protocol',protocolVersion:'1',requestId:'record-copy'})
  expect(recordResult).toMatchObject({isError:false})
  if(recordResult.isError)throw new Error('Record fixture failed')
  const record=recordResult.value as {id:string;revision:number}
  const prepare=a.graph.ctx.tools.register({name:'fixture_review_package',description:'Synthetic imported package for review copy',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(_args,exec)=>a.graph.ctx.cloudResearch.reviewedCall('engine_package_put',{
      id:'review-package',version:'2.3.4',title:'Review package',kind:'protocol',files:{'protocol.aimd':'# Review\n{{var|x: int}}','protocol.toml':'[airalogy_protocol]\nid="review-package"\nversion="2.3.4"'},requestId:'package-copy'},exec)})
  let packageResult
  try{packageResult=await a.tool('fixture_review_package')}finally{prepare()}
  expect(packageResult,JSON.stringify(packageResult)).toMatchObject({isError:false})
  if(packageResult.isError)throw new Error('Package fixture failed')
  const source=packageResult.value as {sha256:string}
  const cases=[
    {op:'record_archive',args:{id:record.id,expectedRevision:record.revision,reason:'Review only',requestId:'archive-copy'},version:record.revision},
    {op:'record_submit',args:{id:record.id,expectedRevision:record.revision,requestId:'submit-copy'},version:record.revision},
    {op:'engine_package_review',args:{id:'review-package',version:'2.3.4',sha256:source.sha256,approved:true,reason:'Review only'},version:'2.3.4'},
  ]
  for(const item of cases){
    const release=a.agent.ctx.on('user-questions/request',async request=>{
      const question=request.questions[0]
      if(question===undefined)throw new Error('Native review question absent')
      const versionLine=question.detail!.split('\n\n')[2]
      expect(versionLine).toBe('**版本**：'+String(item.version).replaceAll('.','\\.'))
      expect({header:question.header,question:question.question,version:versionLine,options:question.options}).toMatchSnapshot(item.op+' saved version')
      return {answers:[{id:question.id,selected:[question.options![0]!.label]}]}
    })
    try{const result=await a.tool('research_'+item.op,item.args);expect(result,JSON.stringify(result)).toMatchObject({isError:false,value:{executed:false,status:'declined'}})}finally{release()}
  }
})

it('keeps actual account Stores and native Session access independent and refuses foreign/native-less invocations',async()=>{
  const a=await fixture('research-a'),b=await fixture('research-b')
  expect(await a.api('state')).toMatchObject({records:[],protocols:[],artifacts:[]})
  expect(await a.tool('research_engine_packages')).toMatchObject({isError:false,value:[]})
  const call=await a.tool('research_protocol_put',{id:'private-protocol',version:'1',content:'# Private\n{{var|x: int}}',requestId:randomUUID()})
  expect(call,JSON.stringify(call)).toMatchObject({isError:false})
  expect(await a.api('state')).toMatchObject({protocols:[{id:'private-protocol'}]})
  expect(await b.api('state')).toMatchObject({protocols:[]})
  await expect(b.graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',args:{request:{sessionId:a.agent.id,op:'state',args:{}}},peer:b.graph.localePeer})).rejects.toBeDefined()
  const forwarded=b.graph.ctx.tools.register({name:'fixture_forward',description:'Foreign native scope fixture',parameters:{type:'object',additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(_args,exec)=>a.graph.ctx.cloudResearch.agentCall('state',{},exec)})
  try{expect((await b.tool('fixture_forward')).isError).toBe(true)}finally{forwarded()}
  a.graph.closeBusiness()
  await expect(a.api('state')).rejects.toBeDefined()
})

it('preserves actual Store errors through Gateway, native client, MessageChannel and iframe recovery',async()=>{
  const a=await fixture('research-recovery-errors'),failures:unknown[]=[]
  const api=await workbenchBrowserApi(async(_endpoint:string,_method:string,payload:{args:{request:{sessionId:string;op:string;args:Record<string,unknown>;execute:boolean}}})=>{
    expect(payload.args.request.sessionId).toBe(a.agent.session.id)
    // The real HTTP carrier decodes JSON into Host records; VM objects retain foreign prototypes.
    try{return {ok:true,value:await a.graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',args:JSON.parse(JSON.stringify(payload.args)),peer:a.graph.localePeer})}}
    catch(error){const failure=a.graph.ctx.typertGateway.wireStream.failure(error);failures.push(failure);return {ok:false,error:failure}}
  },a.agent.session.id)
  const original=a.graph.adapter.stream.bind(a.graph.adapter),called=new Set<string>()
  vi.spyOn(a.graph.adapter,'stream').mockImplementation(async function*(options){
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const requestId=[...text.matchAll(/requestId=([a-f0-9-]{36})/g)].at(-1)?.[1]
    if(requestId&&!called.has(requestId)){called.add(requestId);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('protocol-version-'+called.size),name:'research_workbench_execute',arguments:JSON.stringify({requestId})}};yield {type:'finish',reason:{kind:'tool-calls'}}}
    else yield* original(options)
  })
  await expect(api('protocol_get',{id:'fresh',version:'1'})).rejects.toMatchObject({code:'NOT_FOUND',message:'Protocol version missing'})
  expect(failures).toMatchObject([{code:'research/not-found',details:{}}])
  expect(await api('protocol_put',{id:'fresh',version:'1',content:'# Exact\n{{var|x: int}}',requestId:'first'})).toMatchObject({id:'fresh',version:'1'})
  await a.agent.whenIdle()
  await expect(api('protocol_put',{id:'fresh',version:'1',content:'# Changed\n{{var|x: int}}',requestId:'conflict'})).rejects.toMatchObject({code:'CONFLICT'})
  await a.agent.whenIdle()
  expect(called.size).toBe(2)
  expect(await api('protocol_get',{id:'fresh',version:'1'})).toMatchObject({content:'# Exact\n{{var|x: int}}'})
  a.graph.closeBusiness()
  await expect(api('protocol_get',{id:'fresh',version:'1'})).rejects.toMatchObject({code:'gateway/internal'})
})

it('records a real native workbench intent, executes only its stored parameters once and returns the actual Store result',async()=>{
  const a=await fixture('research-request')
  let requestId=''
  const original=a.graph.adapter.stream.bind(a.graph.adapter)
  vi.spyOn(a.graph.adapter,'stream').mockImplementation(async function*(options){
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const id=/requestId=([a-f0-9-]{36})/.exec(text)?.[1]
    if(id && !requestId){requestId=id;yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('cloud-request'),name:'research_workbench_execute',arguments:JSON.stringify({requestId})}};yield {type:'finish',reason:{kind:'tool-calls'}}}
    else yield* original(options)
  })
  const value=await a.api('protocol_put',{id:'from-workbench',version:'1',content:'# Exact\n{{var|x: int}}',requestId:'exact-request'})
  expect(value).toMatchObject({id:'from-workbench',version:'1'})
  await a.agent.whenIdle()
  expect(requestId).not.toBe('')
  expect(a.agent.session.deriveMessages().map(message=>({role:message.role,parts:message.content.map(part=>part.type),source:message.role==='user'?message.source.kind:undefined}))).toMatchSnapshot('native workbench request and actual tool result')
  expect((await a.tool('research_workbench_execute',{requestId})).isError).toBe(true)
  expect(await a.api('state')).toMatchObject({protocols:[{id:'from-workbench'}]})
})

it('returns committed task create/get/open views as bounded lossless JSON through original native tools',async()=>{
  const a=await fixture('research-task-json-a',{},undefined,true),b=await fixture('research-task-json-b')
  const called=new Set<string>(),outputs:unknown[]=[]
  const original=a.graph.adapter.stream.bind(a.graph.adapter)
  a.graph.ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next()
    if(exec.name==='research_workbench_execute'){expect(result.isError,JSON.stringify(result)).toBe(false);expect(isJsonValue(result.value)).toBe(true);outputs.push(result.value)}
    return decision
  })
  vi.spyOn(a.graph.adapter,'stream').mockImplementation(async function*(options){
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const id=[...text.matchAll(/requestId=([a-f0-9-]{36})/g)].at(-1)?.[1]
    if(id&&!called.has(id)){called.add(id);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('task-intent-'+called.size),name:'research_workbench_execute',arguments:JSON.stringify({requestId:id})}};yield {type:'finish',reason:{kind:'tool-calls'}}}
    else yield* original(options)
  })
  const task=await a.api('task_create',{objective:'评估合成测点采样完整性',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:'task-json-create'}) as {id:string}
  await a.agent.whenIdle()
  expect(outputs).toHaveLength(1)
  expect(task).not.toHaveProperty('record');expect(task).not.toHaveProperty('report')
  const read=await a.tool('research_task_get',{id:task.id})
  expect(read).toMatchObject({isError:false,value:task});expect(isJsonValue(read.value)).toBe(true)
  expect(await a.api('tasks')).toHaveLength(1)

  // Only the external managed Python transport is scripted; task preparation, Store writes and native Tools are real.
  await managedFixture(a,false,undefined,undefined,(payload)=>{
    if(payload.action===undefined)return {python:'3.13.1',airalogy:'0.16.0'}
    if(payload.action==='parse_protocol')return {success:true,data:{assigners:{expected_total:{mode:'auto'}}}}
    if(payload.action==='recalculate'){
      const params=payload.params as {values:unknown;tables:unknown}
      return {success:true,data:{values:params.values,tables:params.tables,targets:['expected_total'],pending:['expected_total'],errors:[]}}
    }
    throw new Error('Unexpected scientific transport operation in JSON result fixture')
  })
  const decisions:string[]=[]
  let accept=false
  const unregister=a.agent.ctx.on('user-questions/request',async request=>{
    const question=request.questions[0]
    if(question===undefined || question.options?.length!==2)throw new Error('Native review question absent')
    expect(question.detail).toContain(task.id.replaceAll('-', '\\-'))
    expect(question.detail).toContain('88a52b1c11219f47f2f1553ea2d4977249ab22c467102b7d9aee631872bd68c8')
    const selected=question.options[accept?1:0]!.label
    decisions.push(selected)
    return {answers:[{id:question.id,selected:[selected]}]}
  })
  let opened:unknown
  try {
    const denied=await a.api('task_open',{id:task.id,reason:'暂不批准合成测试方法',requestId:'task-json-denied'})
    await a.agent.whenIdle()
    expect(denied).toMatchObject({executed:false,status:'declined'})
    expect(await a.api('task_get',{id:task.id})).toEqual(task)
    accept=true
    opened=await a.api('task_open',{id:task.id,reason:'明确核对合成软件测试方法源码',requestId:'task-json-open'})
    await a.agent.whenIdle()
  } finally { unregister() }
  expect(decisions).toHaveLength(2)
  expect(outputs).toHaveLength(3)
  expect(opened).toMatchObject({id:task.id,record:{protocolId:'power-data-quality-interactive'}})
  expect(isJsonValue(opened)).toBe(true)
  expect(opened).not.toHaveProperty('report')
  expect((await b.tool('research_task_get',{id:task.id})).isError).toBe(true)
  const other=await a.graph.ctx.sessionController.create({}),otherAgent=a.graph.ctx.agents.get(other.sessionId)
  if(otherAgent===undefined)throw new Error('Original second Session Agent absent')
  expect((await a.graph.ctx.tools.execute({callId:ToolCallId(randomUUID()),name:'research_task_get',arguments:{id:task.id},agent:otherAgent,signal:new AbortController().signal})).isError).toBe(true)
})

it.each(['peer','request','account','unanswered','changed'] as const)('does not apply sidebar approval when %s fails during the question',async kind=>{
  const a=await fixture('research-review-stopped-'+kind,{},undefined,true)
  const controller=new AbortController()
  const made=await a.tool('research_task_create',{objective:'Synthetic approval abort test',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:'peer-closed-task'})
  if(made.isError)throw new Error('Task fixture failed')
  const task=made.value as {id:string}
  const original=a.graph.adapter.stream.bind(a.graph.adapter),called=new Set<string>()
  vi.spyOn(a.graph.adapter,'stream').mockImplementation(async function*(options){
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const id=[...text.matchAll(/requestId=([a-f0-9-]{36})/g)].at(-1)?.[1]
    if(id&&!called.has(id)){called.add(id);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('peer-closed-review'),name:'research_workbench_execute',arguments:JSON.stringify({requestId:id})}};yield {type:'finish',reason:{kind:'tool-calls'}}}
    else yield* original(options)
  })
  let asked=false
  const unregister=a.agent.ctx.on('user-questions/request',async request=>{
    const q=request.questions[0]
    if(q===undefined||q.options?.length!==2)throw new Error('Native review question absent')
    asked=true
    if(kind==='peer')await a.graph.localePeer.dispose()
    if(kind==='request')controller.abort()
    if(kind==='account')a.graph.closeBusiness()
    if(kind==='unanswered')return undefined
    if(kind==='changed'){
      const change=await a.tool('research_task_select_method',{id:task.id,expectedRevision:1,methodId:'power-linear-calibration',methodVersion:'1.0.0',requestId:'change-during-review'})
      if(change.isError)throw new Error('Failed to change the synthetic method')
    }
    return {answers:[{id:q.id,selected:[q.options[1]!.label]}]}
  })
  try { await expect(a.graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',
    args:{request:{sessionId:a.agent.session.id,op:'task_open',args:{id:task.id,reason:'Synthetic stop during approval',requestId:'peer-closed-open'},execute:true}},
    peer:a.graph.localePeer,signal:controller.signal})).rejects.toBeDefined() }
  finally { unregister() }
  expect(asked).toBe(true)
  await a.agent.whenIdle()
  const db=new DatabaseSync(join(a.graph.profileHome,'research-suite','research.sqlite'),{readOnly:true})
  try {
    const row=db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string}
    const state=JSON.parse(row.body) as {tasks:Array<{id:string;recordId?:string}>;records:Array<{sessionId:string}>}
    expect(state.tasks.find(item=>item.id===task.id)?.recordId).toBeUndefined()
    expect(state.records.filter(item=>item.sessionId===a.agent.session.id)).toHaveLength(0)
  } finally { db.close() }
})

it('preserves all 500 imported rows in bounded chart pages and removes only obsolete generated pages on a two-row revision',async()=>{
  const a=await fixture('research-chart-pages',{maxOutputBytes:4096},undefined,true),targets=['measurements.missing_rate','expected_total','valid_total','missing_rate']
  const observed:number[]=[]
  const original=a.graph.adapter.stream.bind(a.graph.adapter),called=new Set<string>()
  vi.spyOn(a.graph.adapter,'stream').mockImplementation(async function*(options){
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n')
    const id=[...text.matchAll(/requestId=([a-f0-9-]{36})/g)].at(-1)?.[1]
    if(id&&!called.has(id)){called.add(id);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('chart-intent-'+called.size),name:'research_workbench_execute',arguments:JSON.stringify({requestId:id})}};yield {type:'finish',reason:{kind:'tool-calls'}}}
    else yield* original(options)
  })
  // Scientific results are scripted at the managed transport; CSV parsing, Store commits, chart schema/rendering and native FS are real.
  const managed=await managedFixture(a,false,undefined,undefined,payload=>{
    if(payload.action===undefined)return {python:'3.13.18',airalogy:'0.16.0'}
    if(payload.action==='parse_protocol')return {success:true,data:{assigners:Object.fromEntries(targets.map(id=>[id,{mode:'auto'}]))}}
    if(payload.action!=='recalculate')throw new Error('Unexpected scientific transport operation')
    const params=payload.params as {values:Record<string,unknown>;tables:{measurements:Array<{channel:string;expected:number;valid:number}>}}
    const rows=params.tables.measurements;observed.push(rows.length)
    expect([2,500]).toContain(rows.length)
    return {success:true,data:{values:{...params.values,expected_total:rows.length===500?50000:300,valid_total:rows.length===500?45000:270,missing_rate:10},
      tables:{measurements:rows.map(row=>({...row,missing_rate:10}))},targets,pending:[],errors:[]}}
  },4096)
  async function reviewed<T>(op:string,args:Record<string,unknown>):Promise<T>{
    const value=await a.api(op,args);await a.agent.whenIdle();return value as T
  }
  type Chart={id:string;interactionChartId?:string;title:string;sourceRecordId?:string;spec:{data:Array<{id:string;label:string;value:number}>;caption?:string};svg:string}
  type View={id:string;record:{id:string;revision:number;run:{tables:{measurements:Array<{channel:string;expected:number;valid:number;missing_rate:number}>};values:{expected_total:number;valid_total:number;missing_rate:number}};calculation:{errors:unknown[];pending:unknown[]}};charts:Chart[]}
  const task=await reviewed<{id:string}>('task_create',{objective:'Synthetic 500-row chart capacity',basis:'synthetic',methodId:'power-data-quality-interactive',methodVersion:'1.0.0',requestId:'pages-task'})
  const unregister=a.agent.ctx.on('user-questions/request',async request=>{
    const question=request.questions[0]
    if(question===undefined || question.options?.length!==2)throw new Error('Native source review question absent')
    return {answers:[{id:question.id,selected:[question.options[1]!.label]}]}
  })
  let opened:View
  try { opened=await reviewed<View>('task_open',{id:task.id,reason:'Explicit synthetic source review',requestId:'pages-open'}) }
  finally { unregister() }
  const custom=await reviewed<Chart>('chart_render',{spec:{schema:'deepscientist.report_chart.v1',kind:'bar',title:'User-owned chart',data:[{id:'user',label:'Keep this chart',value:42}]},requestId:'user-chart'})
  async function upload(name:string){return reviewed<{reference:string}>('attachment_put',{name,contentBase64:readFileSync(new URL('./fixtures/'+name,import.meta.url)).toString('base64'),requestId:name})}
  const file=await upload('power-quality-500.csv'),args={id:task.id,reference:file.reference,table:'measurements',expectedRecordRevision:opened.record.revision,requestId:'pages-500'}
  const full=await reviewed<View>('task_import_csv',args)
  expect(full.record.run.tables.measurements).toHaveLength(500)
  expect(full.record.run.values).toMatchObject({expected_total:50000,valid_total:45000,missing_rate:10})
  expect(full.record.calculation).toMatchObject({errors:[],pending:[]})
  expect(full.charts.map(chart=>chart.spec.data.length)).toEqual([200,200,100])
  expect(full.charts.flatMap(chart=>chart.spec.data)).toEqual(full.record.run.tables.measurements.map((row,i)=>({id:String(i),label:row.channel,value:row.missing_rate})))
  expect(full.charts.map(chart=>chart.interactionChartId)).toEqual(['missing-rate','missing-rate:page:2','missing-rate:page:3'])
  full.charts.forEach((chart,i)=>{expect(chart.title).toContain('第 '+(i+1)+'/3 页，共 500 项');expect(chart.spec.caption).toContain('未抽样或省略');expect(chart.svg).toContain('500')})
  expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(limits.maxReplyBytes)
  expect((await reviewed<View>('task_import_csv',args)).charts.map(chart=>chart.id)).toEqual(full.charts.map(chart=>chart.id))
  const refreshed=await reviewed<View>('task_import_csv',{...args,expectedRecordRevision:full.record.revision,requestId:'pages-500-refresh'})
  expect(refreshed.charts.map(chart=>chart.id)).toEqual(full.charts.map(chart=>chart.id))
  const smaller=await upload('power-quality-2.csv')
  const restored=await reviewed<View>('task_import_csv',{...args,reference:smaller.reference,expectedRecordRevision:refreshed.record.revision,requestId:'pages-2'})
  expect(restored.record.run.tables.measurements).toHaveLength(2)
  expect(restored.record.run.values).toMatchObject({expected_total:300,valid_total:270,missing_rate:10})
  expect(restored.charts).toHaveLength(1);expect(restored.charts[0]!.id).toBe(full.charts[0]!.id)
  expect(restored.charts[0]!.title).toBe('各测点缺失率（%）')
  const state=await a.api('state') as {artifacts:Chart[]}
  expect(state.artifacts.filter(chart=>chart.sourceRecordId===restored.record.id)).toHaveLength(1)
  expect(state.artifacts.find(chart=>chart.id===custom.id)).toEqual(custom)
  expect(observed).toEqual([500,500,2]);expect(managed.charges).toEqual({resident:0,active:0})
  console.info(JSON.stringify({evidence:'complete-chart-pagination-component',rows:500,pages:full.charts.map(chart=>chart.spec.data.length),replyBytes:Buffer.byteLength(JSON.stringify(full)),maxReplyBytes:limits.maxReplyBytes,commandTailBytes:4096,scientificTransport:'scripted'}))
})

it('runs an approved package through actual native confinement and managed subprocess ownership, copying file results before releasing each command',async()=>{
  const a=await fixture('research-managed')
  const {observations,charges,domainResult}=await managedFixture(a)
  const preparation=a.graph.ctx.tools.register({name:'fixture_prepare',description:'Test setup only',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},async execute(_args,exec){
      const stored=await a.graph.ctx.cloudResearch.reviewedCall('engine_package_put',{id:'managed-package',version:'1',title:'Managed transport fixture',kind:'protocol',
        files:{'protocol.aimd':'# Fixture\n{{var|x: int}}','protocol.toml':'[airalogy_protocol]\nid="fixture"\nversion="1"'},requestId:'prepare'},exec) as {sha256:string}
      return await a.graph.ctx.cloudResearch.reviewedCall('engine_package_review',{id:'managed-package',version:'1',sha256:stored.sha256,approved:true,reason:'Synthetic transport setup'},exec)
    }})
  try{expect((await a.tool('fixture_prepare')).isError).toBe(false)}finally{preparation()}
  const result=await a.tool('research_engine_run',{packageId:'managed-package',version:'1',action:'parse_protocol',params:{},requestId:'native-run'})
  expect(result,JSON.stringify(result)).toMatchObject({isError:false,value:{status:'succeeded',result:domainResult}})
  expect(observations).toEqual(['research_engine_run','research_engine_run'])
  expect(charges).toEqual({resident:0,active:0})
})

async function managedFixture(a:Awaited<ReturnType<typeof fixture>>,physical=false,probeScript?:string,maxSkillCopiesPerOperation?:number,reply?:(payload:Record<string,unknown>)=>unknown,maxTailBytes=32768){
  const {NativeCommandAccount}=await import('../../../packages/cloud/pe-opensandbox/src/native-command-account.ts')
  const {CloudSubprocessRuntime}=await import('../../../packages/cloud/pe-opensandbox/src/native-providers.ts')
  const {CloudSandboxProvider}=await import('../../../packages/cloud/pe-opensandbox/src/native-sandbox.ts')
  const {default:SandboxPolicy}=await import('@deepseek-ai/dsh-sandbox-policy')
  const {writeFile,readFile,unlink}=await import('node:fs/promises')
  const {createHash}=await import('node:crypto')
  const {onTestFinished}=await import('vitest')
  await a.graph.ctx.plugin(SandboxPolicy,{mode:'workspace-write',workspaceRoot:a.f.project})
  const observations:string[]=[],payloads:Record<string,unknown>[]=[],charges={resident:0,active:0},specs:OperationSpec[]=[]
  const empty={prepared:true,submitted:false,commitClosed:false,rangeEmpty:false,ioClosed:false,physicalStopRequired:false,providerFailure:false,direct:undefined,
    stdout:{bytes:Buffer.alloc(0),observedBytes:0,eof:false},stderr:{bytes:Buffer.alloc(0),observedBytes:0,eof:false}}
  const domainResult={success:true,data:{transportFixture:true,value:42}}
  const root={async acquire(scope: {consumerId:string}){
    observations.push(scope.consumerId)
    let stdout='',argv:readonly string[]=[]
    return {async prepare(spec:OperationSpec){argv=spec.argv;specs.push(spec);return empty},async commit(){
      if(physical){
        if(probeScript!==undefined&&argv[8]!==undefined)await writeFile(join(a.f.project,argv[6]!),probeScript)
        const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
        let code=0,err=''
        try{const result=await promisify(execFile)(argv[0]!,argv.slice(1),{cwd:a.f.project,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},maxBuffer:32768});stdout=result.stdout}
        catch(error){if(error===null||typeof error!=='object')throw error;const row=error as {code?:number;stderr?:string};code=typeof row.code==='number'?row.code:1;err=row.stderr||''}
        return {...empty,submitted:true,commitClosed:true,rangeEmpty:true,ioClosed:true,direct:{exitCode:code,signal:null},stdout:{bytes:Buffer.from(stdout),observedBytes:Buffer.byteLength(stdout),eof:true},stderr:{bytes:Buffer.from(err),observedBytes:Buffer.byteLength(err),eof:true}}
      }
      const output=argv[8]
      if(output!==undefined){
        const parts=[];for(let index=0;index<Number(argv[10]);index++)parts.push(Buffer.from(await readFile(join(a.f.project,argv[5]+'.'+index),'utf8'),'base64'));
        const payload:Record<string,unknown>=JSON.parse(Buffer.concat(parts).toString('utf8'));payloads.push(payload)
        const result=reply?reply(payload):payload.action==='workflow_assign'?{success:true,data:{outputs:{y:42}}}:domainResult
        const bytes=Buffer.from(JSON.stringify(result));await writeFile(join(a.f.project,output),bytes,{flag:'wx'});stdout=JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
      }
      else if(argv[3]?.includes('os.unlink')){await unlink(argv[4]!)}
      return {...empty,submitted:true,commitClosed:true,rangeEmpty:true,ioClosed:true,direct:{exitCode:0,signal:null},
        stdout:{bytes:Buffer.from(stdout),observedBytes:Buffer.byteLength(stdout),eof:true},stderr:{bytes:Buffer.alloc(0),observedBytes:0,eof:true}}
    },async poll(){throw new Error('Scripted range already empty')},async stop(){throw new Error('Scripted range already empty')}}
  },reserve(){charges.resident++;charges.active++;if(charges.resident>1)throw new Error('One resident command only')
    return {releaseActive(){charges.active--},releaseResident(){charges.resident--}}},unknown(){throw new Error('Unexpected unknown range')},async close(){}}
  const commands=new NativeCommandAccount(a.graph.ctx,a.graph.binding,{assertBusinessCurrent(){a.graph.api.sessionProject(a.agent.session)},
    getAgent:id=>a.graph.ctx.agents.get(id),projectForAgent:agent=>a.graph.guards.projectForAgent(agent),projectForSession:session=>a.graph.guards.projectForSession(session),
    assertRetainedExecutionOwner(){throw new Error('No background job in fixture')},files(){throw new Error('Only the external channel is scripted')}},
    {enforceSessionFilePolicy:true,...maxSkillCopiesPerOperation===undefined?{}:{maxSkillCopiesPerOperation},allowedTools:['fixture_git','research_engine_run','research_engine_status','research_document_status','skill',...reply?['research_workbench_execute']:[]],maxScopes:2,commandLimits:{maxArgvBytes:4096,maxArgvEntries:16,maxPathBytes:512,maxStdinBytes:4096,maxTailBytes,
      maxObservedBytes:65536,pollIntervalMs:1000,maxWaiters:2,maxLifetimeMs:10000,stopWaitMs:1000}},root)
  const sandbox=new CloudSandboxProvider(a.graph.ctx,commands.calls,{current(){return {enforcement:'partial',denialSignatures:[],runnerFailureRules:[]}}},{maxArgvBytes:4096,maxArgvEntries:16})
  new CloudSubprocessRuntime(a.graph.ctx,commands,sandbox)
  onTestFinished(async()=>{await commands.closeProvider();sandbox.close()})
  return {observations,payloads,charges,domainResult,specs}
}

it('retains a complete managed probe result after the source-style successful Python SystemExit',async()=>{
  const a=await fixture('research-probe'),managed=await managedFixture(a,true,'import sys,json\nprint(json.dumps({"available":True}))\nsys.exit(0)\n')
  const result=await a.tool('research_document_status')
  expect(result,JSON.stringify(result)).toMatchObject({isError:false,value:{available:true,execution:'managed-native'}})
  expect(managed.observations).toEqual(['research_document_status','research_document_status']);expect(managed.charges).toEqual({resident:0,active:0})
  const b=await fixture('research-probe-failed'),failed=await managedFixture(b,true,'import sys,json\nprint(json.dumps({"available":True}))\nsys.exit(7)\n')
  expect(await b.tool('research_document_status')).toMatchObject({isError:false,value:{available:false,execution:'managed-native'}})
  expect(failed.observations).toEqual(['research_document_status']);expect(failed.charges).toEqual({resident:0,active:0})
})

it('combines the shipped research collection selection with the original authenticated provider tail capacity',async()=>{
  const patch=loadOverlayPatches('research-tail-config',fileURLToPath(new URL('../cordis.cloud.patch.yml',import.meta.url)))
  const selected=patch.flatMap(row=>row.insert??[]).find(row=>row.id==='cloud-research')
  if(selected===undefined)throw new Error('Shipped Cloud research configuration absent')
  const config=Cloud.Config(selected.config),tail=SLICE_LIMITS.tailBytesPerStream
  expect(config.maxOutputBytes).toBe(tail)
  const probe="import json\nprint(json.dumps({'python':'3.13.1','airalogy':'0.16.0'}))\n"
  // The scientific version response is synthetic; the Loader, staged Python process and managed collection are real.
  const a=await fixture('research-deployed-tail',{maxOutputBytes:config.maxOutputBytes})
  const managed=await managedFixture(a,true,probe,undefined,undefined,tail)
  expect(await a.tool('research_engine_status')).toMatchObject({isError:false,value:{ready:true,execution:'managed-native'}})
  expect(managed.observations).toEqual(['research_engine_status','research_engine_status'])
  expect(managed.charges).toEqual({resident:0,active:0})

  const b=await fixture('research-oversized-tail',{maxOutputBytes:tail+1})
  const rejected=await managedFixture(b,true,probe,undefined,undefined,tail)
  expect(await b.tool('research_engine_status')).toMatchObject({isError:false,value:{ready:false,
    message:'Cloud command collection exceeds the authenticated channel tail capacity.'}})
  expect(rejected.observations).toEqual([])
  expect(rejected.charges).toEqual({resident:0,active:0})
})

it.each([2,8])('runs staged Python in a real long project under the complete guardian and %s-copy ceilings',async(copies)=>{
  const {readdir}=await import('node:fs/promises')
  const a=await fixture('research-frame-'+copies,{},'research-project-'+ 'p'.repeat(170))
  const deployedLength=('/srv/dsh-features-'+randomUUID()+'/accounts/v1-'+ 'a'.repeat(64)+'/projects/default-workspace').length
  expect(a.f.project.length).toBeGreaterThanOrEqual(deployedLength)
  let loader=''
  const fs=a.agent.ctx.get('fs')!,write=fs.writeText.bind(fs)
  vi.spyOn(fs,'writeText').mockImplementation((target,text,...args)=>{
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limits.fileChunkBytes)
    if(target.displayPath.endsWith('-bootstrap.py'))loader=text
    return write(target,text,...args)
  })
  const code="import json,os,pathlib\nroot=os.environ['EPRI_EXECUTION_ROOT']\nassert os.path.isabs(root) and os.path.isabs(__file__)\nassert os.path.dirname(root)==os.path.dirname(__file__)\npathlib.Path(root).mkdir()\nprint(json.dumps({'available':True}))\n"
  const managed=await managedFixture(a,true,code,copies)
  expect(await a.tool('research_document_status')).toMatchObject({isError:false,value:{available:true}})
  expect(managed.specs).toHaveLength(2)
  const policy={mode:'danger-full-access' as const},device='18446744073709551615'
  const world:SkillWorld={metadata:{device,inode:'1'},skills:{device,inode:'2'},maxCopies:copies,
    copies:Array.from({length:copies},(_,index)=>({version:randomUUID(),identity:{device,inode:String(index+3)}}))}
  for(const spec of managed.specs){
    expect(guardianEncodedBudget(a.f.project,spec,world,policy)).toBeLessThanOrEqual(4096)
    expect(guardianWorkingCopiesBudget(a.f.project,spec,copies,policy)).toBeLessThanOrEqual(4096)
  }
  const spec=managed.specs[0]!
  expect(spec.argv.slice(4,9).every(name=>/^\.research-[a-f0-9-]{36}(?:-bootstrap\.py|\.json|\.py|-work|\.result\.json)$/.test(name))).toBe(true)
  const previous:OperationSpec={...spec,argv:[...spec.argv.slice(0,4),'-c',loader,
    ...spec.argv.slice(5,9).map(name=>join(a.f.project,name)),...spec.argv.slice(9)]}
  expect(()=>guardianWorkingCopiesBudget(a.f.project,previous,copies,policy)).toThrow(expect.objectContaining({code:'guardian_config_budget'}))
  expect((await readdir(a.f.project)).filter(name=>name.startsWith('.research-'))).toEqual([])
  expect(managed.charges).toEqual({resident:0,active:0})
})

it('removes the staged loader, script, input parts and work directory after a real Python failure',async()=>{
  const {readdir}=await import('node:fs/promises')
  const a=await fixture('research-stage-failure'),managed=await managedFixture(a,true,
    "import os,pathlib\npathlib.Path(os.environ['EPRI_EXECUTION_ROOT']).mkdir()\nraise RuntimeError('Synthetic scientific failure')\n",8)
  expect(await a.tool('research_document_status')).toMatchObject({isError:false,value:{available:false,message:expect.stringContaining('Synthetic scientific failure')}})
  expect((await readdir(a.f.project)).filter(name=>name.startsWith('.research-'))).toEqual([])
  expect(managed.observations).toEqual(['research_document_status'])
  expect(managed.charges).toEqual({resident:0,active:0})
})

it('retains the uncollected result after cancellation and joins the original completed command without a cleanup bypass',async()=>{
  const {readdir}=await import('node:fs/promises')
  const a=await fixture('research-cancel-collection'),controller=new AbortController()
  const managed=await managedFixture(a,true,"import json\nprint(json.dumps({'available':True}))\n",8)
  const fs=a.agent.ctx.get('fs')!,read=fs.readByteRange.bind(fs)
  vi.spyOn(fs,'readByteRange').mockImplementation(async(...args)=>{
    const bytes=await read(...args);controller.abort(new Error('Synthetic collection cancellation'));return bytes
  })
  await a.tool('research_document_status',{},controller.signal)
  const retained=(await readdir(a.f.project)).filter(name=>name.startsWith('.research-'))
  expect(retained).toHaveLength(1);expect(retained[0]).toMatch(/^\.research-[a-f0-9-]{36}\.result\.json$/)
  expect(managed.observations).toEqual(['research_document_status'])
  expect(managed.charges).toEqual({resident:0,active:0})
})

it('stages a large input and collects a multibyte managed result through original 64 KiB FS calls without whole-file reads',async()=>{
  const a=await fixture('research-chunked',{maxDatabaseBytes:16777216,maxReplyBytes:8388608})
  const fs=a.agent.ctx.get('fs')!,write=fs.writeText.bind(fs),range=fs.readByteRange.bind(fs),writes:number[]=[],reads:number[]=[]
  let corrupt=false
  vi.spyOn(fs,'writeText').mockImplementation((target,text,...args)=>{
    writes.push(Buffer.byteLength(text));if(Buffer.byteLength(text)>65536)throw new Error('Native single write limit')
    if(corrupt&&target.displayPath.endsWith('.json.0')){corrupt=false;text='AAAA'+text.slice(4)}
    return write(target,text,...args)
  })
  vi.spyOn(fs,'readByteRange').mockImplementation((target,window,signal)=>{
    reads.push(window.length);if(window.length>65536)throw new Error('Native single reply limit');return range(target,window,signal)
  })
  const whole=vi.spyOn(fs,'readBytes').mockImplementation(()=>{throw new Error('Whole file read is not admitted')})
  const text='汉🙂'.repeat(300000)
  const managed=await managedFixture(a,true,"import json,sys,base64\np=json.load(sys.stdin)\nassert len(base64.b64decode(p['files']['notes.txt']))==700000\nprint(json.dumps({'success':True,'data':{'text':'汉🙂'*300000}},ensure_ascii=False))\n")
  const prepare=a.graph.ctx.tools.register({name:'fixture_prepare_large',description:'Synthetic large managed transport fixture',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},async execute(_args,exec){
      const stored=await a.graph.ctx.cloudResearch.reviewedCall('engine_package_put',{id:'large-input',version:'1',title:'Large input',kind:'protocol',
        files:{'protocol.aimd':'# Test\n{{var|x: int}}','protocol.toml':'[airalogy_protocol]\nid="fixture"\nversion="1"','notes.txt':'汉🙂'.repeat(100000)},requestId:'large-upload'},exec) as {sha256:string}
      return a.graph.ctx.cloudResearch.reviewedCall('engine_package_review',{id:'large-input',version:'1',sha256:stored.sha256,approved:true,reason:'Synthetic transfer fixture'},exec)
    }})
  try{expect((await a.tool('fixture_prepare_large')).isError).toBe(false)}finally{prepare()}
  const request={packageId:'large-input',version:'1',action:'parse_protocol',params:{},requestId:'large-execute'}
  const result=await a.tool('research_engine_run',request)
  expect(result.isError).toBe(false);expect(result.value).toMatchObject({status:'succeeded'})
  expect(JSON.stringify(result.value).includes(text)).toBe(true)
  expect(writes.length).toBeGreaterThan(14);expect(Math.max(...writes)).toBeLessThanOrEqual(65536)
  expect(reads.length).toBeGreaterThan(32);expect(Math.max(...reads)).toBeLessThanOrEqual(65536);expect(whole).not.toHaveBeenCalled()
  expect(managed.charges).toEqual({resident:0,active:0})
  corrupt=true
  expect((await a.tool('research_engine_run',{...request,requestId:'corrupted-execute'})).value).toMatchObject({status:'failed'})
  expect(managed.charges).toEqual({resident:0,active:0})
  const {readdir}=await import('node:fs/promises')
  expect((await readdir(a.f.project)).filter(name=>name.startsWith('.research-'))).toEqual([])
})

it('captures accepted native present bytes through bounded windows and preserves the original binary snapshot',async()=>{
  const a=await fixture('research-present'),{writeFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto')
  const bytes=Buffer.from(Array.from({length:300000},(_,index)=>index%251)),path=join(a.f.project,'presented.bin')
  await writeFile(path,bytes)
  const fs=a.agent.ctx.get('fs')!,read=fs.readByteRange.bind(fs)
  const whole=vi.spyOn(fs,'readBytes').mockImplementation(()=>{throw new Error('Whole file read is not admitted')})
  vi.spyOn(fs,'readByteRange').mockImplementation((target,range,signal)=>{
    if(range.length>65536)throw new Error('Native single reply limit');return read(target,range,signal)
  })
  const unregister=a.graph.ctx.tools.register({name:'present',description:'Accepted native presentation fixture',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:async()=>({files:[{path}]})})
  try{expect((await a.tool('present')).isError).toBe(false)}finally{unregister()}
  const reference='attachment:'+createHash('sha256').update(bytes).digest('hex')
  expect(await a.api('attachment_get',{reference})).toMatchObject({contentBase64:bytes.toString('base64')})
  expect(whole).not.toHaveBeenCalled()
})

it('bounds scientific transfer slots independently and releases the slot after actual staging and collection settle',async()=>{
  const a=await fixture('research-transfer-slots',{maxConcurrentFileTransfers:1})
  await managedFixture(a,true,'import json\nprint(json.dumps({"available":True}))\n')
  const fs=a.agent.ctx.get('fs')!,write=fs.writeText.bind(fs),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  let held=true
  vi.spyOn(fs,'writeText').mockImplementation(async(...args)=>{
    if(held){held=false;entered.resolve();await release.promise}return write(...args)
  })
  const first=a.tool('research_document_status')
  await entered.promise
  try{expect(await a.tool('research_document_status')).toMatchObject({isError:false,value:{available:false,message:expect.stringContaining('并发容量')}})}
  finally{release.resolve()}
  expect(await first).toMatchObject({isError:false,value:{available:true}})
  expect(await a.tool('research_document_status')).toMatchObject({isError:false,value:{available:true}})
})

it('keeps workflow transitions in the preserved engine while its assigner uses the same real native tool scope',async()=>{
  const a=await fixture('research-workflow'),managed=await managedFixture(a)
  const files={
    'workflow.aimd':'version: airalogy.workflow.v1\nid: native_flow\nnodes:\n  - id: input\n    protocol_id: input_protocol\n  - id: result\n    protocol_id: result_protocol\nassigners:\n  - id: double\n    runtime: python\n    entrypoint: calculate.py:assign\ntransitions:\n  - id: calculate\n    from: [input]\n    to: [result]\n    run: double\n    inputs:\n      x: ${input.var.x}\n    assign:\n      result:\n        var.y: ${calculate.outputs.y}\n',
    'calculate.py':'def assign(x):\n    return {"y": x * 2}\n',
  }
  const prepare=a.graph.ctx.tools.register({name:'fixture_prepare_flow',description:'Synthetic approved workflow setup',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},async execute(_args,exec){
      const stored=await a.graph.ctx.cloudResearch.reviewedCall('engine_package_put',{id:'native-flow',version:'1',title:'Native workflow',kind:'workflow',files,requestId:'flow-upload'},exec) as {sha256:string}
      return a.graph.ctx.cloudResearch.reviewedCall('engine_package_review',{id:'native-flow',version:'1',sha256:stored.sha256,approved:true,reason:'Synthetic workflow transport fixture'},exec)
    }})
  try{expect((await a.tool('fixture_prepare_flow')).isError).toBe(false)}finally{prepare()}
  const run=await a.tool('research_engine_run',{packageId:'native-flow',version:'1',action:'workflow',params:{records:{input:{var:{x:21}}}},requestId:'native-flow-run'})
  expect(run,JSON.stringify(run)).toMatchObject({isError:false,value:{status:'succeeded',result:{data:{records:{result:{data:{var:{y:42}}}},executed_transitions:[{id:'calculate'}]}}}})
  expect(managed.payloads).toMatchObject([{action:'workflow_assign',params:{entrypoint:'calculate.py:assign',inputs:{x:21}}}])
  expect(managed.observations).toEqual(['research_engine_run','research_engine_run']);expect(managed.charges).toEqual({resident:0,active:0})
})


it('keeps resource previews inert, copies real nested resources in the original skill scope, preserves edits and refuses cross-account links',async()=>{
  const a=await fixture('research-resources-a'),b=await fixture('research-resources-b')
  const ca=await managedFixture(a,true),cb=await managedFixture(b,true)
  for(const f of [a,b]){
    const preview=await f.graph.ctx.get('skills')!.get('research-protocol',{scope:f.agent})
    expect(preview?.resourceBase?.kind).toBe('opaque')
  }
  expect(ca.observations).toEqual([]);expect(cb.observations).toEqual([])
  const ar=await a.tool('skill',{name:'research-protocol'}),br=await b.tool('skill',{name:'research-protocol'})
  expect(ar,JSON.stringify(ar)).toMatchObject({isError:false,value:{resourceBase:{kind:'directory'}}})
  expect(br,JSON.stringify(br)).toMatchObject({isError:false,value:{resourceBase:{kind:'directory'}}})
  const parse=(value:unknown)=>{
    if(value===null||typeof value!=='object'||!('resourceBase' in value))throw new Error('Native skill resource guidance absent')
    const base=value.resourceBase;if(base===null||typeof base!=='object'||!('path' in base)||typeof base.path!=='string')throw new Error('Native resource path absent');return base.path
  }
  const pa=parse(ar.value),pb=parse(br.value)
  expect(pa.startsWith(a.f.project+'/')).toBe(true);expect(pb.startsWith(b.f.project+'/')).toBe(true);expect(pa).not.toBe(pb)
  const fs=a.agent.ctx.get('fs')!,target=await fs.resolve(pa+'references/aimd-authoring.md',{cwd:a.f.project})
  expect(await fs.readText(target)).toContain('AIMD')
  const {writeFile,readFile,rm,symlink}=await import('node:fs/promises')
  await writeFile(pa+'references/aimd-authoring.md','User retained edit')
  expect((await a.tool('skill',{name:'research-protocol'})).isError).toBe(false)
  expect(await readFile(pa+'references/aimd-authoring.md','utf8')).toBe('User retained edit')
  const before=await readFile(pb+'references/aimd-authoring.md')
  await rm(pa+'references',{recursive:true});await symlink(pb+'references',pa+'references')
  expect((await a.tool('skill',{name:'research-protocol'})).isError).toBe(true)
  expect(await readFile(pb+'references/aimd-authoring.md')).toEqual(before)
  expect(ca.observations.every(name=>name==='skill')).toBe(true)
  expect(ca.charges).toEqual({resident:0,active:0});expect(cb.charges).toEqual({resident:0,active:0})
})


it('invalidates the original skill registry immediately after account-local publication, edit and withdrawal',async()=>{
  const a=await fixture('research-published-a'),b=await fixture('research-published-b')
  const list=(f:typeof a)=>f.graph.ctx.get('skills')!.list({scope:f.agent})
  expect((await list(a)).some(skill=>skill.name.startsWith('lab-'))).toBe(false)
  const unregister=a.graph.ctx.tools.register({name:'fixture_publish',description:'Explicit synthetic review setup',parameters:{type:'object',properties:{edit:{type:'boolean'}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},
    async execute(args,exec){
      const call=(op:string,input:Record<string,unknown>)=>a.graph.ctx.cloudResearch.reviewedCall(op,{requestId:randomUUID(),...input},exec)
      if(args && typeof args==='object' && 'edit' in args && args.edit)return call('lab_skill_put',{id:'lab',expectedRevision:2,title:'Updated lab',markdown:'Updated private procedure',evidenceIds:['source']})
      await call('evidence_put',{id:'source',expectedRevision:0,title:'Synthetic source',observation:'Software-only fixture',basis:'synthetic',source:{kind:'citation',url:'https://example.test/source',excerpt:'Synthetic fixture excerpt'}})
      await call('evidence_review',{id:'source',expectedRevision:1,result:'accepted',reason:'Explicit synthetic test review'})
      await call('lab_skill_put',{id:'lab',expectedRevision:0,title:'Private lab',markdown:'Private account procedure',evidenceIds:['source']})
      return call('lab_skill_publish',{id:'lab',expectedRevision:1,published:true,reason:'Explicit synthetic publication'})
    }})
  try{
    expect((await a.tool('fixture_publish')).isError).toBe(false)
    expect((await list(a)).filter(skill=>skill.name.startsWith('lab-'))).toHaveLength(1)
    expect((await list(b)).some(skill=>skill.name.startsWith('lab-'))).toBe(false)
    expect((await a.tool('fixture_publish',{edit:true})).isError).toBe(false)
    expect((await list(a)).some(skill=>skill.name.startsWith('lab-'))).toBe(false)
  }finally{unregister()}
})


it('reads the existing research Store after native graph restart through cold native history without creating another Agent',async()=>{
  const a=await fixture('research-cold')
  expect((await a.tool('research_protocol_put',{id:'cold-protocol',version:'1',content:'# Cold\n{{var|x: int}}',requestId:'cold-write'})).isError).toBe(false)
  const id=a.agent.id
  await a.graph.ctx.sessionPersistence.flush()
  await a.graph.close()
  const next=await a.f.start('2')
  expect(next.ctx.sessions.get(id)).toBeUndefined();expect(next.ctx.agents.get(id)).toBeUndefined()
  const result=await next.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',args:{request:{sessionId:id,op:'state',args:{}}},peer:next.localePeer})
  expect(result).toMatchObject({protocols:[{id:'cold-protocol'}]})
  expect(next.ctx.sessions.get(id)).toBeUndefined();expect(next.ctx.agents.get(id)).toBeUndefined()
})


it('runs the original Git writes and full patches through staged managed Python without changing preview tokens',async()=>{
  const {writeFile,readdir}=await import('node:fs/promises')
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
  const a=await fixture('research-real-git',{maxOutputBytes:4096},'research-git-'+ 'g'.repeat(170))
  const hostGit=(...args:string[])=>promisify(execFile)('/usr/bin/git',args,{cwd:a.f.project})
  await hostGit('init','-b','main');await writeFile(join(a.f.project,'seed.txt'),'seed\n')
  await hostGit('add','seed.txt');await hostGit('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','seed')
  const managed=await managedFixture(a,true,undefined,8,undefined,4096)
  let request:{op:string;args:Record<string,unknown>}={op:'project_git_bind',args:{path:a.f.project}}
  const release=a.graph.ctx.tools.register({name:'fixture_git',description:'Exact reviewed Git fixture',parameters:{type:'object',additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:(_args,exec)=>a.graph.ctx.cloudResearch.reviewedCall(request.op,request.args,exec)})
  async function call<T extends object>(op:string,args:Record<string,unknown>={}):Promise<T>{
    request={op,args};const result=await a.tool('fixture_git');expect(result,JSON.stringify(result)).toMatchObject({isError:false});return result.value as T
  }
  type Working={token:string;head:string;changes:{path:string}[]}
  try{
    expect(await call('project_git_bind',{path:a.f.project})).toMatchObject({bound:true})
    const fs=a.agent.ctx.get('fs')!,read=fs.readByteRange.bind(fs)
    let reached!:()=>void,releaseRead!:()=>void
    const entered=new Promise<void>(resolve=>{reached=resolve}),resume=new Promise<void>(resolve=>{releaseRead=resolve})
    const paused=vi.spyOn(fs,'readByteRange').mockImplementationOnce(async(...args)=>{reached();await resume;return read(...args)})
    request={op:'project_git_working',args:{}}
    const pending=a.tool('fixture_git');await entered
    try{expect(await a.tool('fixture_git')).toMatchObject({isError:true,error:{message:expect.stringContaining('Git 传输尚未结束')}})}finally{releaseRead()}
    expect(await pending).toMatchObject({isError:false});paused.mockRestore()
    const first=await call<Working>('project_git_working'),again=await call<Working>('project_git_working')
    expect(again.token).toBe(first.token);expect(first.changes).toEqual([])
    // User files with a similar prefix remain visible; only this invocation's exact staging names are removed.
    await writeFile(join(a.f.project,'.research-user-notes'),'real user data')
    const files=['.research-user-notes',...Array.from({length:12},(_,i)=>'selected-'+i+'.txt')]
    for(const file of files.slice(1))await writeFile(join(a.f.project,file),'synthetic patch '+file+'\n'.repeat(50))
    const changed=await call<Working>('project_git_working')
    expect(changed.changes.map(row=>row.path).sort()).toEqual([...files].sort())
    expect((await call<Working>('project_git_working')).token).toBe(changed.token)
    const args={files,message:'长消息'.repeat(160),expectedToken:changed.token,requestId:'checkpoint-exact'}
    const saved=await call<{sha:string}>('project_git_checkpoint',args)
    expect(await call('project_git_checkpoint',args)).toEqual(saved)
    const patch=await call<{patch:string;message:string}>('project_git_commit',{sha:saved.sha})
    expect(Buffer.byteLength(patch.patch)).toBeGreaterThan(4096);expect(patch.message).toContain(args.message)
    const clean=await call<Working>('project_git_working');expect(clean.changes).toEqual([])
    const branch=await call<{id:string;path:string}>('project_git_branch',{name:'transport',expectedToken:clean.token,requestId:'branch-exact'})
    expect(branch.path).toContain('/.git/research-worktrees/')
    await writeFile(join(branch.path,'branch.txt'),'managed branch change\n')
    const branchWork=await call<Working>('project_git_working',{worktreeId:branch.id})
    const branchCommit=await call<{sha:string}>('project_git_checkpoint',{worktreeId:branch.id,files:['branch.txt'],message:'branch checkpoint',expectedToken:branchWork.token,requestId:'branch-save'})
    const beforeMerge=await call<Working>('project_git_working')
    const merged=await call<{sha:string}>('project_git_merge',{worktreeId:branch.id,sourceSha:branchCommit.sha,expectedToken:beforeMerge.token,requestId:'merge-exact'})
    const beforeRevert=await call<Working>('project_git_working')
    await call('project_git_revert',{sha:merged.sha,mainline:1,expectedToken:beforeRevert.token,requestId:'revert-exact'})
    expect((await hostGit('show','HEAD:seed.txt')).stdout).toBe('seed\n')
    await expect(hostGit('show','HEAD:branch.txt')).rejects.toBeDefined()
    expect((await readdir(a.f.project)).filter(name=>name.startsWith('.research-'))).toEqual(['.research-user-notes'])
    const policy={mode:'danger-full-access' as const},device='18446744073709551615'
    const world:SkillWorld={metadata:{device,inode:'1'},skills:{device,inode:'2'},maxCopies:8,copies:Array.from({length:8},(_,i)=>({version:randomUUID(),identity:{device,inode:String(i+3)}}))}
    for(const spec of managed.specs){expect(spec.argv.length).toBeLessThanOrEqual(14);expect(guardianEncodedBudget(a.f.project,spec,world,policy)).toBeLessThanOrEqual(4096);expect(guardianWorkingCopiesBudget(a.f.project,spec,8,policy)).toBeLessThanOrEqual(4096)}
    await call('project_git_bind',{path:branch.path})
    const linked=await call<Working>('project_git_working')
    const nested=await call<{path:string}>('project_git_branch',{name:'linked-transport',expectedToken:linked.token,requestId:'linked-branch'})
    expect(nested.path).toContain(join(a.f.project,'.git','research-worktrees'))
    // An associated repository may be inside the project, but outside common metadata cannot receive a managed worktree.
    const outside=join(a.f.project,'..','external-git-metadata'),sub=join(a.f.project,'external-metadata-repo')
    await hostGit('init','-b','main','--separate-git-dir='+outside,sub)
    await writeFile(join(sub,'seed.txt'),'external metadata fixture')
    await hostGit('-C',sub,'add','seed.txt');await hostGit('-C',sub,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','seed')
    await call('project_git_bind',{path:sub})
    const external=await call<Working>('project_git_working')
    request={op:'project_git_branch',args:{name:'refused',expectedToken:external.token,requestId:'external-refused'}}
    expect(await a.tool('fixture_git')).toMatchObject({isError:true,error:{message:expect.stringContaining('当前原生会话项目')}})
    expect(managed.charges).toEqual({resident:0,active:0})
  }finally{release()}
},45000)
