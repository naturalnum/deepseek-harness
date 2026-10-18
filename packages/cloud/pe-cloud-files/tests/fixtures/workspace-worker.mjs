/** TEST ONLY Node-backed ABI transport; no Linux FD, tmpfs, namespace or quota evidence. */
import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const { gate, mode } = workerData
const counters = new Int32Array(gate)
parentPort.postMessage({ kind: 'ready', abiVersion: 5 })
parentPort.on('message', request => {
  const root = request.root
  const path = join(root.rootPath, request.relativePath ?? request.leaf)
  if (request.kind === 'directory') {
    Atomics.add(counters, 1, 1)
    try {
      const canonicalPath = realpathSync(path)
      parentPort.postMessage({ kind: 'directory-reply', id: request.id, ok: true,
        value: { anchorPath: realpathSync(root.rootPath), canonicalPath, directory: statSync(path).isDirectory() } })
    } catch (error) {
      parentPort.postMessage({ kind: 'directory-reply', id: request.id, ok: false, phase: 'target',
        code: error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_IO_ERROR', syscallCode: error.code })
    }
    return
  }
  if (request.kind === 'stat') {
    const count = Atomics.add(counters, 2, 1) + 1
    const info = statSync(path, { bigint: true })
    const identity = `${info.dev}:${mode === 'identity-change' && count % 2 === 0 ? info.ino + 1n : info.ino}`
    parentPort.postMessage({ kind: 'stat-reply', id: request.id,
      metadata: { identity, version: `${identity}:0:1:1`, type: info.isDirectory() ? 'directory' : 'file' } })
    return
  }
  const cleanup = request.kind === 'leaf-cleanup'
  Atomics.add(counters, cleanup ? 3 : 0, 1)
  const parent = statSync(root.rootPath, { bigint: true })
  let tag = 2, flags = 103, errno = 0, mkdirErrno = 0
  if (cleanup) { rmdirSync(path); tag = 6; flags = 124 }
  else {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (statSync(path).isDirectory()) { tag = 1; flags = 96 }
      else { tag = 3; flags = 97; errno = 20; mkdirErrno = 17 }
    }
  }
  const leaf = cleanup ? undefined : statSync(path, { bigint: true })
  if (mode === 'parent-failure' && !cleanup) { tag = 4; errno = 5 }
  if (mode === 'blocked-prepare' && !cleanup) {
    Atomics.store(counters, 4, 1)
    Atomics.notify(counters, 4)
    Atomics.wait(counters, 5, 0)
  }
  const frame = new Uint8Array(64), view = new DataView(frame.buffer)
  view.setUint32(0, 0x44534635)
  frame[4] = 1; frame[5] = cleanup ? 2 : 1; frame[6] = tag; frame[7] = 5
  view.setUint32(8, errno, true); view.setUint32(12, flags, true); view.setUint32(48, mkdirErrno, true)
  if (flags & 4) {
    view.setBigUint64(16, leaf?.dev ?? BigInt(request.identity.device), true)
    view.setBigUint64(24, leaf?.ino ?? BigInt(request.identity.inode), true)
  }
  view.setBigUint64(32, parent.dev, true); view.setBigUint64(40, parent.ino, true)
  parentPort.postMessage({ kind: cleanup ? 'leaf-cleanup-reply' : 'leaf-prepare-reply', id: request.id, frame }, [frame.buffer])
})
