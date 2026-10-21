/** Browser Loader entry consuming the exact pre-Cordis prepared page owner. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installCloudProjects } from './projects.ts'
import { installCloudFileDownloads } from './downloads.ts'
import { installCloudServicePreviews } from './service-previews.ts'

/** Stable browser plugin name. */
export const name = 'pe-cloud-client/client'
/** Prepared ownership is checked explicitly before installing any native carrier. */
export const inject: string[] = []
/** Browser Loader entry configuration; preparation owns all explicit budgets. */
export interface Config {}
/** The native browser Loader supplies no per-entry configuration. */
export const Config: z<Config> = z.object({})

/**
 * Consume the fixed owner prepared before AppWebEntry starts its native graph.
 * @param ctx - real Cloud Loader entry Context carrying the pre-activation owner.
 * @param config - empty native Loader configuration; overrides are rejected.
 * @throws Error before native Connection installation when preparation is absent or invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const owner = ctx.get('peCloudPage')
  if (owner === undefined) throw new Error('pe-cloud-client/client requires its pre-Cordis prepared page owner')
  if (Object.keys(config).length !== 0) throw new Error('pe-cloud-client/client requires empty Loader configuration; limits belong to preparation')
  owner.activate(ctx)
  installCloudProjects(ctx)
  installCloudFileDownloads(ctx, owner)
  installCloudServicePreviews(ctx, owner)
}

export { CloudPagePersistence, CloudPersistenceError } from './persistence.ts'
export type {
  CloudPersistenceFailureCode, CloudPersistenceInput, CloudPersistenceLimits,
  CloudPersistenceSnapshot, CloudPersistenceStorage,
} from './persistence.ts'
export { CloudPageLifetime } from './page-lifetime.ts'
export type { CloudNativeEntry, CloudPageLifetimeInput, CloudPageSnapshot } from './page-lifetime.ts'

export { PreparedCloudPage } from './prepared-page.ts'
export { ClientFailure, type ClientFailureCode } from './errors.ts'
export type { CloudPagePreparation, CloudPagePreparationInput, CloudPreparedNativeOptions } from './prepared-page.ts'
export type { CloudServicePreviewNavigation, CloudServicePreviewSelection } from './service-preview.ts'
