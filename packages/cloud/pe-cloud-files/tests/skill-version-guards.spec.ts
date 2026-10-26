/** Root skill capacities reject before worker creation; a config or unstarted owner cannot mint private authority. */
import { expect, it } from 'vitest'
import { LinuxFilesPool, type FilesPoolConfig } from '../src/worker-pool.ts'

function config(): FilesPoolConfig {
  return {
    maxLanes: 1, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 2,
    maxResidentBytes: 8 * 1048576, maxResidentBytesPerLane: 2 * 1048576, waitTimeoutMs: 1000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 1000, drainTimeoutMs: 1000, helperPath: '/not-opened/fd-skill.node',
    maxReadBytes: 1024, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 },
    staticStorage: { planPath: '/not-opened/plan.json', planSha256: '0'.repeat(64),
      probeHelperPath: '/not-opened/probe.node', probeHelperSha256: '0'.repeat(64),
      maxProbeAssetBytes: 65536, rootProbeReservationBytes: 2 * 1048576, maxPlanBytes: 4096,
      maxMountInfoBytes: 16384, probeTimeoutMs: 1000 },
  }
}

it('accepts explicit finite capacities without granting an unverified root or creating a worker', async () => {
  let calls = 0
  const pool = new LinuxFilesPool(config(), () => { calls++; throw new Error('A configuration-only check cannot spawn a worker') })
  expect(calls).toBe(0)
  expect(() => pool.requireStorageOwner()).toThrow()
  expect(calls).toBe(0)
  expect((await pool.stop(Date.now() + 1000)).status).toBe('confirmed')
  await pool.whenClosed()
})

it.each(['storage', 'content', 'read', 'resident', 'root-resident', 'versions'] as const)(
  'rejects insufficient %s before any worker or private I/O can start', (kind) => {
    const original = config()
    const skills = original.skillVersions
    const { staticStorage: storage, ...withoutStorage } = original
    const { content, ...withoutContent } = original
    if (skills === undefined || storage === undefined || content === undefined) throw new Error('Fixture omitted explicit original capacities')
    const invalid: FilesPoolConfig = kind === 'storage' ? withoutStorage
      : kind === 'content' ? withoutContent
        : kind === 'read' ? { ...original, maxReadBytes: 511 }
          : kind === 'resident' ? { ...original, skillVersions: { ...skills, reservationBytes: 64 } }
            : kind === 'root-resident' ? { ...original, staticStorage: { ...storage, rootProbeReservationBytes: skills.reservationBytes - 1 } }
              : { ...original, skillVersions: { ...skills, maxVersions: 0 } }
    let calls = 0
    expect(() => new LinuxFilesPool(invalid, () => { calls++; throw new Error('Invalid capacities cannot spawn a worker') })).toThrow()
    expect(calls).toBe(0)
  },
)
