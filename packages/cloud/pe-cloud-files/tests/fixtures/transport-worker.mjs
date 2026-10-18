/** Test transport only: the gate models a blocked operation, not filesystem confinement. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode, gate } = workerData
if (mode !== 'no-ready') parentPort.postMessage({ kind: 'ready', abiVersion: mode === 'old-abi' ? 4 : mode === 'old-abi3' ? 3 : 5 })
parentPort.on('message', request => {
  if (mode === 'blocked') {
    const state = new Int32Array(gate)
    Atomics.store(state, 0, 1)
    Atomics.notify(state, 0)
    Atomics.wait(state, 1, 0)
  }
  if (mode === 'crash') throw new Error('test worker failed after dispatch')
  if (mode === 'wrong-id' || mode === 'wrong-id-then-late') {
    parentPort.postMessage({ kind: 'reply', id: 'wrong', ok: true, bytes: new Uint8Array(1) })
    if (mode === 'wrong-id-then-late') {
      parentPort.postMessage({ kind: 'reply', id: request.id, ok: true, bytes: new Uint8Array(1) })
    }
    return
  }
  const bytes = new Uint8Array(Math.min(request.maxBytes, 3))
  bytes.set([1, 2, 3].slice(0, bytes.length))
  parentPort.postMessage({ kind: 'reply', id: request.id, ok: true, bytes }, [bytes.buffer])
})
