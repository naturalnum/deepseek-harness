/** Config and parser checks mint no storage authority or successful native facts. */
import { expect, it } from 'vitest'
import { skillProjectionLimits, skillProjectionBudget, skillSourceContext } from '../src/skill-projection.ts'
import { LinuxFilesPool, type FilesPoolConfig } from '../src/worker-pool.ts'

const MiB = 1048576
const projection = { maxProjects: 2, maxCopiesPerProject: 4, maxCopiesPerOperation: 2, maxParentBorrows: 2,
  maxOperationBorrows: 2, maxRecordBytes: 8192, maxMetadataBytes: 65536, maxMetadataInodes: 4, reservationBytes: 2 * MiB }
function config(): FilesPoolConfig {
  return {
    maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 64 * MiB, maxResidentBytesPerLane: 32 * MiB, waitTimeoutMs: 1000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 1000, drainTimeoutMs: 1000, helperPath: '/not-opened/fd-skill.node',
    maxReadBytes: 8192, maxPathBytes: 256, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: { maxVersions: 4, maxTotalBytes: 8192, maxTotalInodes: 15, maxFileBytes: 1024, reservationBytes: MiB },
    skillProjection: projection,
    staticStorage: { planPath: '/not-opened/plan.json', planSha256: '0'.repeat(64),
      probeHelperPath: '/not-opened/probe.node', probeHelperSha256: '0'.repeat(64), maxProbeAssetBytes: 65536,
      rootProbeReservationBytes: 2 * MiB, maxPlanBytes: 4096, maxMountInfoBytes: 16384, probeTimeoutMs: 1000 },
  }
}

it('charges fixed projection handles and full source/record/borrow overlap separately from legacy source handles', async () => {
  const c = config(), source = c.skillVersions
  if (source === undefined) throw new Error('Missing fixture source limits')
  const budget = skillProjectionBudget(projection, source, { ...c, replyBytes: c.content?.maxReplyBytes ?? 0 })
  expect(budget.handles).toBeGreaterThan(source.maxVersions * 2048)
  expect(budget.operation).toBeLessThanOrEqual(projection.reservationBytes)
  expect(budget.overlap).toBe(MiB + 7 * projection.reservationBytes)
  let starts = 0
  const pool = new LinuxFilesPool(c, () => { starts++; throw new Error('No worker may start in a configuration-only check') })
  expect(starts).toBe(0)
  expect(() => pool.requireStorageOwner()).toThrow()
  expect((await pool.stop(Date.now() + 1000)).status).toBe('confirmed')
  await pool.whenClosed()
})

it.each(['unknown-field', 'metadata-bytes', 'metadata-inodes', 'fraction', 'borrow-set'] as const)(
  'refuses unbounded or under-reserved %s input without defaults', (kind) => {
    const value = kind === 'unknown-field' ? { ...projection, autoRepair: true }
      : kind === 'metadata-bytes' ? { ...projection, maxMetadataBytes: 8192 }
        : kind === 'metadata-inodes' ? { ...projection, maxMetadataInodes: 3 }
          : kind === 'fraction' ? { ...projection, maxProjects: 1.5 }
            : { ...projection, maxCopiesPerOperation: 5 }
    expect(skillProjectionLimits(value)).toBeUndefined()
  },
)

it.each(['overlap', 'scan', 'record', 'operation'] as const)('refuses insufficient %s before creating a worker', (kind) => {
  const c = config()
  const bad = kind === 'overlap' ? { ...c, maxResidentBytesPerLane: 3 * MiB }
    : kind === 'scan' ? { ...c, content: { ...c.content!, maxEntries: 1 } }
      : kind === 'record' ? { ...c, maxReadBytes: 4096 }
        : { ...c, skillProjection: { ...projection, reservationBytes: 1024 } }
  let starts = 0
  expect(() => new LinuxFilesPool(bad, () => { starts++; throw new Error('Invalid config cannot start a worker') })).toThrow()
  expect(starts).toBe(0)
})

it('treats namespace and boot as scope, not a reusable volume identifier', () => {
  const observed = { bootId: '7a8e6c58-944b-44a7-8ba6-8e2fc6ce1d18', mountNamespace: 'mnt:[4026534018]' }
  expect(skillSourceContext(observed)).toEqual(observed)
  expect(skillSourceContext({ ...observed, verified: true })).toBeUndefined()
  expect(skillSourceContext({ ...observed, mountNamespace: 'mnt:[0001]' })).toBeUndefined()
  expect(skillSourceContext({ ...observed, bootId: 'old' })).toBeUndefined()
})
