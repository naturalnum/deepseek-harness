/** Test-only raw probe; production preloads still determine the product bridges in each real frame. */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('localGateProbe', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
})
