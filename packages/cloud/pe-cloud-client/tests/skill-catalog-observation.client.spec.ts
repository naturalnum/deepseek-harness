// @vitest-environment jsdom
/** Real layout and skill-source observation; backend answers are explicit fixtures. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { observeSkillCatalog } from '../src/client/management/skills/catalog-observation.ts'
import { managedFixture } from './fixtures/managed-skills.client.ts'

const skills = brandString<MainPanelId>('skills')
async function fixture(selected = false) {
  const f = managedFixture(), ctx = new Context(), failed = vi.fn()
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: selected ? skills : null })
  ctx.provide('layout', { panelInfo, selectPanel: (id) => { panelInfo.set({ activePanelId: id }) },
    beginNavigation: () => new AbortController().signal, toggleSidebar: () => {}, openRightbar: () => {}, closeRightbar: () => {} })
  let withdraw = (): void => {}
  await ctx.plugin((owner) => { withdraw = observeSkillCatalog(owner, f.source, skills, failed) }).await()
  onTestFinished(async () => { withdraw(); f.withdraw(); await ctx.fiber.dispose() })
  return { ...f, ctx, panelInfo, failed, stop: () => { withdraw() } }
}

it('reads installations on selection and reopens them without rereading on unrelated source notifications', async () => {
  const f = await fixture()
  expect(f.installed).not.toHaveBeenCalled()
  f.panelInfo.set({ activePanelId: skills })
  await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
  expect(f.source.getSnapshot().items.map(item => item.name)).toEqual(['first', 'second'])
  expect(f.installed).toHaveBeenCalledOnce()
  f.panelInfo.set({ activePanelId: skills })
  f.source.set({ ...f.source.getSnapshot() })
  expect(f.installed).toHaveBeenCalledOnce()
  f.panelInfo.set({ activePanelId: null }); f.panelInfo.set({ activePanelId: skills })
  await vi.waitFor(() => { expect(f.installed).toHaveBeenCalledTimes(2) })
  expect(f.details).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled()
})

it('reads an already selected page once its original managed source attaches', async () => {
  const f = await fixture()
  const original = f.source.getSnapshot()
  f.source.set({ phase: 'unavailable', items: [] })
  f.panelInfo.set({ activePanelId: skills })
  expect(f.installed).not.toHaveBeenCalled()
  f.source.set(original)
  await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
  expect(f.installed).toHaveBeenCalledOnce()
})

it('reports a failed read once and leaves retry to a new selection or the explicit Refresh action', async () => {
  const f = await fixture()
  f.installed.mockRejectedValueOnce(new Error('catalog unavailable'))
  f.panelInfo.set({ activePanelId: skills })
  await vi.waitFor(() => { expect(f.failed).toHaveBeenCalledOnce() })
  expect(f.source.getSnapshot().phase).toBe('unavailable')
  f.panelInfo.set({ activePanelId: skills }); f.source.set({ ...f.source.getSnapshot() })
  expect(f.installed).toHaveBeenCalledOnce()
  f.panelInfo.set({ activePanelId: null }); f.panelInfo.set({ activePanelId: skills })
  await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready') })
  expect(f.installed).toHaveBeenCalledTimes(2)
})

it('withdraws both observations and cancels a pending read without adopting its late answer', async () => {
  const f = await fixture(), held = Promise.withResolvers<Awaited<ReturnType<typeof f.installed>>>()
  f.installed.mockReturnValueOnce(held.promise)
  f.panelInfo.set({ activePanelId: skills })
  expect(f.source.getSnapshot().phase).toBe('loading')
  const observer = f.installed.mock.calls[0]?.[0]
  f.stop(); expect(observer?.aborted).toBe(true)
  held.resolve({ items: [], limits: f.editor().limits ?? { maxFiles: 1, maxEntries: 2, maxDirectories: 1,
    maxPathDepth: 1, maxPathBytes: 128, maxFileBytes: 1024, maxTotalBytes: 1024, maxArchiveBytes: 1024 } })
  await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('unavailable') })
  f.panelInfo.set({ activePanelId: null }); f.panelInfo.set({ activePanelId: skills })
  expect(f.installed).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled()
})
