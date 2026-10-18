/** Complete Host-only deployment inputs; account identity/types never depend on this composition. */
import z from '@deepseek-ai/schemastery'
import type { ConfigSaveLimits } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { RuntimeConfig } from './types.ts'
import type { AccountFactoryLimits } from './account-factory.ts'
import type { OwnerPgLimits } from './owner-pg-executor.ts'

/** Required deployment inputs for the actual root Loader; component capacities stay separate. */
export interface RuntimeRootConfig extends RuntimeConfig {
  readonly recipeVersion: string
  readonly internalAddress: string
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly secretResolveTimeoutMs: number
  readonly maxSecretBytes: number
  readonly accountWaitTimeoutMs: number
  readonly database: {
    readonly host: string
    readonly port: number
    readonly user: string
    readonly database: string
    readonly passwordRef: string
    readonly ssl: boolean
  }
  readonly pg: OwnerPgLimits
  readonly factory: AccountFactoryLimits
  readonly saves: ConfigSaveLimits
  readonly paths: {
    readonly sharedAccountsRoot: string
    readonly localCacheRoot: string
    readonly maxPathBytes: number
  }
  readonly native: {
    readonly configPath: string
    readonly installAnchor: string
    readonly bareModuleBaseUrl: string
    readonly requiredEntryIds: string[]
    readonly maxObservedEvents: number
    readonly maxEntries: number
  }
}


const positive = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required()
const timer = () => z.natural().min(1).max(2_147_483_647).required()
const text = () => z.string().pattern(/\S/).required()

/** Actual root deployment schema; no component configuration or absent field enables production. */
export const RuntimeRootConfigSchema: z<RuntimeRootConfig> = z.object({
  maxMountedAccounts: positive(), maxConcurrentMounts: positive(), maxConcurrentDrains: positive(),
  recipeVersion: text(), internalAddress: text(),
  heartbeatIntervalMs: timer(), heartbeatTimeoutMs: timer(), startupTimeoutMs: timer(),
  shutdownTimeoutMs: timer(), secretResolveTimeoutMs: timer(),
  maxSecretBytes: positive(), accountWaitTimeoutMs: timer(),
  database: z.object({
    host: text(), port: z.natural().min(1).max(65535).required(), user: text(), database: text(),
    passwordRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).required(), ssl: z.boolean().required(),
  }).required(),
  pg: z.object({
    maxConnections: positive(), maxQueued: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
    queueTimeoutMs: timer(), connectionTimeoutMs: timer(), statementTimeoutMs: timer(), lockTimeoutMs: timer(),
    maxObservedOperations: positive(), maxObservers: positive(),
  }).required(),
  factory: z.object({
    maxWaiters: positive(), maxWaitersPerAccount: positive(), maxBorrows: positive(), maxBorrowsPerAccount: positive(),
  }).required(),
  saves: z.object({
    maxAccounts: positive(), maxRunning: positive(), maxQueued: positive(), maxQueuedPerAccount: positive(),
    maxTrackedOperations: positive(), maxTrackedOperationsPerAccount: positive(),
    maxNestedPerOperation: positive(), maxWaitersPerAccount: positive(),
  }).required(),
  paths: z.object({ sharedAccountsRoot: text(), localCacheRoot: text(), maxPathBytes: positive() }).required(),
  native: z.object({
    configPath: text(), installAnchor: text(), bareModuleBaseUrl: text(),
    requiredEntryIds: z.array(z.string().pattern(/\S/)).required(), maxObservedEvents: positive(), maxEntries: positive(),
  }).required(),
})
