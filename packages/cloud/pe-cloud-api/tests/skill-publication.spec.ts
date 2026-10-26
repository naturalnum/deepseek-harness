/** Original Loader/registry/parser/save owner and real LocalFS CAS; this storage fixture is not W4 confinement. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import SkillRegistry, { type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FdMutationFailure, type SkillVersion, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { AccountSkillPublication } from '../src/skill-publication.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { skillCodecs } from '../src/skill-json.ts'
import type { SkillResourcePreparation } from '../src/skill-source.ts'
import { CloudApiError } from '../src/errors.ts'

const limits={ maxFileBytes:4096,maxRequestBytes:16384,maxReplyBytes:4096,maxRetainedVersions:4 }
const body=(text:string)=>`---\nname: sample\ndescription: Controlled sample\n---\n${text}\n`
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')

async function fixture(account='a', resources?: SkillResourcePreparation) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'w2-skill-'))),profileDir=join(dir,'profiles','test')
  mkdirSync(profileDir,{ recursive:true });initProfile(profileDir,[])
  writeFileSync(join(dir,'package.json'),'{"name":"skill-api-component"}\n')
  const config=join(profileDir,'cordis.yml');writeFileSync(config,JSON.stringify([{ id:'skills',name:'cordis:skills' },{ id:'fs',name:'cordis:fs',config:{ cwd:dir } }]))
  const ctx=await boot('skill-api-component',config,[],(owner)=>{
    owner.provide('profileContext',{ name:'test',dir:profileDir,patchPath:join(profileDir,'cordis.patch.yml'),
      installAnchor:join(dir,'package.json'),cwd:dir,home:dir,startedBundles:[],overlays:[],telemetryDisabledEnv:undefined })
    Object.assign(owner.loader.builtins,{ skills:SkillRegistry,fs:LocalFileSystem })
  })
  const lifetime=new AbortController()
  const binding:AccountBinding=Object.freeze({ accountId:brandString<AccountBinding['accountId']>(account),
    epoch:brandString<AccountBinding['epoch']>('1'),recipeVersion:'component-only',lifetime:lifetime.signal })
  const coordinator=new ConfigSaveCoordinator({ maxAccounts:1,maxRunning:1,maxQueued:8,maxQueuedPerAccount:8,
    maxTrackedOperations:16,maxTrackedOperationsPerAccount:16,maxNestedPerOperation:4,maxWaitersPerAccount:2 })
  const saves=coordinator.createAccount(binding)
  const issued=new Map<string,SkillVersion>()
  const pointer=join(dir,'current.json');let prepares=0,commits=0,handoff=false,invalidatedWithHandoff=false,preparedHeld=false,currentHeld=false
  let afterCommit:(()=>void)|undefined,loseCommit=false,failApply=false
  let sourceReads = 0
  const own=<T>(value:T)=>({ value,release(){} })
  const currentResult=<T>(value:T)=>{currentHeld=true;return{ value,release(){currentHeld=false} }}
  const info=(version:SkillVersion)=>({ id:version.id,skillSha256:version.skillSha256,resourceSha256:version.resourceSha256,
    skillBytes:version.skillBytes,resourceBytes:version.resourceBytes })
  const port:SkillVersionPort={
    async prepare(input,signal){
      signal.throwIfAborted();prepares++
      const id=brandString<SkillVersion['id']>(randomUUID()),path=join(dir,id)
      await mkdir(path);await writeFile(join(path,'SKILL.md'),input.skillMarkdown);await writeFile(join(path,'resource.bin'),input.resource)
      const version:SkillVersion=Object.freeze({ binding,id,skillSha256:hash(input.skillMarkdown),resourceSha256:hash(input.resource),
        skillBytes:Buffer.byteLength(input.skillMarkdown),resourceBytes:input.resource.byteLength })
      issued.set(id,version);preparedHeld=true;return{ value:version,release(){preparedHeld=false} }
    },
    async current(signal){
      signal.throwIfAborted();const target=await ctx.fs.resolve(pointer),observed=await ctx.fs.stat(target)
      if(observed===undefined)return currentResult(undefined)
      const record:unknown=JSON.parse(await ctx.fs.readText(target,signal))
      if(record===null||typeof record!=='object'||!('id'in record)||typeof record.id!=='string')throw Error('Invalid fixture record')
      const version=issued.get(record.id);if(version===undefined)throw Error('Unknown fixture version')
      return currentResult({ version,revision:observed.version })
    },
    async commit(version,expected,signal){
      commits++;const target=await ctx.fs.resolve(pointer)
      try{
        const wrote=await ctx.fs.writeText(target,JSON.stringify(info(version)),expected===null?{ kind:'createIfAbsent' }:{ kind:'replaceIfVersion',version:expected },signal)
        if(loseCommit)throw new FdMutationFailure('unknown','FS_IO_ERROR')
        handoff=true;afterCommit?.();return{ value:{ version,revision:wrote.version },release(){handoff=false} }
      }catch(error){if(error instanceof FsError)throw new FdMutationFailure('not-published',error.code);throw error}
    },
    async withSource(version,consume,signal){
      sourceReads++
      if(preparedHeld)throw Error('A prepared result is still holding the only fixture residence')
      if(currentHeld)throw Error('A current result is still holding the only fixture residence')
      signal.throwIfAborted();const path=join(dir,version.id),markdown=await readFile(join(path,'SKILL.md'),'utf8'),resource=Uint8Array.from(await readFile(join(path,'resource.bin')))
      let active=true
      const check=(control?:AbortSignal)=>{signal.throwIfAborted();control?.throwIfAborted();if(!active)throw Error('Snapshot released')}
      try{return own(await consume({ version,async readText(name,control){check(control);if(name!=='SKILL.md')throw Error('Name');return markdown},async readBytes(name,control){check(control);return name==='SKILL.md'?new TextEncoder().encode(markdown):Uint8Array.from(resource)} },signal))}
      finally{active=false}
    },
  }
  let publication:AccountSkillPublication|undefined,registered:SkillProviderControl|undefined
  const remove=ctx.skills.registerProvider((control)=>{
    registered=control
    const actual:SkillProviderControl={ signal:control.signal,invalidate(){
      if(handoff)invalidatedWithHandoff=coordinator.snapshot().running===1
      control.invalidate();if(failApply)throw Error('Injected apply notification failure')
    } }
    publication=new AccountSkillPublication(ctx,actual,saves,port,limits,resources);return publication
  })
  if(publication===undefined||registered===undefined)throw Error('Registration did not run')
  const native=publication,control=registered,signal=lifetime.signal
  const check=()=>{ signal.throwIfAborted() }
  const current=()=>native.current(check,signal)
  const publish=(edit:Parameters<AccountSkillPublication['publish']>[0],text:string,observer=signal)=>
    native.publish(edit,body(text),new TextEncoder().encode('resource-'+text),()=>{check();observer.throwIfAborted()},observer)
  onTestFinished(async()=>{
    remove();expect(control.signal.aborted).toBe(true);await saves.stopConfigSaves(Date.now()+1000)
    lifetime.abort();await ctx.fiber.dispose();rmSync(dir,{ recursive:true,force:true })
  })
  return{ ctx,native,port,binding,saves,coordinator,signal,current,publish,get prepares(){return prepares},get commits(){return commits},
    get handoff(){return handoff},get invalidatedWithHandoff(){return invalidatedWithHandoff},get currentHeld(){return currentHeld},
    get sourceReads(){return sourceReads},pointer,
    afterCommit(fn:()=>void){afterCommit=fn},loseCommit(){loseCommit=true},failApply(){failApply=true},
    async externalReplace(){
      const prepared=await port.prepare({ skillMarkdown:body('external'),resource:new TextEncoder().encode('external') },signal)
      await ctx.fs.writeText(await ctx.fs.resolve(pointer),JSON.stringify(info(prepared.value)));prepared.release()
    },
    async restore(){await native.restore(check)} }
}

it('refuses a non-live resource caller before source I/O without retaining a failed save', async () => {
  const denied = new CloudApiError('cloud/forbidden', 'The original live Agent is absent.')
  const resources: SkillResourcePreparation = {
    assertCaller: () => { throw denied },
    materialize: vi.fn(() => Promise.reject(new Error('Unauthorized projection must not run.'))),
  }
  const f = await fixture('resource-denial', resources), edit = await f.current()
  await expect(f.publish(edit.version, 'instructions')).resolves.toMatchObject({ resources: 'project-on-load' })
  const listed = await f.native.list({}), candidates = 'candidates' in listed ? listed.candidates : listed
  const before = f.sourceReads
  await expect(f.native.get(candidates[0]!, {})).rejects.toBe(denied)
  expect(f.sourceReads).toBe(before)
  expect(resources.materialize).not.toHaveBeenCalled()
  expect(f.saves.snapshot().failures).toEqual([])
})

it('uses actual native parser/catalog, real LocalFS current CAS and separate catalog/resource outcomes',async()=>{
  const f=await fixture(),before=await f.current();expect(before.current).toBe(null)
  const saved=await f.publish(before.version,'v1');expect(saved).toMatchObject({ persisted:true,applied:true,resources:'unavailable' })
  expect(f.invalidatedWithHandoff).toBe(true);expect(f.handoff).toBe(false)
  const catalog=await f.ctx.skills.list({ cwd:'/cold-view',scope:f.ctx })
  expect(catalog.map(row=>row.name)).toEqual(['sample']);expect(JSON.stringify(catalog)).not.toContain('skill-source')
  await expect(f.ctx.skills.get('sample',{ cwd:'/cold-view',scope:f.ctx })).rejects.toMatchObject({ code:'cloud/forbidden' })
  const after=await f.current();expect(after.applied).toBe(true);expect(after.version.editToken).not.toBe(before.version.editToken)
  expect(f.saves.snapshot().failures).toEqual([])
})

it('shares the real bounded AccountSaves turn and rejects the second stale edit before any prepare',async()=>{
  const f=await fixture(),before=await f.current()
  const result=await Promise.allSettled([f.publish(before.version,'v1'),f.publish(before.version,'v2')])
  expect(result.map(row=>row.status)).toEqual(['fulfilled','rejected']);expect(f.prepares).toBe(1);expect(f.commits).toBe(1)
  expect(f.saves.snapshot().failures).toEqual([])
})

it('passes the actual read FsVersion to native CAS, refusing an external pointer change without fake global revision',async()=>{
  const f=await fixture(),before=await f.current();await f.publish(before.version,'first')
  const edit=await f.current();await f.externalReplace()
  await expect(f.publish(edit.version,'stale')).rejects.toMatchObject({ code:'cloud/config-conflict' })
  expect((await f.current()).version.editToken).not.toBe(edit.version.editToken);expect(f.saves.snapshot().failures).toEqual([])
})

it('finishes synchronous visible/invalidate with the confirmed handoff after observer cancellation',async()=>{
  const f=await fixture(),edit=await f.current(),observer=new AbortController()
  f.afterCommit(()=>{ observer.abort() })
  await expect(f.publish(edit.version,'cancel-after-durable',observer.signal)).resolves.toMatchObject({ persisted:true,applied:true })
  expect(f.invalidatedWithHandoff).toBe(true);expect(f.handoff).toBe(false);expect((await f.current()).applied).toBe(true)
})

it('retains actual unknown responsibility and never replays a lost durable confirmation',async()=>{
  const f=await fixture(),edit=await f.current();f.loseCommit()
  await expect(f.publish(edit.version,'unknown')).resolves.toMatchObject({ persisted:'unknown',applied:false })
  expect(f.saves.snapshot().failures[0]?.outcome).toBe('unknown')
  await expect(f.publish(edit.version,'no-replay')).rejects.toMatchObject({ code:'cloud/account-unavailable' })
  expect(f.commits).toBe(1);expect((await f.saves.stopConfigSaves(Date.now()+1000)).status).toBe('unknown')
})

it('returns persisted true/applied false and retains the original failed save if actual apply throws',async()=>{
  const f=await fixture(),edit=await f.current();f.failApply()
  await expect(f.publish(edit.version,'apply-failed')).resolves.toMatchObject({ persisted:true,applied:false })
  expect(f.handoff).toBe(false);expect(f.saves.snapshot().failures[0]?.outcome).toBe('failed')
})

it('keeps A and B tokens/files/catalogs separate without adding an authority',async()=>{
  const a=await fixture('a'),b=await fixture('b'),edit=await a.current();await b.current()
  await expect(b.publish(edit.version,'foreign')).rejects.toMatchObject({ code:'cloud/config-conflict' })
  expect(b.prepares).toBe(0);await a.publish(edit.version,'A');expect(await b.ctx.skills.list({})).toEqual([])
})

it('checks original current admission inside queued saves and leaves zero-I/O refusal failure-free',async()=>{
  const f=await fixture(),edit=await f.current(),wait=Promise.withResolvers<undefined>(),entered=Promise.withResolvers<undefined>()
  const held=f.saves.admit('settings',async()=>{entered.resolve(undefined);await wait.promise});await entered.promise
  const observer=new AbortController(),pending=f.publish(edit.version,'denied',observer.signal),result=Promise.allSettled([pending]);observer.abort();wait.resolve(undefined);await held
  expect((await result)[0]?.status).toBe('rejected');expect(f.prepares).toBe(0);expect(f.saves.snapshot().failures).toEqual([])
})

it('closes raw extra identities, native revisions, malformed base64 and complete request overflows before any I/O',()=>{
  const codecs=skillCodecs(limits),version={ epoch:'1',editToken:randomUUID() }
  const request={ slot:'sample',version,skillMarkdown:body('text'),resourceBase64:'YQ==' }
  expect(codecs.publish.create().parse(request)).toEqual(request)
  for(const bad of [{ ...request,path:'/private' },{ ...request,accountId:'b' },{ ...request,expectedFsVersion:'fake' },{ ...request,resourceBase64:'YQ=' },{ ...request,skillMarkdown:'界'.repeat(1400) }])expect(()=>codecs.publish.create().parse(bad)).toThrow()
  expect(()=>skillCodecs({ ...limits,maxRequestBytes:8 }).publish.create().parse(request)).toThrow()
})


it('can re-observe the same durable FsVersion without inventing another configuration revision',async()=>{
  const f=await fixture(),edit=await f.current();await f.publish(edit.version,'durable')
  const before=await f.current(),again=await f.current()
  expect(again.version).toEqual(before.version);expect(again.current).toEqual(before.current)
  await f.restore();expect(f.currentHeld).toBe(false);expect((await f.current()).applied).toBe(true)
  expect((await f.ctx.skills.list({ cwd:'/standing-without-agent',scope:f.ctx })).map(row=>row.name)).toEqual(['sample'])
})

it('holds a finite native provider budget including prepared versions and leaves no promise-based cleanup claim',async()=>{
  const f=await fixture()
  for(let i=0;i<limits.maxRetainedVersions;i++){const edit=await f.current();await f.publish(edit.version,`v${i}`)}
  const edit=await f.current(),before=f.prepares
  await expect(f.publish(edit.version,'over-budget')).rejects.toMatchObject({ code:'cloud/capacity' })
  expect(f.prepares).toBe(before);expect(f.saves.snapshot().failures).toEqual([])
})
