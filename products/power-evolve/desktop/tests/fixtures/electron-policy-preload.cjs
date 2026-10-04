/** Adversarial test bridge: each real sandboxed frame may attempt the production IPC channels. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probe', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => { ipcRenderer.send(channel, ...args) },
})
