/** Adversarial sandbox bridge for actual browser IPC; no credentials or Electron objects cross it. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probe', {
  acquire: (workspace, sessionId) => ipcRenderer.invoke('dsh-desktop:browser-acquire', workspace, sessionId),
  release: lease => ipcRenderer.invoke('dsh-desktop:browser-release', lease),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
