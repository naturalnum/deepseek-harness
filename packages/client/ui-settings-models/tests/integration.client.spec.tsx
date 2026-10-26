// @vitest-environment jsdom
/** Native Models store/registration and renderer-made public hooks; no backend or private React state. */
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { apply, inject } from '../src/client/index.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { IntegratedModels } from '../src/client/IntegratedModels.tsx'
import type { ModelsSettingsIntegration, ModelsSettingsMetadata } from '../src/client/integration.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsCredentialEditing } from '../src/client/operations.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const ref='DEEPSEEK_API_KEY'
function metadata(): ModelsSettingsMetadata {
  const schema=Schema.object({ apiKeyEnv:Schema.string().role('credential-ref') })
  const namespace:SettingsNamespaceView={ ns:'model-provider',schema:JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue,
    value:{ apiKeyEnv:ref },user:{},base:{},secrets:[],autoGenerate:true,applies:'live',revision:1 }
  return { providers:[{ id:'deepseek-official',name:'DeepSeek' }], configurableProviders:[{ provider:'deepseek-official',displayName:'DeepSeek',settingsNs:'model-provider',settingsPath:[] }],
    settings:{ writable:false,hasDocument:false,namespaces:[namespace] } }
}
function integration() {
  const editing=createSnapshotStore<ModelsCredentialEditing|null>(null)
  const reads={ isCurrent:()=>editing.getSnapshot()!==null,metadata:vi.fn(async()=>metadata()),
    credentials:vi.fn(async()=>({ [ref]:{ configured:true,writable:true,source:'file' as const } })) }
  return { editing,reads } satisfies ModelsSettingsIntegration
}
function TestHost({ renderSlot }:PropsRenderSlots<'settings.section'|'settings.onboarding'>) { void renderSlot; return null }
const denied=async ():Promise<never>=>{throw new Error('Native unrestricted read/write was reached')}

it('loads the original store only through the readonly page input and preserves readonly settings',async()=>{
  const ctx=new Context();onTestFinished(()=>ctx.fiber.dispose())
  const source=integration();source.editing.set({ scope:'original-page',isCurrent:()=>true,prepare:async()=>null })
  const mirror={ getSnapshot:()=>({ status:'idle' as const,view:undefined,error:null }),subscribe:()=>()=>{},ensure:denied,acceptView:()=>{} }
  const controller=new ModelsSettingsStore(ctx,settingsSchema,mirror,{ reads:source.reads,unavailable:()=>en.keyEditUnavailable })
  await controller.load()
  expect(controller.store.getSnapshot()).toMatchObject({ status:'ready',writable:false,credentialError:null })
  expect(controller.store.getSnapshot().rows[0]).toMatchObject({ apiKeyEnv:ref,credential:{ configured:true,writable:true } })
  expect(source.reads.credentials).toHaveBeenCalledExactlyOnceWith([ref])
  source.reads.metadata.mockRejectedValueOnce(new Error('PRIVATE_METADATA_ERROR'))
  await controller.load()
  expect(controller.store.getSnapshot()).toMatchObject({ status:'error',error:en.keyEditUnavailable })
  expect(JSON.stringify(controller.store.getSnapshot())).not.toContain('PRIVATE_METADATA_ERROR')
})

it('publishes original slot hooks, clears a draft on null and withdraws its source listener during HMR',async()=>{
  const mock=RemoteMock.create().load(remoteDefaultResponses),ctx=new Context(),source=integration()
  onTestFinished(async()=>{await ctx.fiber.dispose();mock.assertNoUnmatched()})
  await ctx.plugin(SlotRegistry).await();const locale=new LocaleRuntime(ctx);locale.setLocale('en');ctx.provide('locale',locale)
  new TestRemote(ctx,{ credentials:{ describe:denied,set:denied,unset:denied },
    llm:{ listProviders:denied,listConfigurableProviders:denied,discoverModels:denied },
    settings:mock.remote.settings,
    session:{ initializeDefaultModel:denied } })
  await ctx.plugin({ inject:[...settingsInject],apply:settingsApply }).await()
  let listeners=0
  const subscribe=source.editing.subscribe.bind(source.editing)
  ctx.provide('modelsSettingsIntegration',{ reads:source.reads,editing:{ getSnapshot:()=>source.editing.getSnapshot(),subscribe:(listener)=>{listeners++;const remove=subscribe(listener);return()=>{listeners--;remove()}} } })
  const removeHost=ctx.slots.register({ name:'root',children:{ 'settings.section':{ kind:'list',scope:'root' },'settings.onboarding':{ kind:'list',scope:'root' } } },TestHost)
  const plugin=ctx.plugin({ inject:[...inject],apply });await plugin.await()
  expect(ctx.slots.entries('settings.section')).toHaveLength(1)
  const entry=ctx.slots.entries('settings.section')[0]
  if(entry?.inject===undefined)throw new Error('Native Models registration missing')
  const face=entry.inject(), controller=face.controller
  if(!(controller instanceof ModelsSettingsStore))throw new Error('Native Models controller not injected')
  expect(face).toMatchObject({ hooks:{ credentialEditing:ctx.get('modelsSettingsIntegration')?.editing } })
  const store=vi.fn(async()=>undefined)
  const props={ controller,operations:{ storeCredential:denied,removeCredential:denied,writeSettings:denied,discoverModels:denied },schema:settingsSchema,t:locale.bind('settings.models'),
    useSnapshot:bindSnapshotSelector(controller.store),useCredentialEditing:bindSnapshotSelector(source.editing),renderSlot:()=>null }
  const view=render(<IntegratedModels {...props}/> )
  await act(async()=>{source.editing.set({ scope:'native-page',isCurrent:()=>true,prepare:async()=>({ ref,store,remove:async()=>undefined }) })})
  fireEvent.click(await screen.findByRole('button',{ name:en.editKey }))
  fireEvent.change(await screen.findByLabelText(en.keyInput),{ target:{ value:'synthetic-draft-only' } })
  await act(async()=>{locale.setLocale('zh')})
  view.rerender(<IntegratedModels {...props}/> )
  expect(screen.getByLabelText(zh.keyInput)).toHaveProperty('value','synthetic-draft-only')
  expect(screen.getByRole('button',{ name:zh.apply })).toHaveProperty('disabled',false)
  await act(async()=>{source.editing.set(null)})
  expect(screen.queryByLabelText(zh.keyInput)).toBeNull();expect(store).not.toHaveBeenCalled()
  expect(listeners).toBeGreaterThan(0)
  view.unmount();await plugin.dispose();expect(listeners).toBe(0)
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  const again=ctx.plugin({ inject:[...inject],apply });await again.await()
  expect(ctx.slots.entries('settings.section')).toHaveLength(1)
  await again.dispose();expect(listeners).toBe(0);removeHost()
  await waitFor(()=>{ expect(ctx.slots.entries('settings.section')).toHaveLength(0) })
})
