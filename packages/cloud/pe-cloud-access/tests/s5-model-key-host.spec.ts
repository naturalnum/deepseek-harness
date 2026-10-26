import { MODEL_KEY_FIXTURE as APPROVED_MODEL_KEY, modelKeyBinding } from '../../pe-cloud-api/tests/model-key-policy-data.ts'
/** Original Loader/Gateway/login registry/native adapter composition; auth DB responses and ready borrows are component fixtures. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { apply as connectionApply, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import type { Auth } from 'better-auth'
import pg from 'pg'
import { BetterAuthAccess } from '../../pe-cloud-access/src/auth.ts'
import { LoginPeerRegistry, type LoginPeer } from '../../pe-cloud-access/src/peers.ts'
import type { AccessConfig } from '../../pe-cloud-access/src/types.ts'
import { CloudAccountApi } from '../../pe-cloud-api/src/account-service.ts'
import { ConfigSaveCoordinator } from '../../pe-cloud-api/src/config-saves.ts'
import { ExposurePolicy } from '../../pe-cloud-api/src/exposure.ts'
import { AccountModelKeyEnvironment } from '../../pe-cloud-api/src/model-key.ts'
import type { ModelKeyState, ModelKeySaved, ModelKeyMetadata } from '../../pe-cloud-api/src/types.ts'
import { assemble } from '../../../llm/llm-deepseek/tests/assemble.ts'
import { modelKeyLoopback } from '../../pe-cloud-api/tests/s5-model-key-loopback.ts'

const REF=APPROVED_MODEL_KEY.ref, MODEL='deepseek-v4-flash'
const KEYS={ aBefore:'r05-component-a-before',aAfter:'r05-component-a-after',b:'r05-component-b' }
const methods=['metadata','describe','set','unset'] as const
const limits={ bindings:[modelKeyBinding('provider')],maxKeyBytes:128,maxVersionBytes:128,maxReplyBytes:4096,maxMetadataBytes:65536 }
const accessConfig:AccessConfig={ publicOrigin:'http://127.0.0.1:4100',deploymentMode:'development',trustedProxyAddresses:[],authSecretRef:'component',
  sessionRecheckMs:60000,authCheckTimeoutMs:1000,maxPeers:4,maxPeersPerAccount:2,maxPeerWaiters:8,maxPeerWaitersPerAccount:4,
  maxPeerCarriers:8,maxPeerCarriersPerAccount:4,maxPeerCarriersPerLogin:2,peerCloseTimeoutMs:1000,maxAuthOperations:8,
  maxTrackedLogins:8,maxTrackedLoginsPerAccount:4,maxAuthInvalidations:8,
  bindingFields:{ accountHeader:'x-pe-account',generationHeader:'x-pe-generation',accountQuery:'peAccount',generationQuery:'peGeneration' } }
const id=brandString<Parameters<BetterAuthAccess['authenticate']>[1]>('r05-component')

it('uses actual Peer identity, strict Remote input and serial versions across two native model accounts',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'host-scratch-')))
  const rows:{ ctx:Context;binding:AccountBinding;barrier:ReturnType<ConfigSaveCoordinator['createAccount']>;api:CloudAccountApi }[]=[]
  const sockets:Socket[]=[],releasesBeforeClose:(()=>void)[]=[],modelTasks:Promise<unknown>[]=[],modelControllers=new Set<AbortController>()
  const saves=new ConfigSaveCoordinator({ maxAccounts:2,maxRunning:2,maxQueued:4,maxQueuedPerAccount:2,maxTrackedOperations:12,
    maxTrackedOperationsPerAccount:6,maxNestedPerOperation:3,maxWaitersPerAccount:2 })
  const pool=new pg.Pool({ host:'127.0.0.1',port:1,user:'unused-component',database:'unused-component',max:1,connectionTimeoutMillis:50 })
  vi.spyOn(pool,'connect').mockImplementation(()=>{throw new Error('Component authentication has no physical database transport')})
  const queries=vi.spyOn(pool,'query')
  const acquired:{ auth?:BetterAuthAccess;registry?:LoginPeerRegistry;server?:Awaited<ReturnType<typeof modelKeyLoopback>> }={}
  const borrows=new Map<string,number>(),releases=new Map<string,number>(),cleanupFailures:unknown[]=[]
  // Register teardown before acquiring listeners, auth or account graphs.
  onTestFinished(async()=>{
    for(const release of releasesBeforeClose)release()
    for(const controller of modelControllers)controller.abort()
    const closing=acquired.registry?.closeActual()
    void closing?.catch((_cause:unknown)=>{}) // Joined below after the fixture's actual model tasks settle.
    try {await Promise.allSettled(modelTasks);await closing;await acquired.auth?.close();for(const row of rows.toReversed()){
      const receipt=await row.barrier.stopConfigSaves(Date.now()+1000);expect(receipt.status).toBe('confirmed')
      await row.api.withdraw();await row.ctx.fiber.dispose();saves.releaseAccount(row.barrier)
    }}finally{
      await acquired.server?.close();await pool.end();sockets.forEach(socket=>socket.destroy());saves.close()
      vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(home,{ recursive:true,force:true })
    }
  })
  vi.stubEnv('DSH_HOME',join(home,'anonymous-id'))
  const server=await modelKeyLoopback(KEYS);acquired.server=server
  const auth=await BetterAuthAccess.create(
    accessConfig,pool,'r05-component-secret-only-01234567890123456789',
    async (login)=>{await acquired.registry?.invalidateLogin(login)},
  )
  acquired.auth=auth
  const library=Reflect.get(auth,'auth') as Auth
  const now=new Date(),expiresAt=new Date(Date.now()+60000)
  const getSession=vi.spyOn(library.api,'getSession').mockImplementation(async (input)=>{
    const headers=input?.headers
    const account=new Headers(headers).get('cookie')==='component=b'?'b':'a'
    return{ user:{ id:account,name:account,email:`${account}@example.test`,emailVerified:false,createdAt:now,updatedAt:now },
      session:{ id:`login-${account}`,userId:account,token:`synthetic-${account}`,expiresAt,createdAt:now,updatedAt:now,ipAddress:null,userAgent:null } }
  })
  const registry=new LoginPeerRegistry({ ...accessConfig, sessionRecheckLeadMs: 0 },auth,{ borrow:async (binding)=>{
    const row=rows.find(row=>row.binding===binding);if(row===undefined)throw new Error('Fixture graph absent')
    borrows.set(binding.accountId,(borrows.get(binding.accountId)??0)+1)
    let released=false
    const use:AccountUse={ binding,context:row.ctx,assertCurrent(){if(released)throw new Error('Released component Use');binding.lifetime.throwIfAborted()},
      release(){if(!released){released=true;releases.set(binding.accountId,(releases.get(binding.accountId)??0)+1)}} }
    return use
  },beforeHttp(){},beforeStream(){},cleanupFailed(value){cleanupFailures.push(value)} })
  acquired.registry=registry
  const peers=registry
  for(const name of ['a','b']){
    const local=join(home,name),dir=join(local,'profiles','component');mkdirSync(dir,{ recursive:true });initProfile(dir,[])
    const anchor=join(local,'package.json');writeFileSync(anchor,'{"name":"r05-loader-component"}\n')
    const scoped=join(local,'node_modules','@deepseek-ai');mkdirSync(scoped,{ recursive:true })
    symlinkSync(fileURLToPath(new URL('../../../llm/llm-deepseek-api-key/',import.meta.url)),join(scoped,'dsh-llm-deepseek-api-key'),'dir')
    symlinkSync(fileURLToPath(new URL('../../pe-cloud-api/',import.meta.url)),join(scoped,'dsh-pe-cloud-api'),'dir')
    const path=join(local,'credentials.yaml');writeFileSync(path,'version: 1\nrefs: {}\n',{ mode:0o600 })
    const exposure=new ExposurePolicy({ recipeVersion:'r05-component',rpcEndpoints:methods.map(method=>({ endpoint:`cloudModelKey/${method}`,
      handlerId:'native:cloudModelKey',guard:'authenticated-account' })),streamEndpoints:[],exactFetchRoutes:[],allowedSettings:[] })
    const lifetime=new AbortController(),binding:AccountBinding=Object.freeze({ accountId:brandString<AccountBinding['accountId']>(name),
      epoch:brandString<AccountBinding['epoch']>('1'),recipeVersion:'r05-component',lifetime:lifetime.signal })
    const profile:ProfileContext={ name:'component',dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:anchor,cwd:local,home:local,
      startedBundles:[],overlays:[],telemetryDisabledEnv:undefined }
    const config=join(dir,'cordis.yml');writeFileSync(config,JSON.stringify([
      { id:'dependencies',name:'cordis:dependencies' },{ id:'typert-artifacts',name:'cordis:typert-artifacts',config:{ packages:['@deepseek-ai/dsh-pe-cloud-api'] } },{ id:'editor',name:'cordis:editor' },
      { id:'credentials',name:'cordis:credentials',config:{ path,watch:false } }, { id:'connection',name:'cordis:connection' }, { id:'settings',name:'cordis:settings' },
      { id:'llm',name:'cordis:llm' },{ id:'provider',name:APPROVED_MODEL_KEY.plugin,config:{ baseURL:server.baseURL,apiKeyEnv:REF,
        models:[{ id:MODEL }],maxTokens:32,streamIdleTimeoutMs:5000,retryPolicy:{ mode:'normal',maxRetries:0 } } },
      { id:'key',name:'cordis:key' }]))
    let api:CloudAccountApi|undefined,barrier:ReturnType<ConfigSaveCoordinator['createAccount']>|undefined
    const ctx=await boot('r05-component',config,[],(owner)=>{
      owner.provide('profileContext',profile);owner.provide('peAccount',binding)
      owner.provide(DSH_LAUNCH_ENVIRONMENT_KEY,new AccountModelKeyEnvironment(createLaunchEnvironmentSnapshot([{ source:'process',values:{ [REF]:'ambient-must-not-run' } }]), [REF]))
      barrier=saves.createAccount(binding,{ references:[REF],maxReferences:1,maxReferenceBytes:64 })
      api=new CloudAccountApi(owner,{ binding,saves:barrier,rootExposure:exposure,selected:exposure.manifest,
        assertMountCurrent(){lifetime.signal.throwIfAborted()},assertBusinessCurrent(){lifetime.signal.throwIfAborted()} })
      const actual=api
      Object.assign(owner.loader.builtins,{ editor:actual.providers.configEditor,credentials:actual.providers.credentials,
        settings:Settings,llm:LlmRuntime,'typert-artifacts':TypertLoader,connection:{ apply:connectionApply,inject:[...connectionInject] },dependencies:{ async apply(scope:Context){await scope.plugin(Typert);await scope.plugin(RemoteAccess)
          await scope.plugin(Gateway)
        } },key:{ inject:['typert','settings','credentials','llm'],apply(scope:Context){actual.prepareCloudModelKey(scope,
          { limits,maxNativeInventoryEntries:64,withModelKeyPeerUse:(peer,consume)=>peers.withOriginalUse(peer,()=>{},consume) })} } })
    },pathToFileURL(anchor).href)
    if(api===undefined||barrier===undefined)throw new Error('Native preparation absent')
    rows.push({ ctx,binding,barrier,api })
    const providerEntry=[...ctx.loader.entries()].find(entry=>entry.options.id==='provider')!
    expect(providerEntry.fiber?.runtime?.callback).toBeDefined()
    expect(providerEntry.prepareConfigUpdate(providerEntry.options.config).impact).toBe('none')
    await ctx.cloudModelKey.auditProvider();ctx.cloudModelKey.assertProvisionableModel('deepseek-official',MODEL)
    api.audit(ctx.cloudModelKey.inspect())
  }
  const handles:LoginPeer[]=[]
  for(const row of rows){const socket=new Socket();sockets.push(socket);const request=new IncomingMessage(socket)
    request.method='POST';request.url='/api/cloudModelKey/describe'
    request.headers={ host:'127.0.0.1:4100',cookie:`component=${row.binding.accountId}` }
    request.rawHeaders=['Host','127.0.0.1:4100','Cookie',`component=${row.binding.accountId}`]
    const principal=await auth.authenticate(request,id)
    handles.push(await peers.acquire(principal,row.binding,Date.now()+1000,undefined,id))
  }
  const a=rows[0]!,b=rows[1]!,pa=handles[0]!,pb=handles[1]!
  const call=<T>(row:typeof a,peer:PeerScope,method:string,request?:unknown)=>row.ctx.typertGateway.invoke({ namespace:'cloudModelKey',method,args:request===undefined?{}:{ request },peer }) as Promise<T>
  const metadata=await call<ModelKeyMetadata>(a,pa.peer,'metadata');expect(metadata.settings.writable).toBe(false)
  expect(metadata.settings.namespaces[0]?.value).toEqual(a.ctx.get('settings')?.describe({ redactSecrets:true }).find(row=>row.ns==='provider')?.value)
  expect(metadata.settings.namespaces[0]?.value).toMatchObject({ apiKeyEnv:REF,models:[{ id:MODEL }] })
  expect(await a.ctx.llm.listModels('deepseek-official')).toEqual([])
  const provider=[...a.ctx.loader.entries()].find(entry=>entry.options.id==='provider')!
  const before:unknown=provider.options.config
  if(before===null||typeof before!=='object'||Array.isArray(before))throw new Error('Original provider config is not an object')
  try{
    provider.options.config={ ...before,apiKeyEnv:'UNAPPROVED_REFERENCE' }
    await expect(call(a,pa.peer,'metadata')).rejects.toBeDefined()
    await expect(call(a,pa.peer,'describe',{ ref:REF })).rejects.toBeDefined()
  }finally{provider.options.config=before}
  expect(a.barrier.snapshot().pending).toEqual([]);expect(a.barrier.snapshot().failures).toEqual([])
  const av=await call<ModelKeyState>(a,pa.peer,'describe',{ ref:REF }),bv=await call<ModelKeyState>(b,pb.peer,'describe',{ ref:REF })
  await expect(call(a,pa.peer,'set',{ ref:REF,value:KEYS.aBefore,version:{ ...av.version,extra:true } })).rejects.toBeDefined()
  expect(a.barrier.snapshot().pending.length).toBe(0)
  const saved=await call<ModelKeySaved>(a,pa.peer,'set',{ ref:REF,value:KEYS.aBefore,version:av.version })
  await call(b,pb.peer,'set',{ ref:REF,value:KEYS.b,version:bv.version })
  await expect(call(a,pa.peer,'set',{ ref:REF,value:KEYS.aAfter,version:av.version })).rejects.toBeDefined()
  await expect(call(a,pb.peer,'describe',{ ref:REF })).rejects.toBeDefined()
  await expect(call(a,pb.peer,'metadata')).rejects.toBeDefined()
  const generate=(row:typeof a)=>{
    if(modelTasks.length>=8||modelControllers.size>=3)throw new Error('Component model request budget exhausted')
    const controller=new AbortController();modelControllers.add(controller)
    const timer=setTimeout(()=>{ controller.abort() },5000)
    const actual=assemble(row.ctx,{ model:MODEL,signal:controller.signal,messages:[createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Return the synthetic response.' }] })] })
      .finally(()=>{clearTimeout(timer);modelControllers.delete(controller)})
    modelTasks.push(actual)
    void actual.catch((_cause:unknown)=>{}) // Caller assertions and teardown retain the original settlement.
    return actual
  }
  await generate(a);await generate(b)
  const held=server.holdNext();releasesBeforeClose.push(held.release)
  const inflight=generate(a);await held.received
  try{await call(a,pa.peer,'set',{ ref:REF,value:KEYS.aAfter,version:saved.version });await generate(a)}finally{held.release()}
  await inflight
  expect(server.records.map(row=>row.auth)).toEqual(['aBefore','b','aBefore','aAfter'])
  const last=await call<ModelKeyState>(a,pa.peer,'describe',{ ref:REF });const removed=await call<ModelKeySaved>(a,pa.peer,'unset',{ ref:REF,version:last.version })
  await expect(generate(a)).resolves.toMatchObject({ finish:{ kind:'error',failure:{ code:'MISSING_CREDENTIAL' } } });expect(server.records).toHaveLength(4)
  const entered=Promise.withResolvers<undefined>(),release=Promise.withResolvers<undefined>()
  releasesBeforeClose.push(()=>{ release.resolve(undefined) })
  const blocking=a.barrier.admit('settings',async()=>{entered.resolve(undefined);await release.promise})
  await entered.promise
  const retained=call(a,pa.peer,'set',{ ref:REF,value:KEYS.aBefore,version:removed.version })
  const refused=expect(retained).rejects.toBeDefined()
  let closing:Promise<void>|undefined
  try{
    await vi.waitFor(()=>{ expect(saves.snapshot().queued).toBe(1) })
    closing=peers.invalidateLogin(pa.principal.authSessionId)
    expect(releases.get('a')??0).toBe(0)
  }finally{release.resolve(undefined)}
  await blocking;await refused;await closing
  expect(await a.ctx.credentials.describe(REF)).toMatchObject({ configured:false })
  expect(a.barrier.snapshot().failures).toEqual([])
  await expect(call(a,pa.peer,'describe',{ ref:REF })).rejects.toBeDefined()
  expect(borrows.get('a')).toBe(1);expect(releases.get('a')).toBe(1);expect(releases.get('b')??0).toBe(0)
  expect(a.barrier.snapshot().pending.length).toBe(0);expect(b.barrier.snapshot().pending.length).toBe(0)
  expect(cleanupFailures).toEqual([])
  expect(getSession).toHaveBeenCalled();expect(queries).not.toHaveBeenCalled()
  for(const endpoint of ['credentials/set','credentials/unset','settings/mutate'])expect(()=>a.api.requireRpc(endpoint)).toThrow()
  a.ctx.cloudModelKey.assertCurrent()
  a.ctx.cloudModelKey.assertProvisionableModel('deepseek-official',MODEL)
  const aTypert=[...a.ctx.loader.entries()].find(entry=>entry.options.id==='typert-artifacts')
  await aTypert?.fiber?.dispose()
  // The actual service and provider remain mounted; only the original generated contribution was withdrawn.
  a.ctx.cloudModelKey.assertCurrent()
  a.ctx.cloudModelKey.assertProvisionableModel('deepseek-official',MODEL)
  expect(a.ctx.typert.local.get('cloudModelKey/metadata')).toBeUndefined()
  expect(()=>a.api.requireRpc('cloudModelKey/metadata')).toThrow(expect.objectContaining({ code:'cloud/account-unavailable' }))
  const bProvider=[...b.ctx.loader.entries()].find(entry=>entry.options.id==='provider')
  await bProvider?.fiber?.dispose()
  await expect(call(b,pb.peer,'metadata')).rejects.toMatchObject({ code:'cloud/account-unavailable' })
  await expect(call(b,pb.peer,'describe',{ ref:REF })).rejects.toMatchObject({ code:'cloud/account-unavailable' })
  expect(await b.ctx.credentials.describe(REF)).toMatchObject({ configured:true })
  expect(b.barrier.snapshot().failures).toEqual([])
  const bKey=[...b.ctx.loader.entries()].find(entry=>entry.options.id==='key')
  await bKey?.fiber?.dispose()
  expect(()=>b.api.requireRpc('cloudModelKey/metadata')).toThrow(expect.objectContaining({ code:'cloud/account-unavailable' }))

})
