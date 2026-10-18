/** Browser Loader entry; unavailable bootstrap assembly cannot publish a ready client. */
import type { Context } from '@deepseek-ai/cordis'
import { CloudClientConfigSchema, parseCloudClientConfig } from '../config.ts'
import type { CloudClientConfig } from '../types.ts'

/** Stable browser plugin name. */
export const name = 'pe-cloud-client/client'
/** No native carrier is installed before the bootstrap adapter exists. */
export const inject: string[] = []
/** Public browser configuration, excluding credentials and account paths. */
export interface Config extends CloudClientConfig {}
/** Required finite browser limits. */
export const Config = CloudClientConfigSchema

/**
 * Reject incomplete assembly before opening an unbound native connection.
 * @param _ctx - browser Context; no connection, store, or subscription is installed.
 * @param config - reviewed public browser configuration.
 * @throws Error until the access bootstrap decoder and pre-Cordis/native-cache assembly are connected.
 */
export function apply(_ctx: Context, config: Config): never {
  parseCloudClientConfig(config)
  throw new Error('pe-cloud-client/client cannot start: access bootstrap decoding, pre-Cordis native startup and account cache partitioning are not integrated')
}

export { CloudPagePersistence, CloudPersistenceError } from './persistence.ts'
export type {
  CloudPersistenceFailureCode, CloudPersistenceInput, CloudPersistenceLimits,
  CloudPersistenceSnapshot, CloudPersistenceStorage,
} from './persistence.ts'
export { CloudPageLifetime } from './page-lifetime.ts'
export type { CloudNativeEntry, CloudPageLifetimeInput, CloudPageSnapshot } from './page-lifetime.ts'
