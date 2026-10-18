/** Wire fixture only; these bytes grant no filesystem or storage authority. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode, gate } = workerData
parentPort.postMessage({ kind: 'ready', abiVersion: 6, ...mode === 'legacy' ? {} : { storageProbeVersion: mode === 'wrong-version' ? 2 : 1 } })
parentPort.on('message', request => {
  if (mode === 'blocked') {
    const state = new Int32Array(gate)
    Atomics.store(state, 0, 1); Atomics.notify(state, 0)
    Atomics.wait(state, 1, 0)
  }
  if (mode === 'crash') throw new Error('storage fixture failure')
  if (request.kind === 'storage-probe') {
    const frame = new Uint8Array(mode === 'partial' ? 255 : 256)
    frame.set([68, 83, 80, 49, 1, 1, mode === 'unclosed' ? 2 : 3])
    parentPort.postMessage({ kind: 'storage-probe-reply', id: mode === 'wrong-id' ? 'wrong' : request.id, frame }, [frame.buffer])
  } else if (request.kind === 'storage-record') {
    const bytes = new TextEncoder().encode('{}')
    parentPort.postMessage({ kind: 'storage-record-reply', id: request.id, bytes }, [bytes.buffer])
  } else {
    const mountInfo = new TextEncoder().encode('mountinfo'), status = new TextEncoder().encode('status')
    parentPort.postMessage({ kind: 'storage-view-reply', id: request.id, view: { mountInfo, status } }, [mountInfo.buffer, status.buffer])
  }
})
