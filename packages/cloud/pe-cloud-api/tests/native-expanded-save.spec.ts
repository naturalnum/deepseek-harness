/** Real Settings/editor and local-credential submissions through one bounded account barrier. */
import * as fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import { credentialKey, credentialRef, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { installNativeConfigSaveHook, installNativeCredentialSaveHook } from '../src/native-save-hook.ts'
import { latch, nativeSaveFixture } from './native-save-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

const REF = credentialRef('DSH_CLOUD_SAVE_TEST')
const KEY = credentialKey('cloud-save', 'grant')
afterEach(() => { vi.restoreAllMocks() })
beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})

async function slowRename() {
  const entered = latch()
  const release = latch()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve()
    await release.promise
    await real.rename(from, to)
  })
  onTestFinished(() => { release.resolve() })
  return { entered: entered.promise, release: release.resolve }
}

it('admits Settings, default-model and direct editor once each before a single serial queue', async () => {
  const { ctx, profile, root, barrier, release } = await nativeSaveFixture()
  const admitted = vi.spyOn(barrier, 'admit')
  const slow = await slowRename()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  const before = readFileSync(profile.patchPath, 'utf8')
  const tasks = [
    ctx.settings.update('probe', { count: 2 }),
    ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'saved' }),
    ctx.configEditor.edit(entry, raw => ({ ...raw, count: 3 })),
  ]
  onTestFinished(async () => { slow.release(); await Promise.allSettled(tasks) })
  expect(barrier.snapshot().pending.map(row => row.kind)).toEqual(['settings', 'default-model', 'config-editor'])
  expect(root.snapshot()).toMatchObject({ running: 1, queued: 2, tracked: 3 })
  await slow.entered
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(admitted).toHaveBeenCalledTimes(3)
  expect(await barrier.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
  await expect(ctx.settings.update('probe', { count: 9 })).rejects.toMatchObject({ code: 'cloud/config-busy' })
  const change = vi.fn((raw: Record<string, unknown>) => raw)
  await expect(ctx.configEditor.edit(entry, change)).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(change).not.toHaveBeenCalled()
  expect(fs.rename).toHaveBeenCalledOnce()
  slow.release()
  await Promise.all(tasks)
  expect(ctx.settings.describe().find(row => row.ns === 'probe')!.value).toEqual({ count: 3 })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('saved')
  expect(admitted).toHaveBeenCalledTimes(5)
  await release()
})

it('keeps a committed Settings write pending until required native reconciliation returns', async () => {
  const { ctx, profile, barrier, root, release } = await nativeSaveFixture()
  const entered = latch()
  const finish = latch()
  const real = appBoot.reconcileProfilePatches
  vi.spyOn(appBoot, 'reconcileProfilePatches').mockImplementation(async (...args) => {
    const result = await real(...args)
    if (args[3]?.includes('probe')) { entered.resolve(); await finish.promise }
    return result
  })
  const task = ctx.settings.update('probe', { count: 4 })
  onTestFinished(async () => { finish.resolve(); await Promise.allSettled([task]) })
  await entered.promise
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 4')
  expect(await barrier.pauseAccountChanges(Date.now())).toMatchObject({ status: 'unknown' })
  expect(root.snapshot().tracked).toBe(1)
  await expect(release()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  finish.resolve()
  await task
  await release()
})

it('retains Settings publication failure after a real commit and a later successful edit', async () => {
  const { ctx, profile, barrier, remove } = await nativeSaveFixture()
  const failure = new Error('required Settings publication failed')
  const describe = ctx.settings.describe.bind(ctx.settings)
  vi.spyOn(ctx.settings, 'describe').mockImplementation((...args) => {
    const rows = describe(...args)
    const value = rows.find(row => row.ns === 'probe')!.value
    if (value !== null && typeof value === 'object' && 'count' in value && value.count === 8) throw failure
    return rows
  })
  await expect(ctx.settings.update('probe', { count: 8 })).rejects.toBe(failure)
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 8')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'probe')!
  await ctx.configEditor.edit(entry, raw => ({ ...raw, count: 9 }))
  expect(await barrier.stopConfigSaves(Date.now() + 1_000)).toMatchObject({
    status: 'unknown', pendingOperationIds: [], failures: [{ kind: 'settings', outcome: 'failed' }],
  })
  await expect(remove()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(JSON.stringify(barrier.snapshot())).not.toContain(failure.message)
})

it('tracks all four real credential writers and rejects all four after stop with zero additional I/O', async () => {
  const { ctx, credentialPath, barrier, root, release } = await nativeSaveFixture()
  const slow = await slowRename()
  const record: CredentialRecord = { kind: 'grant', payload: { token: 'private-grant' } }
  const before = readFileSync(credentialPath, 'utf8')
  const modified = ctx.credentials.modifyRecord(KEY, () => Promise.resolve(record))
  const tasks = [modified, ctx.credentials.set(REF, 'private-key'), ctx.credentials.unset(REF), ctx.credentials.deleteRecord(KEY)]
  onTestFinished(async () => { slow.release(); await Promise.allSettled(tasks) })
  expect(barrier.snapshot().pending).toHaveLength(4)
  expect(root.snapshot()).toMatchObject({ running: 1, queued: 3, tracked: 4 })
  await slow.entered
  expect(readFileSync(credentialPath, 'utf8')).toBe(before)
  expect(await barrier.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
  const mutate = vi.fn(() => Promise.resolve(record))
  for (const task of [ctx.credentials.set(REF, 'denied'), ctx.credentials.unset(REF), ctx.credentials.modifyRecord(KEY, mutate), ctx.credentials.deleteRecord(KEY)]) {
    await expect(task).rejects.toMatchObject({ code: 'cloud/config-busy' })
  }
  expect(mutate).not.toHaveBeenCalled()
  expect(fs.rename).toHaveBeenCalledOnce()
  const snapshot = JSON.stringify(barrier.snapshot())
  for (const secret of ['private-grant', 'private-key', REF, KEY]) expect(snapshot).not.toContain(secret)
  slow.release()
  await Promise.all(tasks)
  await expect(modified).resolves.toBe(record)
  expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  await release()
})

it('preserves credential write errors and retains failure after the native queue succeeds again', async () => {
  const { ctx, barrier } = await nativeSaveFixture()
  const failure = Object.assign(new Error('credential EIO with private detail'), { code: 'EIO' })
  vi.mocked(fs.rename).mockRejectedValueOnce(failure)
  const first = ctx.credentials.set(REF, 'failed')
  const rejected = expect(first).rejects.toBe(failure)
  const last = ctx.credentials.set(REF, 'final')
  onTestFinished(async () => { await Promise.allSettled([first, last]) })
  expect(barrier.snapshot().pending).toHaveLength(2)
  await rejected
  await last
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'final', source: 'file' })
  expect(await barrier.stopConfigSaves(Date.now() + 1_000)).toMatchObject({
    status: 'unknown', pendingOperationIds: [], failures: [{ kind: 'credentials', outcome: 'failed' }],
  })
  expect(JSON.stringify(barrier.snapshot())).not.toContain(failure.message)
})

it('keeps slow failing credential mutators owned without allowing later work to escape', async () => {
  const { ctx, barrier, root } = await nativeSaveFixture()
  const entered = latch()
  const finish = latch()
  const failure = new Error('refresh failed')
  const first = ctx.credentials.modifyRecord(KEY, async () => {
    entered.resolve()
    await finish.promise
    throw failure
  })
  const rejected = expect(first).rejects.toBe(failure)
  const second = ctx.credentials.set(REF, 'after-refresh')
  onTestFinished(async () => { finish.resolve(); await Promise.allSettled([first, second]) })
  await entered.promise
  expect(fs.rename).not.toHaveBeenCalled()
  expect(await barrier.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
  expect(root.snapshot()).toMatchObject({ running: 1, queued: 1, tracked: 2 })
  finish.resolve()
  await rejected
  await second
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'after-refresh', source: 'file' })
  expect(barrier.snapshot()).toMatchObject({ pending: [], failures: [{ kind: 'credentials' }] })
})

it('joins real credential → Settings → editor work in one operation without serial self-wait', async () => {
  const { ctx, credentialPath, barrier, root, release } = await nativeSaveFixture()
  const admitted = vi.spyOn(barrier, 'admit')
  const slow = await slowRename()
  const record: CredentialRecord = { kind: 'grant', payload: { token: 'nested' } }
  const task = ctx.credentials.modifyRecord(KEY, async () => {
    await ctx.settings.update('probe', { count: 6 })
    return record
  })
  onTestFinished(async () => { slow.release(); await Promise.allSettled([task]) })
  await slow.entered
  expect(admitted.mock.calls.map(call => call[0])).toEqual(['credentials', 'settings'])
  expect(root.snapshot()).toMatchObject({ running: 1, queued: 0, tracked: 1 })
  expect(barrier.snapshot().pending).toHaveLength(1)
  expect(readFileSync(credentialPath, 'utf8')).not.toContain('nested')
  expect(await barrier.pauseAccountChanges(Date.now())).toMatchObject({ status: 'unknown' })
  slow.release()
  await expect(task).resolves.toBe(record)
  expect(ctx.settings.describe().find(row => row.ns === 'probe')!.value).toEqual({ count: 6 })
  expect(await ctx.credentials.readRecord(KEY)).toEqual(record)
  await release()
})

it('requires the same independent account binding for both hooks and rejects unreviewed editor writers', async () => {
  const { ctx, barrier, install, release } = await nativeSaveFixture({ install: false })
  const other = new Context()
  onTestFinished(async () => { await other.fiber.dispose() })
  other.provide('peAccount', { ...barrier.binding })
  for (const register of [installNativeConfigSaveHook, installNativeCredentialSaveHook]) {
    expect(() => register(other, barrier)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
    const foreignChild = other.isolate('peAccount')
    foreignChild.provide('peAccount', barrier.binding)
    expect(() => register(foreignChild, barrier)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
    const child = ctx.isolate('peAccount')
    child.provide('peAccount', { ...barrier.binding })
    expect(() => register(child, barrier)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  }
  install()
  const submit = vi.fn(() => Promise.resolve(1))
  expect(() => ctx.configEditor.submitSave('plugin-manager/unknown', submit)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(submit).not.toHaveBeenCalled()
  expect(barrier.snapshot().pending).toEqual([])
  expect(() => installNativeCredentialSaveHook(ctx, barrier)).toThrow('already registered')
  await release()
})

it('rechecks queued native work against the binding before entering either native queue', async () => {
  const { ctx, barrier, binding } = await nativeSaveFixture()
  const slow = await slowRename()
  const first = ctx.settings.update('probe', { count: 3 })
  const queued = ctx.credentials.set(REF, 'must-not-run')
  const rejected = expect(queued).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  onTestFinished(async () => { slow.release(); await Promise.allSettled([first, queued]) })
  await slow.entered
  ctx.set('peAccount', { ...binding, epoch: brandString<OwnerEpoch>('2') })
  await expect(ctx.credentials.unset(REF)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  slow.release()
  await first
  await rejected
  expect(fs.rename).toHaveBeenCalledOnce()
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'original', source: 'file' })
  expect(barrier.snapshot()).toMatchObject({ pending: [], failures: [{ kind: 'credentials' }] })
})

it('refuses expired generations without releasing actual native work', async () => {
  const { ctx, barrier, lifetime, root } = await nativeSaveFixture()
  const slow = await slowRename()
  const first = ctx.credentials.set(REF, 'already-admitted')
  onTestFinished(async () => { slow.release(); await Promise.allSettled([first]) })
  await slow.entered
  lifetime.abort()
  await expect(ctx.settings.update('probe', { count: 9 })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(ctx.credentials.unset(REF)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(await barrier.stopConfigSaves(Date.now())).toMatchObject({ status: 'unknown' })
  expect(root.snapshot().tracked).toBe(1)
  slow.release()
  await first
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'already-admitted', source: 'file' })
  expect(barrier.snapshot().pending).toEqual([])
})

it('observes early-installed legacy rename and retains a section failure caught by the native importer', async () => {
  const slow = await slowRename()
  const { ctx, home, barrier } = await nativeSaveFixture({ legacy: 'probe:\n  count: 4\nmissing:\n  count: 1\n' })
  await slow.entered
  expect(existsSync(join(home, 'settings.yaml'))).toBe(true)
  expect(barrier.snapshot().pending).toMatchObject([{ kind: 'settings' }])
  slow.release()
  await vi.waitFor(() => { expect(barrier.snapshot().failures).toHaveLength(1) })
  expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(true)
  expect(ctx.settings.describe().find(row => row.ns === 'probe')!.value).toEqual({ count: 4 })
  expect(await barrier.stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'unknown', failures: [{ kind: 'settings' }] })
})

it('does not claim retrospective coverage for late Settings installation or credential initialization migration', async () => {
  const { ctx, home, credentialPath, barrier, install, release } = await nativeSaveFixture({
    install: false, legacy: 'probe:\n  count: 5\n', credentialText: 'DSH_CLOUD_SAVE_TEST: migrated\n',
  })
  await vi.waitFor(() => { expect(ctx.settings.describe().find(row => row.ns === 'probe')!.value).toEqual({ count: 5 }) })
  expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(true)
  expect(readFileSync(credentialPath, 'utf8')).toContain('version: 1')
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'migrated', source: 'file' })
  install()
  expect(barrier.snapshot()).toMatchObject({ pending: [], failures: [] })
  expect(fs.rename).toHaveBeenCalled()
  await release()
})

it('cannot observe credential initialization migration even with boot-time service injection', async () => {
  const admitted: string[] = []
  const { ctx, credentialPath, barrier, release } = await nativeSaveFixture({
    credentialText: 'DSH_CLOUD_SAVE_TEST: migrated\n',
    beforeBoot(saveBarrier) {
      const real = saveBarrier.admit.bind(saveBarrier)
      vi.spyOn(saveBarrier, 'admit').mockImplementation((kind, submit) => {
        admitted.push(kind)
        return real(kind, submit)
      })
    },
  })
  expect(readFileSync(credentialPath, 'utf8')).toContain('version: 1')
  expect(fs.rename).toHaveBeenCalledOnce()
  expect(admitted).toEqual([])
  expect(barrier.snapshot()).toMatchObject({ pending: [], failures: [] })
  await ctx.credentials.set(REF, 'after-initialization')
  expect(admitted).toEqual(['credentials'])
  await release()
})
