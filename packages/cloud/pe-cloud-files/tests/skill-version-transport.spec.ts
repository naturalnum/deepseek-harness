/** A vanished transport retains the original fixed intent and unknown disposition through actual worker exit. */
import { expect, it } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { Worker } from 'node:worker_threads'
import { FdSkillFailure, FdWorkerClient } from '../src/worker-client.ts'
import type { SkillVersionId } from '../src/skill-versions.ts'

it.each(['prepare', 'retire'] as const)('retains the original %s identity when a transport exits without a native receipt', async (kind) => {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url))
  const client = new FdWorkerClient(worker)
  const root = { rootPath: '/not-opened/private', rootDevice: '1', rootInode: '2', rootMountId: '3' }
  const version = '00000000-0000-4000-8000-000000000000' as SkillVersionId
  try {
    await client.ready
    let observed: unknown
    try {
      if (kind === 'prepare') await client.prepareSkillVersion({ kind: 'skill-prepare', root, uid: 1000, gid: 1000, version,
        skill: new Uint8Array(0), resource: new Uint8Array(0),
        limits: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 } },
      new AbortController().signal)
      else await client.retireSkillVersions({ kind: 'skill-retire', root, uid: 1000, gid: 1000, current: { id: version, revision: FsVersion('1:2:3:4:5') } }, 2, new AbortController().signal)
    } catch (error) { observed = error }
    await client.exited
    expect(observed).toBeInstanceOf(FdSkillFailure)
    if (!(observed instanceof FdSkillFailure)) throw new Error('Missing actual transport failure')
    expect(observed.outcome).toBe('unknown')
    expect(observed.intent).toMatchObject({ kind, root, version })
    expect(observed.intent?.operationId).toMatch(/^[a-f0-9-]{36}$/)
    expect(observed.facts).toBeUndefined()
    if (kind === 'retire') expect(observed.intent?.pointerRevision).toBe('1:2:3:4:5')
  } finally { await client.close(); await client.exited; await worker.terminate() }
})

it('refuses a small slice retaining an oversized backing before posting to the worker', async () => {
  const worker = new Worker(new URL('./fixtures/skill-exit-worker.mjs', import.meta.url))
  const client = new FdWorkerClient(worker)
  try {
    await client.ready
    expect(() => client.prepareSkillVersion({ kind: 'skill-prepare',
      root: { rootPath: '/not-opened/private', rootDevice: '1', rootInode: '2', rootMountId: '3' },
      uid: 1000, gid: 1000, version: '00000000-0000-4000-8000-000000000000' as SkillVersionId,
      skill: new Uint8Array(0), resource: new Uint8Array(new ArrayBuffer(4096), 0, 0),
      limits: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 },
    }, new AbortController().signal)).toThrow(expect.objectContaining({ outcome: 'not-published', code: 'FS_TOO_LARGE' }))
    expect(client.available).toBe(true)
  } finally { await client.close(); await client.exited; await worker.terminate() }
})
