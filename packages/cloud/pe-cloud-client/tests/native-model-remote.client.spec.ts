// @vitest-environment jsdom
/** Real native Loader/Connection/generated Remote with scripted wire replies; no Host persistence or CAS is simulated. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as Registry from '@deepseek-ai/dsh-typert-registry/client'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as cloud from '../src/client/index.ts'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { modelSettingsDictionaries } from '../src/client/model-settings-locales.ts'

type Remote = TypertClientRemote['cloudModelKey']
type Metadata = Extract<Awaited<ReturnType<Remote['metadata']>>, { ok:true }>['value']

class Socket implements ConnectionWebSocket {
  readyState=1
  private readonly closed=new Set<()=>void>()
  send():void {}
  close():void {this.readyState=3;for(const listener of this.closed)listener();this.closed.clear()}
  addEventListener:ConnectionWebSocket['addEventListener']=(event,listener)=>{
    if(event==='close')this.closed.add(()=>{ listener({ data:undefined }) })
  }
  removeEventListener:ConnectionWebSocket['removeEventListener']=()=>{}
}

function bootstrap():CloudBootstrap {
  const disabled={ state:'disabled',reason:'not-approved' } as const
  return { account:{ id:'A',displayName:'A' },recipeVersion:'component',connectionGeneration:'native-G',capabilities:{
    projects:{ state:'available' },filePreview:disabled,shell:disabled,developmentServices:disabled,servicePreview:disabled,
    sandboxScope:'session',backgroundJobs:false,localDesktop:false,arbitraryBackendPlugins:false,
    subprocess:{ spawn:false,pipes:false,control:false,inherit:false,terminal:false,consumers:[] },
    configuration:{ catalogVersion:'component',plugins:[],skills:{ manage:false },credentials:{ write:false },fields:[] } } }
}
const metadata:Metadata={ providers:[{ id:'deepseek-official',name:'DeepSeek' }],configurableProviders:[{
  provider:'deepseek-official',displayName:'DeepSeek',settingsNs:'model-provider',settingsPath:[] }],settings:{ writable:false,hasDocument:false,namespaces:[{
  ns:'model-provider',schema:{ type:'object',dict:{} },value:{ apiKeyEnv:'DEEPSEEK_API_KEY' },autoGenerate:true,applies:'live',secrets:[],revision:1 }] } }

it('uses the single real generated namespace for metadata, captured edits and key-only unset; malformed acknowledgements never confirm',async()=>{
  const records:{ method:string;payload:unknown;headers:Headers }[]=[]
  let token='opened-token'
  // These are scripted wire acknowledgements only. They implement neither a credential store nor a CAS backend.
  let scriptedSave:unknown={ ok:true,value:{ persisted:true,version:{ epoch:'native-E',editToken:'reply-token' } } }
  const fetcher=async(target:string|URL,init:RequestInit):Promise<Response>=>{
    if(new URL(target).pathname.endsWith('/cloud/bootstrap'))return Response.json(bootstrap())
    if(typeof init.body!=='string')throw new Error('Native RPC did not serialize its body')
    const body:unknown=JSON.parse(init.body)
    if(body===null||typeof body!=='object'||!('rpcId' in body)||!('method' in body)||typeof body.method!=='string'||!('payload' in body))throw new Error('Native envelope missing')
    records.push({ method:body.method,payload:body.payload,headers:new Headers(init.headers) })
    const result=body.method==='cloudModelKey/metadata'?{ ok:true,value:metadata }
      :body.method==='cloudModelKey/describe'?{ ok:true,value:{ ref:'DEEPSEEK_API_KEY',configured:true,writable:true,source:'file',version:{ epoch:'native-E',editToken:token } } }
        :scriptedSave
    return Response.json({ type:'server-response',rpcId:body.rpcId,result })
  }
  const prepared=PreparedCloudPage.prepare({ baseUrl:'https://example.test/app/',config:{ bootstrapPath:'cloud/bootstrap',bootstrapTimeoutMs:1000,
    maxBootstrapResponseBytes:8192,maxErrorResponseBytes:512,maxPendingFetches:8,maxSockets:2,closeTimeoutMs:1000,
    modelSettingsRequestTimeoutMs:1000 },
  decodeLimits:{ maxBodyBytes:8192,maxStringBytes:256,maxListItems:32 },
  persistenceLimits:{ maxKeys:10,maxKeyBytes:64,maxValueBytes:256,maxTotalBytes:4096,maxNamespaceBytes:256 },
  fields:{ accountHeader:'x-account',generationHeader:'x-generation',accountQuery:'account',generationQuery:'generation' },
  storage:{ getItem:()=>null,setItem:()=>{},removeItem:()=>{} },fetch:fetcher,createWebSocket:()=>new Socket(),
  },new AbortController().signal)
  const page=await prepared.ready,root=new Context()
  onTestFinished(async()=>{await prepared.dispose()})
  const entry={ run:async()=>{
    root.provide('clientPersistence',page.nativeOptions.persistence);page.nativeOptions.prepareContext(root)
    await root.plugin(Loader)
    Object.assign(root.loader.builtins,{ cloud,registry:Registry,gateway:Gateway,slots:SlotRegistry,locale:{ apply(owner:Context){const locale=new LocaleRuntime(owner);locale.setLocale('en');owner.provide('locale',locale)} } })
    await Promise.all(['cloud','registry','gateway','slots','locale'].map(name=>root.loader.create({ name:'cordis:'+name })))
    await root.loader.await()
    expect([...root.loader.entries()].every(row=>row.fiber?.state===FiberState.ACTIVE)).toBe(true)
  },dispose:async()=>{
    await Promise.all([...root.loader.entries()].flatMap(row=>row.fiber===undefined?[]:[row.fiber.dispose()]))
    await root.fiber.dispose()
  } }
  await page.start(entry)
  await vi.waitFor(()=>{ expect(page.modelsSettingsIntegration.editing.getSnapshot()).not.toBeNull() })
  const view=await page.modelsSettingsIntegration.reads.metadata()
  expect(view.settings.writable).toBe(false)
  expect(view.configurableProviders[0]?.provider).toBe('deepseek-official')
  expect(view.configurableProviders[0]?.settingsNs).toBe('model-provider')
  const facts=await page.modelsSettingsIntegration.reads.credentials(['DEEPSEEK_API_KEY'])
  expect(facts).toEqual({ DEEPSEEK_API_KEY:{ configured:true,writable:true,source:'file' } })
  expect(JSON.stringify(facts)).not.toContain('opened-token')
  const editing=page.modelsSettingsIntegration.editing.getSnapshot()
  if(editing===null)throw new Error('Actual model namespace was not attached')
  const edit=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  if(edit===null)throw new Error('Actual original edit did not prepare')
  token='background-token'
  await page.modelsSettingsIntegration.reads.credentials(['DEEPSEEK_API_KEY'])
  expect(await edit.store('synthetic-wire-input')).toBeUndefined()
  expect(records.find(row=>row.method==='cloudModelKey/set')?.payload).toEqual({ args:{ request:{ ref:'DEEPSEEK_API_KEY',value:'synthetic-wire-input',version:{ epoch:'native-E',editToken:'opened-token' } } } })
  const removal=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  if(removal===null)throw new Error('New removal did not prepare')
  expect(await removal.remove()).toBeUndefined()
  expect(records.find(row=>row.method==='cloudModelKey/unset')?.payload).toEqual({ args:{ request:{ ref:'DEEPSEEK_API_KEY',version:{ epoch:'native-E',editToken:'background-token' } } } })
  expect(records.every(row=>row.method.startsWith('cloudModelKey/'))).toBe(true)
  expect(records.every(row=>row.headers.get('x-account')==='A'&&row.headers.get('x-generation')==='native-G')).toBe(true)
  for(const persisted of [false,'true']){
    scriptedSave={ ok:true,value:{ persisted,version:{ epoch:'native-E',editToken:'invalid' } } }
    const rejected=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
    if(rejected===null)throw new Error('Negative case did not prepare')
    expect(await rejected.store('synthetic-malformed-ack')).toBe(modelSettingsDictionaries.en.unavailable)
  }
  scriptedSave={ ok:false,error:{ code:'cloud/config-conflict',message:'PRIVATE_SERVER_DETAIL',details:{} } }
  const conflict=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  if(conflict===null)throw new Error('Conflict case did not prepare')
  expect(await conflict.store('synthetic-conflict')).toBe(modelSettingsDictionaries.en.conflict)
  const localized=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  if(localized===null)throw new Error('Localized case did not prepare')
  root.locale.setLocale('zh')
  expect(await localized.store('synthetic-localized-conflict')).toBe(modelSettingsDictionaries.zh.conflict)
  const calls=records.length
  await page.dispose()
  expect(page.modelsSettingsIntegration.editing.getSnapshot()).toBeNull()
  await expect(edit.store('synthetic-stale-page')).rejects.toMatchObject({ code:'closed' })
  expect(records).toHaveLength(calls)
})
