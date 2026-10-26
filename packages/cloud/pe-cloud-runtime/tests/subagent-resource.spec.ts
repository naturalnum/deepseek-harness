/** Original native-only Factory teardown with fresh PostgreSQL owner metadata; no production readiness fixture. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import * as AccountEntry from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { AccountFactory, type AccountFactoryLimits } from '../src/account-factory.ts'
import type { AccountRecipe } from '../src/account-mount.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import type { AccountId, AccountMountInput, OwnerEpoch, RuntimeConfig, OwnerPgExecutor } from '../src/types.ts'
import NativeAccountProbe from './fixtures/native-probe.ts'

import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { quarantineOwnerSql, beginOwnerReconfigurationSql } from '../src/owner-sql.ts'
import { instanceTestConnection } from './instance-test-connection.ts'

const configuredPg = process.env['DSH_B2_PG_PRIVATE_CONFIG']

describe.skipIf(configuredPg === undefined)('original native-only Factory/PG owner settlement', () => {
  const factories: AccountFactory[] = []
  const directories: string[] = []
  const gates: ReturnType<typeof Promise.withResolvers<undefined>>[] = []
  const limits: AccountFactoryLimits = { maxWaiters: 24, maxWaitersPerAccount: 20, maxBorrows: 24, maxBorrowsPerAccount: 20 }

  afterEach(async () => {
    await locker?.query('ROLLBACK')
    for (const gate of gates.splice(0)) gate.resolve(undefined)
    for (const factory of factories.splice(0)) {
      await factory.close()
      // External fixture teardown can close a native-only graph retained by a failed drain reservation.
      for (const slot of factory['slots'].values()) await slot.native?.dispose()
    }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function gate() {
    const value = Promise.withResolvers<undefined>()
    gates.push(value)
    return value
  }

  function factory(overrides: Partial<AccountFactoryLimits> = {}, capacityOverrides: Partial<RuntimeConfig> = {}) {
    const capacity = new RuntimeCapacity({ maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2, ...capacityOverrides },
      { maxActivePerAccount: 8, maxActiveTotal: 12, maxDepth: 4 })
    const value = new AccountFactory(capacity, { ...limits, ...overrides })
    factories.push(value)
    return { value, capacity }
  }

  function fixture(label: string) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-factory-native-')))
    directories.push(directory)
    const accountId = brandString<AccountId>(label)
    const layout = deriveAccountLayout(accountId, identity.instanceId, {
      sharedAccountsRoot: join(directory, 'shared'), localCacheRoot: join(directory, 'cache'), maxPathBytes: 4096,
    })
    const cwd = defaultProjectLayout(layout, 4096).root
    mkdirSync(cwd, { recursive: true })
    initProfile(layout.profileRoot, [])
    writeFileSync(join(directory, 'package.json'), '{"name":"account-factory-native-fixture","private":true}\n')
    const configPath = join(layout.profileRoot, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    writeFileSync(layout.patchPath, JSON.stringify([{ insert: [
      { id: 'account', name: 'cordis:runtime-account' },
      { id: 'probe', name: 'cordis:probe', config: { ordinary: label, count: 1 } },
    ] }]) + '\n')
    const profile: ProfileContext = {
      name: label, dir: layout.profileRoot, patchPath: layout.patchPath, installAnchor: join(directory, 'package.json'),
      cwd, home: layout.privateRoot, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    const controller = new AbortController()
    const input: AccountMountInput = Object.freeze({
      binding: Object.freeze({ accountId, epoch: brandString<OwnerEpoch>('1'), recipeVersion: 'native-only-fixture', lifetime: controller.signal }),
      instanceId: identity.instanceId, layout,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot, FIXTURE_ACCOUNT: label } }]),
    })
    const entered = Promise.withResolvers<Context>()
    const resume = gate()
    let starts = 0
    const recipe: AccountRecipe = {
      profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
      requiredEntryIds: ['include', 'account', 'probe'], maxObservedEvents: 8, maxPathBytes: 4096,
      prepare: async (ctx) => {
        starts++
        Object.assign(ctx.loader.builtins, { 'runtime-account': AccountEntry, probe: NativeAccountProbe })
        entered.resolve(ctx)
        await resume.promise
      },
    }
    return { input, recipe, entered, resume, controller, starts: () => starts }
  }


  // These tests join actual native-only Factory slots and real PostgreSQL metadata.
  // Direct private settlement calls isolate ownership mechanics; they never make a slot ready
  // or establish complete production files/execution drain evidence.
  let executor: PgOwnerExecutor, locker: Client
  const identity = createProcessInstanceIdentity()
  const config = { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 }
  beforeAll(async () => {
    const path = process.env['DSH_B2_PG_PRIVATE_CONFIG']
    if (path === undefined) throw new Error('Fresh isolated B2 PostgreSQL configuration is required')
    const connection = await instanceTestConnection(path)
    executor = new PgOwnerExecutor(connection, { maxConnections: 4, maxQueued: 16, queueTimeoutMs: 5000,
      connectionTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 4000, maxObservedOperations: 32, maxObservers: 16 })
    locker = new Client(connection); await locker.connect()
  })
  afterAll(async () => { await locker.end(); await executor.close() })

  async function mounted(label: string, carrier: OwnerPgExecutor = executor) {
    const native = fixture(label + '-' + randomUUID().slice(0, 8)), { value, capacity } = factory()
    const owners = new PostgresOwnerStore(carrier, identity, config)
    await owners.migrate()
    const claimed = await owners.claim({ accountId: native.input.binding.accountId, expectedEpoch: null,
      recipeVersion: native.input.binding.recipeVersion })
    const actual = value.startNativeMount(native.input, native.recipe)
    await native.entered.promise; native.resume.resolve(undefined)
    const outcome = await actual
    if (outcome.status !== 'mounted') throw new Error('Original native-only Factory must mount')
    const slot = value['slots'].get(outcome.binding.accountId)!
    expect(slot.state).toBe('mounted-unpublished')
    expect(outcome.binding.epoch).toBe(claimed.epoch)
    // Attach only actual metadata responsibility to this already retained native-only slot.
    // Public child admission must still reject its missing production readiness/owners.
    slot.owners = owners
    const expected = { accountId: outcome.binding.accountId, epoch: outcome.binding.epoch }
    const reserve = () => value['observeSubagent'](slot, capacity.reserveSubagent(expected.accountId, 1))
    return { ...native, value, capacity, owners, slot, outcome, expected, reserve, claimed }
  }

  it('keeps actual native-only mounts closed before original capacity reservation, even with explicit 8/12/4 limits', async () => {
    const f = await mounted('b2-unpublished-closed'), allocate = vi.spyOn(f.capacity, 'reserveSubagent')
    expect(() => f.value.reserveSubagent(f.outcome.binding, 1)).toThrow('production readiness')
    expect(allocate).not.toHaveBeenCalled()
    expect(f.slot.state).toBe('mounted-unpublished')
  })

  it('releases confirmed native child capacity without closing or changing actual owner metadata', async () => {
    const f = await mounted('b2-confirmed'), reservation = f.reserve()
    reservation.settle('confirmed'); reservation.settle('unknown')
    expect(() => { f.capacity.assertSubagentsStopped(f.expected.accountId) }).not.toThrow()
    expect(f.slot.closeRequested).toBe(false)
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'mounting', ownerInstanceId: identity.instanceId })
  })

  it('closes the original slot synchronously, preserves the original error, defers disposal and durably quarantines the exact owner', async () => {
    const f = await mounted('b2-unknown'), reservation = f.reserve(), failure = new Error('original native metadata error')
    let disposed = 0
    f.outcome.context.effect(() => () => { disposed++ })
    const actual = Promise.reject(failure).catch((error: unknown) => { reservation.settle('unknown'); throw error })
    await expect(actual).rejects.toBe(failure)
    expect(f.slot.closeRequested).toBe(true)
    expect(f.slot.state).toBe('unknown')
    expect(disposed).toBe(0)
    expect(() => { f.outcome.context.fiber.assertActive() }).not.toThrow()
    expect(() => { f.value.assertMountCurrent(f.outcome.binding) }).toThrow('no longer current')
    const closing = f.value.stopNative(f.expected.accountId)
    expect(closing).toBe(f.value.stopNative(f.expected.accountId))
    await expect(closing).resolves.toMatchObject({ status: 'unknown' })
    expect(disposed).toBe(1)
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', epoch: f.expected.epoch, ownerInstanceId: identity.instanceId })
    reservation.settle('confirmed')
    expect(() => { f.capacity.assertSubagentsStopped(f.expected.accountId) }).toThrow('unconfirmed')
    expect(f.value.retainsAccount(f.expected.accountId)).toBe(true)
    expect(() => f.capacity.reserveMount(f.expected.accountId)).toThrow('already reserved')
  })

  it('serializes quarantine after the actual in-flight original metadata CAS without reopening the slot', async () => {
    let submitted = 0, quarantines = 0
    const counted: OwnerPgExecutor = { query(sql, values) {
      if (sql === beginOwnerReconfigurationSql) submitted++
      if (sql === quarantineOwnerSql) quarantines++
      return executor.query(sql, values)
    } }
    const f = await mounted('b2-pending-cas', counted)
    await f.owners.ready(f.expected, f.claimed.recipeVersion)
    await locker.query('BEGIN')
    await locker.query('SELECT account_id FROM public.pe_account_owners WHERE account_id=$1 FOR UPDATE', [f.expected.accountId])
    const transition = f.value['retainOwnerMutation'](f.slot, () => f.owners.beginReconfiguration(f.expected))
    await vi.waitFor(() => { expect(submitted).toBe(1) })
    f.reserve().settle('unknown')
    expect(f.slot.closeRequested).toBe(true)
    expect(quarantines).toBe(0)
    await locker.query('ROLLBACK')
    await transition
    await expect(f.value.stopNative(f.expected.accountId)).resolves.toMatchObject({ status: 'unknown' })
    expect(quarantines).toBe(1)
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', epoch: f.expected.epoch })
  })

  it('retains an actually committed quarantine with a lost response and never retries or clears its responsibility', async () => {
    const lost = new Error('isolated carrier lost quarantine response')
    let submissions = 0
    const carrier: OwnerPgExecutor = { async query(sql, values) {
      const result = await executor.query(sql, values)
      if (sql === quarantineOwnerSql) { submissions++; throw lost }
      return result
    } }
    const f = await mounted('b2-lost-quarantine', carrier), reservation = f.reserve()
    reservation.settle('unknown')
    const original = f.slot.quarantine
    expect(original).toBeDefined()
    await expect(f.value.stopNative(f.expected.accountId)).resolves.toMatchObject({ status: 'unknown' })
    expect(f.value['quarantineOwned'](f.slot)).toBe(original)
    await expect(original).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', ownerInstanceId: identity.instanceId })
    reservation.settle('confirmed')
    expect(submissions).toBe(1)
    expect(() => { f.capacity.assertSubagentsStopped(f.expected.accountId) }).toThrow()
    await expect(f.owners.beginDrain(f.expected)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
  })

  it('retains quarantine and child capacity when the original drain reservation is exhausted', async () => {
    const f = await mounted('b2-drain-full'), held = f.capacity.reserveDrain(f.expected.accountId), reservation = f.reserve()
    reservation.settle('unknown')
    await expect(f.value.stopNative(f.expected.accountId)).resolves.toMatchObject({ status: 'unknown' })
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'quarantined', ownerInstanceId: identity.instanceId })
    expect(f.slot.closeRequested).toBe(true)
    reservation.settle('confirmed'); held.release()
    expect(() => { f.capacity.assertSubagentsStopped(f.expected.accountId) }).toThrow()
  })

  it('refuses a stale quarantine CAS without modifying the newer epoch or releasing original responsibility', async () => {
    const f = await mounted('b2-stale-quarantine'), reservation = f.reserve()
    // This isolated metadata fixture advances a row only to exercise the original CAS mismatch.
    await executor.query('UPDATE public.pe_account_owners SET epoch=epoch+1 WHERE account_id=$1', [f.expected.accountId])
    reservation.settle('unknown')
    await expect(f.value.stopNative(f.expected.accountId)).resolves.toMatchObject({ status: 'unknown' })
    await expect(f.slot.quarantine).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(f.owners.locate(f.expected.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: '2', ownerInstanceId: identity.instanceId })
    expect(f.slot.closeRequested).toBe(true)
    reservation.settle('confirmed')
    expect(() => { f.capacity.assertSubagentsStopped(f.expected.accountId) }).toThrow()
  })

})
