/** Browser preload assembly forwards only lease operations and an optional source Session. */
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn() } }))
vi.mock('electron', () => electron)
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); vi.restoreAllMocks() })

it('exports the browser factory without installing listeners and preserves one-argument direct acquire calls', async () => {
  const { createDesktopBrowserBridge } = await import('../src/preload-assembly.ts')
  expect(electron.ipcRenderer.on).not.toHaveBeenCalled()
  expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  const bridge = createDesktopBrowserBridge()
  expect(Object.keys(bridge).sort()).toEqual(['acquire', 'onOpenRequested', 'release'])
  await bridge.acquire('cwd:/workspace')
  await bridge.acquire('cwd:/workspace', undefined)
  await bridge.acquire('cwd:/workspace', 'first')
  await bridge.acquire('cwd:/workspace', 'second')
  await bridge.release('lease' as DesktopBrowserLeaseId)
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.browserAcquire, 'cwd:/workspace'],
    [DESKTOP_IPC.browserAcquire, 'cwd:/workspace'],
    [DESKTOP_IPC.browserAcquire, 'cwd:/workspace', 'first'],
    [DESKTOP_IPC.browserAcquire, 'cwd:/workspace', 'second'],
    [DESKTOP_IPC.browserRelease, 'lease'],
  ])
})

it('dispatches only valid requests for a subscribed lease and contains one failing listener', async () => {
  const { createDesktopBrowserBridge } = await import('../src/preload-browser.ts')
  const bridge = createDesktopBrowserBridge()
  const lease = 'lease' as DesktopBrowserLeaseId
  const bad = vi.fn(() => { throw new Error('listener') })
  const good = vi.fn()
  const stopBad = bridge.onOpenRequested(lease, bad)
  const stopGood = bridge.onOpenRequested(lease, good)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const handler = electron.ipcRenderer.on.mock.calls[0]![1] as (event: unknown, request: unknown) => void
  for (const request of [null, {}, { lease: 1, url: 'https://example.test' }, { lease, url: 1 },
    { lease: 'other', url: 'https://example.test' }]) handler({}, request)
  expect(good).not.toHaveBeenCalled()
  handler({}, { lease, url: 'https://example.test' })
  expect(bad).toHaveBeenCalledOnce()
  expect(error).toHaveBeenCalledOnce()
  expect(good).toHaveBeenCalledExactlyOnceWith('https://example.test')
  stopBad()
  stopGood()
  handler({}, { lease, url: 'https://example.test/late' })
  expect(good).toHaveBeenCalledOnce()
})
