/** Account-scoped scientific suite using the original native Session, login Peer and execution services. */
import { Context, symbols } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolRunContext, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { CloudApiError, CloudAccountApi, type ExposureInventory } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { openStore } from '../../src/server/service.mjs'
import { openAccountDatabase } from '../../src/server/account-database.mjs'
import { validateArgs, contracts } from '../../src/server/contracts.mjs'
import { searchLiterature } from '../../src/reused/literature/literatureSearch.ts'
import { materializeResearchSkill } from './resources.mjs'
import { createNativeResearchRuntime } from './native-runner.mjs'

/** Independent Cloud entry identity. */
export const name = 'research-suite/cloud'
/** Original native providers required before account activation. */
export const inject = ['peCloudApi', 'peCloudFiles', 'typertGateway', 'sessions', 'tools', 'sessionController', 'sessionProjections', 'agents']
/** Explicit finite account Store, transport and immutable-resource limits. */
export interface Config {
  readonly maxDatabaseBytes: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxPendingRequests: number
  readonly executionTimeoutMs: number
  readonly maxPayloadBytes: number
  readonly maxOutputBytes: number
  readonly graceMs: number
  readonly maxConcurrentResourcePreparations: number
  readonly maxSkillProviders: number
  readonly maxSkillFiles: number
  readonly maxSkillBytes: number
  readonly maxSkillFileBytes: number
  readonly maxSkillPathBytes: number
  readonly expectedPythonVersion: string
  readonly expectedAiralogyVersion: string
  readonly gitPath: string
  readonly pythonPath: string
}
/** Resolve complete Cloud configuration without enabling an external computation backend. */
export const Config: schema<Config> = schema.object({
  maxDatabaseBytes: schema.number().step(1).min(65536).max(Number.MAX_SAFE_INTEGER).required(),
  maxRequestBytes: schema.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).required(), maxReplyBytes: schema.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).required(),
  maxPendingRequests: schema.number().step(1).min(1).max(16).required(),
  executionTimeoutMs: schema.number().step(1).min(1000).max(300000).required(),
  maxPayloadBytes: schema.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).required(), maxOutputBytes: schema.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).required(),
  maxConcurrentResourcePreparations:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSkillProviders:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSkillFiles:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSkillBytes:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSkillFileBytes:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSkillPathBytes:schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  expectedPythonVersion:schema.string().pattern(/^\d+\.\d+$/u).required(),
  expectedAiralogyVersion:schema.string().pattern(/^\d+\.\d+\.\d+$/u).required(),
  graceMs: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(), gitPath:schema.string().pattern(/^\/[\w/.-]+$/u).required(), pythonPath: schema.string().pattern(/^\/[\w/.-]+$/u).required(),
})
interface ResearchRequest { readonly sessionId: string; readonly op: string; readonly args: Record<string, unknown>; readonly execute?:boolean }
interface Pending {
  readonly request: ResearchRequest
  readonly inputSha256: string
  readonly check: () => void
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: unknown) => void
  readonly signal: AbortSignal
  running: boolean
}
const reads = new Set(['state','protocol_get','record_get','record_export','workspace_export','attachment_get','local_search',
  'engine_status','engine_packages','engine_package_get','engine_runs','engine_run_get','engine_cancel','document_status','document_text',
  'science_state','science_export','lab_skills','task_get','tasks','method_catalog','method_get','history_list'])
function fail(message: string): never { throw new CloudApiError('cloud/account-unavailable',message) }
function original(value: object): object { const raw: unknown = Reflect.get(value,symbols.original); return raw !== null && typeof raw === 'object' ? raw : value }

declare module '@deepseek-ai/cordis' { interface Context { cloudResearch: CloudResearch } }

/** Independent business Store; authentication, files, native execution and graph drain retain their original owners. */
export class CloudResearch extends TypertRemoteService {
  /** Exact original account generation; serialized identities grant no access. */
  readonly binding
  /** Native research tool deadline selected by the deployment. */
  readonly toolTimeoutMs: number
  private readonly store
  private readonly runtime
  private readonly pending = new Map<string,Pending>()
  private readonly actual = new Set<Promise<unknown>>()
  private readonly skillListeners = new Set<()=>void>()
  private resourcePreparations = 0
  private closed = false
  private readonly operationGuard = new AsyncLocalStorage<()=>void>()
  /**
   * @param ctx Actual native Loader entry, within the account graph.
   * @param config Complete explicit deployment limits.
   * @param api Same graph's original API owner.
   * @param files Same graph's verified private storage and native files owner.
   */
  constructor(ctx: Context, private readonly config: Config, private readonly api: CloudAccountApi, files: CloudAccountFiles) {
    api.assertInstalled(ctx); files.assertInstalled(ctx)
    if (files.binding !== api.binding) fail('科研存储不属于当前账号。')
    const storage = files.researchStorage(ctx)
    super(ctx,'cloudResearch',{namespace:'cloudResearch'})
    this.binding = api.binding; this.toolTimeoutMs=config.executionTimeoutMs
    this.runtime = createNativeResearchRuntime(config,(exec: ToolExecution) => { this.assertToolCurrent(exec) },
      (exec: ToolExecution)=>this.api.sessionProject(exec.agent!.session).path)
    this.store = openStore(storage.directory,{openDatabase:(path: string)=>openAccountDatabase(path,{maxDatabaseBytes:config.maxDatabaseBytes,
      assertCurrent:()=>{ api.assertInstalled(ctx);storage.assertCurrent();this.operationGuard.getStore()?.() }}),engine:{...this.runtime.engine,finalize:(write:()=>unknown)=>this.operationGuard.run(()=>{},write)},documents:this.runtime.documents,
      git: this.runtime.git, literatureSearch:(options:Parameters<typeof searchLiterature>[0])=>searchLiterature({...options,transport:this.runtime.fetch}) })
    api.registerCapabilityInventory('cloudResearch',()=>this.inspect())
    ctx.on('tools/execute',(exec,next)=>{
      if(exec.name!=='skill'||!exec.agent||ctx.get('sessionProjections')!.stateOf(exec.agent.session,'agentPreset')!=='research-suite')return next()
      return this.runtime.withExecution(exec,next)
    })
    ctx.tools.register({ name:'research_workbench_execute', description:'Execute one exact current-session workbench request submitted by the authenticated user. The stored request supplies its operation and arguments; never invent a request ID. Report the actual result and any failure.',
      parameters:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false},
      timeoutMs:config.executionTimeoutMs,
      output:{schema:{type:'object',additionalProperties:true},render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value)}]},
      execute:async(args:unknown,exec:ToolRunContext)=>{
        const {requestId}=z.object({requestId:z.string().uuid()}).strict().parse(args),item=this.pending.get(requestId)
        if(item===undefined || item.running || item.request.sessionId!==exec.agent?.session.id)fail('科研请求不存在、已执行或不属于当前对话。')
        this.assertToolCurrent(exec);item.check();item.signal.throwIfAborted();item.running=true
        const signal=AbortSignal.any([exec.signal,item.signal])
        const owned={...exec,signal}
        try {
          const result=await this.perform(item.request.op,item.request.args,owned,'human',item.check)
          item.check();item.resolve(result);return {requestId,operation:item.request.op,inputSha256:item.inputSha256,result}
        } catch(error) { item.reject(error);throw error }
      },
    })
    ctx.effect(()=>async()=>{
      this.closed=true
      for(const item of this.pending.values())item.reject(new Error('科研账号作用域已关闭；未确认的请求没有成功回执。'))
      this.runtime.close()
      await Promise.allSettled(this.actual)
      await this.store.close()
      api.invalidate()
    },'research-suite: join account store and actual scientific execution')
  }
  /** Check the real installed account provider and native business admission. */
  assertCurrent(): void {
    this.api.assertInstalled(this.ctx)
    if(this.closed || this.binding.lifetime.aborted || original(this.ctx.get('cloudResearch') ?? {})!==original(this))fail('科研账号服务不可用。')
  }
  private session(id: string): Session {
    this.assertCurrent()
    const session=this.ctx.get('sessions')!.get(SessionId(id))
    if(session===undefined)fail('请先打开当前账号中的原生科研对话。')
    this.api.sessionProject(session)
    if(this.ctx.get('sessionProjections')!.stateOf(session,'agentPreset')!=='research-suite')fail('科研工作台仅在科研模式中使用。')
    return session
  }
  private async verifySession(id:string,signal:AbortSignal):Promise<void> {
    if(this.ctx.get('sessions')!.get(SessionId(id))!==undefined){this.session(id);return}
    // The original cold follow validates membership/header/Preset and promotes only after its snapshot yield.
    this.api.requireStream('session/follow')
    const source=this.ctx.get('sessionController')!.follow({address:{kind:'session',sessionId:SessionId(id)},maxMessages:1},signal)[Symbol.asyncIterator]()
    try {
      const first=await source.next()
      if(first.done||first.value.type!=='snapshot'||first.value.header.id!==id)fail('原生科研对话不可读取。')
      const preset=first.value.projections.values.agentPreset ?? first.value.header.agentPreset
      if(preset!=='research-suite')fail('科研工作台仅在科研模式中使用。')
    } finally {await source.return?.()}
  }
  private assertToolCurrent(exec:ToolExecution): void {
    this.assertCurrent()
    const agent=exec.agent
    if(agent===undefined || agent.ctx.root!==this.ctx.root || agent.ctx.get('peAccount')!==this.binding
      || this.ctx.get('agents')?.get(agent.id)!==agent)fail('科研计算需要当前账号真实的原生工具调用。')
    if(this.session(agent.session.id)!==agent.session)fail('科研工具的对话已失效。')
    exec.signal.throwIfAborted()
  }
  private track<T>(work:Promise<T>):Promise<T> {
    this.actual.add(work)
    void work.finally(()=>{this.actual.delete(work)}).catch((_error:unknown)=>{ /* Original native caller retains the result. */ })
    return work
  }
  private perform(op:string,args:Record<string,unknown>,exec:ToolRunContext,actor:'human'|'agent',requestCurrent?:()=>void):Promise<unknown> {
    this.assertToolCurrent(exec)
    return this.track(this.operationGuard.run(()=>{this.assertToolCurrent(exec);requestCurrent?.()},()=>this.runtime.withExecution(exec,async()=>{
      const result=await this.store.execute(op,validateArgs(op,args),actor,exec.signal,exec.agent?.session.id)
      if(op==='engine_run' && result!==null && typeof result==='object' && 'status' in result && result.status==='running') {
        const {id}=z.object({id:z.string()}).passthrough().parse(result)
        const run=await this.store.waitForRun(id,exec.agent!.session.id)
        this.assertToolCurrent(exec)
        return run
      }
      this.assertToolCurrent(exec)
      if(['lab_skill_put','lab_skill_publish','workspace_import'].includes(op))for(const invalidate of this.skillListeners)invalidate()
      return result
    })))
  }
  /** Dispatch an original native research tool.
   * @param op Exact domain operation. @param args Validated operation input. @param exec Actual native invocation.
   * @returns Original domain result after actual scientific settlement. */
  agentCall(op:string,args:Record<string,unknown>,exec:ToolRunContext):Promise<unknown> { return this.perform(op,args,exec,'agent') }
  /** Apply the existing native question continuation.
   * @param op Exact reviewed operation. @param args Version-pinned input. @param exec Original invocation.
   * @returns Original domain result after the existing exact human decision. */
  reviewedCall(op:string,args:Record<string,unknown>,exec:ToolRunContext):Promise<unknown> { return this.perform(op,args,exec,'human') }
  /** Retain the existing registry invalidation.
   * @param owner Actual provider fiber. @param invalidate Original registry callback.
   * @returns Effect disposer withdrawing only this provider notification. */
  watchSkills(owner:Context,invalidate:()=>void):()=>void {
    this.api.assertInstalled(owner)
    return owner.effect(()=>{
      if(this.skillListeners.size>=this.config.maxSkillProviders)fail('科研技能提供方达到配置容量。')
      this.skillListeners.add(invalidate)
      return ()=>{this.skillListeners.delete(invalidate)}
    },'research-suite: revoke account research skill provider')
  }
  /** Prepare exact bundled sources during a real native skill invocation.
   * @param skill Original approved provider entry. @param options Original registry lookup scope.
   * @returns Inert preview or complete native resource guidance after copying. */
  materializeSkill(skill:object,options:object):Promise<object> {
    if(this.runtime.execution()===undefined)return materializeResearchSkill(skill,options,this.runtime,this.config,()=>{},()=>{throw new Error('No preview execution')})
    if(this.resourcePreparations>=this.config.maxConcurrentResourcePreparations)fail('科研资源准备达到配置容量，请稍后重试。')
    this.resourcePreparations++
    const work=materializeResearchSkill(skill,options,this.runtime,this.config,(exec:ToolExecution)=>{this.assertToolCurrent(exec)},
      (exec:ToolExecution)=>this.api.sessionProject(exec.agent!.session).path)
    return this.track(work.finally(()=>{this.resourcePreparations--}))
  }
  /** Read only this account's published dynamic research skills.
   * @param signal Original discovery cancellation. @returns Actual account-local published entries. */
  async publishedSkills(signal?:AbortSignal):Promise<unknown> {
    this.assertCurrent();this.api.requireRpc('cloudResearch/action');signal?.throwIfAborted()
    const result=await this.store.execute('lab_skills',{},'agent',signal,null)
    this.assertCurrent();this.api.requireRpc('cloudResearch/action');signal?.throwIfAborted()
    return result
  }
  /** Existing sidebar carrier; execution enters the native Session inbox.
   * @param request Bounded untrusted wire input. @param signal Original request cancellation.
   * @returns Actual domain result or an explicit unconfirmed-operation failure. */
  @Remote({name:'action',resources:{session:(request:ResearchRequest)=>SessionId(request.sessionId)}})
  action(request:ResearchRequest,signal:AbortSignal):Promise<unknown> {
    void request // Consume only the original Gateway request below; a direct argument grants no identity.
    this.api.requireRpc('cloudResearch/action');this.assertCurrent();signal.throwIfAborted()
    const invocation=this.ctx.invocation
    if(invocation?.service!=='cloudResearch' || invocation.request.namespace!=='cloudResearch' || invocation.request.method!=='action')fail('科研请求缺少原生账号调用上下文。')
    signal=AbortSignal.any([signal,invocation.peer.signal,this.binding.lifetime])
    const raw:unknown=invocation.request.args.request
    if(Buffer.byteLength(JSON.stringify(raw))>this.config.maxRequestBytes)fail('科研请求超过已配置容量。')
    const value=z.object({sessionId:z.string().min(1).max(200),op:z.string().refine(op=>Object.hasOwn(contracts,op)),args:z.record(z.unknown()),execute:z.boolean().optional()}).strict().parse(raw)
    return this.api.withPeerUse(invocation.peer,async(_use,current)=>{
      const check=()=>{current();this.api.requireRpc('cloudResearch/action');if(this.ctx.get('sessions')!.get(SessionId(value.sessionId))!==undefined)this.session(value.sessionId);signal.throwIfAborted()}
      check();await this.verifySession(value.sessionId,signal);check();const args:Record<string,unknown>=JSON.parse(JSON.stringify(validateArgs(value.op,value.args)))
      let result:unknown
      if(reads.has(value.op) && !value.execute)result=await this.store.execute(value.op,args,'human',signal,value.sessionId)
      else {
        if(this.pending.size>=this.config.maxPendingRequests)fail('已有科研操作等待执行，请稍后再试。')
        const requestId=randomUUID(),completion=Promise.withResolvers<unknown>()
        const inputSha256=createHash('sha256').update(JSON.stringify({op:value.op,args})).digest('hex')
        const control=AbortSignal.any([signal,this.binding.lifetime,AbortSignal.timeout(this.config.executionTimeoutMs)])
        const item:Pending={request:{sessionId:value.sessionId,op:value.op,args},inputSha256,check,resolve:completion.resolve,reject:completion.reject,signal:control,running:false}
        this.pending.set(requestId,item)
        const aborted=()=>completion.reject(new Error('科研执行未确认；请检查当前对话及执行记录后重试。'))
        control.addEventListener('abort',aborted,{once:true})
        void completion.promise.catch((_error:unknown)=>{ /* Joined below after original prompt submission. */ })
        try {
          await this.ctx.get('sessionController')!.prompt({sessionId:SessionId(value.sessionId),requestId:brandString<SessionRequestId>(requestId),mode:'queue',
            content:[{type:'text',text:'请执行我刚在科研工作台提交的操作 '+value.op+'。先调用 research_workbench_execute，requestId='+requestId+'。参数指纹 SHA-256='+inputSha256+'。该请求绑定当前对话，参数已由工作台保存；请报告真实执行结果。'}]},control)
          check();result=await completion.promise
        } finally {control.removeEventListener('abort',aborted);this.pending.delete(requestId)}
      }
      await this.verifySession(value.sessionId,signal);check()
      if(Buffer.byteLength(JSON.stringify(result))>this.config.maxReplyBytes)fail('科研结果超过已配置容量，请缩小读取范围。')
      return result
    })
  }
  /** Exact descriptor contribution for the shared Cloud API audit.
   * @returns Current account-native RPC inventory. */
  inspect():ExposureInventory {
    this.assertCurrent()
    return {recipeVersion:this.binding.recipeVersion,rpcEndpoints:[{endpoint:'cloudResearch/action',handlerId:'native:cloudResearch',guard:'account-session'}],streamEndpoints:[],exactFetchRoutes:[]}
  }
}
/** Install the independent package in the prepared native account graph.
 * @param ctx Actual account Loader entry. @param input Complete deployment configuration. */
export function apply(ctx:Context,input:Config):void {
  const config=Config(input),api=ctx.get('peCloudApi'),files=ctx.get('peCloudFiles')
  if(!(api instanceof CloudAccountApi)||!(files instanceof CloudAccountFiles))fail('科研模式需要当前账号原生 Cloud API 和文件能力。')
  new CloudResearch(ctx,config,api,files)
}
