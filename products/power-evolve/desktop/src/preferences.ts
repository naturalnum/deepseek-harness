/** Owned Host-only locale and theme IPC, without backend or filesystem capabilities. */
import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import { DESKTOP_IPC } from '@deepseek-ai/dsh-desktop/assembly'
import type { CloudDesktopConfig } from './config.ts'
import { assertCloudSender } from './window-policy.ts'

/**
 * Install the native document's read-only system locale and theme synchronization.
 * @param window - Current Cloud main window; foreign windows never inherit ownership.
 * @param config - Fixed deployment origins.
 * @param languages - Operating-system languages supplied by the application.
 * @param localeChanged - Apply a validated registered language to native menus.
 * @returns Disposer for exactly the installed IPC listeners and handler.
 */
export function installCloudPreferences(window: () => BrowserWindow | undefined, config: CloudDesktopConfig,
  languages: () => readonly string[], localeChanged: (locale: 'en' | 'zh-CN') => void): () => void {
  ipcMain.handle(DESKTOP_IPC.localeBootstrap, event => {
    assertCloudSender(window(), config, event)
    return { preference: null, languages: languages() }
  })
  const changed = (event: Electron.IpcMainEvent, next: unknown): void => {
    try { assertCloudSender(window(), config, event) } catch (_rejectedSender) { return }
    if (next === 'en' || next === 'zh-CN') localeChanged(next)
  }
  const themed = (event: Electron.IpcMainEvent, value: unknown): void => {
    try { assertCloudSender(window(), config, event) } catch (_rejectedSender) { return }
    if (value === 'system' || value === 'light' || value === 'dark') nativeTheme.themeSource = value
  }
  ipcMain.on(DESKTOP_IPC.localeChanged, changed)
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, themed)
  return () => {
    ipcMain.removeHandler(DESKTOP_IPC.localeBootstrap)
    ipcMain.off(DESKTOP_IPC.localeChanged, changed)
    ipcMain.off(DESKTOP_IPC.nativeThemeSet, themed)
  }
}
