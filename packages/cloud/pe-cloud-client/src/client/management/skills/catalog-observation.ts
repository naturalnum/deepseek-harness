/** Read installed skills when the native layout selects their account page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { observeCloudDisposal } from '../../observe-disposal.ts'
import type { SkillManagementView } from './types.ts'

/**
 * Observe panel selection and late skill-source attachment without reading drafts or submitting writes.
 * @param parent Original management contribution owner.
 * @param source Original account page's skill observable.
 * @param panel Native main-panel routing key.
 * @param failed Report one failed catalog read; the source retains its last confirmed installations.
 * @returns Synchronous observation withdrawal before dependency cleanup.
 */
export function observeSkillCatalog(parent: Context, source: HostObservable<SkillManagementView>,
  panel: string, failed: () => void): () => void {
  let stopped = false, withdraw: (() => void) | undefined
  const dependency = parent.inject(['layout'], (owner) => {
    if (stopped) return
    const observer = new AbortController(), layout = owner.layout.panelInfo
    let selected = false, requested: NonNullable<SkillManagementView['managed']>['refresh'] | undefined
    const update = (): void => {
      if (stopped || observer.signal.aborted) return
      const next = layout.getSnapshot().activePanelId === panel, opened = next && !selected
      selected = next
      const view = source.getSnapshot(), managed = view.managed, load = managed?.refresh
      if (!next || load === undefined || view.phase === 'loading'
        || managed?.phase === 'submitting' || managed?.phase === 'opening' || managed?.phase === 'downloading'
        || !opened && (view.phase !== 'unread' || requested === load)) return
      requested = load
      void load(observer.signal).catch((_readFailure: unknown) => {
        if (!stopped && !observer.signal.aborted) failed()
      })
    }
    owner.effect(() => {
      const offLayout = layout.subscribe(update), offSource = source.subscribe(update)
      const stop = (): void => { observer.abort(); offLayout(); offSource() }
      withdraw = stop
      update()
      return () => { stop(); if (withdraw === stop) withdraw = undefined }
    }, 'pe-cloud-client: read installed skills on panel selection')
  })
  return () => {
    if (stopped) return
    stopped = true; withdraw?.(); withdraw = undefined
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud skill catalog observation withdrawal unconfirmed.') })
  }
}
