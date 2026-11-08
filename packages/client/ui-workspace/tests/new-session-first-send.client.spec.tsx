// @vitest-environment jsdom
/** Actual navigation, reference adapter and composer; only Host creation/prompt are scripted. */
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { InputHub } from '../../ui-conversation/src/client/input/hub.ts'
import { UiWorkspaceService } from '../src/client/navigation.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { en, zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')
const OLD=SessionId('old'), NEXT=SessionId('next'), LATER=SessionId('later'), WORKSPACE='workspace-qa' as WorkspaceId
const runtimes: SlotTestRuntime[]=[]
const fonts=Object.getOwnPropertyDescriptor(document,'fonts')
beforeEach(()=>{
  localStorage.clear()
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
  Object.defineProperty(document,'fonts',{ configurable:true,value:new EventTarget() })
  Range.prototype.getBoundingClientRect=()=>({ top:0,bottom:0,left:0,right:0,width:0,height:0,x:0,y:0,toJSON:()=>({}) })
})
afterEach(async()=>{cleanup();for(const r of runtimes.splice(0))await r.dispose();vi.unstubAllGlobals();vi.restoreAllMocks();if(fonts===undefined)Reflect.deleteProperty(document,'fonts');else Object.defineProperty(document,'fonts',fonts)})
function Root({ renderSlot,startSession }:PropsRenderSlots<'main'>&{ startSession:()=>void }){
  return <><button onClick={startSession}>新建测试会话</button>{renderSlot('main',{}, { entryKey:'conversation' })}</>
}
async function bench(){
  const runtime=await SlotTestRuntime.create();runtimes.push(runtime)
  const locale=new LocaleRuntime(runtime.ctx);runtime.ctx.provide('locale',locale);runtime.slots.installLocale(locale)
  runtime.ctx.effect(()=>locale.register('workspace',{ en,zh }))
  runtime.ctx.provide('configForms',{ developerTools:{ enabled:createSnapshotStore(true) },get:()=>stubConfigForm().scope } as never)
  const layout=new LayoutController({
    selectPanel:id=>runtime.panelInfo.set({ activePanelId:id }),retainMainPanels:vi.fn(),setSidebar:vi.fn(),
    toggleSidebar:vi.fn(),setViewportWidth:vi.fn(),setRightbar:vi.fn(),openRightbar:vi.fn(),closeRightbar:vi.fn(),
  },()=>true,runtime.panelInfo)
  runtime.ctx.provide('layout',layout);runtime.ctx.effect(()=>()=>{layout.dispose()})
  await runtime.workspaces.update((s)=>{s.phase='pending'})
  const prompts=new Map<SessionId,ReturnType<typeof vi.fn<ISession['prompt']>>>()
  for(const id of [OLD,NEXT,LATER]){
    const prompt=vi.fn<ISession['prompt']>(async()=>({ ok:true,value:{ accepted:true } }));prompts.set(id,prompt)
    await runtime.sessions.add({ id,summary:{ title:id,displayTitle:id,cwd:'/project',blank:true },snapshot:{ blank:true },session:{ prompt } })
  }
  const picker:ClientRemote['directoryPicker']={ pick:async()=>{throw Error('unused picker')},list:async()=>{throw Error('unused listing')},createDirectory:async()=>{throw Error('unused directory')} }
  const notify=vi.fn(),uiWorkspace=new UiWorkspaceService(
    runtime.ctx,picker,runtime.workspaces,runtime.sessions,createWorkspaceViewStore().create().actions,notify,
  )
  act(()=>{uiWorkspace.openSession(OLD)})
  await runtime.workspaces.update((s)=>{s.phase='ready';s.state='idle';s.items=[{ workspaceId:WORKSPACE,path:'/project',title:'QA',sessionIds:[OLD,NEXT,LATER],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z' }]})
  await runtime.mount({ inject:[...inject],apply })
  runtime.slots.register({ name:'root',children:{ main:{ kind:'keyed',scope:'root' } },inject:()=>({ startSession:()=>{uiWorkspace.startSession()} }) },Root)
  const view=runtime.renderRoot(),hub=runtime.ctx.conversation.input as InputHub,original=hub.shell(OLD)
  act(()=>{original.setDraft('preserve original draft')})
  return { runtime,uiWorkspace,view,hub,original,prompts,notify }
}

it('blocks immediate Enter/Send to the old composer while creation waits, then sends once to the new Session',async()=>{
  const b=await bench(),created=Promise.withResolvers<SessionId>()
  b.runtime.sessions.stubCreate(()=>created.promise)
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  const pending=b.view.container.querySelector<HTMLElement>('[data-composer-input]')
  expect(pending?.getAttribute('contenteditable')).not.toBe('true')
  expect(b.view.getByRole('button',{ name:'发送消息' })).toHaveProperty('disabled',true)
  if(pending!==null)fireEvent.keyDown(pending,{ key:'Enter' })
  fireEvent.click(b.view.getByRole('button',{ name:'发送消息' }))
  expect(b.prompts.get(OLD)).not.toHaveBeenCalled()
  expect(b.original.snapshot.draft).toBe('preserve original draft')
  expect(b.runtime.sessions.binding(OLD)?.ctx).toBeDefined()
  await act(async()=>{created.resolve(NEXT);await created.promise})
  await waitFor(()=>{expect(b.view.container.querySelector('[data-composer-input]')?.getAttribute('contenteditable')).toBe('true')})
  act(()=>{b.hub.shell(NEXT).setDraft('new Session only')})
  fireEvent.click(b.view.getByRole('button',{ name:'发送消息' }))
  await waitFor(()=>{expect(b.prompts.get(NEXT)).toHaveBeenCalledOnce()})
  expect(b.prompts.get(NEXT)?.mock.calls[0]?.[0]).toEqual([{ type:'text',text:'new Session only' }])
  expect(b.prompts.get(OLD)).not.toHaveBeenCalled()
  expect(b.runtime.sessions.retainInfo(OLD).getSnapshot().referenceCount).toBe(0)
})

it('restores the same scope and complete draft after creation fails, without sending or retrying',async()=>{
  const b=await bench(),created=Promise.withResolvers<SessionId>()
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{})
  b.runtime.sessions.stubCreate(()=>created.promise)
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  await act(async()=>{created.reject(Error('creation refused'));await Promise.resolve()})
  await waitFor(()=>{expect(b.view.container.querySelector('[data-composer-input]')?.getAttribute('contenteditable')).toBe('true')})
  expect(b.hub.shell(OLD)).toBe(b.original)
  expect(b.original.snapshot.draft).toBe('preserve original draft')
  expect(b.view.container.querySelector('[data-composer-input]')?.textContent).toContain('preserve original draft')
  expect(b.notify).toHaveBeenCalledWith({ kind:'createFailed',message:'creation refused' })
  expect(b.runtime.sessions.calls.filter(c=>c.method==='create')).toHaveLength(1)
  expect(b.prompts.get(OLD)).not.toHaveBeenCalled()
  expect(warning).toHaveBeenCalledOnce()
})

it('does not restore the old view when a newer navigation supersedes failed creation',async()=>{
  const b=await bench(),created=Promise.withResolvers<SessionId>()
  vi.spyOn(console,'warn').mockImplementation(()=>{})
  b.runtime.sessions.stubCreate(()=>created.promise)
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  act(()=>{b.uiWorkspace.openSession(LATER)})
  act(()=>{b.hub.shell(LATER).setDraft('later draft')})
  await act(async()=>{created.reject(Error('late creation failure'));await Promise.resolve()})
  expect(b.runtime.sessions.retainInfo(LATER).getSnapshot().retainedBy.mainView).toBe(1)
  expect(b.runtime.sessions.retainInfo(OLD).getSnapshot().referenceCount).toBe(0)
  expect(b.view.container.querySelector('[data-composer-input]')?.textContent).toContain('later draft')
  expect(b.notify).not.toHaveBeenCalled()
  for(const prompt of b.prompts.values())expect(prompt).not.toHaveBeenCalled()
})

it('keeps the latest of two pending new-session navigations and releases every parked reference',async()=>{
  const b=await bench(),first=Promise.withResolvers<SessionId>(),second=Promise.withResolvers<SessionId>()
  let count=0;b.runtime.sessions.stubCreate(()=>++count===1?first.promise:second.promise)
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  await act(async()=>{second.resolve(LATER);await second.promise})
  act(()=>{b.hub.shell(LATER).setDraft('latest wins')})
  await act(async()=>{first.resolve(NEXT);await first.promise})
  expect(b.runtime.sessions.retainInfo(LATER).getSnapshot().retainedBy.mainView).toBe(1)
  expect(b.runtime.sessions.retainInfo(OLD).getSnapshot().referenceCount).toBe(0)
  expect(b.runtime.sessions.retainInfo(NEXT).getSnapshot().referenceCount).toBe(0)
  expect(b.view.container.querySelector('[data-composer-input]')?.textContent).toContain('latest wins')
})

it('restores the original draft if the latest pending creation fails and ignores an older late success',async()=>{
  const b=await bench(),first=Promise.withResolvers<SessionId>(),second=Promise.withResolvers<SessionId>()
  vi.spyOn(console,'warn').mockImplementation(()=>{})
  let count=0;b.runtime.sessions.stubCreate(()=>++count===1?first.promise:second.promise)
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  fireEvent.click(b.view.getByRole('button',{ name:'新建测试会话' }))
  await act(async()=>{second.reject(Error('latest refused'));await Promise.resolve()})
  expect(b.hub.shell(OLD)).toBe(b.original)
  expect(b.original.snapshot.draft).toBe('preserve original draft')
  await act(async()=>{first.resolve(NEXT);await first.promise})
  expect(b.runtime.sessions.retainInfo(OLD).getSnapshot().retainedBy).toEqual({ mainView:1 })
  expect(b.runtime.sessions.retainInfo(NEXT).getSnapshot().referenceCount).toBe(0)
  expect(b.view.container.querySelector('[data-composer-input]')?.textContent).toContain('preserve original draft')
  expect(b.notify).toHaveBeenCalledExactlyOnceWith({ kind:'createFailed',message:'latest refused' })
})

it('restores the original draft when synchronous preparation rejects the newly created target',async()=>{
  const b=await bench();b.runtime.sessions.stubCreate(async()=>NEXT)
  await act(async()=>{
    await expect(b.uiWorkspace.openWorkspace(WORKSPACE,()=>{throw Error('draft preparation refused')})).rejects.toThrow('draft preparation refused')
  })
  expect(b.hub.shell(OLD)).toBe(b.original)
  expect(b.original.snapshot.draft).toBe('preserve original draft')
  expect(b.runtime.sessions.retainInfo(OLD).getSnapshot().retainedBy).toEqual({ mainView:1 })
  expect(b.runtime.sessions.retainInfo(NEXT).getSnapshot().referenceCount).toBe(0)
  expect(b.notify).not.toHaveBeenCalled()
})
