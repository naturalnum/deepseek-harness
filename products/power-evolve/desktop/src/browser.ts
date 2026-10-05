/** Main-owned browser IPC over the existing authenticated Cloud Session, without exporting credentials. */
import { ipcMain, type BrowserWindow, type Session, type WebContents } from 'electron'
import { DesktopBrowserGuests, DESKTOP_IPC, type DesktopBrowserLeaseId } from '@deepseek-ai/dsh-desktop/assembly'
import { DESKTOP_BROWSER_SCOPE_HOST_PATH, desktopBrowserScopeRequest, desktopBrowserScopeView } from '@power-evolve/contracts/desktop-browser-scope'
import type { CloudDesktopConfig } from './config.ts'
import { allowsCloudHost } from './config.ts'
import { assertCloudSender } from './window-policy.ts'
import { CloudBrowserAuthorization } from './browser-authorization.ts'
import { browserRejectsUrl } from './browser-network.ts'

const MAX_SCOPE_RESPONSE_BYTES = 4096

async function readScope(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel()
    throw new Error('PowerEvolve desktop: browser membership unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_SCOPE_RESPONSE_BYTES) throw new Error('PowerEvolve desktop: oversized browser membership')
      chunks.push(result.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel() }
}

/** One window's authorization and guest lifetime; IPC handlers are installed separately for the application. */
export interface CloudSidebarBrowser {
  readonly authorization: CloudBrowserAuthorization
  /** @returns After authorization retirement and removal of guest tracking listeners. */
  dispose(): Promise<void>
}

/**
 * Bind only the owned native Host window to protected guest creation and account invalidation.
 * @param window - Newly owned Cloud window, before loading its first document.
 * @param browser - The same Electron Session used for product login and Host RPC.
 * @param config - Fixed deployment with explicit browser timing.
 * @param attachInput - Owned native shortcut listener with a single-use disposer.
 * @param deviceOrigin - Main-selected local Device endpoint, if enabled.
 * @returns Main-only lifetime controller; absence of browser configuration is an error.
 */
export function bindCloudSidebarBrowser(window: BrowserWindow, browser: Session, config: CloudDesktopConfig,
  attachInput: (guest: WebContents, lease: DesktopBrowserLeaseId) => () => void, deviceOrigin?: string): CloudSidebarBrowser {
  if (config.sidebarBrowser === undefined) throw new Error('PowerEvolve desktop: browser is not configured')
  const contents = window.webContents
  const guests = new DesktopBrowserGuests(() => config.hostOrigin, { rejectsUrl: browserRejectsUrl(config, deviceOrigin) })
  const disposeGuests = guests.bind(window, attachInput)
  const authorization = new CloudBrowserAuthorization({
    config: config.sidebarBrowser,
    assertDocument: () => {
      if (window.isDestroyed() || contents.isDestroyed() || !allowsCloudHost(config, contents.mainFrame.url)) {
        throw new Error('PowerEvolve desktop: browser document unavailable')
      }
    },
    resources: {
      acquire: key => guests.acquire(contents, key),
      release: lease => guests.release(contents, lease),
      retireWorkspace: key => guests.retireWorkspace(key),
    },
    requestScope: async (request, signal) => {
      const response = await browser.fetch(`${config.hostOrigin}${DESKTOP_BROWSER_SCOPE_HOST_PATH}`, {
        method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        headers: { Origin: config.hostOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ request }),
      })
      return desktopBrowserScopeView.parse(await readScope(response))
    },
    onCleanupFailure: () => { console.error('PowerEvolve desktop: browser storage cleanup incomplete') },
  })
  const invalidate = (): void => {
    void authorization.invalidate().catch(() => { console.error('PowerEvolve desktop: browser storage cleanup incomplete') })
  }
  const cookieChanged = (_event: Electron.Event, cookie: Electron.Cookie): void => {
    if (cookie.name === 'pe_agent' && (cookie.path === '/native/api' || cookie.path === '/api/powerEvolve')) invalidate()
  }
  const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (event.isMainFrame && !event.isSameDocument) invalidate()
  }
  browser.cookies.on('changed', cookieChanged)
  contents.on('did-start-navigation', navigation)
  contents.on('render-process-gone', invalidate)
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposed !== undefined) return disposed
    browser.cookies.off('changed', cookieChanged)
    if (!contents.isDestroyed()) {
      contents.off('did-start-navigation', navigation)
      contents.off('render-process-gone', invalidate)
    }
    const current = authorization.dispose().then(() => disposeGuests())
    disposed = current
    void current.catch(() => { if (disposed === current) disposed = undefined })
    return current
  }
  window.once('closed', () => { void dispose().catch(() => { console.error('PowerEvolve desktop: browser close cleanup incomplete') }) })
  return { authorization, dispose }
}

/**
 * Install fixed main IPC operations, validating the owned frame and every wire argument.
 * @param current - Current owned window and its main-only browser controller.
 * @param config - Trusted deployment, independent of renderer arguments.
 * @returns Handler disposer; guest exit is owned by the returned window controller.
 */
export function installCloudBrowserIpc(current: () => { window: BrowserWindow; browser: CloudSidebarBrowser } | undefined, config: CloudDesktopConfig): () => void {
  ipcMain.handle(DESKTOP_IPC.browserAcquire, async (event, ...args: unknown[]) => {
    const owned = current()
    assertCloudSender(owned?.window, config, event)
    if (owned === undefined || args.length !== 2 || typeof args[0] !== 'string' || args[0].length < 1 || args[0].length > 4096) {
      throw new Error('PowerEvolve desktop: invalid browser request')
    }
    const request = desktopBrowserScopeRequest.parse({ sessionId: args[1] })
    try { return await owned.browser.authorization.acquire(request) }
    catch (_authorizationFailed) { throw new Error('PowerEvolve desktop: browser authorization unavailable') }
  })
  ipcMain.handle(DESKTOP_IPC.browserRelease, async (event, ...args: unknown[]) => {
    const owned = current()
    assertCloudSender(owned?.window, config, event)
    if (owned === undefined || args.length !== 1 || typeof args[0] !== 'string' || args[0].length < 1 || args[0].length > 128) {
      throw new Error('PowerEvolve desktop: invalid browser release')
    }
    await owned.browser.authorization.release(args[0])
  })
  return () => { ipcMain.removeHandler(DESKTOP_IPC.browserAcquire); ipcMain.removeHandler(DESKTOP_IPC.browserRelease) }
}
