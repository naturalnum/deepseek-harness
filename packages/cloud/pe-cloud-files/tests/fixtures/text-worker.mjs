/** TEST ONLY Node transport. This supplies no Linux FD, confinement, sync or quota evidence. */
import { parentPort, workerData } from 'node:worker_threads'
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
const { mode = 'normal', gate, abiVersion = 7, content } = workerData
const state = new Int32Array(gate)
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const normalize = text => text.replace(/\r\n?/g, '\n')
const block = () => {
  Atomics.store(state, 1, 1)
  Atomics.notify(state, 1)
  Atomics.wait(state, 2, 0)
}
parentPort.postMessage({ kind: 'ready', abiVersion })
parentPort.on('message', request => {
  const { root, id, relativePath } = request
  const path = join(root.rootPath, relativePath)
  const failed = (code, syscallCode = 'EIO', outcome = 'not-published') => parentPort.postMessage({
    kind: request.kind === 'text-write' ? 'text-write-failure' : 'reply', id, ok: false, code, syscallCode, outcome,
  })
  const anchor = statSync(root.rootPath, { bigint: true })
  if (String(anchor.dev) !== root.rootDevice || String(anchor.ino) !== root.rootInode) {
    failed('FS_PERMISSION_DENIED', 'ESTALE')
    return
  }
  if (['lstat', 'list', 'range'].includes(request.kind) || (abiVersion === 8 && request.kind === 'read')) {
    try {
      if (abiVersion !== 8 || content === undefined) { failed('FS_PERMISSION_DENIED'); return }
      if (mode === 'content-block' && request.kind === 'list') block()
      if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) { failed('FS_ABORTED', 'ECANCELED'); return }
      const within = target => {
        const resolved = realpathSync(target), tail = relative(root.rootPath, resolved)
        if (tail === '..' || tail.startsWith('../')) throw Object.assign(new Error('outside fixture root'), { code: 'EACCES' })
      }
      if (request.relativePath !== '.') within(dirname(path))
      const metadata = name => {
        const info = lstatSync(name, { bigint: true })
        if (info.isFile() && info.nlink !== 1n) throw Object.assign(new Error('hard link'), { code: 'EACCES' })
        return { identity: `${info.dev}:${info.ino}`, version: version(info),
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
          ...info.isFile() || info.isSymbolicLink() ? { size: Number(info.size) } : {} }
      }
      if (request.kind === 'lstat') {
        let info
        try { info = metadata(path) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
        parentPort.postMessage({ kind: 'lstat-reply', id, metadata: info })
      } else if (request.kind === 'list') {
        within(path)
        const names = readdirSync(path)
        if (names.length > request.maxEntries || names.some(name => Buffer.byteLength(name) > content.maxNameBytes)) {
          failed('FS_TOO_LARGE', 'EFBIG'); return
        }
        const entries = names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map(name => ({ name, ...metadata(join(path, name)) }))
        const reply = { kind: 'list-reply', id, entries }
        if (Buffer.byteLength(JSON.stringify(reply)) > request.maxBytes
          || 128 + entries.reduce((sum, entry) => sum + 512 + 6 * Buffer.byteLength(entry.name), 0) > request.maxBytes) {
          failed('FS_TOO_LARGE', 'EFBIG'); return
        }
        parentPort.postMessage(reply)
      } else {
        within(path)
        const info = statSync(path, { bigint: true })
        if (!info.isFile() || info.nlink !== 1n) { failed('FS_NOT_REGULAR_FILE'); return }
        if (mode === 'content-grow' && request.kind === 'read') writeFileSync(path, 'x'.repeat(request.maxBytes + 1))
        const length = request.kind === 'read' ? request.maxBytes + 1 : request.length
        const raw = new Uint8Array(length), fd = openSync(path, 'r')
        let size
        try { size = readSync(fd, raw, 0, length, request.kind === 'read' ? 0 : request.offset) } finally { closeSync(fd) }
        if (request.kind === 'read' && size > request.maxBytes) { failed('FS_TOO_LARGE'); return }
        const bytes = request.kind === 'read' ? raw.subarray(0, size) : raw.slice(0, size)
        parentPort.postMessage(request.kind === 'read' ? { kind: 'reply', id, ok: true, bytes }
          : { kind: 'range-reply', id, bytes }, [bytes.buffer])
      }
    } catch (error) {
      failed(error.code === 'ENOENT' ? 'FS_NOT_FOUND' : error.code === 'ENOTDIR' ? 'FS_NOT_DIRECTORY' : 'FS_PERMISSION_DENIED', error.code)
    }
    return
  }
  if (request.kind === 'directory') {
    try {
      const canonicalPath = realpathSync(path), anchorPath = realpathSync(root.rootPath)
      if (relative(anchorPath, canonicalPath).startsWith('..')) throw Object.assign(new Error('outside fixture root'), { code: 'EACCES' })
      parentPort.postMessage({ kind: 'directory-reply', id, ok: true,
        value: { anchorPath, canonicalPath, directory: statSync(path).isDirectory() } })
    } catch (error) {
      parentPort.postMessage({ kind: 'directory-reply', id, ok: false, phase: 'target',
        code: error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_PERMISSION_DENIED', syscallCode: error.code })
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
  if (request.kind === 'read') {
    const raw = readFileSync(path)
    if (raw.byteLength > request.maxBytes) { failed('FS_TOO_LARGE'); return }
    const bytes = new Uint8Array(raw)
    parentPort.postMessage({ kind: 'reply', id, ok: true, bytes }, [bytes.buffer])
    return
  }
  if (request.kind !== 'text-write') throw new Error('Unexpected text fixture request')
  const count = Atomics.add(state, 0, 1) + 1
  if ((mode === 'block-before' || mode === 'unknown-after-cancel') && count === 1) block()
  if (mode === 'crash') throw new Error('Actual fixture worker exit during mutation')
  if (mode === 'unknown' || mode === 'unknown-after-cancel' || mode === 'unknown-stale') {
    writeFileSync(`${path}.unconfirmed`, request.content)
    failed(mode === 'unknown-stale' ? 'FS_STALE_VERSION' : 'FS_IO_ERROR', mode === 'unknown-stale' ? 'ESTALE' : 'EIO', 'unknown')
    return
  }
  if (mode === 'known-failure') { failed('FS_IO_ERROR'); return }
  if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) {
    Atomics.store(state, 3, 1)
    failed('FS_ABORTED', 'ECANCELED')
    return
  }
  let prior
  try { prior = lstatSync(path, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (prior !== undefined && !prior.isFile()) { failed('FS_NOT_REGULAR_FILE', 'EISDIR'); return }
  if (request.expected?.kind === 'createIfAbsent' && prior !== undefined) { failed('FS_NOT_OBSERVED', 'EEXIST'); return }
  if (request.expected?.kind === 'replaceIfVersion' && (prior === undefined || version(prior) !== request.expected.version)) {
    failed('FS_STALE_VERSION', 'ESTALE')
    return
  }
  let before = null
  if (prior !== undefined && prior.size < BigInt(request.maxBytes) && Buffer.byteLength(request.content) < request.maxBytes) {
    const bytes = readFileSync(path)
    if (!bytes.subarray(0, 8192).includes(0)) {
      try { before = normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (error) { if (!(error instanceof TypeError)) throw error }
    }
  }
  const temporary = `${path}.text-fixture-${id}.tmp`
  writeFileSync(temporary, request.content, { flag: 'wx' })
  renameSync(temporary, path)
  if (mode === 'block-after' && count === 1) block()
  if (mode === 'deadline-after' && count === 1) {
    const cancelled = new Int32Array(request.cancel)
    while (Atomics.load(cancelled, 0) === 0) Atomics.wait(cancelled, 0, 0, 10)
    Atomics.store(state, 3, 1)
    block()
  }
  parentPort.postMessage({ kind: 'text-write-reply', id, result: {
    operation: prior === undefined ? 'create' : 'update', version: mode === 'bad-reply' ? 'invalid' : version(statSync(path, { bigint: true })),
    before, after: normalize(request.content),
  } })
})
