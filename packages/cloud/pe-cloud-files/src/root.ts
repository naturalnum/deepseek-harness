/** Root Loader entry prebuilds one bounded Linux pool; account readiness stays separate. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FilesPoolConfig, LinuxFilesPool } from './worker-pool.ts'
import { mountRootPool } from './root-lifecycle.ts'
import { FilesFailure } from './error.ts'

export { RootStorageOwner, StaticAccountStorageLease } from './storage-owner.ts'
export { parseStaticStoragePlan, accountEnvironmentBank } from './storage-probe.ts'
export type { StaticStorageConfig, StaticStoragePlan, StaticStorageAccount, StaticStorageDomain } from './storage-types.ts'
export type { StaticStoragePlanV1, StaticStoragePlanV2, StaticEnvironmentBank, StaticEnvironmentSlot } from './storage-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root-only worker pool; presence does not mean account or production readiness. */
    peFilesPool: LinuxFilesPool
  }
}

/** Root plugin identity. */
export const name = 'pe-cloud-files/root'
/** Root startup waits for the actual runtime registration service. */
export const inject = ['peAccountRuntime']
/** Required deployment limits for the root-owned scheduler. */
export interface Config extends FilesPoolConfig {}
/** All limits are required; none is a claimed production capacity. */
export const Config: z<Config> = z.object({
  staticStorage: z.union([z.object({
    planPath: z.string().required(),
    planSha256: z.string().required(),
    probeHelperPath: z.string().required(),
    probeHelperSha256: z.string().required(),
    maxProbeAssetBytes: z.natural().min(1).max(4194304).required(),
    rootProbeReservationBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxPlanBytes: z.natural().min(1).max(262144).required(),
    maxMountInfoBytes: z.natural().min(1).max(1048576).required(),
    probeTimeoutMs: z.natural().min(1).max(2147483647).required(),
    skillRevalidation: z.union([z.object({ proofPath: z.string().required(), proofSha256: z.string().required() })]),
  })]),
  maxLanes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxRunning: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxRunningPerLane: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxQueued: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxQueuedPerLane: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxResidentBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxResidentBytesPerLane: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  waitTimeoutMs: z.natural().min(1).max(2_147_483_647).required(),
  workerCount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  minimumHealthyWorkers: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  workerReservationBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  replyOverheadBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  readyTimeoutMs: z.natural().min(1).max(2_147_483_647).required(),
  drainTimeoutMs: z.natural().min(1).max(2_147_483_647).required(),
  helperPath: z.string().required(),
  maxReadBytes: z.natural().min(1).max(2_147_483_646).required(),
  maxPathBytes: z.natural().min(1).max(16384).required(),
  maxResolveRetries: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
  readChunkBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  skillBundles: z.union([z.object({
    maxInstallations: z.natural().min(1).max(2147483647).required(),
    maxFiles: z.natural().min(1).max(2147483647).required(),
    maxDirectories: z.natural().min(1).max(2147483647).required(),
    maxDepth: z.natural().min(1).max(64).required(),
    maxPathBytes: z.natural().min(1).max(2147483647).required(),
    maxFileBytes: z.natural().min(1).max(2147483647).required(),
    maxContentBytes: z.natural().min(1).max(2147483647).required(),
    maxArchiveBytes: z.natural().min(1).max(2147483647).required(),
    maxArchiveEntries: z.natural().min(1).max(2147483647).required(),
    maxExpandedArchiveBytes: z.natural().min(1).max(2147483647).required(),
    maxInputBytes: z.natural().min(1).max(2147483647).required(),
    maxManifestBytes: z.natural().min(1).max(2147483647).required(),
    maxCatalogBytes: z.natural().min(1).max(2147483647).required(),
    maxDownloadBytes: z.natural().min(1).max(2147483647).required(),
    maxRequestBytes: z.natural().min(1).max(2147483647).required(),
    maxReplyBytes: z.natural().min(1).max(2147483647).required(),
    maxStagingBytes: z.natural().min(1).max(2147483647).required(),
    reservationBytes: z.natural().min(1).max(2147483647).required(),
  })]),
  skillProjection: z.union([z.object({
    maxProjects: z.natural().min(1).max(65536).required(),
    maxCopiesPerProject: z.natural().min(1).max(65536).required(),
    maxCopiesPerOperation: z.natural().min(1).max(65536).required(),
    maxParentBorrows: z.natural().min(1).max(65536).required(),
    maxOperationBorrows: z.natural().min(1).max(65536).required(),
    maxRecordBytes: z.natural().min(1).max(2147483647).required(),
    maxMetadataBytes: z.natural().min(1).max(2147483647).required(),
    maxMetadataInodes: z.natural().min(1).max(2147483647).required(),
    reservationBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })]),
  skillVersions: z.union([z.object({
    maxVersions: z.natural().min(1).max(65536).required(),
    maxTotalBytes: z.natural().min(1024).max(2147483647).required(),
    maxTotalInodes: z.natural().min(6).max(2147483647).required(),
    maxFileBytes: z.natural().min(1).max(2147483646).required(),
    reservationBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })]),
  content: z.union([z.object({
    maxEntries: z.natural().min(1).max(2147483647).required(),
    maxNameBytes: z.natural().min(1).max(16384).required(),
    maxReplyBytes: z.natural().min(1).max(2147483647).required(),
    operationTimeoutMs: z.natural().min(1).max(2147483647).required(),
  })]),
  staging: z.union([z.object({
    helperPath: z.string().required(),
    maxFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxBatchRefs: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxBatchBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxSourceChunkBytes: z.natural().min(1).max(2147483647).required(),
    operationTimeoutMs: z.natural().min(1).max(2147483647).required(),
    reservationBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })]),
})

/**
 * Prebuild and register the root files participant without installing a native fs or marking an account ready.
 * @param ctx Root Loader scope with runtime already present.
 * @param config Deployment capacities and a reviewed Linux helper path.
 * @returns Completes after worker handshakes, configured storage verification and unique participant registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') throw new FilesFailure('files/prerequisite-missing',
    'files/root requires the real Linux FD worker backend')
  await mountRootPool(ctx, Config(config))
}
