/** TEST ONLY Node transport. This supplies no Linux FD, confinement, sync or quota evidence. */
import { parentPort, workerData } from 'node:worker_threads'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
const { mode = 'normal', gate, abiVersion = 7, content, storageFacts, projectMetadataVersion, environmentLayoutVersion, sessionDirectories } = workerData
const state = new Int32Array(gate)
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const normalize = text => text.replace(/\r\n?/g, '\n')
const block = () => {
  Atomics.store(state, 1, 1)
  Atomics.notify(state, 1)
  Atomics.wait(state, 2, 0)
}
parentPort.postMessage({ kind: 'ready', abiVersion, ...storageFacts === undefined ? {} : { storageProbeVersion: 1 },
  ...projectMetadataVersion === undefined ? {} : { projectMetadataVersion },
  ...environmentLayoutVersion === undefined ? {} : { environmentLayoutVersion } })
parentPort.on('message', request => {
  if (request.kind === 'leaf-prepare') {
    // TEST ONLY ordinary Node mkdir + synthetic closed-FD frame. No Linux fsync/confinement proof.
    Atomics.add(state, 5, 1)
    const frame = new Uint8Array(64), view = new DataView(frame.buffer), path = join(request.root.rootPath, request.leaf)
    frame.set([68, 83, 70, 54, 1, 1])
    let info
    try { info = lstatSync(path, { bigint: true }) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    let flags = 96 | 384
    if (mode === 'session-leaf-enospc') {
      frame[6] = 3; frame[7] = 3; flags = 97 | 256
      view.setUint32(8, 28, true); view.setUint32(48, 28, true)
    } else if (info === undefined) {
      mkdirSync(path, { mode: 0o700 }); info = statSync(path, { bigint: true })
      frame[6] = 2; frame[7] = 5; flags |= 7; Atomics.add(state, 4, 1)
      view.setBigUint64(16, info.dev, true); view.setBigUint64(24, info.ino, true)
    } else { frame[6] = 1; frame[7] = 5 }
    view.setUint32(12, flags, true); frame[52] = 1
    view.setBigUint64(32, BigInt(request.root.rootDevice), true)
    view.setBigUint64(40, BigInt(request.root.rootInode), true)
    view.setBigUint64(56, BigInt(request.root.rootMountId), true)
    parentPort.postMessage({ kind: 'leaf-prepare-reply', id: request.id, frame }, [frame.buffer]); return
  }
  if (request.kind === 'environment-layout-prepare') {
    if (environmentLayoutVersion !== 1) throw new Error('Unadvertised environment layout operation')
    const frame = new Uint8Array(256), view = new DataView(frame.buffer)
    frame.set([68, 69, 76, 49, 1, 1, 3])
    view.setBigUint64(24, BigInt(request.root.rootDevice), true)
    view.setBigUint64(32, BigInt(request.root.rootInode), true)
    view.setBigUint64(40, BigInt(request.root.rootMountId), true)
    let created = false, synchronized = false, error = mode === 'layout-known-failure' ? 28 : 0
    for (const [index, name] of ['home', 'venv', 'tmp'].entries()) {
      if (error) break
      const path = join(request.root.rootPath, name), offset = 48 + 64 * index
      let info
      try { info = lstatSync(path, { bigint: true }) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if (info === undefined) {
        frame[offset] |= 16; mkdirSync(path, { mode: 0o700 }); frame[offset] |= 2; created = true
        info = lstatSync(path, { bigint: true })
      }
      view.setUint32(offset + 4, request.uid, true); view.setUint32(offset + 8, request.gid, true)
      view.setUint32(offset + 12, Number(info.mode), true)
      view.setBigUint64(offset + 16, BigInt(request.root.rootDevice), true)
      view.setBigUint64(offset + 24, info.ino, true)
      if (!info.isDirectory() || (info.mode & 0o7777n) !== 0o700n) { error = 1; break }
      view.setBigUint64(offset + 32, BigInt(request.root.rootMountId), true)
      frame[offset] |= 13; synchronized = true
    }
    frame[5] = error ? created || synchronized ? 4 : 3 : created ? 2 : 1
    if (mode === 'layout-unknown' || mode === 'layout-unclosed') { frame[5] = 4; error = 5 }
    if (mode === 'layout-unclosed') frame[6] &= ~1
    if (mode === 'layout-bad-frame') frame[240] = 1
    view.setUint32(8, error, true)
    if (mode === 'layout-block-after') block()
    parentPort.postMessage({ kind: 'environment-layout-reply', id: request.id, frame }, [frame.buffer]); return
  }
  if (request.kind === 'project-metadata-prepare') {
    if (projectMetadataVersion !== 1) throw new Error('Unadvertised metadata operation')
    const frame = new Uint8Array(96), view = new DataView(frame.buffer), path = join(request.root.rootPath, '.pe')
    frame.set([68, 80, 77, 49, 1])
    view.setBigUint64(24, BigInt(request.root.rootDevice), true)
    view.setBigUint64(32, BigInt(request.root.rootInode), true)
    view.setBigUint64(40, BigInt(request.root.rootMountId), true)
    let created = false, flags = 3, error = 0
    if (mode === 'metadata-known-failure') error = 28
    else {
      let info
      try { info = lstatSync(path, { bigint: true }) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if (info === undefined) {
        flags |= 64; mkdirSync(path, { mode: 0o700 }); created = true; flags |= 32
        info = lstatSync(path, { bigint: true })
      }
      if (!info.isDirectory() || (info.mode & 0o7777n) !== 0o700n) error = 1
      else {
        flags |= 28
        view.setUint32(12, request.uid, true); view.setUint32(16, request.gid, true); view.setUint32(20, 0o40700, true)
        view.setBigUint64(48, BigInt(request.root.rootDevice), true); view.setBigUint64(56, info.ino, true)
        view.setBigUint64(64, BigInt(request.root.rootMountId), true)
      }
    }
    frame[5] = error ? 3 : created ? 2 : 1
    if (mode === 'metadata-unknown' || mode === 'metadata-unclosed') { frame[5] = 4; error = 5 }
    if (mode === 'metadata-unclosed') flags &= ~1
    if (mode === 'metadata-bad-frame') flags |= 128
    frame[6] = flags; view.setUint32(8, error, true)
    if (mode === 'metadata-block-after') block()
    parentPort.postMessage({ kind: 'project-metadata-reply', id: request.id, frame }, [frame.buffer]); return
  }
  if (request.kind === 'storage-probe' && storageFacts !== undefined) {
    // Synthetic geometry only; no real quota or Linux deployment result is established.
    let facts = storageFacts[request.path]
    if (facts === undefined) throw new Error('Unexpected synthetic storage probe')
    if (sessionDirectories && /\/env-\d+$/.test(request.path)) {
      const used = BigInt(readdirSync(request.path).length * 4)
      facts = { ...facts, availableBlocks: mode === 'session-pool-full' ? '0' : String(BigInt(facts.availableBlocks) - used),
        freeInodes: String(BigInt(facts.freeInodes) - used) }
    }
    if (mode === 'probe-abort-once' && /\/env-\d+$/.test(request.path) && Atomics.compareExchange(state, 3, 0, 1) === 0) {
      parentPort.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_ABORTED', syscallCode: 'ECANCELED' }); return
    }
    const frame = new Uint8Array(256), view = new DataView(frame.buffer)
    frame.set([68, 83, 80, 49, 1, 1, facts.flags])
    for (const [index, key] of ['uid', 'gid', 'mode', 'appUid', 'appGid'].entries()) view.setUint32(12 + index * 4, facts[key], true)
    for (const [index, key] of ['device', 'inode', 'mountId', 'filesystem', 'blockBytes', 'blocks', 'freeBlocks', 'availableBlocks',
      'inodes', 'freeInodes', 'size', 'allocatedBytes', 'links'].entries()) view.setBigUint64(32 + index * 8, BigInt(facts[key]), true)
    parentPort.postMessage({ kind: 'storage-probe-reply', id: request.id, frame }, [frame.buffer]); return
  }
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
  if (mode === 'session-identity-unknown' && request.expected?.kind === 'replaceIfVersion') {
    // The actual write reached its original path; only its completion disposition is uncertain.
    writeFileSync(path, request.content)
    failed('FS_IO_ERROR', 'EIO', 'unknown'); return
  }
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
