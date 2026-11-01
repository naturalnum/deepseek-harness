/** What the browser half registers, when, what refreshes the model catalogue, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { SubagentCardFace } from '../src/client/index.ts'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  if (ns === 'native-subagents') return { ns, schema: z.object({ maxActiveSubagents: z.number() }).toJSON(),
    value: { maxActiveSubagents: 8 }, base: { maxActiveSubagents: 8 }, user: {}, applies: 'live', secrets: [], revision }
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const models = vi.fn(() => Promise.resolve({ ok: true as const, value: { groups: [], failures: [] } }))
  const mutate = vi.fn(async (ns: string, _ops: unknown, revision: number) => ({ ok: true as const, value: view(ns, revision + 1) }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, {
    session: { modelCatalog: models },
    settings: { describe: describeSettings, mutate },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, models, remote, mutate }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-subagent apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  })

  it('registers one page for both namespaces while the Host serves either, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['subagent', 'subagent-model-selection-settings'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'subagent', order: 10 })
    expect(resolveSlotLabel(entry.options.label)).toBe('子智能体')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<SubagentCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks).sort()).toEqual(['subagentLimitsCard', 'subagentModelSelectionCard'])
  })

  it('registers the page when only the model namespace is served, and nothing when neither is', async () => {
    const { ctx, slots, describeSettings } = await bench(['subagent-model-selection-settings'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    await ctx.plugin({ inject: [...inject], apply }).dispose()
    expect(slots.entries('plugins.item')).toHaveLength(1)

    const other = await bench(['shell'])
    declareRoot(other.slots)
    await other.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(other.describeSettings).toHaveBeenCalled() })
    expect(other.slots.entries('plugins.item')).toHaveLength(0)
    expect(describeSettings).toHaveBeenCalled()
  })

  it('refreshes the model catalogue after model inputs change or the connection resets', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const reset = vi.spyOn(SubagentModelSelectionCardController.prototype, 'resetConnection')
    const { ctx, slots, remote } = await bench(['subagent-model-selection-settings'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    refresh.mockClear()
    reset.mockClear()

    remote.emit('llm/adapters-updated', [])
    expect(refresh).toHaveBeenCalledTimes(1)
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledTimes(1)
    refresh.mockRestore()
    reset.mockRestore()
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['subagent'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('rebinds a late account namespace once, writes the actual name, and withdraws the old card', async () => {
    const { ctx, slots, mutate } = await bench(['subagent', 'native-subagents'])
    declareRoot(slots)
    const native = ctx.plugin({ inject: [...inject], apply })
    await native.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const account = ctx.plugin((scope) => {
      scope.reflect.provide('subagentSettingsIntegration', { namespace: 'native-subagents', fields: ['maxActiveSubagents'] })
    })
    await account.await()
    await vi.waitFor(() => {
      expect(slots.entries('plugins.item')).toHaveLength(1)
      const face = slots.entries('plugins.item')[0]!.inject!() as Record<string, unknown> & SubagentCardFace
      expect(face.hooks.subagentLimitsCard.getSnapshot()).toMatchObject({ available: true,
        allowMaxDepth: false, allowMaxActiveSubagents: true })
    })
    const face = slots.entries('plugins.item')[0]!.inject!() as Record<string, unknown> & SubagentCardFace
    face.editLimit('maxDepth', '3')
    expect(face.hooks.subagentLimitsCard.getSnapshot().dirty).toBe(false)
    face.editLimit('maxActiveSubagents', '4')
    face.save()
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(mutate.mock.calls[0]?.[0]).toBe('native-subagents')
    await account.dispose()
    face.editLimit('maxActiveSubagents', '6')
    face.save()
    expect(mutate).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    await native.dispose()
    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('does not dispatch a queued save after its account binding is withdrawn', async () => {
    const { ctx, slots, mutate } = await bench(['native-subagents'])
    declareRoot(slots)
    const native = ctx.plugin({ inject: [...inject], apply })
    await native.await()
    const account = ctx.plugin((scope) => {
      scope.reflect.provide('subagentSettingsIntegration', { namespace: 'native-subagents', fields: ['maxActiveSubagents'] })
    })
    await account.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const face = slots.entries('plugins.item')[0]!.inject!() as Record<string, unknown> & SubagentCardFace
    await vi.waitFor(() => { expect(face.hooks.subagentLimitsCard.getSnapshot().available).toBe(true) })
    const blocked = Promise.withResolvers<Awaited<ReturnType<typeof mutate>>>()
    mutate.mockImplementationOnce(() => blocked.promise)
    const shared = ctx.configForms.get('native-subagents')
    const first = shared.mutate([{ op: 'set', path: ['maxActiveSubagents'], value: 8 }], 0)
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    face.editLimit('maxActiveSubagents', '4')
    face.save()
    await account.dispose()
    const drained = shared.mutate([], 0, () => { throw new Error('queue drained') })
    blocked.resolve({ ok: true, value: view('native-subagents') })
    await first
    await expect(drained).rejects.toThrow('queue drained')
    expect(mutate).toHaveBeenCalledOnce()
    await native.dispose()
  })
})
