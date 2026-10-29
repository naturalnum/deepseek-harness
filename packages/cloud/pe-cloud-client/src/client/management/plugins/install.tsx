/** Plugin page and reader contribution inside the one original Cloud management assembly. */
import { observeCloudDisposal } from '../../observe-disposal.ts'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagementNotice } from '../ManagementActionToast.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconPluginPinwheelOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreparedCloudPage } from '../../prepared-page.ts'
import { CLOUD_MANAGEMENT_NAMESPACE } from '../locales.ts'
import { registerCloudPluginManagement } from './register.ts'
import { createPagePluginCatalog } from './catalog-reader.ts'

// FiberState is a cross-package const enum and is not exported at runtime.
const FIBER_ACTIVE: FiberState.ACTIVE = 2

function PluginPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconPluginPinwheelOutlineRegular size={size}/>
}

/**
 * Consume the original generated namespace for a page-owned approved edit; Projects retains the sole contribution mount.
 * @param parent Original common management owner; enroll the returned withdrawal in its synchronous cleanup.
 * @param page Original immutable page.
 * @param report Original common global feedback callback.
 * @returns Synchronous withdrawal that closes the reader and removes main/sidebar/locale before async cleanup.
 */
export function installCloudPluginCatalog(parent: Context, page: PreparedCloudPage,
  report: (action: ManagementNotice['action'], outcome: ManagementNotice['outcome']) => void): () => void {
  let stopped = false, withdrawActive: (() => void) | undefined
  const closed = (): boolean => stopped || page.lifetime.transport.signal.aborted
  const dependency = parent.inject(['remote', 'remote.cloudPlugins', 'slots', 'locale'], (owner) => {
    if (closed()) return
    const t = owner.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)
    const reader = createPagePluginCatalog(owner, page, (state) => {
      const metadata = state.bundle?.meta ?? state.plugin?.meta
      return { title: metadata?.title === undefined ? state.bundle?.name ?? state.id : owner.locale.resolveText(metadata.title),
        description: metadata?.description === undefined ? state.bundle?.description ?? state.plugin?.moduleName ?? ''
          : owner.locale.resolveText(metadata.description) }
    }, report)
    const removers = new Set<() => void>()
    let active = true
    const retire = (): void => {
      if (!active) return
      active = false; reader.dispose()
      for (const remove of [...removers].reverse()) remove()
      removers.clear()
      if (withdrawActive === retire) withdrawActive = undefined
    }
    withdrawActive = retire
    owner.on('internal/plugin', (fiber) => { if (fiber === owner.fiber && fiber.uid === null) retire() })
    owner.on('internal/status', (fiber) => { if (fiber === owner.fiber && fiber.state !== FIBER_ACTIVE) retire() })
    owner.effect(() => retire, 'pe-cloud-client: withdraw plugin catalog')
    removers.add(registerCloudPluginManagement(owner, 'power-evolve-plugins', () => reader.injected))
    const panelWait = owner.inject(['layout'], (scope) => {
      const panelInfo = scope.layout.panelInfo
      let selected = false
      const update = (): void => {
        if (!active) return
        const next = panelInfo.getSnapshot().activePanelId === 'power-evolve-plugins'
        const opened = next && !selected
        selected = next
        if (opened) reader.injected.refreshPluginCatalog?.()
      }
      scope.effect(() => {
        const unsubscribe = panelInfo.subscribe(update)
        update()
        return unsubscribe
      }, 'pe-cloud-client: load plugin catalog on panel selection')
    })
    removers.add(() => {
      void observeCloudDisposal(panelWait.dispose).catch(() => { console.error('Cloud plugin panel observation withdrawal unconfirmed.') })
    })
    let removeSidebar: (() => void) | undefined
    const stopSidebar = owner.slots.inject('sidebar.panellist', () => {
      if (!active) return () => {}
      const remove = owner.slots.register({ name: 'sidebar.panellist', id: 'power-evolve-plugins',
        locale: CLOUD_MANAGEMENT_NAMESPACE, label: () => t('plugins') }, PluginPanelIcon)
      removeSidebar = remove
      return () => { if (removeSidebar === remove) removeSidebar = undefined; remove() }
    })
    removers.add(() => { removeSidebar?.(); removeSidebar = undefined; stopSidebar() })
    if (closed()) retire()
  })
  return () => {
    if (stopped) return
    stopped = true; withdrawActive?.()
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud plugin catalog withdrawal unconfirmed.') })
  }
}
