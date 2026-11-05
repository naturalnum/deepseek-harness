/** Real public SDK HealthAdapter and bootstrap consumer; only the HTTP transport is a finite component fake. */
import { expect, it, onTestFinished } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadBootstrapPayload, TrustedSdkBootstrap, type BootstrapConfig } from '../src/bootstrap/bootstrap.ts'
import { sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'
import type { AgentReadinessBudget, AgentSelection } from '../src/lifecycle-types.ts'
import { AGENT_SOURCE_SHA256 } from '../src/agent-data/index.ts'

async function fixture(options: { statuses?: number[]
  wireError?: boolean
  command502?: boolean
  replyBytes?: number
  lifecycleByteLimit?: number
  cancelAfterReply?: boolean
  pendingHealth?: boolean
  pendingClose?: boolean } = {}) {
  const deployment = sharedPathDeploymentFixture(), source = fileURLToPath(new URL('../runtime/', import.meta.url))
  const settings: BootstrapConfig = { ...deployment.bootstrap, lifecycle: { ...deployment.lifecycle, platform: 'arm64' }, assertDeploymentCurrent() {} }
  const payload = await loadBootstrapPayload(join(source, 'bootstrap'), join(source, 'agent'))
  const root: AgentSelection['mount']['grant']['project'] = { rootPath: '/project', rootDevice: '5', rootInode: '11', rootMountId: '10', mountVersion: 'mount',
    quota: { device: '5', mountId: '10', maximumBytes: '8388608', maximumInodes: '128' }, readOnlyPaths: ['.pe'],
    metadataDirectory: { relativePath: '.pe', device: '5', inode: '13', mountId: '10', uid: 2000, gid: 2000, mode: 0o40700 } }
  const intent: AgentSelection['intent'] = { allocationId: 'readiness-allocation' as AgentSelection['intent']['allocationId'],
    accountId: 'account' as AgentSelection['intent']['accountId'], epoch: '73' as AgentSelection['intent']['epoch'],
    sessionId: 'session' as AgentSelection['intent']['sessionId'], workspaceId: 'workspace' as AgentSelection['intent']['workspaceId'],
    environmentVersion: settings.lifecycle.environmentVersion, provider: settings.lifecycle.provider,
    projectMountVersion: 'mount', requestedAt: new Date().toISOString(), createDeadlineAt: new Date(Date.now()+10000).toISOString() }
  const selection: AgentSelection = { intent, sandboxId: 'readiness-sandbox', imageDigest: settings.lifecycle.imageDigest,
    payloadSha256: AGENT_SOURCE_SHA256, deploymentIdentity: settings.lifecycle.deploymentIdentity,
    mount: { assertCurrent() {}, exports: { project: '/export/project', protectedProject: '/export/project/.pe', environment: '/export/env' },
      grant: { binding: { accountId: intent.accountId, epoch: intent.epoch, recipeVersion: 'original', lifetime: new AbortController().signal },
        sessionId: intent.sessionId, workspaceId: intent.workspaceId, project: root,
        environment: { ...root, rootPath: '/env', rootDevice: '6', targetPath: '/opt/session-env', bankId: 'bank', slotId: 'slot',
          slotGeneration: 1, environmentVersion: intent.environmentVersion, rootReadOnly: true, writablePaths: ['home','venv','tmp'],
          layout: { home:{ device:'6',inode:'12',mountId:'20',uid:2000,gid:2000,mode:0o40700 },
            venv:{ device:'6',inode:'13',mountId:'20',uid:2000,gid:2000,mode:0o40700 },
            tmp:{ device:'6',inode:'14',mountId:'20',uid:2000,gid:2000,mode:0o40700 } } } } } }
  const requests: string[] = [], statuses = [...options.statuses ?? [200]], control = new AbortController()
  const healthEntered=Promise.withResolvers<undefined>(),healthReply=Promise.withResolvers<undefined>()
  const closeEntered=Promise.withResolvers<undefined>(),closeRelease=Promise.withResolvers<undefined>()
  let commands=0, health=0, charged=0, factories=0, closes=0
  const bootstrap = new TrustedSdkBootstrap(settings,payload,()=>{
    factories++;return { close:async()=>{
      closes++;closeEntered.resolve(undefined);if(options.pendingClose)await closeRelease.promise
    },fetch:async(input,init)=>{
      const r=new Request(input,init),url=new URL(r.url);requests.push(r.method+' '+url.pathname)
      if(r.body!==null)await r.arrayBuffer()
      if(url.pathname.includes('/endpoints/'))return Response.json({ endpoint:`${url.host}/v1/sandboxes/readiness-sandbox/proxy/${url.pathname.split('/').at(-1)}` })
      if(url.pathname.endsWith('/ping')){
        health++;healthEntered.resolve(undefined)
        if(options.pendingHealth)return new Response(new ReadableStream({ async start(c){
          await healthReply.promise;c.enqueue(new TextEncoder().encode('pong'));c.close()
        } }))
        if(options.wireError)return new Response(new ReadableStream({ start(c){c.error(new Error('private health wire error'))} }))
        const status=statuses.shift()??503;const reply=new Response('x'.repeat(options.replyBytes??4),{ status })
        if(options.cancelAfterReply)control.abort(new Error('original caller aborted'))
        return reply
      }
      if(url.pathname.endsWith('/files/upload'))return Response.json({})
      expect(url.pathname.endsWith('/command')).toBe(true);commands++
      if(options.command502)return new Response('private command fault',{ status:502 })
      const rows=[{ type:'init',text:'original' },{ type:'stdout',text:commands===1?'s4-bootstrap-claimed\n':'s4-bootstrap-started\n' },{ type:'execution_complete' }]
      return new Response(rows.map(v=>JSON.stringify(v)+'\n').join(''),{ headers:{ 'content-type':'text/event-stream' } })
    } }})
  const readiness: AgentReadinessBudget = { remainingPolls:2,intervalMs:1,deadlineAtMs:Date.now()+10000,chargeReplyBytes(bytes){
    charged+=bytes;if(charged>(options.lifecycleByteLimit??settings.lifecycle.maxOperationBytes))throw new Error('original lifecycle byte budget')
  } }
  onTestFinished(async()=>{
    healthReply.resolve(undefined);closeRelease.resolve(undefined);control.abort()
    await bootstrap.fence(selection).whenJoined.catch((_cause:unknown)=>{
      /* Negative wire cases intentionally retain original failure. */
    })
  })
  return { bootstrap,selection,readiness,healthEntered,healthReply,closeEntered,closeRelease,
    signal:control.signal,requests,settings,get commands(){return commands},get health(){return health},
    get charged(){return charged},get factories(){return factories},get closes(){return closes} }
}

it('uses one shared remaining N-k pool, accepts a settled negative then positive health and preserves all14 protocol requests',async()=>{
  const f=await fixture({ statuses:[503,200] });const pending=f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)
  expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).toBe(pending);await pending
  expect(f.health).toBe(2);expect(f.commands).toBe(2);expect(f.charged).toBe(8)
  expect(f.requests.filter(v=>!v.endsWith('/ping'))).toHaveLength(14);expect(f.requests).toHaveLength(16)
  expect(f.requests.findIndex(v=>v.endsWith('/command'))).toBeGreaterThan(f.requests.findLastIndex(v=>v.endsWith('/ping')))
  await expect(f.bootstrap.fence(f.selection).whenJoined).resolves.toBeUndefined();expect(f.closes).toBe(1)
})
it('zero remaining original observations fails before any transport or privileged command',async()=>{
  const f=await fixture()
  await expect(f.bootstrap.bootstrap(f.selection,f.signal,{ ...f.readiness,remainingPolls:0 })).rejects.toMatchObject({ code:'sdk/ready-unconfirmed' })
  expect(f.factories).toBe(0);expect(f.requests).toHaveLength(0);expect(f.commands).toBe(0)
  await expect(f.bootstrap.fence(f.selection).whenJoined).resolves.toBeUndefined()
})
it('exhausted settled health observations never submit a command and retain a sticky failed start promise',async()=>{
  const f=await fixture({ statuses:[503,503] });const pending=f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)
  await expect(pending).rejects.toMatchObject({ code:'sdk/ready-unconfirmed' });expect(f.health).toBe(2);expect(f.commands).toBe(0)
  expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).toBe(pending)
  await expect(f.bootstrap.fence(f.selection).whenJoined).resolves.toBeUndefined()
})
it('wire failure is not an unhealthy retry and privileged closure remains unknown',async()=>{
  const f=await fixture({ wireError:true })
  await expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).rejects.toMatchObject({ code:'wire-unknown' })
  expect(f.health).toBe(1);expect(f.commands).toBe(0)
  await expect(f.bootstrap.fence(f.selection).whenJoined).rejects.toMatchObject({ code:'wire-unknown' })
})
it.each(['response','shared bytes'] as const)('health retains the original %s bound and never continues after overflow',async (kind)=>{
  const limits=sharedPathDeploymentFixture()
  const f=await fixture(kind==='response'?{ replyBytes:Math.min(limits.bootstrap.maxReplyBytes,limits.lifecycle.maxResponseBytes)+1 }:{ statuses:[503,200],lifecycleByteLimit:6 })
  await expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).rejects.toMatchObject({ code:'wire-unknown' });expect(f.commands).toBe(0)
  await expect(f.bootstrap.fence(f.selection).whenJoined).rejects.toMatchObject({ code:'wire-unknown' })
})
it('original absolute deadline is not refreshed before the health phase',async()=>{
  const f=await fixture()
  await expect(f.bootstrap.bootstrap(f.selection,f.signal,{ ...f.readiness,deadlineAtMs:Date.now()-1 })).rejects.toMatchObject({ code:'bounds' })
  expect(f.requests).toHaveLength(0);expect(f.commands).toBe(0)
  await expect(f.bootstrap.fence(f.selection).whenJoined).resolves.toBeUndefined()
})
it('caller cancellation after a settled health reply cannot start another poll or prep',async()=>{
  const f=await fixture({ statuses:[503,200],cancelAfterReply:true })
  await expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).rejects.toThrow()
  expect(f.health).toBe(1);expect(f.commands).toBe(0)
  await expect(f.bootstrap.fence(f.selection).whenJoined).resolves.toBeUndefined()
})
it('a real command HTTP502 remains unknown and cannot replay after successful health',async()=>{
  const f=await fixture({ command502:true });const pending=f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)
  await expect(pending).rejects.toMatchObject({ code:'wire-unknown' });expect(f.health).toBe(1);expect(f.commands).toBe(1)
  expect(f.bootstrap.bootstrap(f.selection,f.signal,f.readiness)).toBe(pending);expect(f.commands).toBe(1)
  await expect(f.bootstrap.fence(f.selection).whenJoined).rejects.toMatchObject({ code:'wire-unknown' })
})


it('Root fence waits for health EOF and actual dispatcher close and never admits a late healthy reply',async()=>{
  const f=await fixture({ pendingHealth:true,pendingClose:true })
  const pending=f.bootstrap.bootstrap(f.selection,f.signal,f.readiness), rejected=expect(pending).rejects.toMatchObject({ code:'closed' })
  await f.healthEntered.promise
  const fenced=f.bootstrap.fence(f.selection);let joined=false
  void fenced.whenJoined.then(()=>{joined=true},()=>{joined=true})
  await Promise.resolve(undefined);expect(joined).toBe(false);expect(f.closes).toBe(0)
  f.healthReply.resolve(undefined);await f.closeEntered.promise
  expect(joined).toBe(false);expect(f.commands).toBe(0);expect(f.health).toBe(1)
  f.closeRelease.resolve(undefined);await rejected;await fenced.whenJoined
  expect(joined).toBe(true);expect(f.requests.filter(v=>v.startsWith('POST'))).toHaveLength(0)
})
