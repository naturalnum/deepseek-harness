import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { registerPowerEvolveAbout } from './AboutSection.tsx'
import { PowerEvolveBrandMark, PowerEvolveBrandName, PowerEvolveHeroMark } from './branding.tsx'

export const inject = ['slots', 'locale']

/** Adapt the branded About section and shell mark from PowerEvolve main. */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, PowerEvolveBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, PowerEvolveBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, PowerEvolveHeroMark))
  registerPowerEvolveAbout(ctx)
}
