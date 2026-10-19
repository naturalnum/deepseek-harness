/** TEST ONLY Node protocol transport; no companion ABI, namespace, quota or durability certificate. */
import { parentPort, workerData } from 'node:worker_threads'
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const { mode = 'normal', gate, staging } = workerData
const counters = new Int32Array(gate)
let active, ended
const facts = (kind, closed, clean, publication = 'none') => ({ kind, code: kind === 'failed' ? 'EIO' : 'OK', publication,
  closed, clean, temporaryPresent: !closed, writtenBytes: active?.total ?? 0, readBytes: 0,
  sequence: active?.sequence ?? 0, retainedCreatedDirectories: 0 })
const fail = code => {
  const state = active
  closeSync(state.fd)
  unlinkSync(state.temp)
  const info = facts('aborted', true, true)
  parentPort.postMessage({ kind: 'stage-failure', id: state.id, code, facts: info })
  ended = state.id; active = undefined
}
parentPort.postMessage({ kind: 'ready', abiVersion: 7, ...staging === undefined ? {} : { stagingAbiVersion: 1 } })
parentPort.on('message', request => {
  if (request.kind === 'directory' || request.kind === 'stat') {
    const path = join(request.root.rootPath, request.relativePath), info = statSync(path, { bigint: true })
    parentPort.postMessage(request.kind === 'directory' ? { kind: 'directory-reply', id: request.id, ok: true,
      value: { anchorPath: realpathSync(request.root.rootPath), canonicalPath: realpathSync(path), directory: info.isDirectory() } }
      : { kind: 'stat-reply', id: request.id, metadata: { type: 'directory', identity: `${info.dev}:${info.ino}`,
        version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } })
    return
  }
  if (request.kind === 'stage-begin') {
    Atomics.add(counters, 0, 1)
    const parent = join(request.root.rootPath, '.pe', 'attachments', request.file.digest)
    mkdirSync(parent, { recursive: true })
    const path = join(parent, request.file.name)
    if (existsSync(path)) {
      const bytes = readFileSync(path), digest = createHash('sha256').update(bytes).digest('hex')
      const valid = digest === request.file.digest && bytes.byteLength === request.file.expectedBytes
      parentPort.postMessage(valid ? { kind: 'stage-result', id: request.id, result: { outcome: 'reused',
        facts: { ...facts('reused', true, true), readBytes: bytes.byteLength } } }
        : { kind: 'stage-failure', id: request.id, code: 'FS_IO_ERROR', facts: facts('failed', true, true) })
      ended = request.id; return
    }
    const temp = `${path}.${request.id}.tmp`
    active = { id: request.id, file: request.file, path, temp, fd: openSync(temp, 'wx'), cancel: new Int32Array(request.cancel),
      total: 0, sequence: 0, hash: createHash('sha256'), source: false }
    parentPort.postMessage({ kind: 'stage-ready', id: request.id }); return
  }
  if (active === undefined && request.kind === 'stage-abort' && request.id === ended) return
  if (active === undefined || request.id !== active.id) throw new Error('Fixture stage id mismatch')
  if (request.kind === 'stage-abort') { fail('FS_ABORTED'); return }
  if (request.kind === 'stage-source-complete') { active.source = true; return }
  if (request.kind === 'stage-chunk') {
    Atomics.add(counters, 3, 1)
    Atomics.store(counters, 4, Math.max(Atomics.load(counters, 4), request.bytes.byteLength))
    if (mode === 'block-ack') {
      Atomics.store(counters, 1, 1); Atomics.notify(counters, 1); Atomics.wait(counters, 2, 0)
    }
    if (Atomics.load(active.cancel, 0)) { fail('FS_ABORTED'); return }
    if (active.file.name === 'known.bin') { fail('FS_IO_ERROR'); return }
    if (active.file.name === 'unknown.bin') {
      closeSync(active.fd)
      parentPort.postMessage({ kind: 'stage-failure', id: active.id, code: 'FS_IO_ERROR',
        facts: { ...facts('unknown', true, false, 'unknown'), temporaryPresent: true } })
      ended = active.id; active = undefined; return
    }
    if (mode === 'bad-ack') {
      parentPort.postMessage({ kind: 'stage-ack', id: active.id, sequence: 99, total: 99 }); return
    }
    if (request.sequence !== active.sequence || request.bytes.byteLength > 4096) throw new Error('Fixture stage credit mismatch')
    writeSync(active.fd, request.bytes)
    active.hash.update(request.bytes); active.total += request.bytes.byteLength; active.sequence++
    parentPort.postMessage({ kind: 'stage-ack', id: active.id, sequence: active.sequence, total: active.total }); return
  }
  if (request.kind === 'stage-finish') {
    if (!active.source || active.total !== active.file.expectedBytes || active.hash.digest('hex') !== active.file.digest) {
      fail('FS_IO_ERROR'); return
    }
    fsyncSync(active.fd); closeSync(active.fd); renameSync(active.temp, active.path)
    Atomics.add(counters, 5, 1)
    parentPort.postMessage({ kind: 'stage-result', id: active.id,
      result: { outcome: 'published', facts: facts('published', true, true, 'published') } })
    ended = active.id; active = undefined; return
  }
  throw new Error('Fixture stage command mismatch')
})
