/** Account launcher registration in the existing native Settings shell. */
import type { Context } from '@deepseek-ai/cordis'
import { CloudAccountMenu, type CloudAccountMenuInjected } from './CloudAccountMenu.tsx'
import { ACCOUNT_NS, accountDictionaries } from './account-locales.ts'
import type { PreparedCloudPage } from './prepared-page.ts'
import { observeCloudDisposal } from './observe-disposal.ts'
import { ClientFailure } from './errors.ts'

/**
 * Install only when the original Web entry supplied its real Cookie sign-out action.
 * @param ctx Original Cloud Loader scope; no native account sign-in service is added.
 * @param page Original prepared page and immutable bootstrap display name.
 */
export function installCloudSidebarAccount(ctx: Context, page: PreparedCloudPage): void {
  const signOut = page.accountSignOut, signal = page.lifetime.transport.signal
  const isAborted = (): boolean => signal.aborted
  if (signOut === undefined || isAborted()) return
  let stopped = false, withdraw: (() => void) | undefined
  const dependency = ctx.inject(['slots', 'locale'], (owner) => {
    if (stopped || signal.aborted) return
    const injected = (): CloudAccountMenuInjected => ({ displayName: page.bootstrap.account.displayName,
      signOut: () => { if (stopped) throw new ClientFailure('closed'); signOut(owner) },
    })
    owner.effect(() => {
      const removeCopy = owner.locale.register(ACCOUNT_NS, accountDictionaries)
      try {
        const removeSlot = owner.slots.inject('settings.launcher', () => owner.slots.register({
          name: 'settings.launcher', locale: ACCOUNT_NS, inject: injected,
        }, CloudAccountMenu))
        const retire = (): void => { removeSlot(); removeCopy() }
        withdraw = retire
        return retire
      } catch (error: unknown) { removeCopy(); throw error }
    }, 'pe-cloud-client: sidebar account launcher')
  })
  const stop = (): void => {
    if (stopped) return
    stopped = true; withdraw?.(); withdraw = undefined
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud account launcher withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => { stop(); signal.removeEventListener('abort', stop); await dependency.dispose() },
    'pe-cloud-client: retire sidebar account launcher')
  if (isAborted()) stop()
}
