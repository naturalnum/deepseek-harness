import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountHttpClient } from './account-api.ts'
import { AccountMenu } from './AccountMenu.tsx'
import { AccountSection } from './AccountSection.tsx'
import { en, NS, zh, type AccountLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.account': AccountLocaleKey }
}

export const inject = ['slots', 'locale']

/** Register one cloud account launcher and its personal native Settings section. */
export function apply(ctx: Context): void {
  const client = new AccountHttpClient()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'PowerEvolve account labels')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: NS,
    inject: () => ({ client, navigate: (url: string) => { window.location.assign(url) } }),
  }, AccountMenu))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'account', order: -10, label: () => t('account'), locale: NS,
    inject: () => ({ client }),
  }, AccountSection))
}
