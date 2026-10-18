import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'
import { LinuxFilesPool } from '../src/worker-pool.ts'
import { RootStorageOwner } from '../src/storage-owner.ts'
import type { StaticStorageConfig } from '../src/storage-types.ts'

const limits = {
  maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1,
  maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 10_000,
  workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128,
  replyOverheadBytes: 128, readyTimeoutMs: 2000, drainTimeoutMs: 50,
  helperPath: '/not-loaded/test.node', maxReadBytes: 100, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 16,
} satisfies root.Config

const storage: StaticStorageConfig = { planPath: '/deployment/plan.json', planSha256: '1'.repeat(64),
  probeHelperPath: '/deployment/storage.node', probeHelperSha256: '2'.repeat(64), maxProbeAssetBytes: 1024,
  maxPlanBytes: 16384, maxMountInfoBytes: 16384, rootProbeReservationBytes: 2_000_000, probeTimeoutMs: 1000 }

describe('cloud files unavailable production integration', () => {
  it('requires explicit finite root budgets', () => {
    expect(() => z.resolve({}, root.Config, {})).toThrow()
    expect(() => z.resolve({ ...limits, waitTimeoutMs: Number.POSITIVE_INFINITY }, root.Config, {})).toThrow()
    expect(root.Config(limits)).toEqual(limits)
  })

  it('accepts omitted legacy storage configuration but refuses an unbudgeted or incomplete static deployment', () => {
    expect(root.Config({ ...limits, staticStorage: storage }).staticStorage).toEqual(storage)
    expect(() => z.resolve({ ...limits, staticStorage: {} }, root.Config, {})).toThrow()
    const start = (): never => { throw new Error('worker must not be created') }
    expect(() => new LinuxFilesPool({ ...limits, staticStorage: storage }, start)).toThrow()
    expect(() => new LinuxFilesPool({ ...limits, maxResidentBytes: 3_000_000,
      staticStorage: { ...storage, rootProbeReservationBytes: 1 } }, start)).toThrow()
  })

  it.skipIf(process.platform === 'linux')('cannot turn a component driver into a real storage owner on macOS', async () => {
    let touched = false
    const fail = (): never => { touched = true; throw new Error('no native operation expected') }
    const owner = new RootStorageOwner(storage, 1024, {
      record: fail, view: fail, probe: fail, assertPoolCurrent: () => {}, bind: fail, joinEpoch: fail,
    })
    const preparation = owner.initializeStatic()
    expect(owner.initializeStatic()).toBe(preparation)
    await expect(preparation).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
    expect(() => { owner.assertRootCurrent() }).toThrow()
    expect(touched).toBe(false)
  })

  it('does not publish a pool or native filesystem without required root integration', async () => {
    const context = new Context()
    await expect(root.apply(context, limits)).rejects.toThrow(/requires/)
    expect(context.get('fs')).toBeUndefined()
  })

  it('does not mount a filesystem from account config identity or host defaults', () => {
    const context = new Context()
    expect(() => account.apply(context, {})).toThrow(/runtime-bound account/)
    expect(context.get('fs')).toBeUndefined()
  })
})
