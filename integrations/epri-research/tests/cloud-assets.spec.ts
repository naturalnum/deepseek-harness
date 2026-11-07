/** Original Loader, module registry and Web server over the suite's built browser and static assets. */
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Context,FiberState} from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {ClientModuleRegistry} from '@deepseek-ai/dsh-client-modules'
import {parseBootManifest} from '@deepseek-ai/dsh-client-modules/client'
import WebServer,{type IndexInjection} from '@deepseek-ai/dsh-host-webserver'
import {afterEach,expect,it} from 'vitest'

const suite='deepscientist-harness-suite',suitePath=fileURLToPath(new URL('../',import.meta.url))
const contexts:Context[]=[],directories:string[]=[]
afterEach(async()=>{
  await Promise.all(contexts.splice(0).map(ctx=>ctx.fiber.dispose()))
  for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})
})
async function fixture(providerFirst=true){
  const directory=mkdtempSync(join(tmpdir(),'research-cloud-assets-'))
  directories.push(directory)
  mkdirSync(join(directory,'node_modules'))
  symlinkSync(suitePath,join(directory,'node_modules',suite),'dir')
  const ctx=new Context()
  contexts.push(ctx)
  ctx.baseUrl=pathToFileURL(join(directory,'cordis.yml')).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins,{modules:ClientModuleRegistry,webserver:WebServer})
  await ctx.loader.root.update([
    {id:'webserver',name:'cordis:webserver',config:{host:'127.0.0.1',port:0}},
    ...providerFirst?[{id:'modules',name:'cordis:modules'}]:[],
    {id:'research-assets',name:suite+'/cloud-assets',config:{requestTimeoutMs:180000}},
  ])
  return ctx
}
function injections(ctx:Context){
  const table:IndexInjection[]=[]
  ctx.emit('webserver/index-inject',table)
  return table
}

it.each([true,false])('advertises the actual browser factory without its research Host and withdraws with its Loader owner (providerFirst=%s)',async(providerFirst)=>{
  const ctx=await fixture(providerFirst)
  if(!providerFirst){
    expect(ctx.loader.resolve('research-assets').fiber?.state).toBe(FiberState.PENDING)
    expect(injections(ctx).some(row=>row.kind==='global'&&row.name==='__DS_RESEARCH_PUBLIC__')).toBe(false)
    await ctx.loader.root.update([...ctx.loader.root.data,{id:'modules',name:'cordis:modules'}])
  }
  await ctx.loader.await()
  expect(ctx.loader.resolve('research-assets').fiber?.state).toBe(FiberState.ACTIVE)
  const graph=ctx.clientModules.graph()
  expect(graph.entries.map(row=>row.id)).toEqual([suite])
  expect(parseBootManifest(graph).plugins.map(row=>row.id)).toEqual([suite])
  expect(injections(ctx)).toContainEqual({kind:'global',name:'__DSH_BOOT__',value:graph})
  expect(injections(ctx)).toContainEqual({kind:'global',name:'__DS_RESEARCH_PUBLIC__',value:{
    cloudRequestTimeoutMs:180000,cloud:true,platformIdentity:true,workbenchUrl:'/research/',harnessUrl:'/',
  }})
  expect([...ctx.loader.entries()].map(row=>row.options.name)).toEqual(['cordis:webserver',...providerFirst?['cordis:modules',suite+'/cloud-assets']:[suite+'/cloud-assets','cordis:modules']])
  expect(ctx.get('cloudResearch')).toBeUndefined()
  expect(ctx.get('tools')).toBeUndefined()
  const batch=graph.batches.find(row=>row.entries.includes(suite))
  if(batch===undefined)throw new Error('Actual research browser batch absent')
  const origin=ctx.webServer.getOrigin(),bundle=await fetch(new URL(batch.url,origin+'/'))
  expect(bundle.status).toBe(200)
  expect(await bundle.text()).toContain('conversation.input.dock')
  const url=origin+'/research/'
  expect(Buffer.from(await(await fetch(url)).arrayBuffer())).toEqual(readFileSync(join(suitePath,'dist/ui/index.html')))
  const head=await fetch(url,{method:'HEAD'})
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect(head.headers.get('x-content-type-options')).toBe('nosniff')
  expect(head.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  expect((await fetch(origin+'/research',{redirect:'manual'})).status).toBe(308)
  for(const path of ['app.js','app.css']){
    expect(Buffer.from(await(await fetch(url+path)).arrayBuffer())).toEqual(readFileSync(join(suitePath,'dist/ui',path)))
  }
  expect(await(await fetch(url+'public-config.js')).text()).toContain('"cloud":true')
  for(const path of ['api','auth','missing'])expect((await fetch(url+path)).status).toBe(404)
  expect((await fetch(url,{method:'POST'})).status).toBe(404)
  ctx.loader.remove('research-assets')
  await ctx.loader.await()
  expect(ctx.clientModules.graph().entries).toEqual([])
  expect(injections(ctx).some(row=>row.kind==='global'&&row.name==='__DS_RESEARCH_PUBLIC__')).toBe(false)
  expect((await fetch(url)).status).toBe(404)
})

it('uses the original duplicate declaration refusal without replacing the active browser or static resources',async()=>{
  const ctx=await fixture()
  await ctx.loader.await()
  const graph=ctx.clientModules.graph(),origin=ctx.webServer.getOrigin()
  expect(()=>ctx.clientModules.registerClientPackages([suite],ctx.baseUrl!,{activate:true})).toThrow('duplicate browser declaration')
  expect(ctx.clientModules.graph()).toBe(graph)
  expect((await fetch(origin+'/research/')).status).toBe(200)
})
