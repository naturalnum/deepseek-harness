/** Original inventory responses, account lifetime and late-result behavior. */
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCloudPresetIntegration } from '../src/client/preset-integration.ts'

it('shows the real roster and composition without exposing configuration values', async () => {
  const ctx = new Context(), lifetime = new AbortController()
  const provider = ctx.plugin({ apply(scope: Context) {
    new TestRemote(scope, { pluginInventory: { list: async () => ({ ok: true, value: { entries: [], agentPresets: [
      { id: 'actual', name: 'Actual', isDefault: true, rows: [
        { entryId: 'one', moduleName: 'cordis:actual', enabled: true, fiberPhase: 'active' },
      ] },
    ] } }) } })
  } })
  await provider.await()
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: (owner: Context) => { owner.fiber.assertActive(); lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin({ inject: [], apply(scope: Context) { installCloudPresetIntegration(scope, page as never) } })
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  await plugin.await()
  const source = ctx.get('agentPresetIntegration')!
  expect(await source.list()).toEqual({ presets: [{ id: 'actual', name: 'Actual', isDefault: true }] })
  const document = await source.read('actual')
  expect(document.content).toContain('cordis:actual')
  expect(document.content).toContain('配置值未提供')
  await expect(source.read('missing')).rejects.toThrow()
  await plugin.dispose()
  expect(ctx.get('agentPresetIntegration')).toBeUndefined()
})

it('refuses a late inventory result after account revocation', async () => {
  const ctx = new Context(), lifetime = new AbortController()
  const pending = Promise.withResolvers<{ ok: true; value: { entries: never[]; agentPresets: never[] } }>()
  const list = vi.fn(async () => await pending.promise)
  const provider = ctx.plugin({ apply(scope: Context) {
    new TestRemote(scope, { pluginInventory: { list } })
  } })
  await provider.await()
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: (owner: Context) => { owner.fiber.assertActive(); lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin({ inject: [], apply(scope: Context) { installCloudPresetIntegration(scope, page as never) } })
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  await plugin.await()
  const read = ctx.get('agentPresetIntegration')!.list()
  lifetime.abort()
  pending.resolve({ ok: true, value: { entries: [], agentPresets: [] } })
  await expect(read).rejects.toThrow()
  await expect(ctx.get('agentPresetIntegration')!.list()).rejects.toThrow()
  expect(list).toHaveBeenCalledOnce()
})

it('withdraws the original source and refuses late results when the injected Remote provider is replaced', async () => {
  const ctx = new Context(), lifetime = new AbortController()
  const pending = Promise.withResolvers<{ ok: true; value: { entries: never[]; agentPresets: never[] } }>()
  const first = vi.fn(async () => await pending.promise)
  const provider = ctx.plugin({ apply(scope: Context) { new TestRemote(scope, { pluginInventory: { list: first } }) } })
  await provider.await()
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: (owner: Context) => { owner.fiber.assertActive(); lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin({ inject: [], apply(scope: Context) { installCloudPresetIntegration(scope, page as never) } })
  onTestFinished(async () => {
    pending.resolve({ ok: true, value: { entries: [], agentPresets: [] } }); lifetime.abort(); await ctx.fiber.dispose()
  })
  await plugin.await()
  const source = ctx.get('agentPresetIntegration')!
  const inFlight = source.list()
  await vi.waitFor(() => { expect(first).toHaveBeenCalledOnce() })
  await provider.dispose()
  expect(ctx.get('agentPresetIntegration')).toBe(source)
  pending.resolve({ ok: true, value: { entries: [], agentPresets: [] } })
  await expect(inFlight).rejects.toThrow()
  await expect(source.list()).rejects.toThrow()
  const second = vi.fn(async () => ({ ok: true as const, value: { entries: [], agentPresets: [
    { id: 'replacement', isDefault: false, rows: [] },
  ] } }))
  const replacement = ctx.plugin({ apply(scope: Context) { new TestRemote(scope, { pluginInventory: { list: second } }) } })
  await replacement.await()
  await vi.waitFor(async () => {
    expect(await source.list()).toEqual({ presets: [{ id: 'replacement', isDefault: false }] })
  })
  expect(second).toHaveBeenCalledOnce()
  expect(first).toHaveBeenCalledOnce()
})

it('keeps the read-only source closed until the original Remote namespace is available', async () => {
  const ctx = new Context(), lifetime = new AbortController()
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: (owner: Context) => { owner.fiber.assertActive(); lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin({ inject: [], apply(scope: Context) { installCloudPresetIntegration(scope, page as never) } })
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  await plugin.await()
  const source = ctx.get('agentPresetIntegration')!
  expect(source).toBeDefined()
  await expect(source.list()).rejects.toThrow()
  const provider = ctx.plugin({ apply(scope: Context) { new TestRemote(scope, { pluginInventory: {
    list: async () => ({ ok: true, value: { entries: [], agentPresets: [] } }),
  } }) } })
  await provider.await()
  await vi.waitFor(async () => { expect(await source.list()).toEqual({ presets: [] }) })
})
