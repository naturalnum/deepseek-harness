// @vitest-environment jsdom
import { createSnapshotStore, type ClientPersistence } from '@deepseek-ai/dsh-client-store'
/**
 * Host home reaches the browsing region through the assembled renderer, which
 * memoizes a root entry's inject result for the whole registration — so a home
 * read once at first render would freeze there. This spec drives the real slot
 * renderer (not a direct `entry.inject()` call, which bypasses that memo) and
 * pins that a home learned after first render reaches the rendered rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceViewStoreHandle } from '../src/client/contract/slots.ts'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

/** The assembled sidebar over one Workspace inside the POSIX home the Host reports. */
async function bench(persistence?: ClientPersistence) {
  const runtime = await SlotTestRuntime.create()
  if (persistence !== undefined) runtime.ctx.provide('clientPersistence', persistence)
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('uiConversation', {})
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  const directoryPicker = {}
  const { remote } = runtime
  remote.provideNamespaces({ directoryPicker })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'w1' as WorkspaceId, title: 'Project', path: '/home/u/Documents/project',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.root.declare(
    { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, remote }
}

/** Open the Workspace row's hover card, which is where the home abbreviation shows. */
function openHoverCard(): void {
  const row = screen.getByRole('treeitem').parentElement as HTMLElement
  fireEvent.pointerEnter(row)
  act(() => { vi.advanceTimersByTime(800) })
}

/** Close it again, so the next hover rebuilds the card from current props. */
function closeHoverCard(): void {
  const row = screen.getByRole('treeitem').parentElement as HTMLElement
  fireEvent.pointerLeave(row)
  act(() => { vi.advanceTimersByTime(800) })
}

function viewingStore(runtime: SlotTestRuntime) {
  const handle = runtime.slots.entries('sidebar.workspaces')[0]?.store as WorkspaceViewStoreHandle | undefined
  if (handle === undefined) throw new Error('Actual Workspace browser viewing store absent')
  return { handle, instance: handle.create() }
}

describe('Workspace viewing persistence through apply', () => {
  const key = 'dsh.workspace.view.v5'
  const raw = JSON.stringify({ groupBy: 'workspace-tree', orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {} })

  it('captures each page port before reading and keeps retired view writes away from the other page and raw cache', async () => {
    localStorage.setItem(key, raw)
    const cache = () => {
      const data = new Map<string, string>()
      let active = true
      const current = () => { if (!active) throw new Error('retired page port') }
      const port: ClientPersistence = {
        getItem: (name) => { current(); return data.get(name) ?? null },
        setItem: (name, value) => { current(); data.set(name, value) },
        removeItem: (name) => { current(); data.delete(name) },
        keys: () => { current(); return [...data.keys()] },
      }
      return { data, port, revoke: () => { active = false } }
    }
    const aCache = cache(), bCache = cache()
    const a = await bench(aCache.port), b = await bench(bCache.port)
    const aView = viewingStore(a.runtime), bView = viewingStore(b.runtime)
    expect(aView.instance.getSnapshot().groupBy).toBe('workspace')
    expect(bView.instance.getSnapshot().groupBy).toBe('workspace')
    a.runtime.renderRoot()
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(JSON.parse(aCache.data.get(key)!)).toMatchObject({ groupBy: 'flat' })
    expect(bView.instance.getSnapshot().groupBy).toBe('workspace')
    expect(localStorage.getItem(key)).toBe(raw)
    a.runtime.ctx.set('clientPersistence', bCache.port)
    expect(aView.handle.create(undefined, bCache.port)).toBe(aView.instance)
    act(() => { aView.instance.actions.setGroupBy('workspace-tree') })
    expect(JSON.parse(aCache.data.get(key)!)).toMatchObject({ groupBy: 'workspace-tree' })
    const aBefore = [...aCache.data], bBefore = [...bCache.data]
    aCache.revoke()
    expect(() => { act(() => { aView.instance.actions.setGroupBy('flat') }) }).toThrow('retired page port')
    expect(() => { aView.instance.clearPersisted() }).toThrow('retired page port')
    expect([...aCache.data]).toEqual(aBefore)
    expect([...bCache.data]).toEqual(bBefore)
    expect(localStorage.getItem(key)).toBe(raw)
  })

  it('retains ordinary browser restoration and writes when no page port is provided', async () => {
    localStorage.setItem(key, raw)
    const { runtime } = await bench(), { instance } = viewingStore(runtime)
    expect(instance.getSnapshot().groupBy).toBe('workspace-tree')
    instance.actions.setGroupBy('flat')
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ groupBy: 'flat' })
  })
})

describe('Host home in the assembled browsing region', () => {
  it('abbreviates the path once a home learned after first render reaches the rows', async () => {
    // First render precedes the ready frame: the shell mounts while the carrier
    // is still handshaking, so the Host reports no home yet.
    const { runtime, remote } = await bench()
    remote.$host = { home: undefined, isLoopback: true }
    runtime.renderRoot()
    vi.useFakeTimers()
    try {
      openHoverCard()
      expect(screen.getByText('/home/u/Documents/project')).toBeTruthy()
      closeHoverCard()

      // The ready frame lands: `$host.home` now answers, and the generation is
      // announced through the reset every consumer already listens to.
      remote.$host = { home: '/home/u', isLoopback: true }
      act(() => { runtime.ctx.emit('connection/reset') })
      openHoverCard()

      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
