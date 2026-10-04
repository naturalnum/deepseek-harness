/** Private directory picker for the owned local Device document, never the Cloud document. */
import { contextBridge, ipcRenderer } from 'electron'
import { DEVICE_DESKTOP_IPC } from './device-ipc.ts'
const prefix = '--power-evolve-device-origin='
const origin = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
if (process.isMainFrame && origin !== undefined && location.origin === origin && location.pathname === '/') {
  contextBridge.exposeInMainWorld('powerEvolveDevicePicker', { choose: () => ipcRenderer.invoke(DEVICE_DESKTOP_IPC.choose) })
}
