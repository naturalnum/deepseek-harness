/** Actual native Loader fixtures, with no PG substitute, product ports, ready flag, or clean receipt. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import * as AccountEntry from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { AccountFactory, type AccountFactoryLimits } from '../src/account-factory.ts'
import { AccountMountPrerequisiteError, requireAccountProductionPorts, type AccountRecipe } from '../src/account-mount.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import type { AccountId, AccountMountInput, AccountOwner, OwnerEpoch, RuntimeConfig } from '../src/types.ts'
import NativeAccountProbe from './fixtures/native-probe.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'

const factories: AccountFactory[] = []
const directories: string[] = []
const gates: ReturnType<typeof Promise.withResolvers<undefined>>[] = []
const limits: AccountFactoryLimits = { maxWaiters: 24, maxWaitersPerAccount: 20, maxBorrows: 24, maxBorrowsPerAccount: 20 }

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve(undefined)
  for (const factory of factories.splice(0)) await factory.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function gate() {
  const value = Promise.withResolvers<undefined>()
  gates.push(value)
  return value
}

function factory(overrides: Partial<AccountFactoryLimits> = {}, capacityOverrides: Partial<RuntimeConfig> = {}) {
  const capacity = new RuntimeCapacity({ maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2, ...capacityOverrides })
  const value = new AccountFactory(capacity, { ...limits, ...overrides })
  factories.push(value)
  return { value, capacity }
}

function fixture(label: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-factory-native-')))
  directories.push(directory)
  const accountId = brandString<AccountId>(label)
  const identity = createProcessInstanceIdentity()
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

describe('bounded concrete native account mounts', () => {
  it.each(['same-input', 'fresh-wrapper'])('merges twenty actual Loader starts using %s without publishing ready', async (style) => {
    const { value } = factory()
    const f = fixture(style)
    const actuals = Array.from({ length: 20 }, () => value.startNativeMount(style === 'same-input' ? f.input : { ...f.input }, f.recipe))
    expect(new Set(actuals).size).toBe(1)
    const cancelled = new AbortController()
    const observed = Array.from({ length: 20 }, (_, index) => value.observeMount(
      f.input.binding.accountId, Date.now() + 5000, index === 0 ? cancelled.signal : undefined,
    ))
    const ctx = await f.entered.promise
    cancelled.abort()
    await expect(observed[0]).rejects.toMatchObject({ reason: 'observer-cancelled' })
    expect(value.inspect()).toMatchObject({ slots: 1, pending: 1, waiters: 19, borrows: 0 })
    expect(f.starts()).toBe(1)
    f.resume.resolve(undefined)
    const outcomes = await Promise.all(observed.slice(1))
    for (const outcome of outcomes) {
      if (outcome.status !== 'mounted') throw new Error('Actual native mount must succeed')
      expect(outcome.context === ctx).toBe(true)
    }
    expect(ctx.nativeAccountProbe.environment).toBe(f.input.environment)
    expect(ctx.nativeAccountProbe.binding).toBe(ctx.get('peAccount'))
    expect(ctx.nativeAccountProbe.binding).not.toBe(f.input.binding)
    const binding = ctx.nativeAccountProbe.binding
    expect(() => { value.assertMountCurrent(binding) }).not.toThrow()
    expect(() => { value.assertBusinessCurrent(binding) }).toThrow('production readiness')
    await expect(value.borrowCurrent(binding)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(value.borrowCurrent({ ...binding })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    let calls = 0
    await expect(value.withAccount(binding, Date.now() + 5000, undefined, async () => { calls++; return 'unreachable' }))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(calls).toBe(0)
    expect(value.inspect()).toMatchObject({ pending: 0, waiters: 0, borrows: 0 })
  })

  it('rejects genuinely different bound resources while an original Loader mount is retained', async () => {
    const { value } = factory()
    const f = fixture('resource-conflict')
    const actual = value.startNativeMount(f.input, f.recipe)
    await f.entered.promise
    for (const input of [
      { ...f.input, binding: { ...f.input.binding } },
      { ...f.input, layout: { ...f.input.layout } },
      { ...f.input, environment: createLaunchEnvironmentSnapshot([]) },
      { ...f.input, instanceId: createProcessInstanceIdentity().instanceId },
    ]) expect(() => value.startNativeMount(input, f.recipe)).toThrow('inputs differ')
    expect(() => value.startNativeMount(f.input, { ...f.recipe })).toThrow('inputs differ')
    f.resume.resolve(undefined)
    await expect(actual).resolves.toMatchObject({ status: 'mounted' })
    expect(f.starts()).toBe(1)
  })

  it('removes expired and aborted waiters while actual mounts and both account bounds remain held', async () => {
    const { value } = factory({ maxWaiters: 2, maxWaitersPerAccount: 1 })
    const a = fixture('wait-a'), b = fixture('wait-b')
    const actualA = value.startNativeMount(a.input, a.recipe)
    const actualB = value.startNativeMount(b.input, b.recipe)
    await Promise.all([a.entered.promise, b.entered.promise])
    const abandoned = new AbortController()
    const waitingB = value.observeMount(b.input.binding.accountId, Date.now() + 5000, abandoned.signal)
    const waitingA = value.observeMount(a.input.binding.accountId, Date.now() + 20)
    expect(() => value.observeMount(a.input.binding.accountId, Date.now() + 5000)).toThrow('capacity')
    await expect(waitingA).rejects.toMatchObject({ reason: 'deadline' })
    expect(value.inspect()).toMatchObject({ pending: 2, waiters: 1 })
    expect(() => value.observeMount(b.input.binding.accountId, Date.now() + 5000)).toThrow('capacity')
    abandoned.abort()
    await expect(waitingB).rejects.toMatchObject({ reason: 'observer-cancelled' })
    expect(value.inspect()).toMatchObject({ pending: 2, waiters: 0 })
    a.resume.resolve(undefined); b.resume.resolve(undefined)
    await expect(actualA).resolves.toMatchObject({ status: 'mounted' })
    await expect(actualB).resolves.toMatchObject({ status: 'mounted' })
  })

  it('releases only the mount-operation capacity after actual startup and retains both account reservations', async () => {
    const { value, capacity } = factory({}, { maxMountedAccounts: 2, maxConcurrentMounts: 1 })
    const a = fixture('capacity-a'), b = fixture('capacity-b')
    const actualA = value.startNativeMount(a.input, a.recipe)
    await a.entered.promise
    expect(() => value.startNativeMount(b.input, b.recipe)).toThrow('capacity')
    expect(b.starts()).toBe(0)
    a.resume.resolve(undefined)
    await expect(actualA).resolves.toMatchObject({ status: 'mounted' })
    const actualB = value.startNativeMount(b.input, b.recipe)
    await b.entered.promise
    b.resume.resolve(undefined)
    await expect(actualB).resolves.toMatchObject({ status: 'mounted' })
    await expect(value.stopNative(a.input.binding.accountId)).resolves.toMatchObject({ native: { status: 'confirmed' } })
    expect(() => capacity.reserveMount(brandString<AccountId>('capacity-excess'))).toThrow('capacity')
  })

  it('holds mount capacity through delayed prepare and uses an internal drain after closing admission', async () => {
    const { value, capacity } = factory({}, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
    const f = fixture('close-during-prepare')
    const cleanupEntered = gate(), cleanupFinished = gate()
    const recipe: AccountRecipe = { ...f.recipe, prepare: async (ctx, binding) => {
      ctx.effect(() => async () => { cleanupEntered.resolve(undefined); await cleanupFinished.promise })
      await f.recipe.prepare(ctx, binding)
    } }
    const actual = value.startNativeMount(f.input, recipe)
    await f.entered.promise
    const closed = value.close()
    expect(value.close()).toBe(closed)
    await cleanupEntered.promise
    expect(() => capacity.reserveMount(brandString<AccountId>('another'))).toThrow('capacity')
    expect(value.inspect()).toMatchObject({ pending: 1, closed: true })
    f.resume.resolve(undefined)
    cleanupFinished.resolve(undefined)
    await expect(actual).resolves.toMatchObject({ status: 'failed' })
    await expect(closed).resolves.toMatchObject([{ status: 'observed', native: { status: 'confirmed' } }])
    expect(value.inspect()).toMatchObject({ slots: 1, pending: 0, closed: true })
    expect(() => { value.assertMountCurrent(f.input.binding) }).toThrow('no longer current')
    expect(() => capacity.reserveMount(f.input.binding.accountId)).toThrow('already reserved')
  })

  it('retains real throwing-disposer uncertainty and the original native close while B stays active', async () => {
    const { value, capacity } = factory({}, { maxMountedAccounts: 2, maxConcurrentDrains: 2 })
    const a = fixture('dispose-a'), b = fixture('dispose-b')
    const entered = gate(), finish = gate()
    const recipe: AccountRecipe = { ...a.recipe, prepare: async (ctx, binding) => {
      ctx.effect(() => async () => { entered.resolve(undefined); await finish.promise; throw new Error('native disposer fixture failure') })
      await a.recipe.prepare(ctx, binding)
    } }
    const actualA = value.startNativeMount(a.input, recipe), actualB = value.startNativeMount(b.input, b.recipe)
    a.resume.resolve(undefined); b.resume.resolve(undefined)
    const [outcomeA, outcomeB] = await Promise.all([actualA, actualB])
    if (outcomeA.status !== 'mounted' || outcomeB.status !== 'mounted') throw new Error('Both actual native fixtures must mount')
    const closed = value.stopNative(a.input.binding.accountId)
    await entered.promise
    expect(value.stopNative(a.input.binding.accountId)).toBe(closed)
    expect(() => { outcomeB.context.fiber.assertActive() }).not.toThrow()
    expect(outcomeB.context.nativeAccountProbe.closed).toBe(false)
    expect(() => capacity.reserveMount(brandString<AccountId>('excess'))).toThrow('capacity')
    finish.resolve(undefined)
    await expect(closed).resolves.toMatchObject({ status: 'unknown', native: { status: 'unknown', errorEvents: 1 } })
    expect(value.inspect()).toMatchObject({ slots: 2, unknown: 1 })
    expect(value.stopNative(a.input.binding.accountId)).toBe(closed)
    expect(() => capacity.reserveMount(a.input.binding.accountId)).toThrow('already reserved')
    expect(() => capacity.reserveDrain(a.input.binding.accountId)).toThrow('drain capacity')
    expect(outcomeA.context.get('loader')).toBeUndefined()
    expect(() => { value.assertMountCurrent(outcomeA.binding) }).toThrow('no longer current')
    expect(() => { value.assertMountCurrent(outcomeB.binding) }).not.toThrow()
  })

  it('rejects Profile/layout disagreement before native preparation and never accepts a production flag', async () => {
    const { value } = factory()
    const f = fixture('profile-mismatch')
    const actual = value.startNativeMount(f.input, { ...f.recipe, profile: { ...f.recipe.profile, home: '/wrong-account' } })
    await expect(actual).rejects.toMatchObject({ code: 'cloud/invalid-config' })
    expect(f.starts()).toBe(0)
    expect(() => { requireAccountProductionPorts() }).toThrow(AccountMountPrerequisiteError)
    expect(new AccountMountPrerequisiteError().missing).toContain('all-writer-quota')
  })

  it('rejects ended generations and already abandoned observers without discarding the pending native actual', async () => {
    const { value } = factory()
    const f = fixture('stale-during-prepare')
    const actual = value.startNativeMount(f.input, f.recipe)
    await f.entered.promise
    const abandoned = new AbortController()
    abandoned.abort()
    expect(() => value.observeMount(f.input.binding.accountId, Date.now() + 5000, abandoned.signal))
      .toThrow('observation ended')
    expect(value.inspect()).toMatchObject({ pending: 1, waiters: 0 })
    f.controller.abort()
    f.resume.resolve(undefined)
    await expect(actual).resolves.toMatchObject({ status: 'failed' })
    await expect(value.borrowCurrent(f.input.binding)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('cannot issue a configuration completion receipt from a native-only graph without production ready ownership', async () => {
    const { value } = factory(), f = fixture('configuration-requires-ready')
    const actual = value.startNativeMount(f.input, f.recipe)
    f.resume.resolve(undefined)
    const outcome = await actual
    if (outcome.status !== 'mounted') throw new Error('Actual native mount must succeed')
    let calls = 0
    expect(() => value.scheduleConfigurationRebuild(outcome.binding, {
      async afterRequest() { calls++ }, async closePeers() { calls++ }, assertPrincipal() { calls++ },
      async prepare() { calls++; return { accepted: true as const, intent: 'unreachable' } },
      async apply() { calls++; return 'unreachable' }, async verify() { calls++; return 'unreachable' },
      failed() { calls++ },
    })).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(calls).toBe(0)
    expect(value.inspect()).toMatchObject({ pending: 0, borrows: 0 })
  })

})


function observedOwner(f: ReturnType<typeof fixture>): AccountOwner {
  return Object.freeze({ accountId: f.input.binding.accountId, ownerInstanceId: f.input.instanceId,
    epoch: f.input.binding.epoch, recipeVersion: f.input.binding.recipeVersion, phase: 'ready',
    heartbeatAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' })
}

it('never claims or mounts an absent graph when borrowing observed local ownership', async () => {
  const { value } = factory(), f = fixture('borrow-absent')
  const query = vi.fn(() => Promise.reject(new Error('No SQL is permitted at the factory borrow operation')))
  const owners = new PostgresOwnerStore({ query }, { instanceId: f.input.instanceId },
    { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const claim = vi.spyOn(value, 'claimAndMount'), mount = vi.spyOn(value, 'startNativeMount')
  const ownerClaim = vi.spyOn(owners, 'claim')
  await expect(value.borrowOwned(owners, observedOwner(f))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(value.inspect()).toMatchObject({ slots: 0, borrows: 0 })
  expect(f.starts()).toBe(0)
  expect(query).not.toHaveBeenCalled(); expect(ownerClaim).not.toHaveBeenCalled()
  expect(claim).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled()
})

it.each(['mounting', 'mounted-unpublished'] as const)
('does not promote a real native %s graph or recreate its slot for an observed owner borrow', async (phase) => {
  const { value } = factory(), f = fixture('borrow-' + phase)
  const query = vi.fn(() => Promise.reject(new Error('No SQL is permitted at the factory borrow operation')))
  const owners = new PostgresOwnerStore({ query }, { instanceId: f.input.instanceId },
    { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const actual = value.startNativeMount(f.input, f.recipe)
  await f.entered.promise
  if (phase === 'mounted-unpublished') { f.resume.resolve(undefined); await actual }
  const claim = vi.spyOn(value, 'claimAndMount'), mount = vi.spyOn(value, 'startNativeMount')
  const before = value.inspect()
  await expect(value.borrowOwned(owners, observedOwner(f))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(value.inspect()).toEqual(before)
  expect(query).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled()
  expect(f.starts()).toBe(1)
  f.resume.resolve(undefined)
  await actual
})


it('[observation] reads actual empty, pending, attached and disposed native objects without making them ready', async () => {
  const rows: Readonly<Record<string, string | number | boolean | null>>[] = []
  const capacity = new RuntimeCapacity({ maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const value = new AccountFactory(capacity, limits, (row) => { rows.push(row) })
  factories.push(value)
  value.logObservation()
  expect(rows.at(-1)).toMatchObject({ slots: 0, retainedContexts: 0, activeContexts: 0 })
  const f = fixture('native-object-observation')
  value.logObservation(f.input.binding.accountId)
  expect(rows.at(-1)).toMatchObject({
    accountId: f.input.binding.accountId, slotPresent: false, nativeContextPresent: false, workspaceRecords: 0,
  })
  const actual = value.startNativeMount(f.input, f.recipe)
  value.logObservation()
  expect(rows.findLast(row => row.event === 'factory-snapshot')).toMatchObject({ slots: 1, retainedContexts: 0, activeContexts: 0 })
  const ctx = await f.entered.promise
  value.logObservation()
  expect(rows.findLast(row => row.event === 'factory-snapshot')).toMatchObject({ slots: 1, retainedContexts: 1, activeContexts: 1 })
  expect(rows.at(-1)).toMatchObject({ nativeContextPresent: true, workspaceRegistryPresent: false, workspaceRecords: null })
  expect(rows.find(row => row.event === 'context-attached')).toMatchObject({
    accountId: f.input.binding.accountId, epoch: f.input.binding.epoch, rootFiberUid: ctx.root.fiber.uid,
  })
  f.resume.resolve(undefined)
  await actual
  expect(() => { value.assertBusinessCurrent(ctx.get('peAccount')!) }).toThrow('production readiness')
  await value.stopNative(f.input.binding.accountId)
  expect(rows.find(row => row.event === 'native-disposal-observed')).toMatchObject({
    nativeDisposal: 'confirmed', contextActive: ctx.fiber.state === FiberState.ACTIVE,
  })
  value.logObservation()
  expect(rows.findLast(row => row.event === 'factory-snapshot')).toMatchObject({
    slots: 1, retainedContexts: 1, activeContexts: ctx.fiber.state === FiberState.ACTIVE ? 1 : 0,
  })
  expect(JSON.stringify(rows)).not.toContain(f.input.layout.privateRoot)
})

it('[observation] contains a failed output callback while the same native mount and close settle', async () => {
  const capacity = new RuntimeCapacity({ maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const observed = vi.fn(() => { throw new Error('Synthetic unavailable log output') })
  const value = new AccountFactory(capacity, limits, observed)
  factories.push(value)
  expect(() => { value.logObservation() }).not.toThrow()
  const f = fixture('failed-output-observation')
  const actual = value.startNativeMount(f.input, f.recipe)
  await f.entered.promise
  f.resume.resolve(undefined)
  expect((await actual).status).toBe('mounted')
  await value.stopNative(f.input.binding.accountId)
  expect(value.inspect()).toMatchObject({ slots: 1, borrows: 0 })
  expect(observed).toHaveBeenCalled()
})
