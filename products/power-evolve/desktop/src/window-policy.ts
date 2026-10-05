/** Navigation and IPC authorization for the owned Cloud main window. */
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { allowsCloudHost, allowsCloudNavigation, nativeCloudDestination, type CloudDesktopConfig } from './config.ts'

/**
 * Reject native requests from Platform, subframes, foreign windows and stale navigations.
 * @param window - Current owned Cloud window, absent while closed.
 * @param config - Fixed trusted deployment.
 * @param event - Actual Electron IPC sender.
 */
export function assertCloudSender(window: BrowserWindow | undefined, config: CloudDesktopConfig, event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || !allowsCloudHost(config, event.senderFrame.url)) {
    throw new Error('PowerEvolve desktop: rejected native request')
  }
}

/**
 * Load a validated main document; Electron loadURL does not emit will-navigate.
 * @param window - Owned application window.
 * @param config - Fixed deployment origins.
 * @param value - Requested navigation.
 * @returns Completion of the owned document load.
 */
export async function loadCloudDocument(window: BrowserWindow, config: CloudDesktopConfig, value: string): Promise<void> {
  if (!allowsCloudNavigation(config, value)) throw new Error('PowerEvolve desktop: rejected navigation')
  await window.loadURL(nativeCloudDestination(config, value))
}

/**
 * Guard renderer navigations and HTTP redirects; popup creation remains disabled.
 * @param window - Owned Cloud main window.
 * @param config - Fixed deployment origins.
 * @param ownedBrowserEnabled - Main installed a separate lease-enforcing guest controller.
 */
export function installCloudNavigation(window: BrowserWindow, config: CloudDesktopConfig, ownedBrowserEnabled = false): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowsCloudHost(config, window.webContents.mainFrame.url) && allowsCloudNavigation(config, url)
      && new URL(url).origin === config.platformOrigin) {
      void loadCloudDocument(window, config, url).catch(() => { /* A failed fixed Platform load grants no native capability. */ })
    }
    return { action: 'deny' }
  })
  if (!ownedBrowserEnabled) window.webContents.on('will-attach-webview', event => { event.preventDefault() })
  const guard = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams | Electron.WebContentsWillRedirectEventParams>): void => {
    if (event.isMainFrame) {
      if (!allowsCloudNavigation(config, event.url)) { event.preventDefault(); return }
      const native = nativeCloudDestination(config, event.url)
      if (native !== event.url) {
        event.preventDefault()
        void loadCloudDocument(window, config, native).catch(() => { /* The window retains its last document when the Host is unavailable. */ })
      }
      return
    }
    // Preview frames may use the configured Host; none receive the top-frame preload bridge.
    try {
      const url = new URL(event.url)
      if (url.origin !== config.hostOrigin || url.username !== '' || url.password !== '') event.preventDefault()
    } catch (_invalidUrl) { event.preventDefault() }
  }
  window.webContents.on('will-frame-navigate', guard)
  window.webContents.on('will-redirect', guard)
}
