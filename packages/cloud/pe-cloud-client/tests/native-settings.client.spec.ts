// @vitest-environment jsdom
/** Generated namespace callbacks keep the original page admission and never retry a global reader. */
import { expect, it, vi } from 'vitest'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type { CloudPresetReference } from '@deepseek-ai/dsh-pe-cloud-api/types'
import { createCloudNativeSettingsCallbacks } from '../src/client/native-settings.ts'

type Remote = TypertClientRemote['cloudNativeSettings']
function fixture() {
  const signal = new AbortController()
  const inventory: Remote['inventory'] = vi.fn(async () => ({ ok: true as const, value: { managementAvailable: false, entries: [] } }))
  const presets: Remote['presets'] = vi.fn(async () => ({ ok: true as const, value: { presets: [
    { id: 'a', isDefault: true, name: 'Account preset', description: 'Actual account composition' },
    { id: 'b', isDefault: false },
  ] } }))
  const readPreset: Remote['readPreset'] = vi.fn(async (request: CloudPresetReference) => ({ ok: true as const, value: {
    id: request.id, isDefault: request.id === 'a', rows: [{ entryId: 'shell', moduleName: 'cordis:shell', enabled: true, fiberPhase: 'active' as const }],
  } }))
  const assertCurrent = vi.fn()
  const remote = { inventory, presets, readPreset } satisfies Remote
  return { signal, remote, assertCurrent, callbacks: createCloudNativeSettingsCallbacks(remote, {
    signal: signal.signal, timeoutMs: 1000, assertCurrent,
  }) }
}

it('returns actual native DTOs and composes public preset rows in bounded sequential reads', async () => {
  const f = fixture()
  expect(await f.callbacks.inventory()).toEqual({ managementAvailable: false, entries: [] })
  expect(await f.callbacks.presets()).toEqual([
    { id: 'a', isDefault: true, name: 'Account preset', description: 'Actual account composition',
      rows: [{ entryId: 'shell', moduleName: 'cordis:shell', enabled: true, fiberPhase: 'active' }] },
    { id: 'b', isDefault: false, rows: [{ entryId: 'shell', moduleName: 'cordis:shell', enabled: true, fiberPhase: 'active' }] },
  ])
  expect(f.remote.readPreset).toHaveBeenNthCalledWith(1, { id: 'a' }, expect.any(AbortSignal))
  expect(f.remote.readPreset).toHaveBeenNthCalledWith(2, { id: 'b' }, expect.any(AbortSignal))
  expect(Object.keys(f.callbacks).sort()).toEqual(['inventory', 'presets'])
})

it('refuses closed pages before dispatch and after a late response without another read', async () => {
  const f = fixture(), late = Promise.withResolvers<Awaited<ReturnType<Remote['inventory']>>>()
  vi.mocked(f.remote.inventory).mockReturnValueOnce(late.promise)
  const reading = f.callbacks.inventory()
  f.signal.abort(new Error('Original page retired'))
  late.resolve({ ok: true, value: { entries: [] } })
  await expect(reading).rejects.toThrow('Original page retired')
  await expect(f.callbacks.inventory()).rejects.toThrow('Original page retired')
  expect(f.remote.inventory).toHaveBeenCalledOnce()
})

it('rejects generation changes and native failures without reading the unrestricted namespace', async () => {
  const f = fixture()
  f.assertCurrent.mockImplementation(() => { throw new Error('Retired generation') })
  await expect(f.callbacks.inventory()).rejects.toThrow('Retired generation')
  expect(f.remote.inventory).not.toHaveBeenCalled()
  const failure = fixture()
  vi.mocked(failure.remote.inventory).mockRejectedValueOnce(new Error('Account unavailable'))
  await expect(failure.callbacks.inventory()).rejects.toThrow('Account unavailable')
  expect(failure.remote.inventory).toHaveBeenCalledOnce()
  expect(failure.remote.presets).not.toHaveBeenCalled()
})

it('does not combine a changed preset identity or default with an earlier roster', async () => {
  const f = fixture()
  vi.mocked(f.remote.readPreset).mockResolvedValueOnce({ ok: true, value: { id: 'other', isDefault: true, rows: [] } })
  await expect(f.callbacks.presets()).rejects.toMatchObject({ code: 'closed' })
  expect(f.remote.readPreset).toHaveBeenCalledOnce()
})
