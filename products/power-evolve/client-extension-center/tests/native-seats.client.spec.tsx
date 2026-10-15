import { jsonRecord } from './fetch-fixture.ts'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'
import type {} from '../../../../packages/client/ui-sidebar/src/client/contract/slots.ts'
import type {} from '../../../../packages/client/ui-plugin-manager/src/client/slot-contract.ts'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// @vitest-environment jsdom
/** Actual Cordis/SlotRegistry admission; Session transport is an explicit substitute. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../../../../packages/client/ui-renderer/src/client/registry.ts'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, SKILLS_PANEL_ID } from '../src/client/index.ts'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'
import { ConnectorConfiguration } from '../src/client/ConnectorConfiguration.tsx'
import { CloudProjectDialog, type CloudProjectDialogProps } from '../src/client/CloudProjectDialog.tsx'
import { installExtensionCenterStyles } from '../src/client/styles.ts'
import { en } from '../src/client/locales.ts'
import { apply as applyServer } from '../src/index.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

function isSkillActions(value: unknown): value is Pick<SkillsPageProps, 'client' | 'trySkill'> {
  if (typeof value !== 'object' || value === null) return false
  const actions = jsonRecord(value)
  return typeof actions.trySkill === 'function' && typeof actions.client === 'object' && actions.client !== null
}

function isProjectActions(value: unknown): value is Pick<CloudProjectDialogProps, 'createProjectDirectory'> {
  return typeof value === 'object' && value !== null && typeof jsonRecord(value).createProjectDirectory === 'function'
}

const objectMatcher: unknown = expect.any(Object)
const functionMatcher: unknown = expect.any(Function)
const passiveApply: () => unknown = applyServer

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('registers native Skills, MCP plugin and cloud project seats and withdraws them with their styles', async () => {
  const ctx = new Context(), scope = {}
  const setDraft = vi.fn(), openSession = vi.fn()
  const id = '00000000-0000-4000-8000-000000000003'
  ctx.reflect.provide('locale', { register: () => () => undefined, bind: () => (key: keyof typeof en) => en[key] })
  ctx.reflect.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => undefined },
    create: async () => id, scope: () => scope,
    using: async (_id: string, _request: object, use: (ref: { sessionId: string }) => void) =>{  use({ sessionId: id }) } })
  ctx.reflect.provide('conversation', { input: { for: (current: object) => { expect(current).toBe(scope); return { setDraft } } } })
  const listDirectory = vi.fn(async () => ({ home: '/workspace' }))
  const createDirectory = vi.fn(async (home: string, name: string) => `${home}/${name}`)
  ctx.reflect.provide('uiWorkspace', { openSession, listDirectory, createDirectory })
  await ctx.plugin(SlotRegistry)
  try {
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' }, 'plugins.item': { kind: 'list', scope: 'root' },
      'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
      'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } } },
    ({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist' | 'plugins.item'>) => <>
      {renderSlot('main', {})}{renderSlot('sidebar.panellist', { size: 16, active: false })}
      {renderSlot('plugins.item', { view: 'page' })}
    </>)
    const directoryFallback = () => null
    for (const hole of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const) {
      ctx.slots.register({ name: hole }, directoryFallback)
    }
    const product = ctx.plugin({ name: 'employee2-extension-seats', inject, apply })
    await product
    for (const hole of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const) {
      const entry = ctx.slots.entriesOfSlot(hole)[0]
      expect(entry?.component).toBe(CloudProjectDialog)
      const ports = entry?.inject?.()
      if (!isProjectActions(ports)) throw new Error('Missing native cloud project action')
      expect(await ports.createProjectDirectory('New project')).toBe('/workspace/New project')
    }
    expect(listDirectory).toHaveBeenCalledTimes(2)
    expect(createDirectory).toHaveBeenCalledWith('/workspace', 'New project')
    const skills = ctx.slots.entries('main')[0]
    expect(skills?.component).toBe(SkillsPage)
    expect(skills?.options.key).toBe(SKILLS_PANEL_ID)
    const sidebar = ctx.slots.entries('sidebar.panellist')[0]
    expect(sidebar?.component).toBe(SkillsPanelIcon)
    expect(typeof sidebar?.options.label === 'function' && sidebar.options.label()).toBe(en.skillsNav)
    const config = ctx.slots.entries('plugins.item')[0]
    expect(config?.component).toBe(ConnectorConfiguration)
    expect(config?.options.id).toBe('power-evolve-mcp')
    const configuration = config?.inject?.()
    expect(configuration).toMatchObject({ personalMcp: objectMatcher, sessions: objectMatcher,
      stdioV2: objectMatcher, approvalUrl: functionMatcher })
    expect(Object.keys(jsonRecord(configuration)).sort()).toEqual(['approvalUrl', 'personalMcp', 'sessions', 'stdioV2'])
    expect(ctx.slots.entries('plugins.item')).toHaveLength(1)
    const actions = skills?.inject?.()
    if (!isSkillActions(actions)) throw new Error('Missing native skill trial action')
    expect(actions?.client).toBeTruthy()
    await actions.trySkill({ skillId: id, name: 'Report skill', description: '', enabled: true, revision: 1,
      kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null, manifestDigest: null, observedState: 'ready' })
    expect(setDraft).toHaveBeenCalledWith(en.skillTryPrompt.replace('{alias}', `pe-user-skill-${id}`).replace('{name}', 'Report skill'))
    expect(openSession).toHaveBeenCalledWith(id)
    expect(document.getElementById('@power-evolve/client-extension-center')).toBeTruthy()
    await product.dispose()
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('plugins.item')).toHaveLength(0)
    expect(ctx.slots.entriesOfSlot('sidebar.workspaces.directoryFlow')[0]?.component).toBe(directoryFallback)
    expect(ctx.slots.entriesOfSlot('conversation.hero.workspace.directoryFlow')[0]?.component).toBe(directoryFallback)
    expect(document.getElementById('@power-evolve/client-extension-center')).toBeNull()
  } finally { await ctx.fiber.dispose() }
})

it('reuses an installed style element and renders a passive native sidebar icon', () => {
  const dispose = installExtensionCenterStyles(), reuse = installExtensionCenterStyles()
  const unusedStandardHook = (): never => { throw new Error('The icon fixture does not read shared state') }
  try {
    reuse()
    expect(document.getElementById('@power-evolve/client-extension-center')).toBeTruthy()
    const root = render(<SkillsPanelIcon size={16} active={false} usePanelInfo={selector => selector({ activePanelId: null })}
      useWorkspaces={unusedStandardHook} useSessions={unusedStandardHook}
      useSessionStatus={unusedStandardHook} useSessionRetainInfo={unusedStandardHook} />)
    expect(root.container.querySelector('svg')).toBeTruthy()
    expect(passiveApply()).toBeUndefined()
  } finally { dispose() }
})
