/** Real native default-model/editor writes; only atomic I/O and required-apply timing are controlled. */
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { installNativeDefaultModelSaveHook } from '../src/native-save-hook.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

afterEach(() => { vi.restoreAllMocks() })

function latch() {
  const state = Promise.withResolvers<undefined>()
  return { promise: state.promise, resolve: () => { state.resolve(undefined) } }
}

async function nativeProfile() {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const home = realpathSync(mkdtempSync(join(directory, 'save-m1-')))
  const contextOwner: { release?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await contextOwner.release?.()
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  appBoot.initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"cloud-api-save-test"}\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:save-editor' },
    { id: 'default-model', name: 'cordis:save-model', config: { provider: 'test', model: 'original' } },
  ] }]) + '\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: [], dir, patchPath, installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const binding: AccountBinding = {
    accountId: brandString<AccountId>('a'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m1', lifetime: new AbortController().signal,
  }
  const ctx = await appBoot.boot('test', join(dir, 'cordis.yml'), appBoot.readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('peAccount', binding)
    ctx.loader.builtins['save-editor'] = ConfigEditor
    ctx.loader.builtins['save-model'] = DefaultModel
  })
  contextOwner.release = () => ctx.fiber.dispose()
  const root = new ConfigSaveCoordinator({
    maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4,
    maxNestedPerOperation: 2, maxWaitersPerAccount: 2,
  })
  const barrier = root.createAccount(binding)
  const remove = installNativeDefaultModelSaveHook(ctx, barrier)
  return { ctx, profile, root, barrier, remove }
}

it('tracks real native slow atomic saves and queued selections before either native queue can escape admission', async () => {
  const { ctx, profile, root, barrier, remove } = await nativeProfile()
  const entered = latch()
  const release = latch()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve()
    await release.promise
    await real.rename(from, to)
  })
  const before = readFileSync(profile.patchPath, 'utf8')
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'first' })
  const selected = { provider: 'test', model: 'last' }
  const second = ctx.agentDefaultModel.saveSelection(selected)
  onTestFinished(async () => {
    release.resolve()
    await Promise.allSettled([first, second])
  })
  selected.model = 'mutated'
  expect(barrier.snapshot().pending).toHaveLength(2)
  expect(root.snapshot()).toMatchObject({ running: 1, queued: 1, tracked: 2 })
  await entered.promise
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(vi.mocked(fs.rename)).toHaveBeenCalledOnce()
  const stopped = await barrier.stopConfigSaves(Date.now())
  expect(stopped.status).toBe('unknown')
  expect(stopped.pendingOperationIds).toHaveLength(2)
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'denied' })).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(vi.mocked(fs.rename)).toHaveBeenCalledOnce()
  expect(barrier.snapshot().pending).toHaveLength(2)
  release.resolve()
  await Promise.all([first, second])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'last' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('last')
  expect(await barrier.stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'confirmed', failures: [] })
  await remove()
  root.releaseAccount(barrier)
  root.close()
})

it('does not confirm a real persisted model while required native reconciliation is still pending', async () => {
  const { ctx, profile, barrier, root, remove } = await nativeProfile()
  const applied = latch()
  const release = latch()
  const realReconcile = appBoot.reconcileProfilePatches
  vi.spyOn(appBoot, 'reconcileProfilePatches').mockImplementation(async (...args) => {
    const result = await realReconcile(...args)
    if (args[3]?.includes('default-model')) {
      applied.resolve()
      await release.promise
    }
    return result
  })
  const work = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'persisted' })
  onTestFinished(async () => {
    release.resolve()
    await Promise.allSettled([work])
  })
  await applied.promise
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('persisted')
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('persisted')
  expect(await barrier.pauseAccountChanges(Date.now())).toMatchObject({ status: 'unknown' })
  expect(root.snapshot().tracked).toBe(1)
  release.resolve()
  await work
  expect(await barrier.pauseAccountChanges(Date.now() + 1_000)).toMatchObject({ status: 'confirmed' })
  barrier.resumeAccountChanges()
  await barrier.stopConfigSaves(Date.now() + 1_000)
  await remove()
  root.releaseAccount(barrier)
  root.close()
})

it('retains a real native write failure after the next queued default-model save succeeds', async () => {
  const { ctx, barrier, remove } = await nativeProfile()
  const original = Object.assign(new Error('native storage EIO'), { code: 'EIO' })
  vi.mocked(fs.rename).mockRejectedValueOnce(original)
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'failed' })
  const rejected = expect(first).rejects.toBe(original)
  const last = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  onTestFinished(async () => { await Promise.allSettled([first, last]) })
  await rejected
  await last
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('final')
  expect(await barrier.stopConfigSaves(Date.now() + 1_000)).toMatchObject({
    status: 'unknown', pendingOperationIds: [], failures: [{ kind: 'default-model', outcome: 'failed' }],
  })
  await expect(remove()).rejects.toMatchObject({ code: 'cloud/config-busy' })
})
