// @vitest-environment jsdom
/** Original PreparedCloudPage/Loader/Connection and worker5's unchanged public slot/row. All carriers are local fixtures. */
import { useState } from 'react'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { PreparedCloudPage as PublicPage, CloudServicePreviewNavigation, CloudServicePreviewSelection } from '@deepseek-ai/dsh-pe-cloud-client/client'
import type { CloudServicePreviewPolicy } from '@deepseek-ai/dsh-pe-cloud-client/types'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import * as cloud from '../src/client/index.ts'
import { PreparedCloudPage, type CloudPagePreparationInput } from '../src/client/prepared-page.ts'
import { parseCloudClientConfig, parseCloudWebManifest } from '../src/config.ts'
import type { CloudServicePreviewPage } from '../src/client/service-previews.ts'
import { ServicePreviewRow, type ServicePreviewRowProps } from '../src/client/ServicePreviewRow.tsx'
import { SERVICE_PREVIEW_NAMESPACE } from '../src/client/service-preview-locales.ts'
expectTypeOf<PreparedCloudPage>().toExtend<CloudServicePreviewPage>()
expectTypeOf<PublicPage['servicePreviewNavigation']>().toEqualTypeOf<CloudServicePreviewNavigation | undefined>()
expectTypeOf<keyof CloudServicePreviewSelection>().toEqualTypeOf<'sessionId' | 'serviceHandle'>()
expectTypeOf<keyof CloudServicePreviewPolicy>().toEqualTypeOf<'managementOrigin' | 'previewOrigin' | 'routePath' | 'maxFieldBytes' | 'maxUrlBytes'>()
const policy = { managementOrigin: 'http://console.dsh.localhost:32848', previewOrigin: 'http://preview.dsh.localhost:32848',
  routePath: '/cloud/service-preview', maxFieldBytes: 128, maxUrlBytes: 2048 }
const config = { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
  maxErrorResponseBytes: 512, maxPendingFetches: 2, maxSockets: 1, closeTimeoutMs: 1000 }
const id = SessionId('framework-session')
function data(available = true, account = 'original-page-account', generation = 'original-page-generation'): CloudBootstrap {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  return { account: { id: account, displayName: 'Fixture' }, recipeVersion: 'r04-fixture', connectionGeneration: generation,
    capabilities: { projects: disabled, filePreview: disabled, shell: disabled, developmentServices: disabled,
      servicePreview: available ? { state: 'available' } : disabled, sandboxScope: 'session', backgroundJobs: false,
      localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'fixture', plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] } } }
}
class Socket implements ConnectionWebSocket {
  readyState = 1
  private readonly listeners = new Set<() => void>()
  send(): void {}
  close(): void { this.readyState = 3; for (const fn of this.listeners) fn() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (name, listener) => { if (name === 'close') this.listeners.add(() =>{  listener({ data: undefined }) }) }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
function fixture(options: { available?: boolean; policy?: boolean; driver?: boolean; account?: string; generation?: string } = {}) {
  const values = new Map<string,string>(), open = vi.fn<(url:string) => void>(), refused = vi.fn<(code:'closed'|'target-denied') => void>()
  const original = data(options.available ?? true, options.account, options.generation)
  const input: CloudPagePreparationInput = { baseUrl: policy.managementOrigin + '/', config: { ...config,
    ...options.policy === false ? {} : { servicePreview: { ...policy } } },
  decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 512, maxListItems: 32 },
  persistenceLimits: { maxKeys: 8, maxKeyBytes: 256, maxValueBytes: 1024, maxTotalBytes: 8192, maxNamespaceBytes: 256 },
  fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  storage: { getItem: key => values.get(key) ?? null, setItem: (key,value) => { values.set(key,value) },
    removeItem: (key) => { values.delete(key) } },
  fetch: async () => Response.json(original), createWebSocket: () => new Socket(),
  ...options.driver === false ? {} : { previewNavigation: { open, refused } } }
  const preparation = PreparedCloudPage.prepare(input, new AbortController().signal)
  onTestFinished(() => preparation.dispose())
  return { preparation, input, open, refused }
}
function Host(_props: PropsRenderSlots<'tool.call.toolview'>) { return null }
const useDisclosure = () => { const [expanded, set] = useState(false); return { expanded, toggle: () => { set(v => !v) } } }
function block(): ToolResultNode { return { kind:'tool-result',seq:0,time:0,callId:'call',name:'dev_service',args:PartialArguments.EMPTY,
  callTime:0,call:{ name:'dev_service',argsRaw:'{}' },content:[{ type:'text',text:'process observation' }],isError:false,subCalls:[],
  meta:{ kind:'cloud-dev-service-v1',action:'status',serviceHandle:'recorded-handle',processSubmitted:true } } }
async function native(page: PreparedCloudPage) {
  const ctx = new Context()
  const entry = { async run() {
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale',new LocaleRuntime(ctx,undefined,{ preference:'en',languages:['en'] }))
    ctx.slots.register({ name:'root',children:{ 'tool.call.toolview':{ kind:'keyed',scope:'session' } } },Host)
    ctx.provide('clientPersistence',page.nativeOptions.persistence); page.nativeOptions.prepareContext(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.cloud=cloud
    await ctx.loader.create({ name:'cordis:cloud' });await ctx.loader.await()
    if ([...ctx.loader.entries()].some(row => row.fiber?.state !== FiberState.ACTIVE)) throw Error('Native Cloud entry inactive')
  }, async dispose() { await ctx.fiber.dispose() } }
  await page.start(entry)
  return { ctx,entry,row:() => ctx.get('slots')?.entries('tool.call.toolview').find(row=>row.options.key==='dev_service') }
}
afterEach(cleanup)
it('provides the actual page callback to worker5 original installer and row; only captured C02 plus Session/handle navigate', async () => {
  const f=fixture(), page=await f.preparation.ready, graph=await native(page)
  await waitFor(()=>{ expect(graph.row()).toBeDefined() })
  const row=graph.row()!;if(row.inject===undefined)throw Error('Missing native injection')
  const Component=row.component as typeof ServicePreviewRow
  const props={ ...row.inject(),sessionId:id,useDisclosure,toolName:'dev_service',callId:'call',phase:'result',block:block(),t:graph.ctx.locale.bind(SERVICE_PREVIEW_NAMESPACE) } as ServicePreviewRowProps
  render(<Component {...props}/>);fireEvent.click(screen.getByRole('button',{ name:'Open controlled preview' }))
  expect(f.open).toHaveBeenCalledTimes(1)
  const url=new URL(f.open.mock.calls[0]![0])
  expect(url.origin).toBe(policy.previewOrigin);expect(url.pathname).toBe(policy.routePath)
  expect(Object.fromEntries(url.searchParams)).toEqual({ sessionId:id,serviceHandle:'recorded-handle',peAccount:'original-page-account',peGeneration:'original-page-generation' })
  expect(f.refused).not.toHaveBeenCalled();expect(screen.queryByRole('link')).toBeNull()
  await act(async()=>{await page.dispose()});await waitFor(()=>{ expect(graph.row()).toBeUndefined() })
})
it.each([{ policy:false },{ driver:false },{ available:false }])('omission or disabled bootstrap keeps actual page/worker5 entry closed: %j', async (options) => {
  const f=fixture(options),page=await f.preparation.ready,graph=await native(page)
  expect(page.servicePreviewNavigation).toBeUndefined();expect(graph.row()).toBeUndefined();expect(f.open).not.toHaveBeenCalled()
})
it('old page callback cannot navigate after revoke and handles rejection feedback without escaping', async()=>{
  const f=fixture(),page=await f.preparation.ready;await native(page)
  const callback=page.servicePreviewNavigation!;await page.dispose()
  expect(()=>{ callback({ sessionId:id,serviceHandle:'recorded-handle' }) }).not.toThrow()
  expect(f.open).not.toHaveBeenCalled();expect(f.refused).toHaveBeenLastCalledWith('closed')
})
it('before native activation the callback refuses; malformed selectors and failed navigation remain contained',async()=>{
  const f=fixture(),page=await f.preparation.ready,callback=page.servicePreviewNavigation!
  callback({ sessionId:id,serviceHandle:'recorded-handle' });expect(f.refused).toHaveBeenLastCalledWith('closed')
  await native(page);f.refused.mockClear()
  for(const selected of [{ sessionId:id,serviceHandle:'bad/handle' },{ sessionId:id,serviceHandle:'recorded-handle',accountId:'foreign' }])
    expect(()=>{ callback(selected) }).not.toThrow()
  expect(f.open).not.toHaveBeenCalled();expect(f.refused).toHaveBeenCalledTimes(2)
  f.open.mockImplementation(()=>{throw Error('Do not expose URL or raw navigation failure')})
  expect(()=>{ callback({ sessionId:id,serviceHandle:'recorded-handle' }) }).not.toThrow();expect(f.refused).toHaveBeenLastCalledWith('target-denied')
})
it('original page capture survives mutable preparation inputs and refuses callback URL budget excess',async()=>{
  const f=fixture(),page=await f.preparation.ready
  f.input.fields.accountQuery='foreign';if(f.input.config.servicePreview)Reflect.set(f.input.config.servicePreview,'previewOrigin','http://foreign.localhost:32848')
  if(f.input.previewNavigation)f.input.previewNavigation.open=()=>{throw Error('Mutated driver must not be consulted')}
  await native(page);page.servicePreviewNavigation!({ sessionId:id,serviceHandle:'recorded-handle' })
  expect(new URL(f.open.mock.calls[0]![0]).searchParams.get('peAccount')).toBe('original-page-account')
  const small=fixture();small.input.config.servicePreview={ ...policy,maxUrlBytes:20 }
  // The input changed after prepare, so this separate new prepare explicitly captures the smaller policy.
  const p=PreparedCloudPage.prepare(small.input,new AbortController().signal);onTestFinished(()=>p.dispose())
  const limited=await p.ready;await native(limited);limited.servicePreviewNavigation!({ sessionId:id,serviceHandle:'recorded-handle' })
  expect(small.open).not.toHaveBeenCalled();expect(small.refused).toHaveBeenLastCalledWith('target-denied')
})
it('public manifest validates/freezes complete policy without expanding C11 available data',()=>{
  expect(()=>parseCloudClientConfig({ ...config,servicePreview:{ ...policy,routePath:null } })).toThrow()
  expect(()=>parseCloudClientConfig({ ...config,servicePreview:{ ...policy,cookieDomain:'dsh.localhost' } })).toThrow()
  expect(()=>parseCloudClientConfig({ ...config,servicePreview:Object.assign(Object.create({ foreign:true }) as object,policy) })).toThrow()
  const manifest=parseCloudWebManifest({ client:{ ...config,servicePreview:policy },
    decodeLimits:{ maxBodyBytes:8192,maxStringBytes:512,maxListItems:32 },
    persistenceLimits:{ maxKeys:8,maxKeyBytes:256,maxValueBytes:1024,maxTotalBytes:8192,maxNamespaceBytes:256 },fields:{ accountHeader:'x-pe-account',generationHeader:'x-pe-generation',accountQuery:'peAccount',generationQuery:'peGeneration' },auth:{ requestTimeoutMs:1000,maxRequestBytes:1024,maxResponseBytes:8192 } })
  expect(Object.isFrozen(manifest.client.servicePreview)).toBe(true)
})
it('an old callback never adopts a replacement page account/generation, including after its original page closes',async()=>{
  const a=fixture({ account:'A',generation:'G1' }),pa=await a.preparation.ready;await native(pa)
  const callback=pa.servicePreviewNavigation!
  const b=fixture({ account:'B',generation:'G2' }),pb=await b.preparation.ready;await native(pb)
  callback({ sessionId:id,serviceHandle:'same-handle' });pb.servicePreviewNavigation!({ sessionId:id,serviceHandle:'same-handle' })
  expect(new URL(a.open.mock.calls[0]![0]).searchParams.get('peAccount')).toBe('A')
  expect(new URL(b.open.mock.calls[0]![0]).searchParams.get('peGeneration')).toBe('G2')
  await pa.dispose();callback({ sessionId:id,serviceHandle:'same-handle' })
  expect(a.open).toHaveBeenCalledTimes(1);expect(b.open).toHaveBeenCalledTimes(1)
})
it('feedback failure is contained without logging a selector, URL or underlying exception',async()=>{
  const f=fixture(),page=await f.preparation.ready;await native(page)
  f.refused.mockImplementation(()=>{throw Error('private fixture')})
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});onTestFinished(()=>{ log.mockRestore() })
  expect(()=>{ page.servicePreviewNavigation!({ sessionId:id,serviceHandle:'bad/handle' }) }).not.toThrow()
  expect(log).toHaveBeenCalledExactlyOnceWith('Cloud preview navigation feedback unavailable.')
  expect(f.open).not.toHaveBeenCalled()
})
it('C11 decoder still rejects fabricated policy fields inside the descriptive available capability',async()=>{
  const f=fixture(),value=data()
  const p=PreparedCloudPage.prepare({ ...f.input,fetch:async()=>Response.json({ ...value,capabilities:{ ...value.capabilities,
    servicePreview:{ state:'available',policy } } }) },new AbortController().signal)
  onTestFinished(()=>p.dispose())
  await expect(p.ready).rejects.toThrow();expect(f.open).not.toHaveBeenCalled()
})
it('the preview-only method never widens original management navigation, HTTP/RPC or WS guards',async()=>{
  const f=fixture(),page=await f.preparation.ready,transport=page.lifetime.transport
  const target=policy.previewOrigin+policy.routePath
  expect(()=>transport.navigationUrl(target)).toThrow()
  expect(()=>transport.hooks.fetch!(target,{ method:'POST',body:'{}' })).toThrow()
  expect(()=>transport.hooks.createWebSocket!('ws://preview.dsh.localhost:32848/api/remote.mux')).toThrow()
  expect(new URL(transport.navigationUrl('/api/session/list')).searchParams.get('peGeneration')).toBe('original-page-generation')
  expect(f.open).not.toHaveBeenCalled()
})
