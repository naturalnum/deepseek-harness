/** Account-bound research Remote contribution; the platform owns Connection and logout. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import contribution from '@deepseek-ai/dsh-experimental-epri-research/remote'

export const inject = ['remote']

/** Mount generated research descriptors in the current platform page scope.
 * @param ctx Original account-bound browser Loader scope.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
}
