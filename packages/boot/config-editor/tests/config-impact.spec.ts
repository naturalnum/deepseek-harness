/** Guarded saves use real profile composition and Loader decisions, without a cloud diff. */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { ProfileConfigUpdatePlan } from '@deepseek-ai/dsh-app-boot'
import { assertProfileConfigUpdate } from '@deepseek-ai/dsh-app-boot'
import type { LoaderUpdateGuard } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})
afterEach(() => { vi.restoreAllMocks() })

function first(ctx: Context) {
  return ctx.configEditor.entries().find(row => row.options.id === 'first')!
}

function raw(ctx: Context): Record<string, unknown> {
  return first(ctx).options.config as Record<string, unknown>
}

it('commits pure volatile edits through the actual Loader update with the same fiber and references', async () => {
  const dispose = vi.fn()
  const { ctx, profile } = await configurationFixture({ hmr: false, apply(scope) { scope.effect(() => dispose) } })
  const entry = first(ctx)
  const fiber = entry.fiber
  const config: unknown = fiber!.config
  const plans: ProfileConfigUpdatePlan[] = []
  onTestFinished(ctx.configEditor.registerImpactGuard({ check(plan) { plans.push(plan) } }))
  await ctx.settings.update('first', { count: 5 })
  expect(entry.fiber).toBe(fiber)
  expect(fiber!.config).toBe(config)
  expect(dispose).not.toHaveBeenCalled()
  expect(plans[0]!.impact).toBe('live')
  expect(plans[0]!.entries.every(plan => plan.stopped?.length === 0)).toBe(true)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 5')
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})

it('rejects ordinary config before any replacement, option mutation or fiber stop even when policy approves', async () => {
  const dispose = vi.fn()
  const { ctx, profile } = await configurationFixture({ hmr: false, apply(scope) { scope.effect(() => dispose) } })
  const entry = first(ctx)
  const fiber = entry.fiber
  const options = structuredClone(entry.options)
  const before = readFileSync(profile.patchPath, 'utf8')
  let impact: string | undefined
  onTestFinished(ctx.configEditor.registerImpactGuard({ check(plan) { impact = plan.impact } }))
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, ordinary: 'requires-remount' }))).rejects.toThrow('unproven')
  expect(impact).toBe('remount')
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(entry.options).toEqual(options)
  expect(entry.fiber).toBe(fiber)
  expect(dispose).not.toHaveBeenCalled()
})

it('keeps preparation private and rejects copied or proxied profile decisions before a real save', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const fiber = first(ctx).fiber
  onTestFinished(ctx.configEditor.registerImpactGuard({ check(plan) {
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Reflect.ownKeys(plan).sort()).toEqual(['entries', 'impact'])
    expect(() => { assertProfileConfigUpdate({ ...plan }) }).toThrow('unproven')
    expect(() => { assertProfileConfigUpdate(new Proxy(plan, {})) }).toThrow('unproven')
    assertProfileConfigUpdate(plan)
  } }))
  await ctx.settings.update('first', { count: 5 })
  expect(first(ctx).fiber).toBe(fiber)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 5')
})

it('refuses potential effective ordinary drift without executing the extra resolver', async () => {
  const dispose = vi.fn()
  let extraCalls = 0
  const schema = z.object({ ordinary: z.string().required(), count: z.number().default(2).volatile() })
  const { ctx, profile } = await configurationFixture({ hmr: false, schema, apply(scope) {
    scope.effect(() => dispose)
    scope.on('internal/config', function (this: Fiber, raw: Record<string, unknown>, next: () => Record<string, unknown>) {
      const value = next()
      if (this.uid !== scope.fiber.uid) return value
      extraCalls++
      return { ...value, ordinary: Number(raw.count ?? 2) > 2 ? 'effective-change' : value.ordinary }
    })
  } })
  extraCalls = 0
  const before = readFileSync(profile.patchPath, 'utf8')
  expect(first(ctx).prepareConfigUpdate({ ...raw(ctx), count: 4 }).impact).toBe('unknown')
  const stopGuard = ctx.configEditor.registerImpactGuard({ check() {} })
  onTestFinished(stopGuard)
  await expect(ctx.settings.update('first', { count: 4 })).rejects.toThrow('unproven')
  expect(extraCalls).toBe(0)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
  expect(raw(ctx).count).toBeUndefined()
  await stopGuard()
  await ctx.configEditor.edit(first(ctx), value => ({ ...value, count: 4 }))
  expect(extraCalls).toBeGreaterThan(0)
  expect(dispose).toHaveBeenCalled()
})

it('rejects an expired native plan after an intervening entry update', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const entry = first(ctx)
  const plan = entry.prepareConfigUpdate({ ...raw(ctx), count: 4 })
  expect(plan.impact).toBe('live')
  await entry.update({ config: { ...raw(ctx), count: 3 } })
  expect(() => { entry.assertConfigUpdatePlan(plan) }).toThrow('stale')
})

it('rechecks before persistence when policy approval awaited an intervening update', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entry = first(ctx)
  const before = readFileSync(profile.patchPath, 'utf8')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const dispose = ctx.configEditor.registerImpactGuard({ async check() {
    entered.resolve(undefined)
    await release.promise
  } })
  const saving = ctx.settings.update('first', { count: 5 })
  const rejection = expect(saving).rejects.toThrow('stale')
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([saving]); await dispose() })
  await entered.promise
  await entry.update({ config: { ...raw(ctx), count: 3 } })
  release.resolve(undefined)
  await rejection
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('rejects pending old patches without applying or stopping their affected entry', async () => {
  const dispose = vi.fn()
  const { ctx, profile } = await configurationFixture({ hmr: false, apply(scope) { scope.effect(() => dispose) } })
  const entry = first(ctx)
  writeFileSync(profile.patchPath, '- id: second\n  config:\n    ordinary: pending-remount\n')
  const before = readFileSync(profile.patchPath, 'utf8')
  onTestFinished(ctx.configEditor.registerImpactGuard({ check() {} }))
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, count: 5 }))).rejects.toThrow('pending patches')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
})

it('refuses unknown resolver dependencies rather than assuming a currently matching candidate is live', async () => {
  let calls = 0
  const { ctx, profile } = await configurationFixture({ hmr: false, apply(scope) {
    scope.on('internal/config', (_raw: unknown, next: () => unknown) => { calls++; return next() })
  } })
  calls = 0
  const before = readFileSync(profile.patchPath, 'utf8')
  let impact: string | undefined
  onTestFinished(ctx.configEditor.registerImpactGuard({ check(plan) { impact = plan.impact } }))
  await expect(ctx.settings.update('first', { count: 4 })).rejects.toThrow('unproven')
  expect(impact).toBeUndefined()
  expect(calls).toBe(0)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('refuses custom schema callbacks before candidate validation', async () => {
  let calls = 0
  const schema = z.object({
    ordinary: z.transform(z.string().required(), (value) => { calls++; return value }),
    count: z.number().default(2).volatile(),
  })
  const disposed = vi.fn()
  const { ctx, profile } = await configurationFixture({ hmr: false, schema, apply(scope) { scope.effect(() => disposed) } })
  expect(calls).toBeGreaterThan(0)
  calls = 0
  const before = readFileSync(profile.patchPath, 'utf8')
  const entry = first(ctx)
  expect(entry.fiber?.state).toBe(FiberState.ACTIVE)
  expect(entry.prepareConfigUpdate({ ...raw(ctx), count: 4 }).impact).toBe('unknown')
  onTestFinished(ctx.configEditor.registerImpactGuard({ check() {} }))
  await expect(ctx.configEditor.edit(entry, value => ({ ...value, count: 4 }))).rejects.toThrow('unproven')
  expect(calls).toBe(0)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(disposed).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('reserves actual Loader mutation entry points while a guarded file replacement is pending', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const entry = first(ctx)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const dispose = ctx.configEditor.registerImpactGuard({ check() {} })
  const saving = ctx.settings.update('first', { count: 5 })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([saving]); await dispose() })
  await entered.promise
  await expect(entry.update({ config: { ...raw(ctx), ordinary: 'outside-plan' } })).rejects.toThrow('reserved')
  expect(() => { entry.parent.remove(entry.options.id) }).toThrow('reserved')
  release.resolve(undefined)
  await saving
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})

it('rechecks the schema and effective decision after policy approval and before writing', async () => {
  const count = z.number().default(2).volatile()
  const schema = z.object({ ordinary: z.string().required(), count })
  const { ctx, profile } = await configurationFixture({ hmr: false, schema })
  const before = readFileSync(profile.patchPath, 'utf8')
  onTestFinished(ctx.configEditor.registerImpactGuard({ check() { count.meta.max = 4 } }))
  await expect(ctx.settings.update('first', { count: 5 })).rejects.toThrow('drifted')
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
})

it('binds the actual Loader options to the opaque prepared plan', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const entry = first(ctx)
  const options = structuredClone(entry.options)
  const plan = entry.prepareConfigUpdate({ ...raw(ctx), count: 4 })
  const scope = new AsyncLocalStorage<LoaderUpdateGuard>()
  onTestFinished(() => { scope.disable() })
  await expect(ctx.loader.withUpdateGuard({
    entry: () => plan, group() {}, create() {}, remove() {},
  }, () => entry.update({ config: { ...raw(ctx), ordinary: 'unplanned' } }),
  scope)).rejects.toThrow('prepared options')
  expect(entry.options).toEqual(options)
})

it('keeps policy refusal unwritten and restores the native path when the guard is withdrawn', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const denied = new Error('policy refused')
  const dispose = ctx.configEditor.registerImpactGuard({ check() { throw denied } })
  onTestFinished(dispose)
  const entry = first(ctx)
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, value => ({ ...value, count: 5 }))).rejects.toBe(denied)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  await dispose()
  await ctx.configEditor.edit(entry, value => ({ ...value, ordinary: 'native-remount' }))
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('native-remount')
})

it('reports a required post-commit failure without an unguarded rollback or remount', async () => {
  const disposed = vi.fn()
  const { ctx, profile } = await configurationFixture({ hmr: false, apply(scope) { scope.effect(() => disposed) } })
  const entry = first(ctx)
  const fiber = entry.fiber
  const failure = new Error('required publication failed')
  ctx.on('app-boot/config-reload', () => { throw failure })
  onTestFinished(ctx.configEditor.registerImpactGuard({ check() {} }))
  await expect(ctx.settings.update('first', { count: 5 })).rejects.toBe(failure)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 5')
  expect(entry.fiber).toBe(fiber)
  expect(disposed).not.toHaveBeenCalled()
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})


it('rejects a guarded mutation without a host scope before invoking its operation', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const operation = vi.fn(async () => {})
  const guard: LoaderUpdateGuard = { entry() { return undefined }, group() {}, create() {}, remove() {} }
  await expect(ctx.loader.withUpdateGuard(guard, operation, undefined)).rejects.toThrow('requires an async execution scope')
  expect(operation).not.toHaveBeenCalled()
  expect(ctx.loader.updateGuard).toBeUndefined()
  await first(ctx).update({ config: { ...raw(ctx), count: 3 } })
  expect(raw(ctx).count).toBe(3)
})

it('isolates awaited guarded descendants, refuses nested and unbound mutations, and releases only on actual settlement', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const entry = first(ctx), options = structuredClone(entry.options)
  const next = { ...raw(ctx), count: 4 }
  const plan = entry.prepareConfigUpdate(next)
  const guard: LoaderUpdateGuard = { entry: () => plan, group() {}, create() {}, remove() {} }
  const scope = new AsyncLocalStorage<LoaderUpdateGuard>()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let settled = false
  const updating = ctx.loader.withUpdateGuard(guard, async () => {
    await Promise.resolve()
    expect(ctx.loader.updateGuard).toBe(guard)
    await expect(ctx.loader.withUpdateGuard(guard, async () => {}, scope)).rejects.toThrow('already reserved')
    entered.resolve(undefined)
    await release.promise
    await Promise.resolve().then(async () => {
      expect(ctx.loader.updateGuard).toBe(guard)
      await entry.update({ config: next })
    })
    return 'settled-result'
  }, scope)
  void updating.then(() => { settled = true }, () => { settled = true })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([updating]); scope.disable() })
  await entered.promise
  expect(() => ctx.loader.updateGuard).toThrow('reserved')
  await expect(entry.update({ config: { ...raw(ctx), count: 8 } })).rejects.toThrow('reserved')
  await expect(entry.parent.update([...entry.parent.data])).rejects.toThrow('reserved')
  await expect(entry.parent.create({ name: 'unbound-create' })).rejects.toThrow('reserved')
  expect(() => { entry.parent.remove(entry.options.id) }).toThrow('reserved')
  expect(entry.options).toEqual(options)
  expect(settled).toBe(false)
  release.resolve(undefined)
  await expect(updating).resolves.toBe('settled-result')
  expect(ctx.loader.updateGuard).toBeUndefined()
  expect(raw(ctx).count).toBe(4)
  await entry.update({ config: { ...raw(ctx), count: 6 } })
  expect(raw(ctx).count).toBe(6)
})

it('retains the reservation through a pending rejection and releases it after the original failure', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const guard: LoaderUpdateGuard = { entry() { return undefined }, group() {}, create() {}, remove() {} }
  const scope = new AsyncLocalStorage<LoaderUpdateGuard>()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const failure = new Error('actual guarded operation failed')
  const updating = ctx.loader.withUpdateGuard(guard, async () => {
    entered.resolve(undefined)
    await release.promise
    throw failure
  }, scope)
  const rejected = expect(updating).rejects.toBe(failure)
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([updating]); scope.disable() })
  await entered.promise
  await expect(first(ctx).update({ config: { ...raw(ctx), count: 8 } })).rejects.toThrow('reserved')
  release.resolve(undefined)
  await rejected
  expect(ctx.loader.updateGuard).toBeUndefined()
  await first(ctx).update({ config: { ...raw(ctx), count: 3 } })
  expect(raw(ctx).count).toBe(3)
})

it('keeps independent Loader reservations isolated while one Host save waits for persistence', async () => {
  const firstProfile = await configurationFixture({ hmr: false })
  const secondProfile = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const stopFirst = firstProfile.ctx.configEditor.registerImpactGuard({ check() {} })
  const stopSecond = secondProfile.ctx.configEditor.registerImpactGuard({ check() {} })
  const saving = firstProfile.ctx.settings.update('first', { count: 5 })
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([saving])
    await stopFirst()
    await stopSecond()
  })
  await entered.promise
  await secondProfile.ctx.settings.update('first', { count: 7 })
  expect(raw(secondProfile.ctx).count).toBe(7)
  await expect(first(firstProfile.ctx).update({ config: { ...raw(firstProfile.ctx), count: 9 } })).rejects.toThrow('reserved')
  release.resolve(undefined)
  await saving
  expect(raw(firstProfile.ctx).count).toBe(5)
  expect(firstProfile.ctx.loader.updateGuard).toBeUndefined()
  expect(secondProfile.ctx.loader.updateGuard).toBeUndefined()
})
