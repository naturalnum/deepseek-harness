/** Real CloudAccountApi/ExposurePolicy and existing native Loader graph; bounded producer fixtures, no Root ready authority. */
import { expect, it, vi } from 'vitest'
import type { ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api/types'
import { policyFixture } from './account-policy-fixture.ts'

const selected: ExactFetchExposure = { method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' }
const unavailable = { code: 'cloud/account-unavailable' }, invalid = { code: 'cloud/invalid-config' }
function fixture(initial: readonly ExactFetchExposure[] = [selected]) {
  let actual = initial
  const inspectRootFetch = vi.fn(() => actual)
  const native = policyFixture([], undefined, 'root-fetch', { selected: [selected], inspectRootFetch })
  return { ...native, inspectRootFetch, replace: (rows: readonly ExactFetchExposure[]): void => { actual = rows } }
}

it('preserves omitted callback with actual original native inventory and no exposed Root route', async () => {
  const graph = await policyFixture().start()
  await graph.api.assertBootstrapCurrent(graph.ctx)
  expect(graph.api.requireRpc('session/create').handlerId).toBe('native:sessionController')
  expect(() => graph.api.requireFetch('GET', selected.path)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(graph.adapter.calls).toBe(0)
})

it('fails actual prepared audit when the manifest selects a Root route without a producer callback', async () => {
  const f = policyFixture([], undefined, 'missing-root-fetch', { selected: [selected] })
  await expect(f.start()).rejects.toMatchObject(invalid)
})

it('audits actual callback facts, rechecks dispatch/bootstrap and leaves extra unselected routes denied', async () => {
  const extra = { ...selected, path: '/cloud/other-read' }
  const f = fixture([selected, extra]), graph = await f.start()
  const beforeDispatch = f.inspectRootFetch.mock.calls.length
  expect(graph.api.requireFetch('GET', selected.path)).toEqual(selected)
  expect(f.inspectRootFetch.mock.calls.length).toBeGreaterThan(beforeDispatch)
  const beforeBootstrap = f.inspectRootFetch.mock.calls.length
  await graph.api.assertBootstrapCurrent(graph.ctx)
  expect(f.inspectRootFetch.mock.calls.length).toBeGreaterThan(beforeBootstrap)
  expect(() => graph.api.requireFetch('GET', extra.path)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(() => graph.api.requireFetch('HEAD', selected.path)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(graph.adapter.calls).toBe(0)
})

it('rejects original Root withdrawal, changed method/path/handler/guard and duplicate selected facts on current checks', async () => {
  const f = fixture(), graph = await f.start()
  const changed: readonly (readonly ExactFetchExposure[])[] = [[], [{ ...selected, method: 'POST' }],
    [{ ...selected, path: '/cloud/another-preview' }], [{ ...selected, handlerId: 'root:replacement' }],
    [{ ...selected, guard: 'authenticated-account' }], [selected, selected]]
  for (const rows of changed) {
    f.replace(rows)
    expect(() => graph.api.requireFetch('GET', selected.path)).toThrow(expect.objectContaining(unavailable))
    await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject(unavailable)
  }
  f.replace([selected])
  await graph.api.assertBootstrapCurrent(graph.ctx)
  expect(graph.api.requireFetch('GET', selected.path)).toEqual(selected)
  expect(graph.adapter.calls).toBe(0)
})

it('uses original ExposurePolicy matching/uniqueness during each prepared audit and revokes the failed audit', async () => {
  const f = fixture(), graph = await f.start()
  const changed: readonly (readonly ExactFetchExposure[])[] = [[], [{ ...selected, method: 'POST' }],
    [{ ...selected, handlerId: 'root:replacement' }], [{ ...selected, guard: 'authenticated-account' }], [selected, selected]]
  for (const rows of changed) {
    f.replace(rows)
    await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject(invalid)
    expect(() => graph.api.requireFetch('GET', selected.path)).toThrow(expect.objectContaining(unavailable))
    f.replace([selected]); await graph.api.auditPrepared(graph.ctx)
    expect(graph.api.requireFetch('GET', selected.path)).toEqual(selected)
  }
  expect(graph.adapter.calls).toBe(0)
})

it('rejects over-budget Root arrays before policy duplicate traversal on prepared/dispatch/bootstrap paths', async () => {
  const f = fixture(), graph = await f.start()
  const oversized: ExactFetchExposure[] = Array<ExactFetchExposure>(graph.maxEntries + 1).fill(selected)
  f.replace(oversized)
  expect(() => graph.api.requireFetch('GET', selected.path)).toThrow(expect.objectContaining(unavailable))
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toMatchObject(unavailable)
  await expect(graph.api.auditPrepared(graph.ctx)).rejects.toMatchObject(unavailable)
  f.replace([selected]); await graph.api.auditPrepared(graph.ctx)
  expect(graph.api.requireFetch('GET', selected.path)).toEqual(selected)
  expect(graph.adapter.calls).toBe(0)
})

it('preserves the producer original-registration failure without accepting a prior audit as current facts', async () => {
  const f = fixture(), graph = await f.start(), removed = new Error('Original Root registration was withdrawn')
  f.inspectRootFetch.mockImplementation(() => { throw removed })
  expect(() => graph.api.requireFetch('GET', selected.path)).toThrow(removed)
  await expect(graph.api.assertBootstrapCurrent(graph.ctx)).rejects.toBe(removed)
  await expect(graph.api.auditPrepared(graph.ctx)).rejects.toBe(removed)
  expect(graph.adapter.calls).toBe(0)
})

it('rechecks Root route facts after the original asynchronous bootstrap metadata read', async () => {
  const f = fixture(), graph = await f.start()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = graph.adapter.resolveModel.bind(graph.adapter)
  const spy = vi.spyOn(graph.adapter, 'resolveModel').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return original(...args)
  })
  try {
    const reading = graph.api.assertBootstrapCurrent(graph.ctx)
    const rejected = expect(reading).rejects.toMatchObject(unavailable)
    await entered.promise
    const before = f.inspectRootFetch.mock.calls.length
    f.replace([]); release.resolve(undefined)
    await rejected
    expect(f.inspectRootFetch.mock.calls.length).toBeGreaterThan(before)
  } finally { release.resolve(undefined); spy.mockRestore() }
  expect(graph.adapter.calls).toBe(0)
})
