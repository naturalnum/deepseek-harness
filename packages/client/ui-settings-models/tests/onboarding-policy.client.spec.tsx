// @vitest-environment jsdom
/** Original Models registration and Settings coordinator; wire reads are readonly fixtures and no persistence is simulated. */
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel,type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote,allowAllAccess,bindSnapshotSelector,makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock,ok } from '@deepseek-ai/dsh-remote-mock'
import { apply as settingsApply,inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { SidebarSettingsOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,expect,it,onTestFinished,vi } from 'vitest'
import { apply,inject } from '../src/client/index.ts'
import type { ModelsCredentialEditing,ModelsSettingsIntegration,ModelsSettingsMetadata } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { IntegratedModels } from '../src/client/IntegratedModels.tsx'
import { settingsSchema } from './settings-schema.client.ts'
import { en } from '../src/client/locales.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'
import { SettingsRoot } from '../../ui-settings-general/src/client/SettingsRoot.tsx'
import { createSettingsShellStore } from '../../ui-settings-general/src/client/shell-store.ts'
import type { SettingsRootComponentProps,SettingsSectionRow,SettingsOnboardingStep } from '../../ui-settings-general/src/client/shell-contract.ts'
import { en as shellEn } from '../../ui-settings-general/src/client/locales.ts'

afterEach(()=>{cleanup();vi.unstubAllGlobals()})
const denied=async ():Promise<never>=>{throw new Error('Unrestricted native model/credential/settings operation reached')}
const unused=():never=>{throw new Error('Unused standard slot hook reached')}
const ref='DEEPSEEK_API_KEY'
function TestHost({ renderSlot }:PropsRenderSlots<'settings.section'|'settings.onboarding'>){void renderSlot;return null}
function metadata():ModelsSettingsMetadata {
  const schema=Schema.object({ apiKeyEnv:Schema.string().role('credential-ref') })
  return { providers:[{ id:'deepseek-official',name:'DeepSeek' }],configurableProviders:[{ provider:'deepseek-official',displayName:'DeepSeek',settingsNs:'model-provider',settingsPath:[] }],
    settings:{ writable:false,hasDocument:false,namespaces:[{ ns:'model-provider',schema:JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue,
      value:{ apiKeyEnv:ref },autoGenerate:true,applies:'live',secrets:[],revision:1 }] } }
}
async function fixture(){
  const ctx=new Context(),mock=RemoteMock.create().load(remoteDefaultResponses)
  onTestFinished(async()=>{await ctx.fiber.dispose();mock.assertNoUnmatched()})
  await ctx.plugin(SlotRegistry).await()
  const locale=new LocaleRuntime(ctx);locale.setLocale('en');ctx.provide('locale',locale)
  // Same Cloud projection constraint: locale only; no welcome acknowledgement namespace or settings write.
  mock.remote.settings.describe.mockResolvedValue(ok({ writable:false,hasDocument:false,namespaces:[{
    ns:'locale',schema:{},value:{ preference:'en' },autoGenerate:true,applies:'live',secrets:[],revision:1,
  }] }))
  new TestRemote(ctx,{ credentials:{ describe:denied,set:denied,unset:denied },
    llm:{ listProviders:denied,listConfigurableProviders:denied,discoverModels:denied },
    settings:{ describe:mock.remote.settings.describe,mutate:denied },session:{ initializeDefaultModel:denied } })
  await ctx.plugin({ inject:[...settingsInject],apply:settingsApply }).await()
  await ctx.configForms.describe().ensure()
  const unavailable=ctx.configForms.get('ui-settings-general')
  expect(unavailable.getSnapshot().status).toBe('unavailable')
  const scopes=vi.spyOn(ctx.configForms,'get')
  const editing=createSnapshotStore<ModelsCredentialEditing|null>(null)
  const prepare=vi.fn<ModelsCredentialEditing['prepare']>(async()=>null)
  const integration:ModelsSettingsIntegration={ onboarding:false,editing,reads:{ isCurrent:()=>editing.getSnapshot()!==null,
    metadata:async()=>metadata(),credentials:async()=>({ [ref]:{ configured:false,writable:true } }) } }
  ctx.provide('modelsSettingsIntegration',integration)
  const declare=()=>ctx.slots.register({ name:'root',children:{ 'settings.section':{ kind:'list',scope:'root' },'settings.onboarding':{ kind:'list',scope:'root' } } },TestHost)
  let removeHost=declare(),plugin=ctx.plugin({ inject:[...inject],apply });await plugin.await()
  const sections=createSnapshotStore<SettingsSectionRow[]>([]),steps=createSnapshotStore<SettingsOnboardingStep[]>([])
  const refresh=()=>{sections.set(ctx.slots.entries('settings.section').map(row=>({ id:row.options.id??'',order:row.options.order??0,label:resolveSlotLabel(row.options.label)??'' })))
    steps.set(ctx.slots.entries('settings.onboarding').map(row=>({ id:row.options.id??'',order:row.options.order??0 })))}
  refresh();const off=[ctx.slots.subscribe('settings.section',refresh),ctx.slots.subscribe('settings.onboarding',refresh)]
  onTestFinished(()=>{for(const dispose of off)dispose();removeHost()})
  const currentController=()=>{const row=ctx.slots.entries('settings.section')[0],face=row?.inject?.(),controller=face?.controller
    if(!(controller instanceof ModelsSettingsStore))throw new Error('Original native Models registration missing');return controller}
  let controller=currentController()
  const shell=createSettingsShellStore().create(),sessions:SessionListState={ ids:[],byId:{},phase:'ready',projectionsBySession:{} }
  const renderSlot:SettingsRootComponentProps['renderSlot']=(name,_owner,options)=>{
    if(name==='settings.onboarding')throw new Error('A blocking onboarding step reached the original coordinator')
    if(name==='settings.section')return <IntegratedModels controller={controller}
      operations={{ storeCredential:denied,removeCredential:denied,writeSettings:denied,discoverModels:denied }}
      schema={settingsSchema} t={locale.bind('settings.models')} useSnapshot={bindSnapshotSelector(controller.store)} useCredentialEditing={bindSnapshotSelector(editing)}
      renderSlot={()=>null}/>
    if(name==='settings.header')return 'Settings panel'
    if(name==='settings.close')return 'Close'
    if(name==='settings.trigger')return 'Settings'
    return options?.fallback
  }
  const sidebarOwner:SidebarSettingsOwnerProps={ wide:true }
  const props:SettingsRootComponentProps={ ...sidebarOwner,reconnect:()=>{},openDesktopUpdate:()=>{},
    useStore:bindSnapshotSelector(shell),actions:shell.actions,
    useSessions:select=>select(sessions),useSessionStatus:unused,usePanelInfo:unused,
    useSessionRetainInfo:unused,useResource:unused,useWorkspaces:unused,...allowAllAccess,
    useShortcuts:select=>select([]),useDesktopUpdate:select=>select({ failed:false,opening:false }),useConnectionState:select=>select('connected'),
    useSections:bindSnapshotSelector(sections),useOnboardingSteps:bindSnapshotSelector(steps),renderSlot,t:makeTranslate(shellEn) }
  const appRoot=document.createElement('div');appRoot.id='root';appRoot.inert=false
  document.body.append(appRoot);onTestFinished(()=>{ appRoot.remove() })
  const view=render(<SettingsRoot {...props}/>,{ container:appRoot })
  return { ctx,scopes,editing,prepare,controller,shell,view,appRoot,
    open:async()=>{await act(async()=>{editing.set({ scope:'original-cloud-page',isCurrent:()=>editing.getSnapshot()!==null,prepare })})},
    hmr:async()=>{await act(async()=>{
      await plugin.dispose();plugin=ctx.plugin({ inject:[...inject],apply })
      await plugin.await();controller=currentController()
    })},
    redeclare:async()=>{await act(async()=>{removeHost();removeHost=declare()})} }
}

it.each([undefined,{ credentialOnboarding:true }])('P1 Cloud omits unavailable Welcome before editing admission, even with legacy bootstrap %j',async (payload)=>{
  if(payload!==undefined)vi.stubGlobal(ONBOARDING_CONFIG_GLOBAL,payload)
  const f=await fixture()
  expect(f.editing.getSnapshot()).toBeNull()
  expect(f.ctx.slots.entries('settings.onboarding')).toEqual([])
  expect(f.scopes.mock.calls.some(([ns])=>ns==='ui-settings-general')).toBe(false)
  expect(f.ctx.slots.entries('settings.section').map(row=>row.options.id)).toEqual(['models'])
  expect(screen.queryByRole('dialog')).toBeNull();expect(f.appRoot.inert).toBe(false)
  await f.open();fireEvent.click(screen.getByRole('button',{ name:'Settings' }))
  expect(await screen.findByRole('button',{ name:en.editKey })).toBeDefined()
  expect(f.controller.store.getSnapshot().writable).toBe(false)
  fireEvent.click(screen.getByRole('button',{ name:'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull();expect(f.appRoot.inert).toBe(false)
})

it('P2 missing Cloud key stays in manual Models: cancel and unavailable prepare leave no outer modal, including revoke/HMR/redeclaration',async()=>{
  vi.stubGlobal(ONBOARDING_CONFIG_GLOBAL,{ credentialOnboarding:true })
  const f=await fixture(),store=vi.fn(async()=>undefined)
  await f.open();expect(f.ctx.slots.entries('settings.onboarding')).toEqual([])
  f.prepare.mockResolvedValueOnce({ ref,store,remove:denied })
  fireEvent.click(screen.getByRole('button',{ name:'Settings' }))
  fireEvent.click(await screen.findByRole('button',{ name:en.editKey }))
  fireEvent.change(await screen.findByLabelText(en.keyInput),{ target:{ value:'synthetic-uncommitted-draft' } })
  fireEvent.click(screen.getByRole('button',{ name:en.cancel }))
  expect(screen.queryByLabelText(en.keyInput)).toBeNull();expect(store).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{ name:en.editKey }))
  await screen.findByText(en.keyEditUnavailable)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  fireEvent.click(screen.getByRole('button',{ name:'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull();expect(f.appRoot.inert).toBe(false)
  await act(async()=>{f.editing.set(null)})
  await f.hmr();await f.redeclare()
  expect(f.ctx.slots.entries('settings.onboarding')).toEqual([])
  expect(f.ctx.slots.entries('settings.section').map(row=>row.options.id)).toEqual(['models'])
  expect(screen.queryByRole('dialog')).toBeNull();expect(f.appRoot.inert).toBe(false)
  expect(f.scopes.mock.calls.some(([ns])=>ns==='ui-settings-general')).toBe(false)
  await f.open();fireEvent.click(screen.getByRole('button',{ name:'Settings' }))
  await waitFor(()=>{ expect(screen.getByRole('button',{ name:en.editKey })).toBeDefined() })
})
