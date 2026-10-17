/** Root Loader entry; incomplete authentication and routing assembly fails before exposing traffic. */
import type { Context } from '@deepseek-ai/cordis'
import { AccessConfigSchema, parseAccessConfig } from './config.ts'
import type { AccessConfig } from './types.ts'
export { AuthAccessError } from './auth-error.ts'

/** Stable root plugin name. */
export const name = 'pe-cloud-access/root'

/** This increment installs no service or handler while mandatory adapters are absent. */
export const inject: string[] = []

/** Root-only deployment configuration. */
export interface Config extends AccessConfig {}

/** Required Loader configuration; cross-field validation runs before assembly. */
export const Config = AccessConfigSchema

/**
 * Validate root configuration, then reject unavailable production assembly.
 * @param _ctx - Root Context; no route or authentication service is installed yet.
 * @param config - Explicit deployment configuration.
 * @throws Error until the selected authentication library, runtime, manifest and native transport adapters are integrated.
 */
export function apply(_ctx: Context, config: Config): never {
  parseAccessConfig(config)
  throw new Error('pe-cloud-access/root cannot admit traffic: database-backed authentication, account runtime, exposure manifest and native HTTP/WS adapters are not integrated')
}
