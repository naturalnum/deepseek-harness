/** Actual account Loader inventory; no Target or browser authority. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import PluginInventoryGateway from '@deepseek-ai/dsh-host-plugin-inventory'
import { createNativePluginInventory, type NativePluginInventory } from '../src/native-plugin-inventory.ts'
import { ExposurePolicy } from '../src/exposure.ts'

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'account-plugin-inventory-')), config = join(home, 'cordis.yml')
  writeFileSync(config, JSON.stringify([{ id: 'inventory', name: 'cordis:account-inventory' }]))
  const controller = new AbortController(), binding: AccountBinding = {
    accountId: 'inventory-account' as AccountBinding['accountId'], epoch: '1' as AccountBinding['epoch'],
    recipeVersion: 'inventory-test', lifetime: controller.signal,
  }
  const row = { endpoint: 'pluginInventory/list', handlerId: 'native:pluginInventory', guard: 'authenticated-account' as const }
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion, rpcEndpoints: [row], streamEndpoints: [],
    exactFetchRoutes: [], allowedSettings: [] })
  let native: NativePluginInventory | undefined, ready = true
  const owner: { graph?: Awaited<ReturnType<typeof boot>> } = {}
  onTestFinished(async () => { try { await owner.graph?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } })
  const graph = await boot('account-plugin-inventory', config, [], async (ctx) => {
    ctx.provide('peAccount', binding)
    await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
    Object.assign(ctx.loader.builtins, { 'account-inventory': {
      inject: ['loader', 'peAccount'],
      apply(scope: Context) {
        native = createNativePluginInventory(scope, binding, () => { if (!ready) throw new Error('account not ready') }, policy, 256, 65536)
      },
    } })
  })
  owner.graph = graph
  if (native === undefined) throw new Error('inventory not mounted')
  policy.audit(native.inspect())
  const peer: PeerScope = { id: brandString<PeerId>('inventory-peer'), ctx: graph, principal: { kind: 'owner' },
    interactions: 'answer', signal: controller.signal, dispose: async () => {} }
  const invoke = () => graph.typertGateway.invoke({ namespace: 'pluginInventory', method: 'list', args: {}, peer })
  return { graph, native, policy, invoke, revoke: () => { ready = false }, end: () => { controller.abort() } }
}

it('reads the real account Loader entries with no native manager writes', async () => {
  const f = await fixture(), result = await f.native.value.list()
  expect(result.entries.some(row => row.moduleName === 'cordis:account-inventory')).toBe(true)
  expect(result.managementAvailable).toBeUndefined()
  expect(f.native.inspect().rpcEndpoints).toEqual([{ endpoint: 'pluginInventory/list', handlerId: 'native:pluginInventory', guard: 'authenticated-account' }])
  expect(JSON.stringify(result)).not.toContain('config')
  const wire = await f.invoke()
  expect(wire).toEqual(result)
})

it('withdraws access on account admission, generation, and exposure revocation', async () => {
  for (const end of ['ready', 'binding', 'exposure'] as const) {
    const f = await fixture()
    if (end === 'ready') f.revoke()
    else if (end === 'binding') f.end()
    else f.policy.invalidate()
    await expect(f.native.value.list()).rejects.toBeDefined()
    await expect(f.invoke()).rejects.toBeDefined()
  }
})

it('preserves preset state without disclosing raw Loader conditions or exception text', async () => {
  const f = await fixture()
  const spy = vi.spyOn(PluginInventoryGateway.prototype, 'list').mockResolvedValue({ entries: [], agentPresets: [{
    id: 'example', isDefault: true, broken: 'private error', rows: [{ entryId: null, moduleName: 'cordis:sample',
      enabled: 'conditional', condition: 'private expression', fiberPhase: null }],
  }] })
  onTestFinished(() => { spy.mockRestore() })
  const result = await f.invoke()
  expect(result).toEqual({ entries: [], agentPresets: [{ id: 'example', isDefault: true, broken: 'Preset could not load.',
    rows: [{ entryId: null, moduleName: 'cordis:sample', enabled: 'conditional', fiberPhase: null }] }] })
})

it('does not publish a pending inventory result after the account is withdrawn', async () => {
  const f = await fixture()
  const settled = Promise.withResolvers<Awaited<ReturnType<PluginInventoryGateway['list']>>>()
  const spy = vi.spyOn(PluginInventoryGateway.prototype, 'list').mockReturnValue(settled.promise)
  onTestFinished(() => { spy.mockRestore() })
  const result = f.native.value.list()
  f.revoke()
  settled.resolve({ entries: [] })
  await expect(result).rejects.toBeDefined()
})

it('refuses an over-limit native inventory before publishing any partial list', async () => {
  const f = await fixture()
  const row = { entryId: null, moduleName: 'cordis:sample', enabled: true as const, fiberPhase: null }
  const spy = vi.spyOn(PluginInventoryGateway.prototype, 'list').mockResolvedValue({ entries: [], agentPresets: [{
    id: 'too-many', isDefault: true, rows: Array.from({ length: 257 }, () => row),
  }] })
  onTestFinished(() => { spy.mockRestore() })
  await expect(f.invoke()).rejects.toBeDefined()
})
