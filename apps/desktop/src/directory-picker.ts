/** Window-owned workspace directory dialogs for the local Desktop renderer. */

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

const pending = new WeakMap<BrowserWindow, Promise<string | null>>()

/**
 * Open a directory dialog belonging to a local application window.
 * The caller authorizes the document; closing its window discards a late selection.
 * @param window - Owned local window, restored and focused before the dialog opens.
 * @returns One path or cancellation; concurrent requests share the same native dialog.
 */
export function chooseDesktopDirectory(window: BrowserWindow): Promise<string | null> {
  if (window.isDestroyed()) return Promise.resolve(null)
  const existing = pending.get(window)
  if (existing !== undefined) return existing
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  const result = dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }).then(
    ({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null,
  ).finally(() => { pending.delete(window) })
  pending.set(window, result)
  return result
}

/**
 * Install the application-lifetime directory picker IPC handler.
 * @param getWindow - Current local application window; shell pages and subframes cannot open dialogs.
 */
export function installDesktopDirectoryPicker(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected directory picker from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    return chooseDesktopDirectory(window)
  })
}
