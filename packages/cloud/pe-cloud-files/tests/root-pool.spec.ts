import { Worker } from 'node:worker_threads'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import PeAccountRuntime from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import * as Root from '../src/root.ts'
import { mountRootPool } from '../src/root-lifecycle.ts'
import * as Account from '../src/account.ts'

const contexts: Context[] = []
const workers: Worker[] = []
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function mounted() {
  let filesContext!: Context
  let appliedConfig!: Root.Config
  const directory = await mkdtemp(join(tmpdir(), 'dsh-files-root-pool-'))
  temporary.push(directory)
  const fixture = join(directory, 'cordis.yml')
  await writeFile(fixture, await readFile(fileURLToPath(new URL('./fixtures/root-pool.cordis.yml', import.meta.url))))
  const ctx = await boot('files-pool-test', fixture, [], (setup) => {
    setup.loader.builtins['files-runtime-test'] = PeAccountRuntime
    setup.loader.builtins['files-pool-test'] = {
      name: 'files-pool-test',
      inject: Root.inject,
      Config: Root.Config,
      apply: async (child: Context, config: Root.Config) => {
        filesContext = child
        appliedConfig = config
        await mountRootPool(child, config, () => {
          const worker = new Worker(new URL('./fixtures/transport-worker.mjs', import.meta.url), { workerData: { mode: 'normal' } })
          workers.push(worker)
          return worker
        })
      },
    }
  })
  contexts.push(ctx)
  await filesContext.fiber.await()
  return { ctx, filesContext, config: appliedConfig }
}

function addExecution(ctx: Context): void {
  ctx.peAccountRuntime.registerDrainParticipant({
    id: 'execution',
    stopEpoch: binding => Promise.resolve({
      participant: 'execution', accountId: binding.accountId, epoch: binding.epoch,
      status: 'confirmed', pendingOperationIds: [], evidenceRefs: [],
    }),
  })
}

describe('files root pool through the real Loader', () => {
  it('registers one actual files participant only after all workers handshake', async () => {
    const { ctx, config } = await mounted()
    expect(ctx.peFilesPool.inspect()).toMatchObject({ state: 'running', workers: 2, healthy: 2 })
    expect(workers).toHaveLength(2)
    expect(() => { ctx.peAccountRuntime.assertRequiredParticipants() }).toThrow('execution')
    addExecution(ctx)
    expect(() => { ctx.peAccountRuntime.assertRequiredParticipants() }).not.toThrow()
    expect(() => ctx.peAccountRuntime.registerDrainParticipant(ctx.peFilesPool)).toThrow('Duplicate')
    let duplicateStarted = false
    await expect(mountRootPool(ctx, config, () => {
      duplicateStarted = true
      throw new Error('duplicate worker must not start')
    })).rejects.toThrow(/already exists/)
    expect(duplicateStarted).toBe(false)
    expect(ctx.get('fs')).toBeUndefined()
    expect(() => { Account.apply(ctx, {}) }).toThrow(/runtime-bound/)
  })

  it('keeps registration and root budget until worker exits and held result ownership settle', async () => {
    const { ctx, filesContext } = await mounted()
    addExecution(ctx)
    const pool = ctx.peFilesPool
    const binding: AccountBinding = Object.freeze({
      accountId: 'A' as AccountId, epoch: '1' as OwnerEpoch,
      recipeVersion: 'test', lifetime: new AbortController().signal,
    })
    const result = await pool.bind(binding, { rootPath: '/not-opened', rootDevice: '1', rootInode: '1' }, () => {})
      .readBytes('file.txt', 10)
    let disposed = false
    const disposing = filesContext.fiber.dispose().then(() => { disposed = true })
    try {
      expect((await pool.stop(Date.now() + 50)).status).toBe('unknown')
      expect(disposed).toBe(false)
      expect(pool.inspect().rootReservedBytes).toBeGreaterThan(0)
      expect(() => { ctx.peAccountRuntime.assertRequiredParticipants() }).not.toThrow()
    } finally {
      result.release()
      await disposing
    }
    expect(pool.inspect()).toMatchObject({ state: 'closed', exited: 2, rootReservedBytes: 0 })
    expect(ctx.get('peFilesPool')).toBeUndefined()
    expect(() => { ctx.peAccountRuntime.assertRequiredParticipants() }).toThrow('files')
  })

  it('retains its root service through actual worker exits when participant registration is rejected', async () => {
    const { ctx, filesContext, config } = await mounted()
    await filesContext.fiber.dispose()
    addExecution(ctx)
    ctx.peAccountRuntime.registerDrainParticipant({
      id: 'files',
      stopEpoch: binding => Promise.resolve({
        participant: 'files', accountId: binding.accountId, epoch: binding.epoch,
        status: 'confirmed', pendingOperationIds: [], evidenceRefs: [],
      }),
    })
    const ownedAtExit: boolean[] = []
    await expect(mountRootPool(ctx, config, () => {
      const worker = new Worker(new URL('./fixtures/transport-worker.mjs', import.meta.url), { workerData: { mode: 'normal' } })
      workers.push(worker)
      worker.once('exit', () => {
        const pool = ctx.get('peFilesPool')
        ownedAtExit.push(pool !== undefined && pool.inspect().rootReservedBytes > 0)
      })
      return worker
    })).rejects.toThrow('Duplicate')
    expect(ownedAtExit).toEqual([true, true])
    expect(ctx.get('peFilesPool')).toBeUndefined()
    expect(() => { ctx.peAccountRuntime.assertRequiredParticipants() }).not.toThrow()
  })
})
