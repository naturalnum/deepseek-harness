/** Policy projection keeps original native model metadata and excludes foreign routes. */
import { Context } from '@deepseek-ai/cordis'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { assertNativeModelRoute, projectNativeModelCatalog, type NativeModelSelectionPolicy } from '../src/native-model-selection.ts'

const policy: NativeModelSelectionPolicy = {
  allowedProvider: provider => provider === 'approved' || provider === 'offline-approved',
  allowedModel: (provider, model) => provider === 'approved' && model === 'flash',
}

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly reasoning = true) { super() }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider.startsWith('offline-')) return Promise.reject(new Error('The provider catalog is unavailable.'))
    return Promise.resolve(['flash', 'private'].map(id => ({ provider, id, name: `${provider}:${id}` })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.reasoning ? { reasoning: {
      efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    } } : {} })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Catalog reads must not execute a model request.')
  }
}

async function catalog(reasoning = true): Promise<ModelCatalog> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['approved', 'foreign', 'offline-approved', 'offline-foreign'], new CatalogAdapter(reasoning))
  return buildModelCatalog(ctx, { provider: 'approved', model: 'flash', reasoningEffort: 'high' })
}

it('projects the original native catalog and retains its actual model, reasoning, default and failure facts', async () => {
  const native = await catalog()
  const result = projectNativeModelCatalog(native, policy, 16, 65536)
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0]).toEqual({ id: 'approved', name: 'approved', models: [native.groups[0]!.models[0]] })
  expect(result.groups[0]!.models[0]).toBe(native.groups[0]!.models[0])
  expect(result.groups[0]!.models[0]!.reasoning).toBe(native.groups[0]!.models[0]!.reasoning)
  expect(result.default).toBe(native.default)
  expect(result.routableProviders).toEqual(['approved'])
  expect(result.failures).toEqual([native.failures[0]])
  expect(result.failures[0]).toBe(native.failures[0])
  expect(native.groups.map(group => group.models.length)).toEqual([2, 2])
  expect(native.failures).toHaveLength(2)
})

it('retains a native model without reasoning controls rather than inventing effort options', async () => {
  const native = await catalog(false)
  const result = projectNativeModelCatalog(native, policy, 16, 65536)
  expect(result.groups[0]!.models[0]).toEqual({ id: 'flash', name: 'approved:flash' })
  expect(result.groups[0]!.models[0]).toBe(native.groups[0]!.models[0])
})

it('does not advertise an approved provider with no approved catalog model', async () => {
  const native = await catalog()
  const result = projectNativeModelCatalog({ ...native, groups: native.groups.map(group => ({ ...group,
    models: group.models.filter(model => model.id !== 'flash') })) }, policy, 16, 65536)
  expect(result.groups).toEqual([])
  expect(result.routableProviders).toEqual([])
  expect(result.failures).toEqual([native.failures[0]])
})

it.each([
  { provider: 'foreign', model: 'flash' },
  { provider: 'approved', model: 'private' },
  { provider: 'unknown', model: 'flash' },
])('rejects an unapproved route before native selection can mutate state: %j', (selection) => {
  const select = vi.fn()
  expect(() => { assertNativeModelRoute(selection, policy); select() }).toThrow(expect.objectContaining({ code: 'cloud/model-not-allowed' }))
  expect(select).not.toHaveBeenCalled()
})

it('keeps adapter-owned reasoning effort validation with the original native selector', () => {
  expect(() => { assertNativeModelRoute({ provider: 'approved', model: 'flash', reasoningEffort: 'not-an-effort' }, policy) }).not.toThrow()
})

it('rejects a native default outside the immutable route policy', async () => {
  const native = await catalog()
  expect(() => projectNativeModelCatalog({ ...native, default: { provider: 'foreign', model: 'flash' } }, policy, 16, 65536))
    .toThrow(expect.objectContaining({ code: 'cloud/model-not-allowed' }))
})

it.each([0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid collection bound %s', async (maximum) => {
  const native = await catalog()
  expect(() => projectNativeModelCatalog(native, policy, maximum, 65536))
    .toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
})

it('bounds the complete original catalog before hiding unapproved rows', async () => {
  const native = await catalog()
  expect(() => projectNativeModelCatalog(native, policy, 1, 65536)).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  const enlarged = { ...native, failures: [...native.failures, { id: 'foreign', name: 'hidden', message: 'x'.repeat(65536) }] }
  expect(() => projectNativeModelCatalog(enlarged, policy, 16, 65536)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})
