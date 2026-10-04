/** Native account seats and product policy for confirmed sign-in expiry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AccountHttpClient } from './account-api.ts'
import { AccountMenu } from './AccountMenu.tsx'
import { AccountSection } from './AccountSection.tsx'
import { AccountSession } from './session-expiry.ts'
import { SessionExpiredNotice } from './SessionExpiredNotice.tsx'
import { en, NS, zh, type AccountLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.account': AccountLocaleKey }
}

/** Native presentation and the cancellable connection loop used by the identity policy. */
export const inject = ['slots', 'locale', 'connection']

/** Register native account seats and own independent identity checks for this plugin lifetime.
 * @param ctx - native client context.
 */
export function apply(ctx: Context): void {
  const client = new AccountHttpClient(undefined, () => session.confirmExpired())
  const session = new AccountSession({ client, connection: ctx.get('connection') as ConnectionHandle,
    navigate: url => { window.location.replace(url) }, resetDocument: () => { window.location.reload() } })
  ctx.effect(() => session.start(), 'PowerEvolve account identity lifetime')
  ctx.effect(() => {
    const visible = () => { if (document.visibilityState === 'visible') session.check() }
    window.addEventListener('online', session.check)
    window.addEventListener('focus', session.check)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('online', session.check)
      window.removeEventListener('focus', session.check)
      document.removeEventListener('visibilitychange', visible)
    }
  }, 'PowerEvolve account identity browser wake')
  const loadNavigation = (signal: AbortSignal) => client.navigation(signal)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'PowerEvolve account labels')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: NS,
    inject: () => ({ client, loadNavigation, navigate: (url: string) => { window.location.assign(url) } }),
  }, AccountMenu))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'account', order: -10, label: () => t('account'), locale: NS,
    inject: () => ({ client }),
  }, AccountSection))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'power-evolve-account-expiry', locale: NS,
    inject: () => ({ hooks: { accountExpiry: session.view }, returnToLogin: session.returnToLogin }),
  }, SessionExpiredNotice))
}
