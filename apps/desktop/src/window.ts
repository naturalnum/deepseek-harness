/** Native desktop window chrome and navigation without application startup effects. */
import { BrowserWindow, Menu, nativeTheme, shell, type Session, type MenuItemConstructorOptions } from 'electron'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
import { DESKTOP_IPC, SCHEME } from './ipc.ts'
import type { DesktopLocale } from './locale.ts'

/** Main-owned configuration for one native desktop window. */
export interface DesktopWindowOptions {
  readonly preload: string
  readonly show?: boolean
  readonly primary?: boolean
  readonly session?: Session
  readonly webviewTag?: boolean
  /** Public, main-owned arguments available to the sandbox preload. */
  readonly additionalArguments?: readonly string[]
  readonly messages: () => DesktopLocale['messages']
  /** Handles document navigation only; callers own redirects, frames and explicit loadURL calls. */
  readonly allowsNavigation?: (destination: URL, current: URL) => boolean
  /** Handles blocked HTTP(S) navigation and new-window links; defaults to the system browser. */
  readonly openExternal?: (url: string) => void
}

function chromeFallbackFill(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'
}

function defaultNavigation(destination: URL, current: URL): boolean {
  return destination.protocol === `${SCHEME}:`
    || (destination.protocol === 'http:' && destination.origin === current.origin)
}

function defaultOpenExternal(url: string): void { void shell.openExternal(url) }

/**
 * Create native window chrome with the official navigation policy unless a caller supplies one.
 * @param options - Main-owned preload, Session, chrome and document navigation settings.
 * @returns The new window, whose caller owns loading, additional navigation guards and teardown.
 */
export function createDesktopWindow(options: DesktopWindowOptions): BrowserWindow {
  const { preload, show = false, primary = false, messages,
    allowsNavigation = defaultNavigation, openExternal = defaultOpenExternal } = options
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show,
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: chromeFallbackFill(),
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.additionalArguments === undefined ? {} : { additionalArguments: [...options.additionalArguments] }),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: options.webviewTag ?? primary,
      devTools: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) openExternal(url)
    return { action: 'deny' }
  })
  if (process.platform === 'darwin') {
    // macOS hides the traffic lights in fullscreen; the page drops its
    // clearance for them off the html[data-fullscreen] flag this feeds.
    const sendFullscreen = (): void => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.windowFullscreen, window.isFullScreen())
    }
    window.on('enter-full-screen', sendFullscreen)
    window.on('leave-full-screen', sendFullscreen)
    // Reloads and navigations re-register the preload listener; resend the
    // current state so a fullscreen reload does not fall back to windowed CSS.
    window.webContents.on('did-finish-load', sendFullscreen)
    // Deminiaturize reattaches the NSVisualEffectView material late
    // (electron/electron#25368), so a transparent window shows the desktop
    // through the sidebar until then. Paint an opaque base while minimized or
    // hidden so the deminiaturize animation and the reattachment gap show a
    // solid fill; restoring flips back, and the null -> 'sidebar' transition
    // forces the material to reattach.
    const applyBackdrop = (): void => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) {
        window.setVibrancy(null)
        window.setBackgroundColor(chromeFallbackFill())
      } else {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      }
    }
    window.on('minimize', applyBackdrop)
    window.on('hide', applyBackdrop)
    window.on('restore', applyBackdrop)
    window.on('show', applyBackdrop)
  }
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const labels = messages()
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        ...(process.platform === 'win32' && item.role !== undefined && item.role in labels
          ? { label: labels[item.role as keyof typeof labels] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (!allowsNavigation(destination, current)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) openExternal(url)
    }
  })
  return window
}
