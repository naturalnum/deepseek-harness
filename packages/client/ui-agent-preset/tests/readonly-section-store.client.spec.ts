/** Public-summary reads remain with one original page and never invoke global profile controls. */
import { expect, it, vi } from 'vitest'
import { ReadonlyAgentPresetSectionController } from '../src/client/readonly-section-store.ts'
import type { AgentPresetCompositionSummary } from '../src/client/integration.ts'

const summaries: readonly AgentPresetCompositionSummary[] = [{ id: 'approved', name: 'Account preset', isDefault: true,
  rows: [{ entryId: 'bash', moduleName: 'cordis:tool-bash', enabled: true, fiberPhase: 'active' }] }]

it('loads and inspects public module/state facts without creating configuration text', async () => {
  const list = vi.fn(async () => summaries)
  const controller = new ReadonlyAgentPresetSectionController({ isCurrent: () => true, list }, () => 'Unavailable')
  await controller.load()
  expect(controller.store.getSnapshot().rows).toEqual([{ id: 'approved', name: 'Account preset', isDefault: true }])
  await controller.view('approved')
  expect(controller.store.getSnapshot().view).toEqual({ id: 'approved', title: 'Account preset', content: '', composition: summaries[0]!.rows })
  controller.closeView()
  expect(controller.store.getSnapshot().view).toBeNull()
  await controller.view('foreign')
  expect(controller.store.getSnapshot().view).toBeNull()
  expect(list).toHaveBeenCalledTimes(1)
})

it('retries an actual read failure without preserving the old roster or inventing a fallback', async () => {
  const list = vi.fn(async (): Promise<readonly AgentPresetCompositionSummary[]> => summaries)
  const controller = new ReadonlyAgentPresetSectionController({ isCurrent: () => true, list }, () => 'Unavailable')
  await controller.load()
  list.mockRejectedValueOnce(new Error('actual failure'))
  await controller.load()
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'Unavailable', rows: [], view: null })
  await controller.view('approved')
  expect(controller.store.getSnapshot().view).toBeNull()
  await controller.load()
  expect(controller.store.getSnapshot().rows).toHaveLength(1)
})

it.each(['retire', 'dispose'] as const)('ignores a late read after %s and does not start another read', async (mode) => {
  const held = Promise.withResolvers<readonly AgentPresetCompositionSummary[]>()
  let current = true
  const list = vi.fn(() => held.promise)
  const controller = new ReadonlyAgentPresetSectionController({ isCurrent: () => current, list }, () => 'Unavailable')
  const pending = controller.load()
  expect(controller.load()).toBe(pending)
  const before = controller.store.getSnapshot()
  if (mode === 'dispose') controller.dispose()
  else current = false
  held.resolve(summaries)
  await pending
  expect(controller.store.getSnapshot()).toBe(before)
  await controller.load()
  await controller.view('approved')
  expect(list).toHaveBeenCalledTimes(1)
  expect(controller.store.getSnapshot()).toBe(before)
})
