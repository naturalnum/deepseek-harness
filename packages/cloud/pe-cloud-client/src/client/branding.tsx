/** PowerEvolve occupants for the existing native sidebar brand positions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LightningMark } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './branding.module.css'
import { CLOUD_BRAND_NAMESPACE, cloudBrandDictionaries } from './branding-locales.ts'

function PowerEvolveMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span className={css.mark}><LightningMark size={size} /></span>
}

function PowerEvolveName({ t }: PropsLocale<typeof CLOUD_BRAND_NAMESPACE>) {
  return <span className={css.name}>{t('brandName')}</span>
}

function EmptyWelcomeHeader() { return null }

/**
 * Fill native brand positions together, retaining their declaration and plugin disposal ownership.
 * @param ctx - Original Cloud browser plugin scope.
 */
export function installCloudBrand(ctx: Context): void {
  ctx.inject(['slots', 'locale'], (owner) => {
    owner.effect(() => owner.locale.register(CLOUD_BRAND_NAMESPACE, cloudBrandDictionaries), 'pe-cloud-client: brand dictionaries')
    owner.slots.inject('conversation.hero.header', () =>
      owner.slots.register({ name: 'conversation.hero.header' }, EmptyWelcomeHeader))
    owner.slots.inject('sidebar.brand.mark', () =>
      owner.slots.inject('sidebar.brand.name', function* () {
        yield owner.slots.register({ name: 'sidebar.brand.mark' }, PowerEvolveMark)
        yield owner.slots.register({ name: 'sidebar.brand.name', locale: CLOUD_BRAND_NAMESPACE }, PowerEvolveName)
      }))
  })
}
