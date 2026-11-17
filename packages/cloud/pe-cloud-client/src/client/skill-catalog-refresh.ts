/** Cloud event policy over the original Native skill catalog cache. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-skill/client'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/types'

/**
 * Refresh current Native catalogs after the existing account skill event.
 * @param ctx - Original Cloud page plugin scope; its dependency owner withdraws the subscription.
 */
export function installCloudSkillCatalogRefresh(ctx: Context): void {
  ctx.inject(['remote', 'remote.skills', 'uiSkillCatalog'], (owner) => {
    const catalog = owner.uiSkillCatalog
    owner.effect(() => owner.remote.$on('skills/change', () => { catalog.invalidate() }), 'Cloud skill catalog event')
  })
}
