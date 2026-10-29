/** Sole Cloud management navigation, locale and transient feedback assembly. */
import { observeCloudDisposal } from '../observe-disposal.ts'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreparedCloudPage } from '../prepared-page.ts'
import { ClientFailure } from '../errors.ts'
import { SkillsPage } from './skills/SkillsPage.tsx'
import type { SkillsPageInjected } from './skills/types.ts'
import { SKILLS_MANAGEMENT_NAMESPACE, skillsManagementDictionaries } from './skills/locales.ts'
import { ManagementActionToast, type ManagementNotice } from './ManagementActionToast.tsx'
import { CLOUD_MANAGEMENT_NAMESPACE, cloudManagementDictionaries } from './locales.ts'
import { installCloudPluginCatalog } from './plugins/install.tsx'

const SKILLS_PANEL = 'power-evolve-skills'
// FiberState is a cross-package const enum and is not exported at runtime.
const FIBER_ACTIVE = 2 satisfies FiberState.ACTIVE
function SkillsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSkillOutlineRegular size={size}/>
}

/**
 * Attach management surfaces to the original page without another transport or account state.
 * @param ctx Original Cloud Loader scope; disposal synchronously withdraws its registrations.
 * @param page Captured page whose native namespace dependency retains the skill adapters and approved plugin edits.
 */
export function installCloudManagement(ctx: Context, page: PreparedCloudPage): void {
  const signal = page.lifetime.transport.signal
  const aborted = (): boolean => signal.aborted
  const skills = page.skillSettings !== undefined && page.bootstrap.capabilities.configuration.skills.manage
  const plugins = page.bootstrap.capabilities.configuration.plugins.length > 0
  if ((!skills && !plugins) || aborted()) return
  const removers = new Set<() => void>()
  const track = (remove: () => void): (() => void) => {
    let active = true
    const withdraw = (): void => { if (!active) return; active = false; removers.delete(withdraw); remove() }
    removers.add(withdraw)
    return withdraw
  }
  const withdraw = (): void => { for (const remove of [...removers].reverse()) remove() }
  ctx.on('internal/plugin', (fiber) => { if (fiber === ctx.fiber && fiber.uid === null) withdraw() })
  const dependency = ctx.inject(['slots', 'locale'], (owner) => {
    const assertCurrent = (): void => {
      ctx.fiber.assertActive()
      signal.throwIfAborted()
      if (owner.get('peCloudPage') !== page) throw new ClientFailure('closed')
    }
    assertCurrent()
    owner.on('internal/plugin', (fiber) => { if (fiber === owner.fiber && fiber.uid === null) withdraw() })
    owner.on('internal/status', (fiber) => { if (fiber === owner.fiber && fiber.state !== FIBER_ACTIVE) withdraw() })
    owner.effect(() => track(owner.locale.register(CLOUD_MANAGEMENT_NAMESPACE, cloudManagementDictionaries)), 'pe-cloud-client: management copy')
    if (skills) owner.effect(() => track(owner.locale.register(SKILLS_MANAGEMENT_NAMESPACE, skillsManagementDictionaries)), 'pe-cloud-client: skills copy')
    const notice = createSnapshotStore<ManagementNotice | null>(null)
    let sequence = 0
    const report = (action: ManagementNotice['action'], outcome: ManagementNotice['outcome']): void => {
      try {
        assertCurrent(); page.assertAccountManagementCurrent(owner)
        notice.set(Object.freeze({ sequence: ++sequence, action, outcome }))
      } catch (_closed) {
        try { console.error('Cloud management feedback unavailable.') }
        catch (_loggerFailure) { /* Feedback failure cannot replace the original operation's outcome. */ }
      }
    }
    const contribute = (key: 'main' | 'sidebar.panellist' | 'shell.overlay', install: () => () => void): void => {
      track(owner.slots.inject(key, () => {
        if (aborted()) return () => {}
        assertCurrent()
        return track(install())
      }))
    }
    contribute('shell.overlay', () => owner.slots.register({ name: 'shell.overlay', id: 'cloud-management.feedback',
      locale: CLOUD_MANAGEMENT_NAMESPACE, inject: () => ({ hooks: { managementNotice: notice },
        dismiss: (expected: number) => { if (notice.getSnapshot()?.sequence === expected) notice.set(null) } }) }, ManagementActionToast))
    if (skills) contribute('main', () => owner.slots.register({ name: 'main', key: SKILLS_PANEL,
      locale: SKILLS_MANAGEMENT_NAMESPACE, inject: (): SkillsPageInjected => ({
        scope: page.bootstrap.connectionGeneration + ':' + String(owner.fiber.uid) + ':' + String(owner.slots.getVersion('main')),
        hooks: { skillManagement: page.skillVersionEditing }, report,
      }) }, SkillsPage))
    if (skills) contribute('sidebar.panellist', () => owner.slots.register({ name: 'sidebar.panellist', id: SKILLS_PANEL,
      locale: CLOUD_MANAGEMENT_NAMESPACE, label: () => owner.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('skills') }, SkillsPanelIcon))
    if (plugins) track(installCloudPluginCatalog(owner, page, report))
  })
  const stop = (): void => {
    withdraw()
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud management withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    withdraw()
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw management contributions')
  if (aborted()) stop()
}
