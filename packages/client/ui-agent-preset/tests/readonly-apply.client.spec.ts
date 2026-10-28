/** Admitted preset Settings activate without unrestricted native services or editable surfaces. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import type { AgentPresetSectionInjected } from '../src/client/AgentPresetSection.tsx'

function readonlyActions(value: Record<string, unknown> | undefined): value is Record<string, unknown>
  & Pick<AgentPresetSectionInjected, 'readOnly' | 'startCreatorDraft' | 'load' | 'makeDefault'> {
  return value !== undefined && value.readOnly === true
    && value.startCreatorDraft === undefined && typeof value.load === 'function' && typeof value.makeDefault === 'function'
}

it('registers only the original read-only Settings section without remote namespaces or config forms', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const list = vi.fn(async () => [{ id: 'approved', isDefault: true, rows: [] }])
  ctx.provide('agentPresetSettingsIntegration', { isCurrent: () => true, list })
  ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entries = ctx.slots.entries('settings.section')
  expect(entries.map(entry => entry.options.id)).toEqual(['agent-presets'])
  expect(list).not.toHaveBeenCalled()
  const entry = entries[0]!
  const face = entry.inject?.()
  if (!readonlyActions(face)) throw new Error('The admitted Settings section did not provide its readonly actions')
  expect(face.readOnly).toBe(true)
  expect(face.startCreatorDraft).toBeUndefined()
  await face.load()
  expect(list).toHaveBeenCalledTimes(1)
  await expect(face.makeDefault('approved')).rejects.toThrow()
  expect(ctx.slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
  expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
  expect(ctx.slots.entries('plugins.add.actions')).toHaveLength(0)
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  await face.load()
  expect(list).toHaveBeenCalledTimes(1)
})
