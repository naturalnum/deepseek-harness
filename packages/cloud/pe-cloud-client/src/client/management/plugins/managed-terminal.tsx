/** Original native Terminal card backed only by the current managed Shell provider's limits. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShellCardProps, ShellCardState } from '@deepseek-ai/dsh-client-ui-settings-shell/client'
import type { ReactNode } from 'react'
import type { PluginManagerSnapshot } from '@deepseek-ai/dsh-pe-cloud-api/types'

/** Mount and synchronously withdraw the native card with its page owner.
 * @param owner Original account page scope.
 * @param ShellCard Original native Shell card supplied by its active owner.
 * @returns Account-owned read-only card lifecycle.
 */
export function managedTerminalCard(owner: Context, ShellCard: (props: ShellCardProps) => ReactNode): {
  update(limits: PluginManagerSnapshot['terminal']): void
  dispose(): void
} {
  let active = true, remove: (() => void) | undefined
  let maxTimeoutMs = 0
  const field = (value: number) => ({ text: String(value), overridden: false, invalid: false })
  const store = createSnapshotStore<ShellCardState>({ available: false, writable: false, dirty: false,
    invalid: false, saving: false, failed: false, timeoutMs: field(0), maxOutputBytes: field(0) })
  const t = owner.locale.bind('settings.shell')
  const noop = (): void => {}
  const wait = owner.slots.inject('plugins.item', () => {
    const sync = (): void => {
      if (!active || !store.getSnapshot().available) { remove?.(); remove = undefined; return }
      if (remove !== undefined) return
      remove = owner.slots.register({ name: 'plugins.item', id: 'shell', order: 40,
        label: () => t('title'), locale: 'settings.shell',
        inject: () => ({ hooks: { shellCard: store }, edit: noop, resetField: noop, save: noop, discard: noop,
          managedMaxTimeoutMs: maxTimeoutMs }),
      }, ShellCard)
    }
    const unsubscribe = store.subscribe(sync)
    sync()
    return () => { unsubscribe(); remove?.(); remove = undefined }
  })
  return {
    update(limits) {
      if (!active) return
      if (limits === undefined) { store.update((state) => { state.available = false }); return }
      remove?.(); remove = undefined
      maxTimeoutMs = limits.maxTimeoutMs
      store.set({ available: true, writable: false, dirty: false, invalid: false, saving: false, failed: false,
        timeoutMs: field(limits.timeoutMs), maxOutputBytes: field(limits.maxOutputBytes) })
    },
    dispose() {
      if (!active) return
      active = false; store.update((state) => { state.available = false }); remove?.(); remove = undefined; wait()
    },
  }
}
