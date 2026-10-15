/** Optional remote intake preserves the native local credential path and removes with its provider. */
import { Context } from '@deepseek-ai/cordis'
import { expect, onTestFinished, test, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createModelsOperations } from '../src/client/operations.ts'

test('typed key storage and draft discovery use the installed browser intake only', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  const localStore = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const localDiscovery = vi.fn(async () => ({ ok: true as const, value: [] }))
  new TestRemote(ctx, { credentials: { set: localStore }, llm: { discoverModels: localDiscovery } })
  const storeCredential = vi.fn(async () => undefined)
  const discoverModels = vi.fn(async () => ({ kind: 'found' as const, models: [{ id: 'owned-model' }] }))
  const provider = ctx.plugin({ apply(owner: Context) { owner.provide('modelsCredentialIntake', { storeCredential, discoverModels }) } })
  await provider.await()
  const operations = createModelsOperations(ctx)
  expect(await operations.storeCredential('OWNED_KEY', 'browser-key')).toBeUndefined()
  expect(await operations.discoverModels('llm-pi-ai', { baseURL: 'https://provider.example', apiKey: 'draft-key' }))
    .toEqual({ kind: 'found', models: [{ id: 'owned-model' }] })
  expect(localStore).not.toHaveBeenCalled(); expect(localDiscovery).not.toHaveBeenCalled()
  expect(storeCredential).toHaveBeenCalledWith('OWNED_KEY', 'browser-key')
  expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { baseURL: 'https://provider.example', apiKey: 'draft-key' })
  await provider.dispose()
  expect(ctx.get('modelsCredentialIntake')).toBeUndefined()
  expect(await operations.storeCredential('OWNED_KEY', 'local-key')).toBeUndefined()
  expect(localStore).toHaveBeenCalledWith('OWNED_KEY', 'local-key')
})

test('keyless directory discovery retains the native Remote path with an intake installed', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  const native = vi.fn(async () => ({ ok: true as const, value: [{ id: 'catalog-model' }] }))
  new TestRemote(ctx, { llm: { discoverModels: native } })
  const direct = vi.fn(async () => ({ kind: 'found' as const, models: [] }))
  ctx.provide('modelsCredentialIntake', { storeCredential: async () => undefined, discoverModels: direct })
  expect(await createModelsOperations(ctx).discoverModels('llm-pi-ai', { provider: 'openai' }))
    .toEqual({ kind: 'found', models: [{ id: 'catalog-model' }] })
  expect(native).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openai' })
  expect(direct).not.toHaveBeenCalled()
})

test('a deployment requiring direct intake refuses typed keys before Host RPC when its provider is absent', async () => {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  const localStore = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const localDiscovery = vi.fn(async () => ({ ok: true as const, value: [] }))
  new TestRemote(ctx, { credentials: { set: localStore }, llm: { discoverModels: localDiscovery } })
  const operations = createModelsOperations(ctx, { required: true, unavailable: () => 'intake unavailable' })
  expect(await operations.storeCredential('OWNED_KEY', 'must-stay-in-browser')).toBe('intake unavailable')
  expect(await operations.discoverModels('llm-pi-ai', { baseURL: 'https://provider.example', apiKey: 'must-stay-in-browser' }))
    .toEqual({ kind: 'refused', message: 'intake unavailable' })
  expect(localStore).not.toHaveBeenCalled(); expect(localDiscovery).not.toHaveBeenCalled()
})
