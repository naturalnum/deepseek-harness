/** Root Loader entry for actual authentication resources; request admission stays closed pending the root audit. */
import type { Context } from '@deepseek-ai/cordis'
import { PeAuthService } from './auth-root.ts'
import { AuthRootConfigSchema, type AuthRootConfig } from './root-config.ts'
export { AuthAccessError } from './auth-error.ts'
export { PeAuthService } from './auth-root.ts'

/** Stable root plugin name. */
export const name = 'pe-cloud-access/root'

/** Authentication resources consume the official root credential provider. */
export const inject = ['credentials']

/** Root-only deployment configuration. */
export interface Config extends AuthRootConfig {}

/** Required Loader configuration; cross-field validation runs before assembly. */
export const Config = AuthRootConfigSchema

/**
 * Initialize root authentication resources without opening any shared Web route.
 * @param ctx - Root Context with official credentials.
 * @param config - Explicit authentication, database and secret budgets.
 * @returns After library schema inspection; the resource provider is available through ctx.get('peAuth').
 * @throws AuthAccessError on failed or timed-out initialization; actual cleanup remains retained.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await PeAuthService.mountRoot(ctx, config)
}
