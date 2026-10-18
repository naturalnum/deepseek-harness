/** Controlled transport fixture; actual kernel path/close evidence belongs to the root's Linux run. */
import { parentPort, workerData } from 'node:worker_threads'
import { posix } from 'node:path'
const { mode = 'normal', gate, maxPathBytes = 256 } = workerData
const state = gate === undefined ? undefined : new Int32Array(gate)
const physicalRoot = '/physical'
parentPort.postMessage({ kind: 'ready', abiVersion: 6 })
parentPort.on('message', request => {
  if (request.kind !== 'directory') throw new Error('unexpected metadata fixture request')
  if (state !== undefined) Atomics.add(state, 2, 1)
  if (mode === 'blocked') {
    Atomics.store(state, 0, 1)
    Atomics.notify(state, 0)
    Atomics.wait(state, 1, 0)
  }
  if (mode === 'crash') throw new Error('metadata fixture exited after actual dispatch')
  const failures = {
    'target-missing': ['target', 'FS_NOT_FOUND', 'ENOENT'],
    'anchor-missing': ['anchor', 'FS_NOT_FOUND', 'ENOENT'],
    'ancestor-file': ['target', 'FS_NOT_DIRECTORY', 'ENOTDIR'],
    'verify-missing': ['verify', 'FS_NOT_FOUND', 'ENOENT'],
    'backend-error': ['target', 'FS_IO_ERROR', 'EIO'],
    denied: ['target', 'FS_PERMISSION_DENIED', 'EACCES'],
    'invalid-phase': ['unrecognized', 'FS_NOT_FOUND', 'ENOENT'],
  }
  const failure = failures[mode]
  if (failure !== undefined) {
    parentPort.postMessage({ kind: 'directory-reply', id: request.id, ok: false, phase: failure[0], code: failure[1], syscallCode: failure[2] })
    return
  }
  const relative = request.relativePath === 'alias' ? 'folder' : request.relativePath
  let canonicalPath = posix.resolve(physicalRoot, relative)
  if (mode === 'oversized') canonicalPath = `${physicalRoot}/${'x'.repeat(maxPathBytes)}`
  if (mode === 'outside-result') canonicalPath = '/physical-other/file'
  if (mode === 'relative-result') canonicalPath = 'not-absolute'
  const reply = {
    kind: 'directory-reply', id: mode === 'wrong-id-then-late' ? 'wrong-id' : request.id, ok: true,
    value: { anchorPath: physicalRoot, canonicalPath, directory: relative !== 'file' },
  }
  parentPort.postMessage(reply)
  if (mode === 'wrong-id-then-late') parentPort.postMessage({ ...reply, id: request.id })
})
