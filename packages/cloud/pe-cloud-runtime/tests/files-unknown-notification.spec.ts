/** Finite native-only slot/notification tests; scripted storage facts never establish production readiness or clean drain. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import * as AccountEntry from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { RootStorageOwner, type StaticAccountStorageLease } from '@deepseek-ai/dsh-pe-cloud-files/root'
import { createMutationUnknownState } from '../../pe-cloud-files/src/worker-pool.ts'
import { FdMutationFailure } from '../../pe-cloud-files/src/worker-client.ts'
import type { StaticStorageDriver } from '../../pe-cloud-files/src/storage-owner.ts'
import { staticStorageProtocol } from '../../pe-cloud-files/tests/fixtures/static-storage-lifetime.ts'
import { AccountFactory } from '../src/account-factory.ts'
import type { AccountRecipe } from '../src/account-mount.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { quarantineOwnerSql } from '../src/owner-sql.ts'
import type { AccountId, AccountMountInput, OwnerEpoch, OwnerPgExecutor } from '../src/types.ts'
import { instanceTestConnection } from './instance-test-connection.ts'
import NativeAccountProbe from './fixtures/native-probe.ts'

const configuredPg = process.env['DSH_FILES_UNKNOWN_PG_PRIVATE_CONFIG']
const identity = createProcessInstanceIdentity()
const capacityLimits = { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 }
const factories: AccountFactory[] = [], directories: string[] = []
const leases: Array<{ owner: RootStorageOwner; lease: StaticAccountStorageLease }> = []
let locker: Client | undefined

afterEach(async () => {
  await locker?.query('ROLLBACK')
  for (const factory of factories.splice(0)) await factory.close()
  // These component leases never issued a files lane; release only their own retained preparation.
  for (const { owner, lease } of leases.splice(0)) { await lease.closeAfterActualDrain(); owner.closeAdmission() }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: false })
  vi.restoreAllMocks()
})

function factory() {
  const capacity = new RuntimeCapacity(capacityLimits)
  const value = new AccountFactory(capacity, { maxWaiters: 24, maxWaitersPerAccount: 20,
    maxBorrows: 24, maxBorrowsPerAccount: 20 })
  factories.push(value)
  return { value, capacity }
}

async function componentLease(input: AccountMountInput) {
  const protocol = staticStorageProtocol(), row = protocol.record.accounts[0]
  if (row === undefined) throw new Error('Public storage geometry requires its first account')
  const oldPrivate = row.private.rootPath, oldProjects = row.projects.rootPath
  row.accountId = input.binding.accountId; row.storageKey = input.layout.storageKey; row.accountRoot = input.layout.accountRoot
  row.private.rootPath = input.layout.privateRoot; row.projects.rootPath = input.layout.projectsRoot
  protocol.record.recipeVersion = input.binding.recipeVersion
  const encoded = new TextEncoder().encode(JSON.stringify(protocol.record)), facts = new Map(Object.entries(protocol.facts))
  for (const [oldPath, path] of [[oldPrivate, row.private.rootPath], [oldProjects, row.projects.rootPath]]) {
    const observed = oldPath === undefined ? undefined : facts.get(oldPath)
    if (oldPath === undefined || path === undefined || observed === undefined) throw new Error('Public geometry path missing')
    facts.set(path, observed); facts.delete(oldPath)
  }
  const mountInfo = protocol.mounts.replaceAll(oldPrivate, row.private.rootPath).replaceAll(oldProjects, row.projects.rootPath)
  const unavailable = (): never => { throw new Error('This component lease cannot issue a production files lane') }
  const driver: StaticStorageDriver = {
    record: async () => encoded,
    view: async () => ({ mountInfo: new TextEncoder().encode(mountInfo), status: new TextEncoder().encode(protocol.status) }),
    probe: async path => facts.get(path) ?? unavailable(), assertPoolCurrent: () => {}, bind: unavailable,
    joinEpoch: unavailable,
  }
  const owner = new RootStorageOwner({ ...protocol.config,
    planSha256: createHash('sha256').update(encoded).digest('hex') }, 4096, driver)
  await owner.initializeStatic()
  const lease = await owner.prepareAccount(input)
  leases.push({ owner, lease })
  return { owner, lease }
}

async function mounted(label: string, shared = factory()) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-files-unknown-slot-')))
  directories.push(directory)
  const accountId = brandString<AccountId>(label + '-' + randomUUID())
  const layout = deriveAccountLayout(accountId, identity.instanceId, {
    sharedAccountsRoot: join(directory, 'shared'), localCacheRoot: join(directory, 'cache'), maxPathBytes: 4096,
  })
  const cwd = defaultProjectLayout(layout, 4096).root
  mkdirSync(cwd, { recursive: true }); initProfile(layout.profileRoot, [])
  const anchor = join(directory, 'package.json'), configPath = join(layout.profileRoot, 'cordis.yml')
  writeFileSync(anchor, '{"name":"files-unknown-native-only-fixture","private":true}\n')
  writeFileSync(configPath, '[]\n')
  writeFileSync(layout.patchPath, JSON.stringify([{ insert: [
    { id: 'account', name: 'cordis:runtime-account' }, { id: 'probe', name: 'cordis:probe', config: { ordinary: label, count: 1 } },
  ] }]) + '\n')
  const profile: ProfileContext = { name: label, dir: layout.profileRoot, patchPath: layout.patchPath, installAnchor: anchor,
    cwd, home: layout.privateRoot, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const controller = new AbortController()
  const original: AccountMountInput = { binding: { accountId, epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'files-unknown-native-only-fixture', lifetime: controller.signal }, instanceId: identity.instanceId, layout,
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot } }]) }
  const entered = Promise.withResolvers<Context>()
  const recipe: AccountRecipe = { profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    requiredEntryIds: ['include', 'account', 'probe'], maxObservedEvents: 8, maxPathBytes: 4096,
    prepare: (ctx) => { Object.assign(ctx.loader.builtins, { 'runtime-account': AccountEntry, probe: NativeAccountProbe }); entered.resolve(ctx) } }
  const actual = shared.value.startNativeMount(original, recipe)
  await entered.promise
  const outcome = await actual
  if (outcome.status !== 'mounted') throw new Error('Actual native-only fixture failed to mount')
  const slot = shared.value['slots'].get(accountId)
  if (slot === undefined) throw new Error('Original mounted slot missing')
  expect(slot.state).toBe('mounted-unpublished')
  const input: AccountMountInput = { ...original, binding: outcome.binding }, storage = await componentLease(input)
  slot.storageLease = storage.lease; slot.storageOwner = storage.owner
  const notify = () => { shared.value['fileMutationUnknown'](slot, outcome.binding, storage.lease) }
  return { ...shared, ...storage, input, slot, outcome, controller, notify }
}

describe('finite original-slot file failure notification', () => {
  it('fences synchronously, preserves the error, defers native disposal and retains the original slot and lease', async () => {
    const f = await mounted('017-local-A'), b = await mounted('017-local-B', f)
    let disposed = 0
    f.outcome.context.effect(() => () => { disposed++ })
    const state = createMutationUnknownState(f.notify), failure = new FdMutationFailure('unknown', 'FS_IO_ERROR')
    state.markUnknown()
    expect(state.unknown).toBe(true); expect(f.slot.state).toBe('unknown'); expect(f.slot.closeRequested).toBe(true)
    expect(disposed).toBe(0); f.outcome.context.fiber.assertActive()
    expect(() => f.value.assertMountCurrent(f.outcome.binding)).toThrow('no longer current')
    await expect(f.value.borrowCurrent(f.outcome.binding)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    b.value.assertMountCurrent(b.outcome.binding); b.outcome.context.fiber.assertActive()
    await expect(Promise.reject(failure)).rejects.toBe(failure)
    const closing = f.slot.closing, quarantine = f.slot.quarantine
    state.markUnknown(); f.notify()
    expect(f.slot.closing).toBe(closing); expect(f.slot.quarantine).toBe(quarantine)
    await expect(closing).resolves.toMatchObject({ status: 'unknown' })
    expect(disposed).toBe(1); expect(f.slot.storageLease).toBe(f.lease)
    expect(f.value.retainsAccount(f.outcome.binding.accountId)).toBe(true)
    expect(() => f.capacity.reserveMount(f.outcome.binding.accountId)).toThrow('already reserved')
    b.value.assertMountCurrent(b.outcome.binding)
  })

  it('ignores a copied binding, another lease and a withdrawn slot without changing healthy B', async () => {
    const f = await mounted('017-stale-A'), b = await mounted('017-stale-B', f)
    const foreign = { ...f.outcome.binding, epoch: brandString<OwnerEpoch>('2') }
    f.value['fileMutationUnknown'](f.slot, foreign, f.lease)
    f.value['fileMutationUnknown'](f.slot, { ...f.outcome.binding }, f.lease)
    f.value['fileMutationUnknown'](f.slot, f.outcome.binding, b.lease)
    const slots = f.value['slots']
    slots.delete(f.outcome.binding.accountId)
    try { f.notify() } finally { slots.set(f.outcome.binding.accountId, f.slot) }
    expect(f.slot.state).toBe('mounted-unpublished'); expect(f.slot.closeRequested).toBe(false)
    expect(f.slot.quarantine).toBeUndefined(); expect(f.slot.closing).toBeUndefined()
    f.value.assertMountCurrent(f.outcome.binding); b.value.assertMountCurrent(b.outcome.binding)
  })

  it('retains a late unknown after observer cancellation instead of dropping original failure ownership', async () => {
    const f = await mounted('017-cancelled')
    f.controller.abort()
    f.notify(); const closing = f.slot.closing
    expect(f.slot.state).toBe('unknown'); expect(f.slot.closeRequested).toBe(true)
    await expect(closing).resolves.toMatchObject({ status: 'unknown' })
    expect(f.slot.storageLease).toBe(f.lease); expect(f.value.retainsAccount(f.outcome.binding.accountId)).toBe(true)
  })
})

describe.skipIf(configuredPg === undefined)('original file notification with actual isolated PostgreSQL metadata', () => {
  let executor: PgOwnerExecutor
  beforeAll(async () => {
    if (configuredPg === undefined) throw new Error('Coordinator-assigned public isolated PostgreSQL configuration required')
    const connection = await instanceTestConnection(configuredPg)
    executor = new PgOwnerExecutor(connection, { maxConnections: 4, maxQueued: 16, queueTimeoutMs: 5000,
      connectionTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 4000, maxObservedOperations: 32, maxObservers: 16 })
    locker = new Client(connection); await locker.connect()
  })
  afterAll(async () => {
    await locker?.end(); locker = undefined
    await executor.close()
    expect(executor.inspect()).toMatchObject({ connections: 0, querying: 0, queued: 0, observedOperations: 0, observers: 0 })
  })
  async function owned(label: string, carrier: OwnerPgExecutor = executor, shared?: ReturnType<typeof factory>) {
    const f = await mounted(label, shared)
    const owners = new PostgresOwnerStore(carrier, identity, capacityLimits)
    await owners.migrate()
    const claimed = await owners.claim({ accountId: f.outcome.binding.accountId, expectedEpoch: null,
      recipeVersion: f.outcome.binding.recipeVersion })
    expect(claimed.epoch).toBe(f.outcome.binding.epoch)
    // Metadata attachment keeps this fixture unpublished; it never forges a production ready/drain receipt.
    f.slot.owners = owners
    return { ...f, owners, expected: { accountId: f.outcome.binding.accountId, epoch: f.outcome.binding.epoch } }
  }

  it('submits one real quarantine for the original epoch while B stays unchanged and cleanup remains unknown', async () => {
    let quarantines = 0
    const counted: OwnerPgExecutor = { query: (sql, values) => {
      if (sql === quarantineOwnerSql) quarantines++
      return executor.query(sql, values)
    } }
    const f = await owned('017-PG-A', counted), b = await owned('017-PG-B', executor, f)
    f.notify(); const actual = f.slot.quarantine, closing = f.slot.closing
    expect(f.slot.closeRequested).toBe(true); expect(f.slot.state).toBe('unknown')
    f.notify(); expect(f.slot.quarantine).toBe(actual); expect(f.slot.closing).toBe(closing)
    await actual
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined',
      ownerInstanceId: identity.instanceId, epoch: f.expected.epoch })
    await expect(b.owners.locate(b.expected.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: b.expected.epoch })
    await expect(closing).resolves.toMatchObject({ status: 'unknown' })
    expect(quarantines).toBe(1); expect(f.slot.storageLease).toBe(f.lease)
    b.value.assertMountCurrent(b.outcome.binding)
  })

  it('keeps an actually committed quarantine with a lost response and never retries its original responsibility', async () => {
    let quarantines = 0
    const lost = new Error('public fixture lost quarantine response')
    const carrier: OwnerPgExecutor = { query: async (sql, values) => {
      const result = await executor.query(sql, values)
      if (sql === quarantineOwnerSql) { quarantines++; throw lost }
      return result
    } }
    const f = await owned('017-PG-lost', carrier)
    f.notify(); const actual = f.slot.quarantine
    await expect(actual).rejects.toMatchObject({ code: 'cloud/account-unavailable', cause: lost })
    f.notify(); expect(f.slot.quarantine).toBe(actual)
    await expect(f.slot.closing).resolves.toMatchObject({ status: 'unknown' })
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', epoch: f.expected.epoch })
    expect(quarantines).toBe(1); expect(f.value.retainsAccount(f.expected.accountId)).toBe(true)
  })

  it('retains local fencing when the original quarantine CAS rejects a newer epoch without changing it', async () => {
    const f = await owned('017-PG-stale')
    await executor.query('UPDATE public.pe_account_owners SET epoch=epoch+1 WHERE account_id=$1', [f.expected.accountId])
    f.notify()
    await expect(f.slot.quarantine).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(f.slot.closing).resolves.toMatchObject({ status: 'unknown' })
    expect(f.slot.closeRequested).toBe(true); expect(f.slot.storageLease).toBe(f.lease)
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'mounting',
      epoch: String(BigInt(f.expected.epoch) + 1n), ownerInstanceId: identity.instanceId })
  })

  it('waits for the original in-flight owner CAS before the one quarantine without reopening the slot', async () => {
    let quarantines = 0
    const counted: OwnerPgExecutor = { query: (sql, values) => {
      if (sql === quarantineOwnerSql) quarantines++
      return executor.query(sql, values)
    } }
    const f = await owned('017-PG-ordered', counted)
    if (locker === undefined) throw new Error('Original test locker absent')
    await locker.query('BEGIN')
    await locker.query('SELECT account_id FROM public.pe_account_owners WHERE account_id=$1 FOR UPDATE', [f.expected.accountId])
    const transition = f.value['retainOwnerMutation'](f.slot, () => f.owners.beginDrain(f.expected))
    await vi.waitFor(() => { expect(executor.inspect().querying).toBeGreaterThan(0) })
    f.notify(); expect(f.slot.closeRequested).toBe(true); expect(quarantines).toBe(0)
    await locker.query('ROLLBACK'); await transition; await f.slot.quarantine
    await expect(f.slot.closing).resolves.toMatchObject({ status: 'unknown' })
    expect(quarantines).toBe(1)
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', epoch: f.expected.epoch })
  })
})
