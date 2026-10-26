/** Function Loader, original executor/stores and Root closure; only the pg driver and secret source are external fixtures. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { expect, it, vi, onTestFinished } from 'vitest'
import * as Root from '../src/root.ts'
import { AccountFactory } from '../src/account-factory.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountOwner, InstanceId, OwnerEpoch } from '../src/types.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'
import { locateOwnerSql } from '../src/owner-sql.ts'
import { locateInstanceSql, registerInstanceSql, closeInstanceSql, heartbeatInstanceSql } from '../src/instance-sql.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { account } from './owner-fixture.ts'

const driver = vi.hoisted(() => ({
  calls: [] as { text: string; values: readonly (string | null)[] }[],
  events: [] as string[],
  run: undefined as undefined | ((text: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>),
  end: undefined as undefined | ((text: string) => Promise<void>),
}))
vi.mock('pg', () => ({ defaults: { query_timeout: 0 }, Client: class {
  private text = ''
  constructor(private readonly config: { password?: string | (() => Promise<string>) }) {}
  on() { return this }
  async connect() { if (typeof this.config.password === 'function') await this.config.password() }
  async query(input: { text: string; values: readonly (string | null)[] }) {
    this.text = input.text; driver.calls.push(input)
    if (driver.run === undefined) throw new Error('Private pg driver is not configured')
    return driver.run(input.text, input.values)
  }
  async end() { await driver.end?.(this.text); driver.events.push(this.text === locateOwnerSql ? 'owner-client-ended' : 'other-client-ended') }
} }))

async function fixture(maintenance = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'private106-root-')))
  const config = { ...rootConfig(directory), heartbeatIntervalMs: 60000 }
  driver.calls.length = 0; driver.events.length = 0; driver.end = undefined
  driver.run = async (text, values) => {
    if (text === accountOwnerMigrationSql || text === instanceMigrationSql) return { rows: [] }
    if (text === registerInstanceSql || text === closeInstanceSql || text === heartbeatInstanceSql) {
      if (text === closeInstanceSql) driver.events.push('instance-close-submitted')
      return { rows: [{ instance: { instanceId: values[0], internalAddress: values[1], recipeVersion: values[2],
        phase: text === closeInstanceSql ? 'closed' : 'registered', heartbeatAt: '2026-10-17T00:00:00.000000Z' } }] }
    }
    if (text === locateOwnerSql) return { rows: [{ owner: { accountId: values[0], ownerInstanceId: 'metadata-owner-106',
      epoch: '9007199254740993', phase: 'ready', recipeVersion: config.recipeVersion,
      heartbeatAt: '2026-10-17T00:00:00.000000Z', updatedAt: '2026-10-17T00:00:00.000000Z' } }] }
    if (text === locateInstanceSql) return { rows: [{ instance: { instanceId: values[0], internalAddress: 'https://metadata-only.invalid',
      recipeVersion: config.recipeVersion, phase: 'registered', heartbeatAt: '2026-10-17T00:00:00.000000Z' } }] }
    throw new Error('Unexpected SQL outside original migrations/registration/metadata/close')
  }
  const selected = maintenance ? { ...config, recovery: { verifierId: 'local-original-process-and-provider-v1' as const,
    limits: { maxAllocations: 2, maxEvidenceRefs: 2, maxReferenceBytes: 128, maxProofBytes: 4096,
      maxAuditRows: 2, maxProofAgeMs: 1000 } } } : config
  const path = join(directory, 'cordis.yml')
  writeFileSync(path, JSON.stringify([{ id: 'credentials', name: 'cordis:metadata-secret' },
    { id: 'root', name: 'cordis:metadata-root', config: selected }]))
  let context: Context | undefined
  const release: { callback?: () => void; expectedCloseFailure?: boolean } = {}
  onTestFinished(async () => {
    release.callback?.()
    try { await context?.fiber.dispose() } catch (cause) { if (!release.expectedCloseFailure) throw cause }
    finally { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  })
  const queries = vi.spyOn(PgOwnerExecutor.prototype, 'query')
  const graph = await boot('private106-root', path, [], (ctx) => {
    context = ctx
    Object.assign(ctx.loader.builtins, { 'metadata-root': Root,
      'metadata-secret': { apply(owner: Context) { new RootCredentials(owner, async () => ({ value: 'private106-synthetic', source: 'private106' })) } } })
  })
  const runtime = graph.get('peAccountRuntime')
  if (!(runtime instanceof Root.PeAccountRuntime)) throw new Error('Original function Root was not installed')
  return { graph, runtime, queries, config, release }
}

function expected(f: Awaited<ReturnType<typeof fixture>>): AccountOwner {
  const registration = driver.calls.find(call => call.text === registerInstanceSql)
  const local = registration?.values[0]
  if (typeof local !== 'string') throw new Error('Original instance registration absent')
  return Object.freeze({ accountId: account, ownerInstanceId: brandString<InstanceId>(local),
    epoch: brandString<OwnerEpoch>('9007199254740993'), recipeVersion: f.config.recipeVersion, phase: 'ready',
    heartbeatAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' })
}

it('publishes the original Root close before an ingress callback synchronously reenters it', async () => {
  const f = await fixture()
  let reentered: Promise<void> | undefined, calls = 0
  f.runtime.registerIngressClose({ closeActual() {
    calls++
    reentered = f.runtime.close()
    return Promise.resolve(undefined)
  } })
  const closing = f.runtime.close()
  await Promise.all([closing, reentered])
  expect(calls).toBe(1)
  expect(reentered).toBe(closing)
  expect(f.runtime.close()).toBe(closing)
  expect(driver.calls.filter(call => call.text === closeInstanceSql)).toHaveLength(1)
})

it('keeps an actual ordinary unsealed Root closed to existing-owner borrows before any owner query, claim or graph', async () => {
  const f = await fixture(), claim = vi.spyOn(AccountFactory.prototype, 'claimAndMount')
  const mount = vi.spyOn(AccountFactory.prototype, 'startNativeMount'), borrow = vi.spyOn(AccountFactory.prototype, 'borrowOwned')
  const before = driver.calls.length
  await expect(f.runtime.borrowOwnedAccount(expected(f))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(driver.calls).toHaveLength(before)
  expect(claim).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled(); expect(borrow).not.toHaveBeenCalled()
  expect(f.runtime.inspectControl()).toMatchObject({ accounts: 0 })
})

it('keeps a maintenance Root closed to existing-owner borrows without an owner lookup or account creation', async () => {
  const f = await fixture(true), claim = vi.spyOn(AccountFactory.prototype, 'claimAndMount')
  const before = driver.calls.length
  await expect(f.runtime.borrowOwnedAccount(expected(f))).rejects.toThrow('Maintenance recovery')
  expect(driver.calls).toHaveLength(before); expect(claim).not.toHaveBeenCalled()
  expect(f.runtime.inspectControl()).toMatchObject({ accounts: 0 })
})

it('rejects component and stopped Roots without starting any factory acquisition', async () => {
  const ctx = new Context(), runtime = new Root.PeAccountRuntime(ctx,
    { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const f = await fixture(), owner = expected(f), claim = vi.spyOn(AccountFactory.prototype, 'claimAndMount')
  try {
    await expect(runtime.borrowOwnedAccount(owner)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await runtime.close()
    await expect(runtime.borrowOwnedAccount(owner)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await f.runtime.close()
    const before = driver.calls.length
    await expect(f.runtime.borrowOwnedAccount(owner)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(driver.calls).toHaveLength(before); expect(claim).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})


it('exposes only the original active ordinary startup identity without granting a seal or a graph', async () => {
  const f = await fixture(), owner = expected(f)
  expect(f.runtime.activeInstanceId).toBe(owner.ownerInstanceId)
  expect(f.runtime.inspectControl()).toMatchObject({ accounts: 0 })
  expect(() => { f.runtime.assertRecipeSealed(f.config.recipeVersion) }).toThrow()
  await f.runtime.close()
  expect(f.runtime.activeInstanceId).toBeUndefined()
})

it('omits the startup identity in component and maintenance mode', async () => {
  const ctx = new Context(), component = new Root.PeAccountRuntime(ctx,
    { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  try { expect(component.activeInstanceId).toBeUndefined() } finally { await ctx.fiber.dispose() }
  const f = await fixture(true)
  expect(f.runtime.activeInstanceId).toBeUndefined()
})

it('starts ingress closure synchronously and joins ingress before metadata and original instance teardown', async () => {
  const f = await fixture(), port = f.runtime.ownerResolver
  if (port === undefined) throw new Error('Original resolver absent')
  const auth = Promise.withResolvers<undefined>(), ended = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.release.callback = () => { auth.resolve(undefined); ended.resolve(undefined) }
  let closeCalls = 0
  f.runtime.registerIngressClose({ closeActual() {
    closeCalls++; driver.events.push('ingress-admission-closed')
    return auth.promise.then(() => { driver.events.push('ingress-actual-closed') })
  } })
  driver.end = async (text) => { if (text === locateOwnerSql) { entered.resolve(undefined); await ended.promise } }
  const reading = port.resolve(account), rejected = expect(reading).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await entered.promise
  const stopping = f.runtime.close()
  expect(closeCalls).toBe(1)
  expect(driver.events).toContain('ingress-admission-closed')
  expect(f.runtime.activeInstanceId).toBeUndefined()
  expect(driver.events).not.toContain('instance-close-submitted')
  auth.resolve(undefined); await Promise.resolve(undefined); await Promise.resolve(undefined)
  expect(driver.events).toContain('ingress-actual-closed')
  expect(driver.events).not.toContain('instance-close-submitted')
  ended.resolve(undefined); await rejected; await stopping
  expect(driver.events.indexOf('ingress-actual-closed')).toBeLessThan(driver.events.indexOf('owner-client-ended'))
  expect(driver.events.indexOf('owner-client-ended')).toBeLessThan(driver.events.indexOf('instance-close-submitted'))
  expect(closeCalls).toBe(1)
})

it('retains one caller-effect ingress registration through actual withdrawal and rejects replacement until settlement', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  f.release.callback = () => { gate.resolve(undefined) }
  let calls = 0
  const owner = { closeActual() { calls++; return gate.promise } }
  let ingressContext: Context | undefined
  await f.graph.plugin({ inject: ['peAccountRuntime'], apply(ctx: Context) {
    ingressContext = ctx
    const runtime = ctx.peAccountRuntime
    if (!(runtime instanceof Root.PeAccountRuntime)) throw new Error('Original Runtime Root absent')
    runtime.registerIngressClose(owner)
  } })
  if (ingressContext === undefined) throw new Error('Original ingress caller did not mount')
  const withdrawing = ingressContext.fiber.dispose()
  let settled = false
  void withdrawing.then(() => { settled = true })
  await Promise.resolve(undefined)
  expect(calls).toBe(1); expect(settled).toBe(false)
  expect(() => f.runtime.registerIngressClose({ closeActual: () => Promise.resolve(undefined) })).toThrow()
  gate.resolve(undefined); await withdrawing
  expect(settled).toBe(true)
  const withdraw = f.runtime.registerIngressClose({ closeActual: () => Promise.resolve(undefined) })
  await withdraw()
})

it('shares one actual ingress close between repeated withdrawal and concurrent Root shutdown', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  f.release.callback = () => { gate.resolve(undefined) }
  let calls = 0
  const withdraw = f.runtime.registerIngressClose({ closeActual() { calls++; return gate.promise } })
  const first = withdraw(), second = withdraw()
  expect(second).toBe(first)
  const stopping = f.runtime.close()
  expect(f.runtime.close()).toBe(stopping)
  expect(calls).toBe(1)
  expect(driver.events).not.toContain('instance-close-submitted')
  gate.resolve(undefined); await first; await stopping
  expect(calls).toBe(1)
})

it.each(['throw', 'reject'] as const)('retains a %s ingress close failure and never reports Root closed or tears down its instance', async (kind) => {
  const f = await fixture(), failure = new Error('actual ingress close is unconfirmed')
  f.release.expectedCloseFailure = true
  let calls = 0
  const withdraw = f.runtime.registerIngressClose({ closeActual() {
    calls++
    if (kind === 'throw') throw failure
    return Promise.reject(failure)
  } })
  const stopping = f.runtime.close()
  await expect(stopping).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed', cause: failure })
  expect(f.runtime.close()).toBe(stopping)
  await expect(withdraw()).rejects.toBe(failure)
  expect(calls).toBe(1)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true })
  expect(f.runtime.activeInstanceId).toBeUndefined()
  expect(driver.events).not.toContain('instance-close-submitted')
})


it('retains failed ingress withdrawal and closes Root business admission before any replacement', async () => {
  const f = await fixture(), failure = new Error('actual ingress withdrawal is unknown')
  f.release.expectedCloseFailure = true
  const withdraw = f.runtime.registerIngressClose({ closeActual: () => Promise.reject(failure) })
  await expect(withdraw()).rejects.toBe(failure)
  await vi.waitFor(() => { expect(f.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true }) })
  expect(f.runtime.activeInstanceId).toBeUndefined()
  expect(() => f.runtime.registerIngressClose({ closeActual: () => Promise.resolve(undefined) })).toThrow()
  await expect(f.runtime.close()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed', cause: failure })
  expect(driver.events).not.toContain('instance-close-submitted')
})
