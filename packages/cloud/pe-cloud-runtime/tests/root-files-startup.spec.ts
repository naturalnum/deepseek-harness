/** Real Cordis/Runtime/Files startup; only PG transport and Linux probe facts are external fixtures. */
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { StaticAccountBindings } from '../src/static-account-bindings.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { staticAccountMigrationSql } from '../src/migrations/static-accounts.ts'
import { registerInstanceSql, heartbeatInstanceSql, closeInstanceSql } from '../src/instance-sql.ts'
import { locateOwnerSql } from '../src/owner-sql.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'
import * as FilesRoot from '../../pe-cloud-files/src/root.ts'
import { mountRootPool } from '../../pe-cloud-files/src/root-lifecycle.ts'
import { staticStorageProtocol } from '../../pe-cloud-files/tests/fixtures/static-storage-lifetime.ts'

const driver = vi.hoisted(() => ({
  run: undefined as undefined | ((text: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>),
}))
vi.mock('pg', () => ({ defaults: { query_timeout: 0 }, Client: class {
  constructor(private readonly config: { password?: string | (() => Promise<string>) }) {}
  on() { return this }
  async connect() { if (typeof this.config.password === 'function') await this.config.password() }
  query(input: { text: string; values: readonly (string | null)[] }) {
    if (driver.run === undefined) throw new Error('Unconfigured startup PG transport')
    return driver.run(input.text, input.values)
  }
  async end() {}
} }))

function protocol(version: 1 | 3) {
  const original = staticStorageProtocol()
  if (version === 1) return original
  const { accounts, ...base } = original.record
  const environments = accounts.map((account, index) => ({
    ...account.private, rootPath: account.accountRoot + '/environments/slot-0',
    rootDevice: String(index + 7), rootMountId: String(index + 17),
    backing: { ...account.private.backing, path: `/backing-${index + 7}`, inode: String(index + 27) },
  }))
  const record = { ...base, version: 3, maxAccounts: 2, slots: accounts.map(({ accountId, ...account }, index) => ({
    ...account, slotId: accountId, templateId: 'standard',
    environmentBank: { bankId: `bank-${index}`, slots: [{ slotId: 'slot-0', domain: environments[index]! }] },
  })) }
  const facts = { ...original.facts }
  for (const [index, domain] of environments.entries()) {
    const prior = accounts[index]!.private
    facts[domain.rootPath] = { ...facts[prior.rootPath]!, device: domain.rootDevice, mountId: domain.rootMountId }
    facts[domain.backing.path] = { ...facts[prior.backing.path]!, inode: domain.backing.inode }
  }
  const mounts = [original.mounts, ...environments.map((domain, index) =>
    `${domain.rootMountId} 1 8:${index + 7} / ${domain.rootPath} rw - ext4 /dev/test-env-${index} rw`)].join('\n')
  return { ...original, record, facts, mounts, config: { ...original.config,
    planSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') } }
}

async function fixture(version: 1 | 3 = 3, failStartup = false) {
  // The original storage-probe fixture controls Linux facts only; it proves no actual quota or deployment.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'root-files-startup-')))
  const config = { ...rootConfig(directory), heartbeatIntervalMs: 1000 }
  const wire = protocol(version), readyGate = new SharedArrayBuffer(4), counters = new SharedArrayBuffer(4)
  const entered = Promise.withResolvers<undefined>(), workers: Worker[] = [], statements: string[] = []
  let context: Context | undefined
  const release = () => { Atomics.store(new Int32Array(readyGate), 0, 1); Atomics.notify(new Int32Array(readyGate), 0) }
  driver.run = async (text, values) => {
    statements.push(text)
    if (text === instanceMigrationSql || text === accountOwnerMigrationSql || text === locateOwnerSql
      || text === staticAccountMigrationSql || text.includes('FROM public.pe_account_static_bindings LIMIT')) return { rows: [] }
    if ([registerInstanceSql, heartbeatInstanceSql, closeInstanceSql].includes(text)) return { rows: [{
      instance: { instanceId: values[0], internalAddress: values[1], recipeVersion: values[2],
        phase: text === closeInstanceSql ? 'closed' : 'registered', heartbeatAt: '2026-11-08T00:00:00.000000Z' },
    }] }
    throw new Error('Unexpected startup fixture SQL')
  }
  const filesConfig: FilesRoot.Config = {
    maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
    maxResidentBytes: 8 * 1048576, maxResidentBytesPerLane: 2 * 1048576, waitTimeoutMs: 5000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 16384,
    readyTimeoutMs: 5000, drainTimeoutMs: 1000, helperPath: '/not-loaded/component-only.node',
    maxReadBytes: 1024, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 128,
    content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000 },
    skillVersions: { maxVersions: 2, maxTotalBytes: 4096, maxTotalInodes: 9, maxFileBytes: 1024, reservationBytes: 1048576 },
    staticStorage: { ...wire.config, rootProbeReservationBytes: 2 * 1048576 },
  }
  const path = join(directory, 'cordis.yml')
  writeFileSync(path, JSON.stringify([{ id: 'credentials', name: 'cordis:startup-credentials' },
    { id: 'runtime', name: 'cordis:startup-runtime', config },
    { id: 'files', name: 'cordis:startup-files', config: filesConfig }]))
  const initializing = vi.spyOn(StaticAccountBindings.prototype, 'initialize')
  const graph = boot('root-files-startup-fixture', path, [], (ctx) => {
    context = ctx
    Object.assign(ctx.loader.builtins, { 'startup-runtime': Root,
      'startup-credentials': { apply(owner: Context) {
        new RootCredentials(owner, async () => ({ value: 'synthetic-only', source: 'fixture' }))
      } },
      'startup-files': { name: 'startup-files', inject: FilesRoot.inject, Config: FilesRoot.Config,
        apply: (owner: Context, actual: FilesRoot.Config) => mountRootPool(owner, actual, () => {
          const worker = new Worker(new URL('./fixtures/delayed-files-startup-worker.mjs', import.meta.url), {
            workerData: { record: wire.record, facts: wire.facts, mounts: wire.mounts, status: wire.status,
              counters, readyGate, failStartup },
          })
          workers.push(worker); entered.resolve(undefined); return worker
        }) },
    })
  })
  onTestFinished(async () => {
    release()
    try { await graph; await context?.fiber.dispose() }
    finally {
      await Promise.all(workers.map(worker => worker.terminate()))
      vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true })
    }
  })
  await entered.promise
  if (context === undefined) throw new Error('Original Loader context absent')
  const runtime = context.get('peAccountRuntime'), pool = context.get('peFilesPool', false)
  if (!(runtime instanceof Root.PeAccountRuntime) || pool === undefined) throw new Error('Original startup owners absent')
  await vi.waitFor(() => { expect(runtime.inspectControl().phase).toBe('active') })
  const storage = vi.spyOn(pool, 'requireStorageOwner'), start = vi.spyOn(pool, 'start')
  return { runtime, pool, graph, release, workers, storage, start, initializing, statements }
}

it('joins the retained Files startup before concurrent management reads and lets the original inventory callback finish', async () => {
  const f = await fixture(), original = f.pool.start()
  expect(f.pool.start()).toBe(original)
  const first = f.runtime.accountResourceTemplates(), second = f.runtime.accountResourceTemplates()
  const administration = f.runtime.initializeAccountAdministration([], { idleTransactionTimeoutMs: 1_000_000,
    authOperationTimeoutMs: 500_000, authStatementTimeoutMs: 1000, authConnectionTimeoutMs: 1000 })
  // Handle a legacy early rejection immediately so the pre-fix regression has no unhandled Promise.
  const settled = Promise.allSettled([first, second, administration])
  let finished = false
  void settled.then(() => { finished = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  expect(f.storage).not.toHaveBeenCalled()
  expect(f.initializing).not.toHaveBeenCalled()
  f.release()
  await expect(settled).resolves.toEqual([
    { status: 'fulfilled', value: [{ id: 'standard', available: 2 }] },
    { status: 'fulfilled', value: [{ id: 'standard', available: 2 }] },
    { status: 'fulfilled', value: undefined },
  ])
  await f.graph
  expect(f.workers).toHaveLength(1)
  expect(f.initializing).toHaveBeenCalledTimes(1)
  expect(f.statements.filter(text => text === staticAccountMigrationSql)).toHaveLength(1)
  const starts = f.start.mock.calls.length
  await expect(f.runtime.accountResourceTemplates()).resolves.toEqual([{ id: 'standard', available: 2 }])
  expect(f.start).toHaveBeenCalledTimes(starts)
})

it.each([1, 3] as const)('does not publish bindings after Root closes during v%i Files startup', async (version) => {
  const f = await fixture(version), pending = f.runtime.accountResourceTemplates(), settled = Promise.allSettled([pending])
  await f.runtime.close()
  f.release()
  await expect(settled).resolves.toMatchObject([{ status: 'rejected', reason: { code: 'cloud/account-unavailable' } }])
  await f.graph
  expect(f.runtime.inspectControl().phase).toBe('closed')
  expect(f.storage).not.toHaveBeenCalled()
  expect(f.initializing).not.toHaveBeenCalled()
  expect(f.statements).not.toContain(staticAccountMigrationSql)
})

it('propagates the original retained Files startup rejection without issuing storage or bindings', async () => {
  const f = await fixture(3, true), original = f.pool.start(), originalFailure = original.catch((error: unknown) => error)
  const pending = f.runtime.accountResourceTemplates(), failure = pending.catch((error: unknown) => error)
  f.release()
  expect(await failure).toBe(await originalFailure)
  await f.graph
  expect(f.storage).not.toHaveBeenCalled()
  expect(f.initializing).not.toHaveBeenCalled()
  expect(f.workers).toHaveLength(1)
})

it('waits for the same original Files start but keeps legacy v1 inventory behavior unchanged', async () => {
  const f = await fixture(1), pending = f.runtime.accountResourceTemplates(), settled = Promise.allSettled([pending])
  let finished = false
  void settled.then(() => { finished = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  expect(f.storage).not.toHaveBeenCalled()
  f.release()
  await expect(settled).resolves.toEqual([{ status: 'fulfilled', value: [] }])
  await f.graph
  expect(f.initializing).not.toHaveBeenCalled()
  expect(f.statements).not.toContain(staticAccountMigrationSql)
  expect(f.workers).toHaveLength(1)
})
