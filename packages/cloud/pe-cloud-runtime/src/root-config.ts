/** Complete Host-only deployment inputs; account identity/types never depend on this composition. */
import z from '@deepseek-ai/schemastery'
import type { ConfigSaveLimits } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { RuntimeConfig } from './types.ts'
import { SubagentCapacityLimitsSchema } from './subagent-capacity-schema.ts'
import type { AccountFactoryLimits } from './account-factory.ts'
import type { OwnerPgLimits } from './owner-pg-executor.ts'
import type { AccountPolicyConfig } from './account-policy.ts'
import type { AccountNativePreparation } from './account-native-integration.ts'
import { AccountRuntimeError } from './errors.ts'
import type { OwnerRecoveryLimits, RecoveryVerifierId } from './owner-types.ts'

/** Required deployment inputs for the actual root Loader; component capacities stay separate. */
export interface RuntimeRootConfig extends RuntimeConfig {
  /** Explicit maintenance-only authority; omission preserves ordinary runtime admission and closes recovery. */
  readonly recovery?: Readonly<{ readonly verifierId: RecoveryVerifierId; readonly limits: OwnerRecoveryLimits }>
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
  readonly accountPolicy: AccountPolicyConfig
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
    /** Explicit optional readonly budgets; Root supplies the actual per-account profile home. */
    readonly firstScreen?: Omit<NonNullable<AccountNativePreparation['firstScreen']>, 'home'>
    readonly attachments?: NonNullable<AccountNativePreparation['attachments']>
  }
}


const positive = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required()
const timer = () => z.natural().min(1).max(2_147_483_647).required()
const text = () => z.string().pattern(/\S/).required()

const accountPolicyFields: z<AccountPolicyConfig> = z.object({
  maxModelRoutes: positive(), maxPolicyStringBytes: positive(), maxPresetConfigBytes: positive(),
  models: z.array(z.object({ provider: text(), model: text() })).required(),
  presetId: text(), presetEntryId: text(), agentLoopEntryId: text(),
  presetConfigSha256: z.string().pattern(/^[0-9a-f]{64}$/).required(),
}).required()

/** Explicit finite model routes and exact fixed-Preset expectations; no field certifies account readiness. */
export const AccountPolicyConfigSchema: z<AccountPolicyConfig> = z.transform(accountPolicyFields, (config) => {
  const invalid = (): never => { throw new AccountRuntimeError('cloud/invalid-config', 'Account policy exceeds its finite limits or repeats a route') }
  if (config.models.length === 0 || config.models.length > config.maxModelRoutes
    || config.presetEntryId === config.agentLoopEntryId) invalid()
  const bounded = (value: string): void => {
    if (value.length > config.maxPolicyStringBytes || Buffer.byteLength(value) > config.maxPolicyStringBytes) invalid()
  }
  for (const value of [config.presetId, config.presetEntryId, config.agentLoopEntryId]) bounded(value)
  const providers = new Map<string, Set<string>>()
  for (const route of config.models) {
    bounded(route.provider); bounded(route.model)
    const models = providers.get(route.provider) ?? new Set<string>()
    if (models.has(route.model)) invalid()
    models.add(route.model)
    providers.set(route.provider, models)
  }
  return config
}).required()

/** Actual root deployment schema; no component configuration or absent field enables production. */
export const RuntimeRootConfigSchema: z<RuntimeRootConfig> = z.object({
  recovery: z.union([z.object({
    verifierId: z.const('local-original-process-and-provider-v1').required(),
    limits: z.object({
      maxAllocations: z.natural().min(1).max(128).required(),
      maxEvidenceRefs: z.natural().min(1).max(128).required(),
      maxReferenceBytes: z.natural().min(1).max(4096).required(),
      maxProofBytes: z.natural().min(1).max(131072).required(),
      maxAuditRows: z.natural().min(1).max(2147483647).required(),
      maxProofAgeMs: timer(),
    }).required(),
  }).required()]),
  maxMountedAccounts: positive(), maxConcurrentMounts: positive(), maxConcurrentDrains: positive(),
  subagentCapacity: z.union([SubagentCapacityLimitsSchema]),
  recipeVersion: text(), internalAddress: text(),
  heartbeatIntervalMs: timer(), heartbeatTimeoutMs: timer(), startupTimeoutMs: timer(),
  shutdownTimeoutMs: timer(), secretResolveTimeoutMs: timer(),
  maxSecretBytes: positive(), accountWaitTimeoutMs: timer(),
  accountPolicy: AccountPolicyConfigSchema,
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
    firstScreen: z.union([z.object({
      maxHomeBytes: positive(), maxCollectionItems: positive(), maxFrameBytes: positive(),
      maxQueuedEvents: positive(), maxQueuedBytes: positive(),
    }).required()]),
    attachments: z.union([z.object({
      maxSurfaceNodes: positive(), maxRefs: positive(), maxRefBytes: positive(),
      maxPromptFiles: positive(), maxFileBytes: positive(), maxUploadChunkBytes: positive(),
      intakeReservationBytes: positive(), maxPendingReceipts: positive(),
    }).required()]),
  }).required(),
})
