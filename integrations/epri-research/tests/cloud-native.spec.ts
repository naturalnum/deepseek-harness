/** Real Loader/native Session/Gateway and independent account Stores; no deployment or external computation is certified. */
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {expect,it,vi} from 'vitest'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ResearchSkills from '../plugins/deepscientist/index.mjs'
import {policyFixture} from '../../../packages/cloud/pe-cloud-runtime/tests/account-policy-fixture.ts'
import * as Cloud from '../plugins/cloud/index.ts'
import * as Airalogy from '../plugins/airalogy/index.mjs'

const limits={maxDatabaseBytes:1048576,maxRequestBytes:1048576,maxReplyBytes:1048576,maxPendingRequests:2,
  maxConcurrentResourcePreparations:1,maxSkillProviders:64,maxSkillFiles:1024,maxSkillBytes:33554432,maxSkillFileBytes:4194304,maxSkillPathBytes:256,executionTimeoutMs:10000,expectedPythonVersion:'3.13',expectedAiralogyVersion:'0.16.0',maxPayloadBytes:1048576,maxOutputBytes:32768,graceMs:1000,gitPath:'/usr/bin/git',pythonPath:'/usr/bin/python3'}
const endpoint={endpoint:'cloudResearch/action',handlerId:'native:cloudResearch',guard:'account-session' as const}
async function fixture(accountId:string) {
  const options={defaultId:'research-suite',declarations:[{entryId:'research-preset',selectable:true,config:{id:'research-suite',plugins:[
    {id:'persona',name:'cordis:m8z-persona',config:{prefix:'Research fixture.',complete:true,includeRuntimeContext:false}},
    {id:'research-tools',name:'deepscientist-harness-suite/airalogy'},
    {id:'research-skills',name:'deepscientist-harness-suite/research'},
    {id:'tool-skill',name:'@deepseek-ai/dsh-tool-skill'},
  ]}}],sourceModules:{'@deepseek-ai/dsh-skill':SkillRegistry,'@deepseek-ai/dsh-tool-skill':ToolSkill,'deepscientist-harness-suite/research':ResearchSkills,'deepscientist-harness-suite/cloud':Cloud,'deepscientist-harness-suite/airalogy':Airalogy},
  extraEntries:[{id:'skills',name:'@deepseek-ai/dsh-skill'},{id:'cloud-research',name:'deepscientist-harness-suite/cloud',config:limits}],
  researchStorage(binding:Cloud.CloudResearch['binding'],privateRoot:string){
    return {binding,directory:join(privateRoot,'research-suite'),assertCurrent(){binding.lifetime.throwIfAborted()}}
  }}
  const f=policyFixture([endpoint],undefined,accountId,{selected:[]},undefined,undefined,undefined,undefined,[],false,undefined,options)
  const graph=await f.start()
  await graph.api.auditPrepared(graph.ctx)
  const {sessionId}=await graph.ctx.sessionController.create({})
  const agent=graph.ctx.agents.get(sessionId)
  if(agent===undefined)throw new Error('Original Agent absent')
  const api=(op:string,args:Record<string,unknown>={},execute=false)=>graph.ctx.typertGateway.invoke({namespace:'cloudResearch',method:'action',
    args:{request:{sessionId,op,args,execute}},peer:graph.localePeer})
  const tool=async(name:string,args:Record<string,unknown>={})=>graph.ctx.tools.execute({callId:ToolCallId(randomUUID()),name,arguments:args,agent,signal:new AbortController().signal})
  return {f,graph,agent,api,tool}
}

it('keeps actual account Stores and native Session access independent and refuses foreign/native-less invocations',async()=>{
  const a=await fixture('research-a'),b=await fixture('research-b')
  expect(await a.api('state')).toMatchObject({records:[],protocols:[],artifacts:[]})
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

async function managedFixture(a:Awaited<ReturnType<typeof fixture>>,physical=false){
  const {NativeCommandAccount}=await import('../../../packages/cloud/pe-opensandbox/src/native-command-account.ts')
  const {CloudSubprocessRuntime}=await import('../../../packages/cloud/pe-opensandbox/src/native-providers.ts')
  const {CloudSandboxProvider}=await import('../../../packages/cloud/pe-opensandbox/src/native-sandbox.ts')
  const {default:SandboxPolicy}=await import('@deepseek-ai/dsh-sandbox-policy')
  const {writeFile,unlink}=await import('node:fs/promises')
  const {createHash}=await import('node:crypto')
  const {onTestFinished}=await import('vitest')
  await a.graph.ctx.plugin(SandboxPolicy,{mode:'workspace-write',workspaceRoot:a.f.project})
  const observations:string[]=[],charges={resident:0,active:0}
  const empty={prepared:true,submitted:false,commitClosed:false,rangeEmpty:false,ioClosed:false,physicalStopRequired:false,providerFailure:false,direct:undefined,
    stdout:{bytes:Buffer.alloc(0),observedBytes:0,eof:false},stderr:{bytes:Buffer.alloc(0),observedBytes:0,eof:false}}
  const domainResult={success:true,data:{transportFixture:true,value:42}}
  const root={async acquire(scope: {consumerId:string}){
    observations.push(scope.consumerId)
    let stdout='',argv:readonly string[]=[]
    return {async prepare(spec:{argv:readonly string[]}){argv=spec.argv;return empty},async commit(){
      if(physical){
        const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
        let code=0,err=''
        try{const result=await promisify(execFile)(argv[0]!,argv.slice(1),{cwd:a.f.project,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},maxBuffer:32768});stdout=result.stdout}
        catch(error){if(error===null||typeof error!=='object')throw error;const row=error as {code?:number;stderr?:string};code=typeof row.code==='number'?row.code:1;err=row.stderr||''}
        return {...empty,submitted:true,commitClosed:true,rangeEmpty:true,ioClosed:true,direct:{exitCode:code,signal:null},stdout:{bytes:Buffer.from(stdout),observedBytes:Buffer.byteLength(stdout),eof:true},stderr:{bytes:Buffer.from(err),observedBytes:Buffer.byteLength(err),eof:true}}
      }
      const output=argv[9]
      if(output!==undefined){const bytes=Buffer.from(JSON.stringify(domainResult));await writeFile(output,bytes,{flag:'wx'});stdout=JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
      else if(argv[3]?.includes('os.unlink')){await unlink(argv[4]!)}
      return {...empty,submitted:true,commitClosed:true,rangeEmpty:true,ioClosed:true,direct:{exitCode:0,signal:null},
        stdout:{bytes:Buffer.from(stdout),observedBytes:Buffer.byteLength(stdout),eof:true},stderr:{bytes:Buffer.alloc(0),observedBytes:0,eof:true}}
    },async poll(){throw new Error('Scripted range already empty')},async stop(){throw new Error('Scripted range already empty')}}
  },reserve(){charges.resident++;charges.active++;if(charges.resident>1)throw new Error('One resident command only')
    return {releaseActive(){charges.active--},releaseResident(){charges.resident--}}},unknown(){throw new Error('Unexpected unknown range')},async close(){}}
  const commands=new NativeCommandAccount(a.graph.ctx,a.graph.binding,{assertBusinessCurrent(){a.graph.api.sessionProject(a.agent.session)},
    getAgent:id=>a.graph.ctx.agents.get(id),projectForAgent:agent=>a.graph.guards.projectForAgent(agent),projectForSession:session=>a.graph.guards.projectForSession(session),
    assertRetainedExecutionOwner(){throw new Error('No background job in fixture')},files(){throw new Error('Only the external channel is scripted')}},
    {enforceSessionFilePolicy:true,allowedTools:['research_engine_run','skill'],maxScopes:2,commandLimits:{maxArgvBytes:4096,maxArgvEntries:16,maxPathBytes:512,maxStdinBytes:4096,maxTailBytes:32768,
      maxObservedBytes:65536,pollIntervalMs:1000,maxWaiters:2,maxLifetimeMs:10000,stopWaitMs:1000}},root)
  const sandbox=new CloudSandboxProvider(a.graph.ctx,commands.calls,{current(){return {enforcement:'partial',denialSignatures:[],runnerFailureRules:[]}}},{maxArgvBytes:4096,maxArgvEntries:16})
  new CloudSubprocessRuntime(a.graph.ctx,commands,sandbox)
  onTestFinished(async()=>{await commands.closeProvider();sandbox.close()})
  return {observations,charges,domainResult}
}


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
