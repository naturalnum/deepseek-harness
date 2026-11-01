/** Original inventory responses, account lifetime and late-result behavior. */
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished } from 'vitest'
import { installCloudPresetIntegration } from '../src/client/preset-integration.ts'

it('shows the real roster and composition without exposing configuration values', async () => {
  const ctx = new Context(), lifetime = new AbortController()
  new TestRemote(ctx, { pluginInventory: { list: async () => ({ ok: true, value: { entries: [], agentPresets: [
    { id: 'actual', name: 'Actual', isDefault: true, rows: [
      { entryId: 'one', moduleName: 'cordis:actual', enabled: true, fiberPhase: 'active' },
    ] },
  ] } }) } })
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: () => { lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin((scope) => { installCloudPresetIntegration(scope, page as never) })
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
  new TestRemote(ctx, { pluginInventory: { list: async () => await pending.promise } })
  const page = { lifetime: { transport: { signal: lifetime.signal } },
    assertAccountManagementCurrent: () => { lifetime.signal.throwIfAborted() } }
  const plugin = ctx.plugin((scope) => { installCloudPresetIntegration(scope, page as never) })
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  await plugin.await()
  const read = ctx.get('agentPresetIntegration')!.list()
  lifetime.abort()
  pending.resolve({ ok: true, value: { entries: [], agentPresets: [] } })
  await expect(read).rejects.toThrow()
})
