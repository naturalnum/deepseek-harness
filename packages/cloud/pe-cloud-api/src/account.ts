/** Account Loader entry; trusted runtime/files/native-save integration is required. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CloudApiError } from './errors.ts'
import { CloudAccountApi } from './account-service.ts'

/** Account plugin identity. */
export const name = 'pe-cloud-api/account'
/** Preparation is explicit; no dependency injection may leave a missing owner silently pending. */
export const inject: string[] = []
/** Account identity, roots and save hooks cannot be selected in Loader JSON. */
export interface Config {}
/** There are no client-selectable account parameters. */
export const Config: z<Config> = z.transform(z.object({}), (config) => {
  if (Object.keys(config).length !== 0) throw new CloudApiError('cloud/invalid-config', 'Account API Loader configuration must be empty.')
  return config
})

/**
 * Require the prepared graph owner without publishing account readiness.
 * @param ctx - isolated account context.
 * @param config - empty Loader configuration.
 * @throws CloudApiError when its runtime-prepared API owner is missing or belongs to another graph.
 */
export function apply(ctx: Context, config: Config): void {
  Config(config)
  const api = ctx.get('peCloudApi')
  if (!(api instanceof CloudAccountApi)) {
    throw new CloudApiError('cloud/account-unavailable', 'pe-cloud-api/account requires its runtime-prepared API owner.')
  }
  api.assertInstalled(ctx)
}
