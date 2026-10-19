/** Account-fixed native project Remote contribution consumed by the Cloud Client. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { registerCloudProjectSlots } from './project-slots.ts'

/**
 * Mount the generated cloudProjects Remote before activating namespace-dependent directory-flow actions.
 * @param ctx Cloud Loader entry after its original prepared page has activated the native carrier.
 */
export function installCloudProjects(ctx: Context): void {
  ctx.inject(['remote', 'slots', 'locale'], async (owner) => {
    const { default: contribution } = await import('@deepseek-ai/dsh-pe-cloud-api/remote')
    const unmount = await owner.remote.$mount(contribution)
    try {
      owner.fiber.assertActive()
      await owner.inject(['remote.cloudProjects'], (scope) => {
        registerCloudProjectSlots(scope, async (title, signal) => {
          const result = await scope.remote.cloudProjects.create({ title }, signal)
          if (!result.ok) throw result.error
          return result.value.workspace.path
        })
      })
      return unmount
    } catch (error) { await unmount(); throw error }
  })
}
