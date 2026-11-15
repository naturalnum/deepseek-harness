// @vitest-environment jsdom
/** Actual Native clock and original SlotRenderer; Cloud owns only mark and copy. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSlotRenderer } from '../../../client/ui-renderer/src/client/scoped-slots.tsx'
import { RunningStatus } from '../../../client/ui-chat/src/client/chat/RunningStatus.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from '../../../client/ui-chat/src/client/locale.ts'
import { installCloudBrand } from '../src/client/branding.tsx'
import { CLOUD_RUNNING_NAMESPACE, cloudRunningDictionaries } from '../src/client/branding-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'pe-cloud-test.running-host': { kind: 'single'; scope: 'root' } }
}
function PersistentRoot({ renderSlot }: PropsRenderSlots<'pe-cloud-test.running-host'>) {
  return renderSlot('pe-cloud-test.running-host', {})
}

afterEach(() => { cleanup(); vi.useRealTimers() })
interface ClockState { readonly startTime: number | undefined; readonly paused: boolean; readonly holding: boolean }
interface ClockFace { readonly hooks: { clock: SnapshotStore<ClockState> } }
function RunningHost({ useClock, renderSlotChain, t }:
  InjectFace<ClockFace> & PropsRenderSlots<'conversation.chat.running.mark' | 'conversation.chat.running.copy'> & PropsLocale<'chat'>) {
  return <RunningStatus {...useClock(value => value)} t={t} renderSlotChain={renderSlotChain} />
}
async function fixture(install = true) {
  vi.useFakeTimers(); vi.setSystemTime(5_000)
  const ctx = new Context(), slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale); slots.installLocale(locale); slots.install(createSlotRenderer())
  for (const id of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) ctx.effect(() => locale.addLanguage({ id, label: id, fallback: 'en' }))
  ctx.effect(() => locale.register('chat', { en, zh, ja, es, fr, de, ru, pt })); locale.setLocale('zh')
  const absent = createSnapshotStore<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  slots.installScope('session', { current: absent, bindingSource: () => absent, renderArea: (_binding, { children }) => <>{children}</> })
  const clock = createSnapshotStore<ClockState>({ startTime: undefined, paused: false, holding: false })
  const removeShell = slots.register({ name: 'root', children: {
    'pe-cloud-test.running-host': { kind: 'single', scope: 'root' },
  } }, PersistentRoot)
  const declare = () => slots.register({ name: 'pe-cloud-test.running-host', locale: 'chat', inject: () => ({ hooks: { clock } }), children: {
    'conversation.chat.running.mark': { kind: 'chain', scope: 'root', inline: true },
    'conversation.chat.running.copy': { kind: 'chain', scope: 'root', inline: true },
  } }, RunningHost)
  let removeRoot = declare()
  const owners: Array<() => Promise<void>> = []
  const mount = async () => {
    const owner = ctx.plugin((scope) => { installCloudBrand(scope) })
    owners.push(() => owner.dispose()); await owner.await(); return owner
  }
  const owner = install ? await mount() : undefined
  const view = render(slots.renderSlot('root', {}))
  onTestFinished(async () => {
    cleanup()
    for (const dispose of [...owners].reverse()) await dispose()
    removeRoot(); removeShell(); await ctx.fiber.dispose()
  })
  return { slots, locale, clock, view, owner, mount,
    remove: () => { removeRoot() }, declare: () => { removeRoot = declare() } }
}

it('keeps Native defaults, fills all original running copy, and restores defaults when Cloud withdraws', async () => {
  const f = await fixture(false), indicator = f.view.container.querySelector('[data-chat-running]')
  expect(screen.getByRole('status').textContent).toBe('深度求索中')
  expect(f.view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
  expect(vi.getTimerCount()).toBe(0)
  let owner: Awaited<ReturnType<typeof f.mount>> | undefined
  await act(async () => { owner = await f.mount() })
  for (const [id, copy] of Object.entries(cloudRunningDictionaries)) {
    act(() => { f.locale.setLocale(id) })
    expect(screen.getByRole('status').textContent).toBe(copy.running)
    expect(f.view.container.querySelector('[data-chat-running] > :last-child')?.textContent).toBe(copy.running)
    expect(f.view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
  }
  for (const anchor of f.view.container.querySelectorAll<HTMLElement>('[data-slot^="conversation.chat.running."]')) {
    expect(anchor.tagName).toBe('SPAN'); expect(anchor.style.display).toBe('contents')
  }
  act(() => { f.locale.setLocale('zh') })
  expect(f.locale.bind('chat')('chat.deepDiving')).toBe('深度求索中')
  expect(f.view.container.querySelector('[data-chat-running]')).toBe(indicator)
  await act(async () => { await owner!.dispose() })
  expect(screen.getByRole('status').textContent).toBe('深度求索中')
  expect(f.view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
  expect(f.locale.bind(CLOUD_RUNNING_NAMESPACE)('running')).toBe('running')
  expect(f.view.container.querySelector('[data-chat-running]')).toBe(indicator)
})

it('keeps Native elapsed time, disconnected pause, holding and one static accessible announcement', async () => {
  const f = await fixture()
  act(() => { f.clock.set({ startTime: 1_000, paused: false, holding: false }) })
  const content = f.view.container.querySelector('[data-chat-running] > :last-child'), status = screen.getByRole('status')
  expect(content?.textContent).toBe('处理中，用时 4秒…')
  expect(vi.getTimerCount()).toBe(1)
  act(() => { vi.advanceTimersByTime(2_000) })
  expect(content?.textContent).toBe('处理中，用时 6秒…')
  expect(screen.getByRole('status')).toBe(status); expect(status.textContent).toBe('处理中')
  act(() => { f.clock.set({ ...f.clock.getSnapshot(), paused: true }) })
  act(() => { vi.advanceTimersByTime(5_000) })
  expect(vi.getTimerCount()).toBe(0); expect(content?.textContent).toBe('处理中，用时 6秒…')
  act(() => { f.clock.set({ ...f.clock.getSnapshot(), paused: false }) })
  expect(content?.textContent).toBe('处理中，用时 11秒…')
  act(() => { f.clock.set({ ...f.clock.getSnapshot(), holding: true }) })
  expect(screen.queryByRole('status')).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  expect(f.view.container.querySelector('[data-chat-running]')?.getAttribute('aria-hidden')).toBe('true')
  expect(f.view.container.querySelector('[data-shimmer="true"]')).toBeNull()
})

it('withdraws and reconnects the Cloud contribution with the original Native declaration', async () => {
  const f = await fixture()
  expect(screen.getByRole('status').textContent).toBe('处理中')
  await act(async () => { f.remove() })
  expect(f.slots.entries('conversation.chat.running.mark')).toHaveLength(0)
  expect(f.slots.entries('conversation.chat.running.copy')).toHaveLength(0)
  expect(f.view.container.querySelector('[data-chat-running]')).toBeNull()
  await act(async () => { f.declare() })
  expect(f.slots.entries('conversation.chat.running.mark')).toHaveLength(1)
  expect(f.slots.entries('conversation.chat.running.copy')).toHaveLength(1)
  expect(screen.getByRole('status').textContent).toBe('处理中')
  expect(f.view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
})
