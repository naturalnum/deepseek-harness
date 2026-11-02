/** TEST ONLY Node transport for the native account-read component fixture; no Linux or quota evidence. */
import { parentPort } from 'node:worker_threads'
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const isOutside = path => path === '..' || path.startsWith('../')
parentPort.postMessage({ kind: 'ready', abiVersion: 8 })
parentPort.on('message', (request) => {
  const { root, id, relativePath } = request
  const path = join(root.rootPath, relativePath)
  const failed = (code, syscallCode = 'EIO') => parentPort.postMessage({ kind: 'reply', id, ok: false, code, syscallCode })
  const anchor = statSync(root.rootPath, { bigint: true })
  if (String(anchor.dev) !== root.rootDevice || String(anchor.ino) !== root.rootInode) {
    failed('FS_PERMISSION_DENIED', 'ESTALE')
    return
  }
  if (request.kind === 'directory') {
    try {
      const anchorPath = realpathSync(root.rootPath), canonicalPath = realpathSync(path)
      if (isOutside(relative(anchorPath, canonicalPath))) throw new Error('outside fixture root')
      parentPort.postMessage({ kind: 'directory-reply', id, ok: true,
        value: { anchorPath, canonicalPath, directory: statSync(path).isDirectory() } })
    } catch (error) {
      parentPort.postMessage({ kind: 'directory-reply', id, ok: false, phase: 'target',
        code: error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_PERMISSION_DENIED', syscallCode: error.code ?? 'EACCES' })
    }
    return
  }
  if (request.kind === 'stat') {
    let info
    try { info = statSync(path, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
    parentPort.postMessage({ kind: 'stat-reply', id, metadata: info === undefined ? undefined : {
      identity: `${info.dev}:${info.ino}`, version: version(info), type: info.isDirectory() ? 'directory' : 'file',
      ...info.isDirectory() ? {} : { size: Number(info.size) },
    } })
    return
  }
  if (request.kind !== 'lstat' && request.kind !== 'read') throw new Error('Unexpected account-read fixture request')
  try {
    if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) { failed('FS_ABORTED', 'ECANCELED'); return }
    if (relativePath !== '.' && isOutside(relative(realpathSync(root.rootPath), realpathSync(dirname(path))))) {
      failed('FS_PERMISSION_DENIED', 'EACCES'); return
    }
    const info = lstatSync(path, { bigint: true })
    if (request.kind === 'lstat') {
      parentPort.postMessage({ kind: 'lstat-reply', id, metadata: {
        identity: `${info.dev}:${info.ino}`, version: version(info),
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
        ...info.isFile() || info.isSymbolicLink() ? { size: Number(info.size) } : {},
      } })
      return
    }
    if (!info.isFile() || info.nlink !== 1n || isOutside(relative(realpathSync(root.rootPath), realpathSync(path)))) {
      failed('FS_PERMISSION_DENIED', 'EACCES'); return
    }
    const raw = new Uint8Array(request.maxBytes + 1), fd = openSync(path, 'r')
    let size
    try { size = readSync(fd, raw, 0, raw.length, 0) } finally { closeSync(fd) }
    if (size > request.maxBytes) { failed('FS_TOO_LARGE'); return }
    const bytes = raw.slice(0, size)
    parentPort.postMessage({ kind: 'reply', id, ok: true, bytes }, [bytes.buffer])
  } catch (error) {
    failed(error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_PERMISSION_DENIED', error.code ?? 'EACCES')
  }
})
