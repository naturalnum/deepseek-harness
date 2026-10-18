/** Save admission observes actual queued profile writes through native reconciliation. */
import * as fs from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import type { ConfigSaveSubmissionHook } from '@deepseek-ai/dsh-config-editor'
import { configurationFixture } from './configuration-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

afterEach(() => { vi.restoreAllMocks() })
beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})

function observer() {
  const pending = new Set<Promise<unknown>>()
  const submitted: Promise<unknown>[] = []
  const writers: string[] = []
  const failures: unknown[] = []
  let accepting = true
  const denied = new Error('save admission closed')
  const hook: ConfigSaveSubmissionHook = {
    submit<T>(writer: string, submit: () => Promise<T>): Promise<T> {
      if (!accepting) throw denied
      const operation = submit()
      writers.push(writer)
      submitted.push(operation)
      pending.add(operation)
      void operation.then(() => { pending.delete(operation) }, (error: unknown) => {
        pending.delete(operation)
        failures.push(error)
      })
      return operation
    },
  }
  return { hook, pending, submitted, writers, failures, denied, stop: () => { accepting = false } }
}

it('retains both actual saves before the second can enter the writer, including slow atomic replacement', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const before = readFileSync(profile.patchPath, 'utf8')
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'first' })
  const secondSelection = { provider: 'test', model: 'second' }
  const second = ctx.agentDefaultModel.saveSelection(secondSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([first, second])
    await dispose()
  })
  secondSelection.model = 'mutated'
  expect(tracked.pending.size).toBe(2)
  expect(tracked.writers).toEqual(['agent-default-model/saveSelection', 'agent-default-model/saveSelection'])
  await entered.promise
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(tracked.pending.size).toBe(2)
  expect(vi.mocked(fs.rename)).toHaveBeenCalledOnce()
  tracked.stop()
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'refused' })).rejects.toBe(tracked.denied)
  expect(tracked.submitted).toHaveLength(2)
  release.resolve(undefined)
  await Promise.all([first, second])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'second' })
  expect(tracked.pending.size).toBe(0)
  expect(tracked.failures).toEqual([])
})

it('rejects admission with zero queue submission, I/O or mutation of the default', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  tracked.stop()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  onTestFinished(dispose)
  const edit = vi.spyOn(ctx.configEditor, 'edit')
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'refused' })).rejects.toBe(tracked.denied)
  expect(edit).not.toHaveBeenCalled()
  expect(tracked.submitted).toEqual([])
  expect(tracked.failures).toEqual([])
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('original')
})

it('retains a failed operation even though the native queue continues to a later successful save', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const tracked = observer()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  onTestFinished(dispose)
  const failure = Object.assign(new Error('profile disk unavailable'), { code: 'EIO' })
  vi.mocked(fs.rename).mockRejectedValueOnce(failure)
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'failed' })
  const rejected = expect(first).rejects.toBe(failure)
  const second = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(tracked.pending.size).toBe(2)
  await rejected
  await second
  await expect(tracked.submitted[0]).rejects.toBe(failure)
  expect(tracked.failures).toEqual([failure])
  expect(tracked.pending.size).toBe(0)
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('final')
})

it('observes required reconciliation after the document is already committed', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  const applied = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const reconcile = appBoot.reconcileProfilePatches
  vi.spyOn(appBoot, 'reconcileProfilePatches').mockImplementation(async (...args) => {
    const result = await reconcile(...args)
    if (args[3]?.includes('default-model')) {
      applied.resolve(undefined)
      await release.promise
    }
    return result
  })
  const saved = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'committed' })
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([saved])
    await dispose()
  })
  await applied.promise
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('committed')
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('committed')
  expect(tracked.pending.size).toBe(1)
  release.resolve(undefined)
  await saved
  expect(tracked.pending.size).toBe(0)
})

it('retains a reconciliation rejection after native rollback restores the document and live value', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  onTestFinished(dispose)
  const failure = new Error('profile application failed')
  const reconcile = appBoot.reconcileProfilePatches
  vi.spyOn(appBoot, 'reconcileProfilePatches').mockImplementation(async (...args) => {
    if (args[3]?.includes('default-model')) throw failure
    return reconcile(...args)
  })
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'unapplied' })).rejects.toBe(failure)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('original')
  expect(tracked.failures).toEqual([failure])
})

it('keeps generic result/Promise identity without a hook and removes a registered hook with its caller', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const operation = Promise.resolve(7)
  expect(ctx.configEditor.submitSave('fixture/write', () => operation)).toBe(operation)
  const tracked = observer()
  const owner = await ctx.plugin({ inject: ['configEditor'], apply(scope) {
    scope.configEditor.registerSaveHook(tracked.hook)
  } })
  expect(() => ctx.configEditor.registerSaveHook(tracked.hook)).toThrow('already registered')
  expect(ctx.configEditor.submitSave('fixture/write', () => operation)).toBe(operation)
  await operation
  expect(tracked.writers).toEqual(['fixture/write'])
  await owner.dispose()
  expect(ctx.configEditor.submitSave('fixture/write', () => operation)).toBe(operation)
  expect(tracked.writers).toEqual(['fixture/write'])
})

it('admits Settings and direct editor saves once through required application under HMR', async () => {
  const { ctx } = await configurationFixture()
  const tracked = observer()
  onTestFinished(ctx.configEditor.registerSaveHook(tracked.hook))
  await ctx.settings.update('first', { count: 4 })
  await ctx.settings.replace('first', { count: 5 })
  await ctx.settings.mutate('first', [{ op: 'set', path: ['count'], value: 6 }])
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  await ctx.configEditor.edit(entry, raw => ({ ...raw, count: 7 }))
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'nested' })
  expect(tracked.writers).toEqual([
    'settings/write', 'settings/write', 'settings/write', 'config-editor/edit', 'agent-default-model/saveSelection',
  ])
  expect(tracked.pending.size).toBe(0)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 7 })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('nested')
})

it('denies Settings and direct editor saves before file or live-value mutation', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  onTestFinished(ctx.configEditor.registerSaveHook(tracked.hook))
  tracked.stop()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  const before = readFileSync(profile.patchPath, 'utf8')
  const mutate = vi.fn((raw: Record<string, unknown>) => ({ ...raw, count: 9 }))
  await expect(ctx.settings.update('first', { count: 9 })).rejects.toBe(tracked.denied)
  await expect(ctx.configEditor.edit(entry, mutate)).rejects.toBe(tracked.denied)
  expect(mutate).not.toHaveBeenCalled()
  expect(fs.rename).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
  expect(tracked.submitted).toEqual([])
})

it('retains Settings publication failure after a committed editor operation', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const tracked = observer()
  onTestFinished(ctx.configEditor.registerSaveHook(tracked.hook))
  const failure = new Error('required Settings publication failed')
  const describe = ctx.settings.describe.bind(ctx.settings)
  vi.spyOn(ctx.settings, 'describe').mockImplementation((...args) => {
    const rows = describe(...args)
    const value = rows.find(row => row.ns === 'first')!.value
    if (value !== null && typeof value === 'object' && 'count' in value && value.count === 8) throw failure
    return rows
  })
  await expect(ctx.settings.update('first', { count: 8 })).rejects.toBe(failure)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('8')
  expect(tracked.writers).toEqual(['settings/write'])
  expect(tracked.failures).toEqual([failure])
  expect(tracked.pending.size).toBe(0)
})

it('does not re-enter a single-slot admission queue from nested editor saves', async () => {
  const { ctx } = await configurationFixture()
  const writers: string[] = []
  let tail = Promise.resolve()
  onTestFinished(ctx.configEditor.registerSaveHook({
    submit<T>(writer: string, submit: () => Promise<T>): Promise<T> {
      writers.push(writer)
      const task = tail.then(submit)
      tail = task.then(() => undefined, () => undefined)
      return task
    },
  }))
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  await Promise.all([
    ctx.settings.update('first', { count: 4 }),
    ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'queued' }),
    ctx.configEditor.edit(entry, raw => ({ ...raw, count: 5 })),
  ])
  expect(writers).toEqual(['settings/write', 'agent-default-model/saveSelection', 'config-editor/edit'])
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('queued')
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})

it('re-admits a detached continuation after its original save settles, including rejection', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  const tracked = observer()
  const dispose = ctx.configEditor.registerSaveHook(tracked.hook)
  onTestFinished(dispose)
  const release = Promise.withResolvers<undefined>()
  let detached: Promise<number> = Promise.resolve(0)
  const original = Promise.resolve(1)
  expect(ctx.configEditor.submitSave('outer', () => {
    detached = release.promise.then(() => ctx.configEditor.submitSave('late', () => Promise.resolve(2)))
    return original
  })).toBe(original)
  await original
  tracked.stop()
  release.resolve(undefined)
  await expect(detached).rejects.toBe(tracked.denied)
  expect(tracked.writers).toEqual(['outer'])
  const failure = new Error('synchronous submission failure')
  const second = observer()
  await dispose()
  onTestFinished(ctx.configEditor.registerSaveHook(second.hook))
  expect(() => ctx.configEditor.submitSave('throw', () => { throw failure })).toThrow(failure)
  await ctx.configEditor.submitSave('after-throw', () => Promise.resolve(3))
  expect(second.writers).toEqual(['after-throw'])
})

it('admits legacy rename separately from each section and retains a caught section failure', async () => {
  const tracked = observer()
  const { ctx, home, start } = await configurationFixture({ hmr: false, onBoot(scope) {
    scope.inject(['configEditor'], (child) => { child.configEditor.registerSaveHook(tracked.hook) })
  } })
  await ctx.fiber.dispose()
  const legacy = join(home, 'settings.yaml')
  writeFileSync(legacy, 'first:\n  count: 4\nmissing:\n  count: 1\n')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  onTestFinished(() => { release.resolve(undefined) })
  const restored = await start()
  await entered.promise
  expect(tracked.writers).toEqual(['settings/legacyRename'])
  expect(tracked.pending.size).toBe(1)
  expect(existsSync(legacy)).toBe(true)
  release.resolve(undefined)
  await vi.waitFor(() => { expect(tracked.failures).toHaveLength(1) })
  expect(tracked.writers).toEqual(['settings/legacyRename', 'settings/write', 'settings/write'])
  expect(tracked.failures[0]).toBeInstanceOf(Error)
  expect(String(tracked.failures[0])).toContain('No configurable plugin entry "missing"')
  expect(tracked.pending.size).toBe(0)
  expect(existsSync(legacy)).toBe(false)
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 4 })
})
