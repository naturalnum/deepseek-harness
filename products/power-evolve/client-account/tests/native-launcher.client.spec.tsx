import { jsonRecord, requestUrl } from './fetch-fixture.ts'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// @vitest-environment jsdom
/** Real Cordis and SlotRegistry; only HTTP and Connection transport are substituted. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../../../../packages/client/ui-renderer/src/client/registry.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { AccountMenu, type AccountMenuProps } from '../src/client/AccountMenu.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

function isLauncherPorts(value: unknown): value is Pick<AccountMenuProps, 'loadNavigation' | 'navigate'> {
  if (typeof value !== 'object' || value === null) return false
  const ports = jsonRecord(value)
  return typeof ports.loadNavigation === 'function' && typeof ports.navigate === 'function'
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('shadows the official default launcher and restores it on product disposal', async () => {
  const ctx = new Context()
  const listeners = new Set<() => void>()
  const requests: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) requests.push(init.signal)
    return requestUrl(input) === '/config' ? Response.json({ loginUrl: 'https://platform.test/login' })
      : Response.json({ userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
        settings: { model: 'one', maxTokens: 512, revision: 1 } })
  }))
  const labels = vi.fn(() => () => undefined)
  ctx.reflect.provide('locale', { register: labels })
  ctx.reflect.provide('connection', { state: { getSnapshot: () => 'connected', subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }, stop: vi.fn() })
  await ctx.plugin(SlotRegistry)
  const fallback = () => null
  try {
    ctx.slots.register({ name: 'root', children: { 'settings.launcher': { kind: 'single', scope: 'root' } } },
      ({ renderSlot }: PropsRenderSlots<'settings.launcher'>) => renderSlot('settings.launcher', {
        wide: true, settingsOpen: false, openSettings: () => undefined, openOnboarding: () => undefined,
      }))
    ctx.slots.register({ name: 'settings.launcher' }, fallback)
    expect(() => ctx.slots.register({ name: 'settings.launcher' }, fallback)).toThrow(/priority 0/u)
    const product = ctx.plugin({ name: 'employee2-account-seat', inject, apply })
    await product
    expect(ctx.slots.entriesOfSlot('settings.launcher')[0]?.component).toBe(AccountMenu)
    expect(ctx.slots.entries('settings.launcher')).toHaveLength(2)
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
    expect(listeners.size).toBe(1)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await product.dispose()
    expect(ctx.slots.entriesOfSlot('settings.launcher')[0]?.component).toBe(fallback)
    expect(listeners.size).toBe(0)
    expect(requests.some(signal => signal.aborted)).toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it.each(['identity-change', 'expired'] as const)('connects native browser navigation to %s policy', async (scenario) => {
  const browser = Object.assign(new EventTarget(), { location: { assign: vi.fn(), replace: vi.fn(), reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  vi.stubGlobal('window', browser); vi.stubGlobal('document', doc)
  const userId = '54f0f232-a068-4223-96e8-d0cff78d0f1c'
  let changed = false, reads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const route = requestUrl(input)
    if (route === '/config') return Response.json({ loginUrl: 'https://platform.test/login' })
    if (route.endsWith('accountCapabilities')) return Response.json({ userId, username: 'alice', displayName: 'Alice',
      role: 'USER', canManage: false, accountUrl: 'https://platform.test/account' })
    reads++
    if (changed && scenario === 'expired') return new Response(null, { status: 401 })
    return Response.json({ userId: changed ? 'c432cd3b-435c-42d5-ad50-e45c43fc7414' : userId,
      username: changed ? 'bob' : 'alice', settings: { model: 'one', maxTokens: 512, revision: 1 } })
  }))
  const ctx = new Context()
  ctx.reflect.provide('locale', { register: () => () => undefined })
  const stop = vi.fn()
  ctx.reflect.provide('connection', { state: { getSnapshot: () => 'connected', subscribe: () => () => undefined }, stop })
  await ctx.plugin(SlotRegistry)
  try {
    ctx.slots.register({ name: 'root', children: { 'settings.launcher': { kind: 'single', scope: 'root' } } },
      ({ renderSlot }: PropsRenderSlots<'settings.launcher'>) => renderSlot('settings.launcher', {
        wide: true, settingsOpen: false, openSettings: () => undefined, openOnboarding: () => undefined,
      }))
    const product = ctx.plugin({ name: 'employee2-account-browser', inject, apply }); await product
    const ports = ctx.slots.entries('settings.launcher')[0]?.inject?.()
    if (!isLauncherPorts(ports)) throw new Error('Missing launcher ports')
    expect(await ports.loadNavigation(new AbortController().signal)).toMatchObject({ role: 'USER', canManage: false })
    ports.navigate('https://platform.test/account#password')
    expect(browser.location.assign).toHaveBeenCalledWith('https://platform.test/account#password')
    doc.dispatchEvent(new Event('visibilitychange')); expect(reads).toBe(1)
    changed = true; doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
    if (scenario === 'identity-change') await vi.waitFor(() =>{  expect(browser.location.reload).toHaveBeenCalledOnce() })
    else await vi.waitFor(() =>{  expect(browser.location.replace).toHaveBeenCalledWith('https://platform.test/login') })
    expect(stop).toHaveBeenCalledOnce()
    await product.dispose()
    const prior = reads
    browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('online')); doc.dispatchEvent(new Event('visibilitychange'))
    expect(reads).toBe(prior)
  } finally { await ctx.fiber.dispose() }
})
