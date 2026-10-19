/** TEST ONLY bounded Node-file transport; no Linux openat2, mount, quota or production-authority evidence. */
import { parentPort, workerData } from 'node:worker_threads'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const { mode, gate, chunkBytes, maxReadBytes } = workerData
const state = new Int32Array(gate)
let active
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const fail = (id, code, syscallCode = 'EIO') => parentPort.postMessage({ kind: 'reply', id, ok: false, code, syscallCode })
const close = () => {
  if (active === undefined) return
  closeSync(active.fd)
  active = undefined
  Atomics.add(state, 4, 1)
}
parentPort.postMessage({ kind: 'ready', abiVersion: 6 })
parentPort.on('message', request => {
  Atomics.add(state, 0, 1)
  if (request.kind === 'stream-cancel') {
    Atomics.add(state, 2, 1)
    if (mode === 'delayed-cancel') Atomics.wait(state, 3, 0)
    close()
    fail(request.id, 'FS_ABORTED', 'ECANCELED')
    return
  }
  if (request.kind === 'stream-pull') {
    if (active === undefined || request.id !== active.id) throw new Error('Unexpected fixture stream pull')
    const bytes = new Uint8Array(chunkBytes)
    const count = readSync(active.fd, bytes, 0, bytes.byteLength, null)
    active.total += count
    if (active.total > active.maximum) { close(); fail(request.id, 'FS_TOO_LARGE'); return }
    if (count === 0) {
      close()
      parentPort.postMessage({ kind: 'stream-end', id: request.id })
    } else {
      const chunk = bytes.slice(0, count)
      parentPort.postMessage({ kind: 'stream-chunk', id: request.id, bytes: chunk }, [chunk.buffer])
    }
    return
  }
  const { id, root, relativePath } = request
  const path = join(root.rootPath, relativePath)
  const anchor = statSync(root.rootPath, { bigint: true })
  if (String(anchor.dev) !== root.rootDevice || String(anchor.ino) !== root.rootInode) {
    fail(id, 'FS_PERMISSION_DENIED', 'ESTALE')
    return
  }
  if (new Int32Array(request.cancel)[0] !== 0) { fail(id, 'FS_ABORTED', 'ECANCELED'); return }
  if (request.kind === 'stat') {
    if (relativePath === 'default-workspace') Atomics.add(state, 8, 1)
    if (relativePath === 'instructions') Atomics.add(state, 5, 1)
    let info
    try { info = statSync(path, { bigint: true }) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    parentPort.postMessage({ kind: 'stat-reply', id, metadata: info === undefined ? undefined : {
      identity: `${info.dev}:${info.ino}`, version: version(info), type: info.isDirectory() ? 'directory' : 'file',
      ...info.isDirectory() ? {} : { size: Number(info.size) },
    } })
    return
  }
  if (request.kind === 'directory') {
    Atomics.add(state, 6, 1)
    try {
      const anchorPath = realpathSync(root.rootPath), canonicalPath = realpathSync(path)
      const child = relative(anchorPath, canonicalPath)
      if (child === '..' || child.startsWith('../')) throw Object.assign(new Error('Outside fixture anchor'), { code: 'EACCES' })
      parentPort.postMessage({ kind: 'directory-reply', id, ok: true,
        value: { anchorPath, canonicalPath, directory: statSync(path).isDirectory() } })
    } catch (error) {
      parentPort.postMessage({ kind: 'directory-reply', id, ok: false, phase: 'target',
        code: error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_PERMISSION_DENIED', syscallCode: error.code })
    }
    return
  }
  if (request.kind !== 'stream' || active !== undefined) throw new Error('Unexpected fixture operation')
  if (request.maxBytes > maxReadBytes) { fail(id, 'FS_TOO_LARGE'); return }
  const fd = openSync(path, 'r')
  const info = fstatSync(fd)
  if (!info.isFile() || info.size > request.maxBytes) {
    closeSync(fd)
    fail(id, info.isFile() ? 'FS_TOO_LARGE' : 'FS_NOT_REGULAR_FILE')
    return
  }
  active = { fd, id, total: 0, maximum: request.maxBytes }
  Atomics.add(state, 1, 1)
  parentPort.postMessage({ kind: 'stream-ready', id })
})
