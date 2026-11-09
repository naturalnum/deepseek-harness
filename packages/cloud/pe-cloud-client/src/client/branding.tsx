/** PowerEvolve occupants for the existing native sidebar brand positions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LightningMark } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './branding.module.css'

function PowerEvolveMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span className={css.mark}><LightningMark size={size} /></span>
}

function PowerEvolveName({ t }: PropsLocale<'common'>) {
  return <span className={css.name}>{t('brand.localBuild')}</span>
}

/**
 * Fill native brand positions together, retaining their declaration and plugin disposal ownership.
 * @param ctx - Original Cloud browser plugin scope.
 */
export function installCloudBrand(ctx: Context): void {
  ctx.inject(['slots'], (owner) => {
    owner.slots.inject('sidebar.brand.mark', () =>
      owner.slots.inject('sidebar.brand.name', function* () {
        yield owner.slots.register({ name: 'sidebar.brand.mark' }, PowerEvolveMark)
        yield owner.slots.register({ name: 'sidebar.brand.name', locale: 'common' }, PowerEvolveName)
      }))
  })
}
