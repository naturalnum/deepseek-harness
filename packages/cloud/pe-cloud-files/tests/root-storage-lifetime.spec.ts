/** Parent Cordis disposal + real pool/storage lease; synthetic worker facts certify no deployment or PG result. */
import { Worker } from 'node:worker_threads'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { mountRootPool } from '../src/root-lifecycle.ts'
import { staticStorageProtocol } from './fixtures/static-storage-lifetime.ts'

it('finishes both installed storage leases during parent Root disposal while native cleanup is still pending', async () => {
  // Same explicit protocol-fixture platform override as the original storage-probe spec.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
  const directory = await mkdtemp(join(tmpdir(), 'free40-root-storage-'))
  const workers: Worker[] = [], entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>(), protocol = staticStorageProtocol()
  const counters = new SharedArrayBuffer(4), completed: string[] = []
  const lifetime: { root?: Context } = {}
  let cleanup = async (): Promise<void> => {}
  // Component fixture owns the account-drain callback. Native/PG control is not replaced with a clean receipt.
  class DrainRuntime extends PeAccountRuntime {
    private joined?: Promise<void>
    override close(): Promise<void> {
      return this.joined ??= (async () => {
        entered.resolve(undefined)
        await resume.promise
        try { await cleanup(); finished.resolve(undefined) }
        catch (cause) { finished.reject(cause); throw cause }
        await super.close()
      })()
    }
  }
  void finished.promise.catch(() => {})
  onTestFinished(async () => {
    resume.resolve(undefined)
    await lifetime.root?.fiber.dispose()
    await Promise.all(workers.map(worker => worker.terminate()))
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })
  const config: Root.Config = {
    maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
    maxResidentBytes: 8 * 1048576, maxResidentBytesPerLane: 2 * 1048576, waitTimeoutMs: 5000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 2000, drainTimeoutMs: 20, helperPath: '/not-loaded/component-only.node',
    maxReadBytes: 1024, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 },
    staticStorage: { ...protocol.config, rootProbeReservationBytes: 2 * 1048576 },
  }
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { id: 'runtime', name: 'cordis:lifetime-runtime', config: { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 } },
    { id: 'files', name: 'cordis:lifetime-files', config },
  ]))
  const root = await boot('free40-component-storage', path, [], (ctx) => {
    Object.assign(ctx.loader.builtins, {
      'lifetime-runtime': DrainRuntime,
      'lifetime-files': { name: 'lifetime-files', inject: Root.inject, Config: Root.Config,
        apply: (scope: Context, actual: Root.Config) => mountRootPool(scope, actual, () => {
          const worker = new Worker(new URL('./fixtures/storage-lifetime-worker.mjs', import.meta.url), {
            workerData: { record: protocol.record, facts: protocol.facts, mounts: protocol.mounts,
              status: protocol.status, counters },
          })
          workers.push(worker)
          return worker
        }) },
    })
  })
  lifetime.root = root
  const pool = root.peFilesPool, owner = pool.requireStorageOwner()
  const leases: Array<{ lease: Root.StaticAccountStorageLease; binding: AccountMountInput['binding'] }> = []
  for (const account of protocol.plan.accounts) {
    const home = account.private.rootPath
    const input: AccountMountInput = {
      binding: { accountId: account.accountId, epoch: '1' as AccountMountInput['binding']['epoch'],
        recipeVersion: protocol.plan.recipeVersion, lifetime: new AbortController().signal },
      instanceId: 'component-fixture-instance' as AccountMountInput['instanceId'],
      layout: { storageKey: account.storageKey, accountRoot: account.accountRoot, privateRoot: home,
        projectsRoot: account.projects.rootPath, profileRoot: home + '/profile', patchPath: home + '/profile/cordis.patch.yml',
        credentialsRoot: home + '/credentials', sessionsRoot: home + '/sessions', storageRoot: home + '/storage',
        attachmentsRoot: home + '/attachments', skillsRoot: home + '/skills', instructionsRoot: home + '/instructions',
        environmentsRoot: account.accountRoot + '/environments', localIndexRoot: '/cache/' + account.storageKey },
      environment: { get: () => undefined, getFrom: () => undefined },
    }
    const lease = await owner.prepareAccount(input)
    lease.bindInstalled(input.binding, () => {}, () => {}, async () => { throw new Error('No project lookup during cleanup') })
    leases.push({ lease, binding: input.binding })
  }
  cleanup = async () => {
    for (const { lease, binding } of leases) {
      expect((await pool.stopEpoch(binding, Date.now() + 1000)).status).toBe('confirmed')
      await lease.closeAfterActualDrain()
      completed.push(binding.accountId)
    }
  }
  const disposing = root.fiber.dispose()
  await entered.promise
  // Let concurrent Cordis child disposal enter while the explicit native-cleanup gate remains pending.
  await new Promise<void>(resolve => setImmediate(resolve))
  resume.resolve(undefined)
  try {
    await expect(finished.promise).resolves.toBeUndefined()
    expect(completed).toEqual(protocol.plan.accounts.map(account => account.accountId))
    expect(Atomics.load(new Int32Array(counters), 0)).toBe(2)
  } finally { await disposing }
  expect(pool.inspect()).toMatchObject({ state: 'closed', workers: 1, exited: 1, rootReservedBytes: 0 })
})
