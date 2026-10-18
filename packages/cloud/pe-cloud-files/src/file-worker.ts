/** Linux-only private worker: all blocking root/open/stat/read/close calls stay here. */
import { createRequire } from 'node:module'
import { fstatSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { FdTaskRequest, FdWorkerInput, FdWorkerReply, FdMetadata, FdDirectoryRequest } from './worker-protocol.ts'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'

interface LinuxFdHelper {
  openAnchor(this: void, path: string, device: string, inode: string): void
  openRead(this: void, relativePath: string): number
  openMetadata(this: void, relativePath: string): number
  closeRead(this: void): void
  closeAnchor(this: void): void
  canonicalPath(this: void, rootPath: string, maxPathBytes: number): Uint8Array
  probeKernel(this: void): void
}

function isHelper(value: unknown): value is LinuxFdHelper {
  return record(value) && value.abiVersion === 4
    && typeof value.openAnchor === 'function' && typeof value.openRead === 'function' && typeof value.closeRead === 'function'
    && typeof value.canonicalPath === 'function' && typeof value.openMetadata === 'function' && typeof value.closeAnchor === 'function' && typeof value.probeKernel === 'function'
}

class WorkerFailure extends Error {
  constructor(readonly code: FsErrorCode, readonly syscallCode?: string) {
    super(code)
  }
}

class AnchorCloseFailure extends Error {}

function closeAnchor(native: LinuxFdHelper): void {
  try { native.closeAnchor() } catch (error) {
    throw new AnchorCloseFailure('Project anchor close is unconfirmed', { cause: error })
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function input(value: unknown): FdWorkerInput {
  if (!record(value) || process.platform !== 'linux'
    || typeof value.helperPath !== 'string' || !isAbsolute(value.helperPath) || !value.helperPath.endsWith('.node')
    || typeof value.maxReadBytes !== 'number' || !Number.isSafeInteger(value.maxReadBytes) || value.maxReadBytes < 1 || value.maxReadBytes > 2_147_483_646
    || typeof value.maxPathBytes !== 'number' || !Number.isSafeInteger(value.maxPathBytes) || value.maxPathBytes < 1 || value.maxPathBytes > 16384
    || typeof value.maxResolveRetries !== 'number' || !Number.isSafeInteger(value.maxResolveRetries) || value.maxResolveRetries < 0
    || typeof value.readChunkBytes !== 'number' || !Number.isSafeInteger(value.readChunkBytes) || value.readChunkBytes < 1 || value.readChunkBytes > value.maxReadBytes + 1
    || Buffer.byteLength(value.helperPath) > value.maxPathBytes) {
    throw new WorkerFailure('FS_IO_ERROR')
  }
  return {
    helperPath: value.helperPath,
    maxReadBytes: value.maxReadBytes, maxPathBytes: value.maxPathBytes,
    maxResolveRetries: value.maxResolveRetries, readChunkBytes: value.readChunkBytes,
  }
}

function helper(path: string): LinuxFdHelper {
  const loaded: unknown = createRequire(import.meta.url)(path)
  if (!isHelper(loaded)) {
    throw new WorkerFailure('FS_IO_ERROR')
  }
  const openAnchor = loaded.openAnchor
  const openRead = loaded.openRead
  const openMetadata = loaded.openMetadata
  const closeRead = loaded.closeRead
  const closeAnchor = loaded.closeAnchor
  const canonicalPath = loaded.canonicalPath
  const probeKernel = loaded.probeKernel
  return {
    openAnchor: (path, device, inode) => { openAnchor(path, device, inode) },
    openRead: (path) => {
      const fd: unknown = openRead(path)
      if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) throw new WorkerFailure('FS_IO_ERROR')
      return fd
    },
    openMetadata: (path) => {
      const fd: unknown = openMetadata(path)
      if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) throw new WorkerFailure('FS_IO_ERROR')
      return fd
    },
    closeRead: () => { closeRead() },
    closeAnchor: () => { closeAnchor() },
    canonicalPath: (path, maxPathBytes) => {
      const raw: unknown = canonicalPath(path, maxPathBytes)
      if (!(raw instanceof Uint8Array) || raw.byteLength > 2 * maxPathBytes + 1) throw new WorkerFailure('FS_IO_ERROR')
      return raw
    },
    probeKernel: () => { probeKernel() },
  }
}

function failure(error: unknown): { code: FsErrorCode; syscallCode?: string } {
  if (error instanceof WorkerFailure) return {
    code: error.code, ...error.syscallCode === undefined ? {} : { syscallCode: error.syscallCode },
  }
  const syscallCode = record(error) && typeof error.code === 'string' ? error.code : 'EIO'
  const code: FsErrorCode = syscallCode === 'ENOENT' ? 'FS_NOT_FOUND'
    : ['EXDEV', 'ELOOP', 'EPERM', 'EACCES', 'ESTALE'].includes(syscallCode) ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR'
  return { code, syscallCode }
}

function taskRequest(value: unknown, limits: FdWorkerInput): FdTaskRequest {
  if (!record(value) || !['read', 'stat', 'stream'].includes(String(value.kind)) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || !record(value.root) || typeof value.root.rootPath !== 'string' || !isAbsolute(value.root.rootPath)
    || Buffer.byteLength(value.root.rootPath) > limits.maxPathBytes
    || typeof value.root.rootDevice !== 'string' || !/^\d{1,20}$/.test(value.root.rootDevice)
    || typeof value.root.rootInode !== 'string' || !/^\d{1,20}$/.test(value.root.rootInode)
    || typeof value.relativePath !== 'string' || value.relativePath.length === 0
    || isAbsolute(value.relativePath) || value.relativePath.includes('\0')
    || value.relativePath.split('/').includes('..') || Buffer.byteLength(value.relativePath) > limits.maxPathBytes
    || typeof value.maxBytes !== 'number' || !Number.isSafeInteger(value.maxBytes)
    || value.maxBytes < 0 || value.maxBytes > limits.maxReadBytes
    || !(value.cancel instanceof SharedArrayBuffer) || value.cancel.byteLength !== 4) {
    throw new WorkerFailure('FS_PERMISSION_DENIED')
  }
  return {
    kind: value.kind as FdTaskRequest['kind'], id: value.id as FdTaskRequest['id'], relativePath: value.relativePath, maxBytes: value.maxBytes, cancel: value.cancel,
    root: { rootPath: value.root.rootPath, rootDevice: value.root.rootDevice, rootInode: value.root.rootInode },
  }
}

function readBytes(native: LinuxFdHelper, request: FdTaskRequest, limits: FdWorkerInput): Uint8Array<ArrayBuffer> {
  const cancelled = new Int32Array(request.cancel)
  const assertRunning = (): void => {
    if (Atomics.load(cancelled, 0) !== 0) throw new WorkerFailure('FS_ABORTED')
  }
  let fd: number
  let attempts = 0
  while (true) {
    assertRunning()
    try { fd = native.openRead(request.relativePath); break } catch (error) {
      if (!record(error) || error.code !== 'EAGAIN' || attempts++ >= limits.maxResolveRetries) throw error
    }
  }
  try {
    const metadata = fstatSync(fd, { bigint: true })
    if (!metadata.isFile() || metadata.nlink !== 1n) throw new WorkerFailure('FS_NOT_REGULAR_FILE')
    if (metadata.size > BigInt(request.maxBytes)) throw new WorkerFailure('FS_TOO_LARGE')
    const bytes = new Uint8Array(request.maxBytes + 1)
    let total = 0
    while (total < bytes.byteLength) {
      assertRunning()
      const count = readSync(fd, bytes, total, Math.min(limits.readChunkBytes, bytes.byteLength - total), null)
      if (count === 0) break
      total += count
      if (total > request.maxBytes) throw new WorkerFailure('FS_TOO_LARGE')
    }
    assertRunning()
    return bytes.subarray(0, total)
  } finally { native.closeRead() }
}

function openWithRetry(native: LinuxFdHelper, request: Pick<FdTaskRequest, 'relativePath' | 'cancel'>, limits: FdWorkerInput, metadata: boolean): number {
  let attempts = 0
  while (true) {
    if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) throw new WorkerFailure('FS_ABORTED')
    try { return metadata ? native.openMetadata(request.relativePath) : native.openRead(request.relativePath) } catch (error) {
      if (!record(error) || error.code !== 'EAGAIN' || attempts++ >= limits.maxResolveRetries) throw error
    }
  }
}

function metadata(native: LinuxFdHelper, request: FdTaskRequest, limits: FdWorkerInput): FdMetadata | undefined {
  let fd: number
  try { fd = openWithRetry(native, request, limits, true) } catch (error) {
    if (record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
  try {
    const info = fstatSync(fd, { bigint: true })
    if ((!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1n)) throw new WorkerFailure('FS_PERMISSION_DENIED')
    if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkerFailure('FS_TOO_LARGE')
    return {
      identity: `${info.dev}:${info.ino}`, version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      type: info.isFile() ? 'file' : 'directory', ...info.isFile() ? { size: Number(info.size) } : {},
    }
  } finally { native.closeRead() }
}

function directoryRequest(value: unknown, limits: FdWorkerInput): FdDirectoryRequest {
  if (!record(value) || value.kind !== 'directory' || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || !record(value.root) || typeof value.root.rootPath !== 'string' || !isAbsolute(value.root.rootPath)
    || value.root.rootPath.includes('\0') || Buffer.byteLength(value.root.rootPath) > limits.maxPathBytes
    || typeof value.root.rootDevice !== 'string' || !/^\d{1,20}$/.test(value.root.rootDevice)
    || typeof value.root.rootInode !== 'string' || !/^\d{1,20}$/.test(value.root.rootInode)
    || typeof value.relativePath !== 'string' || value.relativePath.length === 0 || isAbsolute(value.relativePath)
    || value.relativePath.includes('\0') || Buffer.byteLength(value.relativePath) > limits.maxPathBytes
    || !(value.cancel instanceof SharedArrayBuffer) || value.cancel.byteLength !== 4) throw new WorkerFailure('FS_PERMISSION_DENIED')
  return {
    kind: 'directory', id: value.id as FdDirectoryRequest['id'], relativePath: value.relativePath, cancel: value.cancel,
    root: { rootPath: value.root.rootPath, rootDevice: value.root.rootDevice, rootInode: value.root.rootInode },
  }
}

function observeDirectory(native: LinuxFdHelper, request: FdDirectoryRequest, limits: FdWorkerInput): FdWorkerReply {
  let phase: 'anchor' | 'target' | 'verify' = 'anchor'
  let anchor = false
  let reader = false
  const assertRunning = (): void => {
    if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) throw new WorkerFailure('FS_ABORTED')
  }
  const closeReader = (): void => {
    try { native.closeRead() } catch (error) { throw new AnchorCloseFailure('Metadata FD close is unconfirmed', { cause: error }) }
    reader = false
  }
  try {
    assertRunning()
    native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode)
    anchor = true
    phase = 'target'
    const fd = openWithRetry(native, request, limits, true)
    reader = true
    phase = 'verify'
    const info = fstatSync(fd, { bigint: true })
    if ((!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1n)) throw new WorkerFailure('FS_PERMISSION_DENIED')
    let canonicalPath: string
    let anchorPath: string
    let attempts = 0
    while (true) {
      assertRunning()
      try {
        const bytes = native.canonicalPath(request.root.rootPath, limits.maxPathBytes)
        const separator = bytes.indexOf(0)
        if (separator < 1 || separator > limits.maxPathBytes || bytes.byteLength - separator - 1 > limits.maxPathBytes) {
          throw new WorkerFailure('FS_IO_ERROR')
        }
        anchorPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, separator))
        canonicalPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(separator + 1))
        break
      } catch (error) {
        if (!record(error) || error.code !== 'EAGAIN' || attempts++ >= limits.maxResolveRetries) throw error
      }
    }
    assertRunning()
    closeReader()
    closeAnchor(native)
    anchor = false
    return { kind: 'directory-reply', id: request.id, ok: true, value: { anchorPath, canonicalPath, directory: info.isDirectory() } }
  } catch (error) {
    if (error instanceof AnchorCloseFailure) throw error
    if (reader) closeReader()
    if (anchor) closeAnchor(native)
    const observed = failure(error)
    const syscallCode = observed.syscallCode !== undefined && /^[A-Z]{1,16}$/.test(observed.syscallCode) ? observed.syscallCode : undefined
    return {
      kind: 'directory-reply', id: request.id, ok: false, phase,
      code: syscallCode === 'ENOTDIR' ? 'FS_NOT_DIRECTORY' : observed.code,
      ...syscallCode === undefined ? {} : { syscallCode },
    }
  }
}

function start(): void {
  const port = parentPort
  if (port === null) throw new Error('files worker requires a parent port')
  let limits: FdWorkerInput
  let native: LinuxFdHelper
  try {
    const raw: unknown = workerData
    limits = input(raw)
    native = helper(limits.helperPath)
    native.probeKernel()
  } catch (error) {
    port.postMessage({ kind: 'startup-failed', ...failure(error) } satisfies FdWorkerReply)
    port.close()
    return
  }
  let active: { request: FdTaskRequest; fd: number; total: number } | undefined
  let endedStreamId: FdTaskRequest['id'] | undefined
  const endStream = (error?: unknown): void => {
    if (active === undefined) throw new Error('files stream has no owned FD')
    const { request } = active
    // An unconfirmed descriptor close is fatal, never a stream completion reply.
    try { native.closeRead() } catch (error) { throw new AnchorCloseFailure('Stream FD close is unconfirmed', { cause: error }) }
    closeAnchor(native)
    active = undefined
    endedStreamId = request.id
    port.postMessage(error === undefined
      ? { kind: 'stream-end', id: request.id } satisfies FdWorkerReply
      : { kind: 'reply', id: request.id, ok: false, ...failure(error) } satisfies FdWorkerReply)
  }
  port.on('message', (raw: unknown) => {
    if (record(raw) && (raw.kind === 'stream-pull' || raw.kind === 'stream-cancel')) {
      if (active === undefined && raw.kind === 'stream-cancel' && raw.id === endedStreamId) return
      if (active === undefined || raw.id !== active.request.id) { port.close(); return }
      if (raw.kind === 'stream-cancel' || Atomics.load(new Int32Array(active.request.cancel), 0) !== 0) {
        endStream(new WorkerFailure('FS_ABORTED'))
        return
      }
      try {
        const bytes = new Uint8Array(Math.min(limits.readChunkBytes, active.request.maxBytes - active.total + 1))
        const count = readSync(active.fd, bytes, 0, bytes.byteLength, null)
        active.total += count
        if (active.total > active.request.maxBytes) throw new WorkerFailure('FS_TOO_LARGE')
        if (count === 0) { endStream(); return }
        if (Atomics.load(new Int32Array(active.request.cancel), 0) !== 0) throw new WorkerFailure('FS_ABORTED')
        port.postMessage({ kind: 'stream-chunk', id: active.request.id, bytes: bytes.subarray(0, count) } satisfies FdWorkerReply, [bytes.buffer])
      } catch (error) {
        if (error instanceof AnchorCloseFailure) throw error
        endStream(error)
      }
      return
    }
    if (active !== undefined) { port.close(); return }
    if (record(raw) && raw.kind === 'directory') {
      let request: FdDirectoryRequest
      try { request = directoryRequest(raw, limits) } catch (_error) { port.close(); return }
      port.postMessage(observeDirectory(native, request, limits))
      return
    }
    let request: FdTaskRequest
    try { request = taskRequest(raw, limits) } catch (_error) {
      // Malformed private commands require actual exit and helper environment cleanup.
      port.close()
      return
    }
    let opened = false
    try {
      native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode)
      opened = true
      if (request.kind === 'stream') {
        const fd = openWithRetry(native, request, limits, false)
        const info = fstatSync(fd, { bigint: true })
        if (!info.isFile() || info.nlink !== 1n) { native.closeRead(); throw new WorkerFailure('FS_NOT_REGULAR_FILE') }
        if (info.size > BigInt(request.maxBytes)) { native.closeRead(); throw new WorkerFailure('FS_TOO_LARGE') }
        active = { request, fd, total: 0 }
        port.postMessage({ kind: 'stream-ready', id: request.id } satisfies FdWorkerReply)
        return
      }
      if (request.kind === 'stat') {
        const info = metadata(native, request, limits)
        closeAnchor(native)
        opened = false
        port.postMessage({ kind: 'stat-reply', id: request.id, metadata: info } satisfies FdWorkerReply)
        return
      }
      const bytes = readBytes(native, request, limits)
      closeAnchor(native)
      opened = false
      port.postMessage({ kind: 'reply', id: request.id, ok: true, bytes } satisfies FdWorkerReply, [bytes.buffer])
    } catch (error) {
      if (error instanceof AnchorCloseFailure) throw error
      if (opened) closeAnchor(native)
      if (request.kind === 'stream') endedStreamId = request.id
      port.postMessage({ kind: 'reply', id: request.id, ok: false, ...failure(error) } satisfies FdWorkerReply)
    }
  })
  port.postMessage({ kind: 'ready', abiVersion: 4 } satisfies FdWorkerReply)
}

start()
