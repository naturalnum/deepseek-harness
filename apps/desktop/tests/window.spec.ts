/** Native window behavior uses substituted Electron objects without starting an application. */
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions, Session } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { en, zh } from '../src/locale.ts'
import type { DesktopLocale } from '../src/locale.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      getURL: vi.fn(() => 'dsh-app://app/'), setWindowOpenHandler: vi.fn(), send: vi.fn(),
    })
    destroyed = false
    fullscreen = false
    minimized = false
    visible = true
    readonly setVibrancy = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: BrowserWindowConstructorOptions) { super() }
    isDestroyed() { return this.destroyed }
    isFullScreen() { return this.fullscreen }
    isMinimized() { return this.minimized }
    isVisible() { return this.visible }
  }
  return { Window, nativeTheme: { shouldUseDarkColors: false }, openExternal: vi.fn(),
    popup: vi.fn(), buildFromTemplate: vi.fn() }
})
vi.mock('electron', () => ({ BrowserWindow: electron.Window, nativeTheme: electron.nativeTheme,
  shell: { openExternal: electron.openExternal }, Menu: { buildFromTemplate: electron.buildFromTemplate } }))
const { createDesktopWindow } = await import('../src/window.ts')
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); electron.nativeTheme.shouldUseDarkColors = false })
function fixture(platform: NodeJS.Platform, options: Parameters<typeof createDesktopWindow>[0] = { preload: '/qa/preload.cjs', messages: () => en }) {
  vi.stubGlobal('process', { ...process, platform })
  electron.buildFromTemplate.mockReturnValue({ popup: electron.popup })
  const window = createDesktopWindow(options)
  if (!(window instanceof electron.Window)) throw new Error('window fixture was not constructed')
  return window
}

it('retains the default chrome and isolation settings on each desktop platform', () => {
  const linux = fixture('linux')
  expect(linux.options).toEqual({ width: 1280, height: 820, minWidth: 520, minHeight: 600, show: false,
    webPreferences: { preload: '/qa/preload.cjs', nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, webviewTag: false, devTools: true } })
  const mac = fixture('darwin', { preload: '/qa/mac.cjs', primary: true, messages: () => en })
  expect(mac.options).toMatchObject({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000', webPreferences: { webviewTag: true } })
  electron.nativeTheme.shouldUseDarkColors = true
  const windows = fixture('win32', { preload: '/qa/windows.cjs', primary: true, messages: () => en })
  expect(windows.options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: {
    height: WINDOWS_TITLEBAR_HEIGHT, color: '#1b1b1c', symbolColor: '#f9fafb' } })
  expect(fixture('win32').options).not.toHaveProperty('titleBarStyle')
})

it('accepts an explicit Session and disables webviews independently of primary chrome', () => {
  const session = {} as Session
  const additionalArguments = ['--fixture-origin=http://127.0.0.1:19904']
  const window = fixture('darwin', { preload: '/qa/cloud.cjs', show: true, primary: true,
    session, webviewTag: false, additionalArguments, messages: () => en })
  expect(window.options.show).toBe(true)
  expect(window.options.webPreferences?.session).toBe(session)
  expect(window.options.webPreferences?.webviewTag).toBe(false)
  expect(window.options.webPreferences?.additionalArguments).toEqual(additionalArguments)
  expect(window.options.webPreferences?.additionalArguments).not.toBe(additionalArguments)
  additionalArguments.push('--changed')
  expect(window.options.webPreferences?.additionalArguments).toHaveLength(1)
})

it('retains official navigation and external-link behavior by default', () => {
  const window = fixture('linux'), preventDefault = vi.fn()
  for (const destination of ['dsh-app://app/settings', 'dsh-app://shell/']) {
    window.webContents.emit('will-navigate', { preventDefault }, destination)
  }
  expect(preventDefault).not.toHaveBeenCalled()
  window.webContents.getURL.mockReturnValue('http://127.0.0.1:19387/')
  window.webContents.emit('will-navigate', { preventDefault }, 'http://127.0.0.1:19387/session')
  expect(preventDefault).not.toHaveBeenCalled()
  for (const destination of ['https://example.com/', 'http://127.0.0.1:19388/', 'file:///tmp/test']) {
    window.webContents.emit('will-navigate', { preventDefault }, destination)
  }
  expect(preventDefault).toHaveBeenCalledTimes(3)
  expect(electron.openExternal.mock.calls).toEqual([['https://example.com/'], ['http://127.0.0.1:19388/']])
  const open = window.webContents.setWindowOpenHandler.mock.calls[0]![0]
  expect(open({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
  expect(open({ url: 'file:///tmp/test' })).toEqual({ action: 'deny' })
  expect(electron.openExternal).toHaveBeenCalledTimes(3)
})

it('passes destination and current URL to an exact remote navigation policy', () => {
  const host = 'http://127.0.0.1:19904', platform = 'http://127.0.0.1:19906'
  const permits = vi.fn((destination: URL, _current: URL) => [host, platform].includes(destination.origin))
  const window = fixture('linux', { preload: '/qa/cloud.cjs', messages: () => en, allowsNavigation: permits })
  window.webContents.getURL.mockReturnValue(`${host}/native/`)
  const preventDefault = vi.fn()
  for (const destination of [`${host}/native/session`, `${platform}/login`]) {
    window.webContents.emit('will-navigate', { preventDefault }, destination)
  }
  expect(preventDefault).not.toHaveBeenCalled()
  expect(permits).toHaveBeenLastCalledWith(new URL(`${platform}/login`), new URL(`${host}/native/`))
  for (const destination of ['http://127.0.0.1:19905/native/', 'http://127.0.0.1.example/native/',
    'https://example.com/', 'dsh-app://app/', 'data:text/plain,test']) {
    window.webContents.emit('will-navigate', { preventDefault }, destination)
  }
  expect(preventDefault).toHaveBeenCalledTimes(5)
})

it('delegates external opening so callers can suppress automatic browser launches', () => {
  const openExternal = vi.fn()
  const window = fixture('linux', { preload: '/qa/cloud.cjs', messages: () => en,
    allowsNavigation: () => false, openExternal })
  const preventDefault = vi.fn()
  window.webContents.emit('will-navigate', { preventDefault }, 'https://outside.example/')
  const open = window.webContents.setWindowOpenHandler.mock.calls[0]![0]
  expect(open({ url: 'http://outside.example/' })).toEqual({ action: 'deny' })
  expect(openExternal.mock.calls).toEqual([['https://outside.example/'], ['http://outside.example/']])
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(electron.openExternal).not.toHaveBeenCalled()
})

it('preserves fullscreen reload publication, Mac backdrop changes and localized edit menus', () => {
  const mac = fixture('darwin')
  mac.fullscreen = true
  mac.emit('enter-full-screen')
  mac.webContents.emit('did-finish-load')
  expect(mac.webContents.send.mock.calls).toEqual([
    [DESKTOP_IPC.windowFullscreen, true], [DESKTOP_IPC.windowFullscreen, true],
  ])
  mac.minimized = true
  mac.emit('minimize')
  expect(mac.setVibrancy).toHaveBeenLastCalledWith(null)
  expect(mac.setBackgroundColor).toHaveBeenLastCalledWith('#f9fafb')
  mac.minimized = false
  mac.emit('restore')
  expect(mac.setVibrancy).toHaveBeenLastCalledWith('sidebar')
  expect(mac.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
  let messages: DesktopLocale['messages'] = en
  const windows = fixture('win32', { preload: '/qa/preload.cjs', messages: () => messages })
  const context = { isEditable: false, selectionText: 'selected', editFlags: { canCopy: true } }
  windows.webContents.emit('context-menu', {}, context)
  expect(electron.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: en.copy, accelerator: '' }])
  messages = zh
  windows.webContents.emit('context-menu', {}, context)
  expect(electron.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: zh.copy, accelerator: '' }])
  expect(electron.popup).toHaveBeenLastCalledWith({ window: windows })
})
