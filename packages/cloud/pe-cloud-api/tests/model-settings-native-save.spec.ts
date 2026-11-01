/** Native Settings writer and model-key provider share one account owner. */
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { localeFixture } from './locale-field-fixture.ts'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof fs>()
  return { ...native, rename: vi.fn(native.rename) }
})
beforeEach(async () => {
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
})

it('saves one approved structured model list through the existing revisioned Settings writer', async () => {
  const fields = [{ namespace: 'model-provider', field: 'models' }]
  const f = await localeFixture('model-native-save', true, fields)
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  const before = f.ctx.settingsController.describe().namespaces.find(row => row.ns === 'model-provider')
  expect(before).toBeDefined()
  await expect(f.modelMetadata()).resolves.toMatchObject({ settings: { writable: true } })
  const result = await f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'synthetic-new' }] }],
    f.revision('model-provider'), { ns: 'model-provider' })
  if (typeof result !== 'object' || result === null || !('value' in result)) throw new Error('Settings mutation returned no value')
  expect(result.value).toEqual({ models: [{ id: 'synthetic', inputModalities: ['text'] }, { id: 'synthetic-new', inputModalities: ['text'] }] })
  expect(f.barrier.snapshot().failures).toEqual([])
  await expect(f.keyState()).resolves.toBeDefined()
  await expect(f.modelMetadata()).resolves.toMatchObject({ settings: { writable: true } })
  await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'different' }] }],
    f.revision('model-provider'), { ns: 'model-provider' })).rejects.toMatchObject({ code: 'settings/rejected' })
  await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'stale' }] }],
    before!.revision, { ns: 'model-provider' })).rejects.toMatchObject({ code: 'settings/conflict' })
})

it('resets to the native inherited model catalog when it contains the selected default', async () => {
  const f = await localeFixture('model-reset', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  await f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'override' }] }],
    f.revision('model-provider'), { ns: 'model-provider' })
  const restored = await f.call([{ op: 'unset', path: ['models'] }], f.revision('model-provider'), { ns: 'model-provider' })
  if (typeof restored !== 'object' || restored === null || !('value' in restored)) throw new Error('Settings mutation returned no value')
  expect(restored.value).toMatchObject({ models: [{ id: 'synthetic' }] })
  expect(f.barrier.snapshot().failures).toEqual([])
  await expect(f.keyState()).resolves.toBeDefined()
})

it('rejects reset without writing when its native inherited catalog drops the selected default', async () => {
  const f = await localeFixture('model-reset-reject', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'override' }).await()
  await f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'override' }] }],
    f.revision('model-provider'), { ns: 'model-provider' })
  const before = readFileSync(f.profile.patchPath)
  await expect(f.call([{ op: 'unset', path: ['models'] }], f.revision('model-provider'), { ns: 'model-provider' }))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toEqual([])
})

it('retains the original in-flight model save when its observer withdraws after publication', async () => {
  const f = await localeFixture('model-withdraw', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  const published = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let writes = 0
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await native.rename(from, to)
    if (to === f.profile.patchPath) { writes++; published.resolve(undefined); await release.promise }
  })
  const result = f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'synthetic-new' }] }],
    f.revision('model-provider'), { ns: 'model-provider' })
  const observed = Promise.allSettled([result])
  await published.promise
  f.revoke()
  const receipt = await f.api.stopConfigSaves(Date.now() + 10)
  expect(receipt.status).toBe('unknown')
  release.resolve(undefined)
  expect((await observed)[0].status).toBe('rejected')
  expect(f.barrier.snapshot().failures).toMatchObject([{ kind: 'settings', outcome: 'unknown' }])
  expect(f.contained()).toBe(true)
  expect((await f.api.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
  expect(writes).toBe(1)
})

it('retains unknown if the pinned provider identity changes after publication', async () => {
  const f = await localeFixture('model-owner-change', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  const entry = [...f.ctx.loader.entries()].find(item => item.options.id === 'model-provider')!
  const previous = entry.options.name, native = await vi.importActual<typeof fs>('node:fs/promises')
  let writes = 0
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await native.rename(from, to)
    if (to === f.profile.patchPath) { writes++; Reflect.set(entry.options, 'name', 'fixture:changed-provider') }
  })
  try {
    await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'synthetic-new' }] }],
      f.revision('model-provider'), { ns: 'model-provider' })).rejects.toBeDefined()
    expect(f.barrier.snapshot().failures).toMatchObject([{ kind: 'settings', outcome: 'unknown' }])
    expect(f.contained()).toBe(true)
    expect((await f.api.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
    expect(writes).toBe(1)
  } finally { Reflect.set(entry.options, 'name', previous) }
})

it('retains unknown when the provider audit fails after the native model config was saved', async () => {
  const f = await localeFixture('model-post-save-audit', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  const entry = [...f.ctx.loader.entries()].find(item => item.options.id === 'model-provider')!
  const original = entry.prepareConfigUpdate.bind(entry), before = readFileSync(f.profile.patchPath)
  let failed = 0
  const spy = vi.spyOn(entry, 'prepareConfigUpdate').mockImplementation((...args) => {
    const models = (entry.options.config as { models?: Array<{ id?: string }> }).models
    if (models?.some(model => model.id === 'synthetic-new')) { failed++; throw new Error('injected post-save audit failure') }
    return original(...args)
  })
  try {
    await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'synthetic-new' }] }],
      f.revision('model-provider'), { ns: 'model-provider' })).rejects.toBeDefined()
    expect(failed).toBe(1)
    expect(readFileSync(f.profile.patchPath)).not.toEqual(before)
    expect(f.barrier.snapshot().failures).toMatchObject([{ kind: 'settings', outcome: 'unknown' }])
    expect(f.contained()).toBe(true)
    expect((await f.api.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
    await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }] }], 0,
      { ns: 'model-provider' })).rejects.toBeDefined()
    expect(failed).toBe(1)
  } finally { spy.mockRestore() }
})

it('does not accept a changed effective catalog after the approved plan was persisted', async () => {
  const f = await localeFixture('model-effective-drift', true, [{ namespace: 'model-provider', field: 'models' }])
  await f.ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'synthetic' }).await()
  const entry = [...f.ctx.loader.entries()].find(item => item.options.id === 'model-provider')!
  const snapshot = entry.snapshotConfigUpdatePlan.bind(entry), before = readFileSync(f.profile.patchPath)
  let calls = 0
  const spy = vi.spyOn(entry, 'snapshotConfigUpdatePlan').mockImplementation((plan) => {
    const actual = snapshot(plan)
    if (++calls === 2) return { ...(actual as object), models: [{ id: 'drift' }] }
    return actual
  })
  try {
    await expect(f.call([{ op: 'set', path: ['models'], value: [{ id: 'synthetic' }, { id: 'override' }] }],
      f.revision('model-provider'), { ns: 'model-provider' })).rejects.toBeDefined()
    expect(calls).toBe(2)
    expect(readFileSync(f.profile.patchPath)).not.toEqual(before)
    expect(f.barrier.snapshot().failures).toMatchObject([{ kind: 'settings', outcome: 'unknown' }])
    expect(f.contained()).toBe(true)
  } finally { spy.mockRestore() }
})
