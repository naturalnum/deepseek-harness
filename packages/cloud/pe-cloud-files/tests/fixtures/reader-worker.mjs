/** Transport fixture only; filesystem confinement and single-FD evidence comes from Linux smoke. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode = 'normal', data = 'A你🙂Z', chunkSize = 2, gate } = workerData
const state = gate === undefined ? undefined : new Int32Array(gate)
const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
let active
parentPort.postMessage({ kind: 'ready', abiVersion: 5 })
parentPort.on('message', request => {
  if (request.kind === 'stat') {
    if (mode === 'bad-metadata') {
      parentPort.postMessage({ kind: 'stat-reply', id: request.id, metadata: { version: 'invalid', identity: '1:2', type: 'file', size: 3 } })
      return
    }
    const metadata = request.relativePath === 'missing' ? undefined : {
      identity: request.relativePath === '.' ? '1:1' : '1:2', version: '1:2:9:4:5',
      type: request.relativePath === '.' ? 'directory' : 'file',
      ...request.relativePath === '.' ? {} : { size: bytes.length },
    }
    parentPort.postMessage({ kind: 'stat-reply', id: request.id, metadata })
    return
  }
  if (request.kind === 'stream') {
    active = { request, offset: 0 }
    parentPort.postMessage({ kind: 'stream-ready', id: request.id })
    return
  }
  if (request.kind === 'stream-cancel') {
    if (mode === 'delayed-cancel') {
      Atomics.store(state, 0, 1)
      Atomics.notify(state, 0)
      Atomics.wait(state, 1, 0)
    }
    active = undefined
    parentPort.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_ABORTED' })
    return
  }
  if (request.kind !== 'stream-pull' || active === undefined) throw new Error('invalid stream fixture command')
  if (mode === 'crash-stream') throw new Error('actual fixture worker exit')
  if (mode === 'blocked-pull') {
    Atomics.store(state, 0, 1)
    Atomics.notify(state, 0)
    Atomics.wait(state, 1, 0)
  }
  if (state !== undefined) Atomics.add(state, 2, 1)
  if (active.offset === bytes.length) {
    active = undefined
    parentPort.postMessage({ kind: 'stream-end', id: request.id })
    return
  }
  const chunk = bytes.slice(active.offset, active.offset + (mode === 'oversized-chunk' ? chunkSize + 1 : chunkSize))
  active.offset += chunk.length
  parentPort.postMessage({ kind: 'stream-chunk', id: request.id, bytes: chunk }, [chunk.buffer])
})
