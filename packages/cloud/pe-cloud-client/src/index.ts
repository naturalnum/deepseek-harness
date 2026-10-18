/** Host declaration and optional public Web inputs; no business service or HTTP route. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-modules'
import { CloudWebManifestSchema, parseCloudWebManifest } from './config.ts'
import type { CloudWebManifest } from './types.ts'

/** Stable declaration-half plugin name; this is not an account or root service. */
export const name = 'pe-cloud-client'
/** Web rows use the original Loader's explicit clientModules dependency; omission requires no services. */
export const inject: string[] = []
/** Optional public deployment inputs; the browser Loader entry still accepts no configuration. */
export interface Config {
  readonly web?: CloudWebManifest
}
/** No browser inputs are injected unless the deployment explicitly supplies them. */
export const Config: z<Config> = z.object({ web: z.union([CloudWebManifestSchema]) })

/**
 * Declare the browser package without activating an account Host service.
 * @param ctx - original Loader entry; Web deployments explicitly inject clientModules on that row.
 * @param config - optional explicit public Web deployment inputs.
 * @returns actual module-only registration and injection setup; supplies no account readiness.
 * @throws Error if the Web row lacks its native dependency declaration, resolution base or module supplier.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.web === undefined) return
  const manifest = parseCloudWebManifest(config.web)
  if (!Object.hasOwn(ctx.fiber.inject, 'clientModules')) {
    throw new Error('Cloud Web Loader entry must explicitly inject clientModules')
  }
  const baseUrl = ctx.fiber.entry?.parent.tree.ctx.baseUrl
  if (baseUrl === undefined) throw new Error('Cloud Web module supply requires the original Loader resolution base')
  const supplier = ctx.inject(['clientModules'], (owner) => {
    owner.effect(() => owner.clientModules.registerClientPackages(
      ['@deepseek-ai/dsh-client-connection'], baseUrl, { activate: false },
    ), 'pe-cloud-client: module-only native Connection')
    owner.on('webserver/index-inject', (rows) => {
      rows.push({ kind: 'global', name: '__DSH_CLOUD_WEB__', value: manifest })
    })
  })
  await supplier
  if (supplier.state !== FiberState.ACTIVE) throw new Error('Cloud Web native module supplier did not activate')
}
