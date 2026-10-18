/** Ordered root contributions remain registered until actual pool and result ownership ends. */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountRuntimeService } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Worker } from 'node:worker_threads'
import type { FdWorkerInput } from './worker-protocol.ts'
import { LinuxFilesPool } from './worker-pool.ts'
import type { FilesPoolConfig } from './worker-pool.ts'
import { FilesFailure } from './error.ts'

/**
 * Mount one pool and order actual shutdown before participant/service removal.
 * @param ctx Root Loader effect scope carrying runtime registration.
 * @param config Explicit validated capacities and helper location.
 * @param createWorker Internal test override; omission uses the reviewed private asset.
 * @returns Completes after worker startup and unique participant registration.
 */
export async function mountRootPool(
  ctx: Context,
  config: FilesPoolConfig,
  createWorker?: (input: FdWorkerInput) => Worker,
): Promise<void> {
  const runtime: AccountRuntimeService | undefined = ctx.get('peAccountRuntime')
  if (runtime === undefined) throw new FilesFailure('files/prerequisite-missing', 'files/root requires peAccountRuntime')
  if (ctx.get('peFilesPool') !== undefined) throw new FilesFailure('files/prerequisite-missing', 'files/root pool already exists')
  const pool = new LinuxFilesPool(config, createWorker)
  const unprovide = ctx.provide('peFilesPool', pool)
  let unregister: (() => void | Promise<void>) | undefined
  try {
    await pool.start()
    // A registration rejection leaves the service owned until startup cleanup finishes.
    const unregisterParticipant = runtime.registerDrainParticipant(pool)
    unregister = unregisterParticipant
    // Synchronous yield preserves Cordis thenable disposer ownership and ordering.
    ctx.effect(function* () {
      yield unprovide
      yield unregisterParticipant
      yield async () => {
        const receipt = await pool.stop(Date.now() + config.drainTimeoutMs)
        if (receipt.status === 'unknown') ctx.logger.error('files root shutdown is unconfirmed; retaining participant and actual worker ownership')
        await pool.whenClosed()
      }
    }, 'pe-cloud-files: actual pool lifetime before unregister')
  } catch (error) {
    const receipt = await pool.stop(Date.now() + config.drainTimeoutMs)
    if (receipt.status === 'unknown') ctx.logger.error('files root startup cleanup is unconfirmed; retaining actual worker ownership')
    await pool.whenClosed()
    if (unregister !== undefined) await unregister()
    unprovide()
    throw error
  }
}
