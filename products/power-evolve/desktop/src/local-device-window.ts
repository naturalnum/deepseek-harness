/** Owned local authorization window, separate from the Cloud browser session and its IPC. */
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { createDesktopWindow, chooseDesktopDirectory, type DesktopLocale } from '@deepseek-ai/dsh-desktop/assembly'
import type { DeviceProcess } from './device-process.ts'
import { DEVICE_DESKTOP_IPC } from './device-ipc.ts'

/** Local window inputs owned by the Electron main process. */
export interface LocalDeviceWindowOptions {
  readonly origin: string
  readonly getDevice: () => DeviceProcess | undefined
  readonly messages: () => DesktopLocale['messages']
}

/** Keep a local dialog and its selected paths outside the Cloud renderer. */
export class LocalDeviceWindow {
  private window: BrowserWindow | undefined
  private windowDevice: DeviceProcess | undefined
  private opening: Promise<void> | undefined
  private closing = false
  private readonly pickers = new Set<Promise<string | null>>()
  private readonly browser = session.fromPartition('power-evolve-local-device-' + randomUUID())
  constructor(private readonly options: LocalDeviceWindowOptions) {
    this.browser.setPermissionCheckHandler(() => false)
    this.browser.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ipcMain.handle(DEVICE_DESKTOP_IPC.choose, async (event, ...args: unknown[]) => {
      const window = this.assertSender(event)
      if (args.length !== 0) throw new Error('PowerEvolve desktop: invalid directory request')
      const device = this.options.getDevice()
      if (device === undefined) throw new Error('PowerEvolve desktop: local device unavailable')
      const pending = chooseDesktopDirectory(window)
      this.pickers.add(pending)
      try {
        const path = await pending
        if (this.closing || this.options.getDevice() !== device || this.window !== window || window.isDestroyed()) return null
        this.assertSender(event)
        return path
      } finally { this.pickers.delete(pending) }
    })
  }

  /**
   * Show only the current owned Device after its parent validates readiness.
   * @returns Completion of the fixed local document load.
   */
  open(): Promise<void> {
    const device = this.options.getDevice()
    if (this.closing || device === undefined) return Promise.reject(new Error('PowerEvolve desktop: local device unavailable'))
    if (this.opening !== undefined) return this.opening
    if (this.window !== undefined && !this.window.isDestroyed() && this.windowDevice === device) {
      this.window.show(); this.window.focus(); return Promise.resolve()
    }
    this.window?.destroy()
    this.window = undefined
    const pending = this.openOwned(device).finally(() => { if (this.opening === pending) this.opening = undefined })
    this.opening = pending
    return pending
  }

  private async openOwned(device: DeviceProcess): Promise<void> {
    const url = this.options.origin + '/'
    const window = createDesktopWindow({ primary: false, webviewTag: false,
      preload: fileURLToPath(new URL('./preload-device.cjs', import.meta.url)), session: this.browser,
      messages: this.options.messages, additionalArguments: ['--power-evolve-device-origin=' + this.options.origin],
      allowsNavigation: target => target.href === url, openExternal: () => {},
    })
    this.window = window
    this.windowDevice = device
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame || event.url !== url) event.preventDefault() })
    window.webContents.on('will-redirect', event => { if (!event.isMainFrame || event.url !== url) event.preventDefault() })
    window.on('closed', () => { if (this.window === window) { this.window = undefined; this.windowDevice = undefined } })
    try {
      await window.loadURL(url)
      if (this.closing || this.options.getDevice() !== device || window.isDestroyed() || this.window !== window) {
        throw new Error('local_device_changed')
      }
      window.show()
    } catch (_loadFailure) {
      if (!window.isDestroyed()) window.destroy()
      throw new Error('PowerEvolve desktop: local authorization unavailable')
    }
  }

  /**
   * Destroy the local document before awaiting its owned directory dialog.
   * @returns Completion of pending native selections; late paths are discarded.
   */
  async close(): Promise<void> {
    this.closing = true
    ipcMain.removeHandler(DEVICE_DESKTOP_IPC.choose)
    this.window?.destroy()
    this.window = undefined
    await Promise.allSettled([...this.pickers, this.opening])
    await this.browser.clearStorageData()
  }

  private assertSender(event: IpcMainInvokeEvent): BrowserWindow {
    const window = this.window
    if (this.closing || window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== this.options.origin + '/'
      || this.windowDevice === undefined || this.options.getDevice() !== this.windowDevice) {
      throw new Error('PowerEvolve desktop: rejected local directory request')
    }
    return window
  }
}
