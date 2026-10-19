/** Worker reply validation fixture; it grants no filesystem authority. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode = 'normal', abiVersion = 8, gate } = workerData
const metadata = { identity: '1:2', version: '1:2:3:4:5', type: 'file', size: 3 }
parentPort.postMessage({ kind: 'ready', abiVersion })
parentPort.on('message', request => {
  if (mode === 'blocked') {
    const state = new Int32Array(gate)
    Atomics.store(state, 0, 1)
    Atomics.wait(state, 1, 0)
    parentPort.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_ABORTED' })
    return
  }
  if (request.kind === 'lstat') {
    parentPort.postMessage({ kind: 'lstat-reply', id: request.id,
      metadata: request.relativePath === 'absent' ? undefined : { ...metadata, type: 'symlink' } })
  } else if (request.kind === 'list') {
    let entries = [{ name: 'a', ...metadata }, { name: '你.txt', ...metadata }]
    if (mode === 'duplicate') entries[1].name = 'a'
    if (mode === 'escape') entries[1].name = '../outside'
    if (mode === 'surrogate') entries[1].name = '\ud800'
    if (mode === 'unsorted') entries.reverse()
    if (mode === 'invalid-size') entries[1].size = -1
    if (mode === 'identity-mismatch') entries[1].version = '9:9:3:4:5'
    if (mode === 'over-count') entries.push({ name: 'z', ...metadata })
    if (mode === 'over-bytes') entries[1].name = 'z'.repeat(2048)
    parentPort.postMessage({ kind: 'list-reply', id: request.id, entries, ...mode === 'extra-field' ? { extra: { nested: 'unreviewed' } } : {} })
  } else {
    const bytes = mode === 'range-overrun' ? new Uint8Array(request.length + 1)
      : mode === 'range-backing' ? new Uint8Array(new ArrayBuffer(8), 2, 2) : new Uint8Array([2, 3])
    parentPort.postMessage({ kind: 'range-reply', id: request.id, bytes }, [bytes.buffer])
  }
})
