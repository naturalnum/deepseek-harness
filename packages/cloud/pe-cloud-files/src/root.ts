/** Root Loader entry prebuilds one bounded Linux pool; account readiness stays separate. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FilesPoolConfig, LinuxFilesPool } from './worker-pool.ts'
import { mountRootPool } from './root-lifecycle.ts'
import { FilesFailure } from './error.ts'

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
})

/**
 * Prebuild and register the root files participant without installing a native fs or marking an account ready.
 * @param ctx Root Loader scope with runtime already present.
 * @param config Deployment capacities and a reviewed Linux helper path.
 * @returns Completes after all configured workers handshake and the unique participant is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') throw new FilesFailure('files/prerequisite-missing', 'files/root requires the real Linux FD worker backend')
  await mountRootPool(ctx, Config(config))
}
