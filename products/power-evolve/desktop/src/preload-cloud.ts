/** Native window preferences for the configured Cloud document; no local paths or execution IPC. */
import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, createDesktopShortcutBridge, markDocumentPlatform, syncWindowFullscreen,
  syncNativeTheme } from '@deepseek-ai/dsh-desktop/preload-assembly'
import { DEVICE_DESKTOP_IPC } from './device-ipc.ts'

const prefix = '--power-evolve-host-origin='
const origin = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
if (process.isMainFrame && origin !== undefined && location.origin === origin && location.pathname.startsWith('/native/')) {
  contextBridge.exposeInMainWorld('dshDesktop', createDesktopShortcutBridge())
  if (process.argv.includes('--power-evolve-device-enabled')) {
    contextBridge.exposeInMainWorld('powerEvolveDesktopDevice', {
      openAuthorization: () => ipcRenderer.invoke(DEVICE_DESKTOP_IPC.open),
    })
  }
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap),
    onChange: (locale: string) => { ipcRenderer.send(DESKTOP_IPC.localeChanged, locale) },
  })
  markDocumentPlatform()
  syncWindowFullscreen()
  syncNativeTheme()
}
