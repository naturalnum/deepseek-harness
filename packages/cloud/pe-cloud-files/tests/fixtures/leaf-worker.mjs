/** ABI5 transport facts only; this fixture performs no filesystem operations. */
import { parentPort, workerData } from 'node:worker_threads'
const { mode = 'created', gate } = workerData
parentPort.postMessage({ kind: 'ready', abiVersion: 5 })
parentPort.on('message', request => {
  const cleanup = request.kind === 'leaf-cleanup'
  if (cleanup && gate?.byteLength >= 12) Atomics.add(new Int32Array(gate), 2, 1)
  if (mode === 'crash') throw new Error('leaf actual reply lost')
  if (mode === 'blocked-prepare' || (mode === 'blocked-cleanup' && cleanup) || (mode === 'blocked-read' && request.kind === 'read')) {
    const state = new Int32Array(gate)
    Atomics.store(state, 0, 1)
    Atomics.notify(state, 0)
    Atomics.wait(state, 1, 0)
  }
  if (request.kind === 'directory') {
    parentPort.postMessage({ kind: 'directory-reply', id: request.id, ok: true,
      value: { anchorPath: request.root.rootPath, canonicalPath: `${request.root.rootPath}/${request.relativePath}`, directory: true } })
    return
  }
  if (request.kind === 'stat') {
    parentPort.postMessage({ kind: 'stat-reply', id: request.id, metadata: { identity: '1:3', version: '1:3:0:1:1', type: 'directory' } })
    return
  }
  if (request.kind === 'read') {
    const bytes = new Uint8Array(Math.min(request.maxBytes, 3))
    parentPort.postMessage({ kind: 'reply', id: request.id, ok: true, bytes }, [bytes.buffer])
    return
  }
  const frame = new Uint8Array(mode === 'pooled' ? 128 : 64)
  const v = new DataView(frame.buffer)
  v.setUint32(0, 0x44534635)
  frame[4] = 1; frame[5] = cleanup ? 2 : 1; frame[7] = 5
  let tag = cleanup ? 6 : 2
  let flags = cleanup ? 124 : 103
  let errno = 0, mkdirErrno = 0
  if (!cleanup && mode === 'existing') { tag = 1; flags = 96 }
  if (!cleanup && mode === 'not-created') { tag = 3; flags = 97; errno = 13; mkdirErrno = 13; frame[7] = 3 }
  if (!cleanup && mode === 'anchor-missing') { tag = 3; flags = 32; errno = 2; frame[7] = 1 }
  if (!cleanup && mode === 'known-failure') { tag = 4; errno = 5 }
  if (!cleanup && mode === 'unknown') { tag = 5; flags = 99; errno = 5; frame[7] = 4 }
  if (cleanup && mode === 'cleanup-unknown') { tag = 7; flags = 108; errno = 39; frame[7] = 6 }
  frame[6] = tag
  v.setUint32(8, errno, true); v.setUint32(12, flags, true); v.setUint32(48, mkdirErrno, true)
  if (flags & 4) { v.setBigUint64(16, 1n, true); v.setBigUint64(24, 3n, true) }
  if (flags & 64) { v.setBigUint64(32, 1n, true); v.setBigUint64(40, 2n, true) }
  if (mode === 'bad-tag') frame[6] = 99
  if (mode === 'bad-close') v.setUint32(12, flags & ~32, true)
  if (mode === 'bad-parent') v.setBigUint64(40, 99n, true)
  if (mode === 'bad-reserved') frame[63] = 1
  if (mode === 'bad-operation') frame[5] = cleanup ? 1 : 2
  parentPort.postMessage({ kind: cleanup ? 'leaf-cleanup-reply' : 'leaf-prepare-reply',
    id: mode === 'wrong-id' ? 'wrong' : request.id, frame: frame.subarray(0, 64) }, [frame.buffer])
})
