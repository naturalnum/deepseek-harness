/** Linux-only private worker: all blocking root/open/stat/read/close calls stay here. */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fstatSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { FdTaskRequest, FdWorkerInput, FdWorkerReply, FdMetadata, FdDirectoryRequest, FdLeafRequest, FdTextWriteRequest, FdContentLimits, FdContentRequest, FdPathMetadata, FdDirectoryEntry } from './worker-protocol.ts'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { directoryWorkBudget } from './directory-budget.ts'
import { cancelledLeafFrame, parseLeafFrame } from './leaf-frame.ts'
import { createStorageWorker, storageRequest } from './storage-worker.ts'
import type { StaticStorageConfig } from './storage-types.ts'

interface LinuxFdHelper {
  readonly abiVersion: 6 | 7 | 8
  writeText?(this: void, rootPath: string, relativePath: string, temporary: string, bytes: Uint8Array,
    maximum: number, guard: string, expected: string, cancel: Int32Array<SharedArrayBuffer>): unknown
  openPathMetadata?(this: void, relativePath: string): number
  verifyContentAnchor?(this: void, rootPath: string): void
  listDirectory?(this: void, rootPath: string, relativePath: string, maxEntries: number, maxBytes: number,
    maxNameBytes: number, timeoutMs: number, cancel: Int32Array<SharedArrayBuffer>): unknown
  openAnchor(this: void, path: string, device: string, inode: string, mountId: string): void
  openRead(this: void, relativePath: string): number
  openMetadata(this: void, relativePath: string): number
  closeRead(this: void): void
  closeAnchor(this: void): void
  canonicalPath(this: void, rootPath: string, maxPathBytes: number): Uint8Array
  probeKernel(this: void): void
  prepareLeaf(this: void, path: string, device: string, inode: string, leaf: string, limit: number, retries: number): Uint8Array
  prepareExt4Leaf(
    this: void, path: string, device: string, inode: string, leaf: string, mountId: string, limit: number, retries: number,
  ): Uint8Array
  removeExt4Leaf(
    this: void, path: string, device: string, inode: string, leaf: string,
    leafDevice: string, leafInode: string, mountId: string, limit: number, retries: number,
  ): Uint8Array
  removeEmptyLeaf(
    this: void, path: string, device: string, inode: string, leaf: string,
    leafDevice: string, leafInode: string, limit: number, retries: number,
  ): Uint8Array
}

function isHelper(value: unknown): value is LinuxFdHelper {
  return record(value) && (value.abiVersion === 6 || value.abiVersion === 7 || value.abiVersion === 8)
    && (value.abiVersion === 6 || typeof value.writeText === 'function')
    && (value.abiVersion !== 8 || typeof value.openPathMetadata === 'function'
      && typeof value.verifyContentAnchor === 'function' && typeof value.listDirectory === 'function')
    && typeof value.prepareExt4Leaf === 'function' && typeof value.removeExt4Leaf === 'function'
    && typeof value.prepareLeaf === 'function' && typeof value.removeEmptyLeaf === 'function'
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
    ...value.content === undefined ? {} : { content: contentLimits(value.content, value.maxPathBytes) },
    maxReadBytes: value.maxReadBytes, maxPathBytes: value.maxPathBytes,
    maxResolveRetries: value.maxResolveRetries, readChunkBytes: value.readChunkBytes,
    ...value.storageProbe === undefined ? {} : { storageProbe: storageConfig(value.storageProbe) },
  }
}

function contentLimits(value: unknown, maxPathBytes: number): FdContentLimits {
  if (!record(value) || ['maxEntries', 'maxNameBytes', 'maxReplyBytes', 'operationTimeoutMs'].some(key =>
    typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 2_147_483_647)
    || typeof value.maxEntries !== 'number' || typeof value.maxNameBytes !== 'number' || value.maxNameBytes > maxPathBytes
    || value.maxNameBytes > 16384
    || typeof value.maxReplyBytes !== 'number' || typeof value.operationTimeoutMs !== 'number') throw new WorkerFailure('FS_PERMISSION_DENIED')
  return { maxEntries: value.maxEntries, maxNameBytes: value.maxNameBytes, maxReplyBytes: value.maxReplyBytes,
    operationTimeoutMs: value.operationTimeoutMs }
}

function storageConfig(value: unknown): StaticStorageConfig {
  if (!record(value) || typeof value.planPath !== 'string' || typeof value.planSha256 !== 'string'
    || typeof value.probeHelperPath !== 'string' || typeof value.probeHelperSha256 !== 'string'
    || typeof value.maxProbeAssetBytes !== 'number' || typeof value.rootProbeReservationBytes !== 'number'
    || typeof value.maxPlanBytes !== 'number' || typeof value.maxMountInfoBytes !== 'number' || typeof value.probeTimeoutMs !== 'number') {
    throw new WorkerFailure('FS_IO_ERROR')
  }
  return { planPath: value.planPath, planSha256: value.planSha256, probeHelperPath: value.probeHelperPath,
    probeHelperSha256: value.probeHelperSha256, maxProbeAssetBytes: value.maxProbeAssetBytes,
    rootProbeReservationBytes: value.rootProbeReservationBytes, maxPlanBytes: value.maxPlanBytes,
    maxMountInfoBytes: value.maxMountInfoBytes, probeTimeoutMs: value.probeTimeoutMs }
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
  const prepareLeaf = loaded.prepareLeaf
  const removeEmptyLeaf = loaded.removeEmptyLeaf
  const prepareExt4Leaf = loaded.prepareExt4Leaf
  const removeExt4Leaf = loaded.removeExt4Leaf
  return {
    abiVersion: loaded.abiVersion,
    ...loaded.openPathMetadata === undefined ? {} : { openPathMetadata: loaded.openPathMetadata },
    ...loaded.verifyContentAnchor === undefined ? {} : { verifyContentAnchor: loaded.verifyContentAnchor },
    ...loaded.listDirectory === undefined ? {} : { listDirectory: loaded.listDirectory },
    ...loaded.writeText === undefined ? {} : { writeText: loaded.writeText },
    openAnchor: (path, device, inode, mountId) => {
      try { openAnchor(path, device, inode, mountId) } catch (error) {
        if (record(error) && error.code === 'DSH_FD_CLOSE') throw new AnchorCloseFailure('Mount validation close is unconfirmed')
        throw error
      }
    },
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
    prepareLeaf: (path, device, inode, leaf, limit, retries) => prepareLeaf(path, device, inode, leaf, limit, retries),
    prepareExt4Leaf: (path, device, inode, leaf, mountId, limit, retries) =>
      prepareExt4Leaf(path, device, inode, leaf, mountId, limit, retries),
    removeExt4Leaf: (path, device, inode, leaf, leafDevice, leafInode, mountId, limit, retries) =>
      removeExt4Leaf(path, device, inode, leaf, leafDevice, leafInode, mountId, limit, retries),
    removeEmptyLeaf: (path, device, inode, leaf, leafDevice, leafInode, limit, retries) =>
      removeEmptyLeaf(path, device, inode, leaf, leafDevice, leafInode, limit, retries),
  }
}

function mountField(root: Record<string, unknown>): { readonly rootMountId?: string } {
  if (root.rootMountId === undefined) return {}
  if (typeof root.rootMountId !== 'string' || root.rootMountId.length > 20 || !/^[1-9]\d{0,19}$/.test(root.rootMountId)) {
    throw new WorkerFailure('FS_PERMISSION_DENIED')
  }
  return { rootMountId: root.rootMountId }
}

function leafRequest(value: unknown, limits: FdWorkerInput): FdLeafRequest {
  if (!record(value) || (value.kind !== 'leaf-prepare' && value.kind !== 'leaf-cleanup')
    || (value.backend !== 'tmpfs' && value.backend !== 'ext4')
    || typeof value.id !== 'string' || value.id.length !== 36 || !/^[a-f0-9-]{36}$/.test(value.id)
    || !record(value.root) || typeof value.root.rootPath !== 'string' || typeof value.root.rootDevice !== 'string'
    || typeof value.root.rootInode !== 'string' || typeof value.leaf !== 'string'
    || !(value.cancel instanceof SharedArrayBuffer) || value.cancel.byteLength !== 4) throw new WorkerFailure('FS_IO_ERROR')
  const root = { rootPath: value.root.rootPath, rootDevice: value.root.rootDevice,
    rootInode: value.root.rootInode, ...mountField(value.root) }
  if (value.backend === 'ext4' && root.rootMountId === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
  directoryWorkBudget({ parent: root, leaf: value.leaf }, { maxPathBytes: limits.maxPathBytes, replyOverheadBytes: 1 })
  if (value.kind === 'leaf-prepare') return { kind: value.kind, id: value.id as FdLeafRequest['id'], root, backend: value.backend, leaf: value.leaf, cancel: value.cancel }
  const identity = value.identity
  if (!record(identity) || typeof identity.device !== 'string' || identity.device.length > 20 || !/^\d{1,20}$/.test(identity.device)
    || typeof identity.inode !== 'string' || identity.inode.length > 20 || !/^\d{1,20}$/.test(identity.inode)) throw new WorkerFailure('FS_IO_ERROR')
  return { kind: value.kind, id: value.id as FdLeafRequest['id'], root, backend: value.backend, leaf: value.leaf, cancel: value.cancel,
    identity: { device: identity.device, inode: identity.inode } }
}

function leafOperation(native: LinuxFdHelper, request: FdLeafRequest, limits: FdWorkerInput): Uint8Array<ArrayBuffer> {
  const operation = request.kind === 'leaf-prepare' ? 1 : 2
  if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) return cancelledLeafFrame(operation, request.backend)
  const { root, leaf } = request
  let raw: unknown
  if (request.backend === 'ext4') {
    if (root.rootMountId === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
    raw = request.kind === 'leaf-prepare'
      ? native.prepareExt4Leaf(root.rootPath, root.rootDevice, root.rootInode, leaf,
        root.rootMountId, limits.maxPathBytes, limits.maxResolveRetries)
      : native.removeExt4Leaf(root.rootPath, root.rootDevice, root.rootInode, leaf,
        request.identity.device, request.identity.inode, root.rootMountId, limits.maxPathBytes, limits.maxResolveRetries)
  } else {
    raw = request.kind === 'leaf-prepare'
      ? native.prepareLeaf(root.rootPath, root.rootDevice, root.rootInode, leaf, limits.maxPathBytes, limits.maxResolveRetries)
      : native.removeEmptyLeaf(root.rootPath, root.rootDevice, root.rootInode, leaf,
        request.identity.device, request.identity.inode, limits.maxPathBytes, limits.maxResolveRetries)
  }
  if (parseLeafFrame(raw, operation, root, request.kind === 'leaf-cleanup' ? request.identity : undefined, request.backend) === undefined
    || !(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer)) throw new WorkerFailure('FS_IO_ERROR')
  // Cancellation after C must retain its real creation/unlink facts instead of replacing the reply.
  return new Uint8Array(raw.buffer, 0, 64)
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
    root: { rootPath: value.root.rootPath, rootDevice: value.root.rootDevice, rootInode: value.root.rootInode, ...mountField(value.root) },
  }
}

function textWriteRequest(value: unknown, limits: FdWorkerInput): FdTextWriteRequest {
  if (!record(value) || value.kind !== 'text-write' || typeof value.content !== 'string'
    || Buffer.byteLength(value.content) > limits.maxReadBytes || value.maxBytes !== limits.maxReadBytes) throw new WorkerFailure('FS_TOO_LARGE')
  const request = taskRequest({ ...value, kind: 'read' }, limits)
  const expected = value.expected
  const base = { ...request, kind: 'text-write' as const, content: value.content }
  if (expected === undefined) return base
  if (record(expected) && expected.kind === 'createIfAbsent') return { ...base, expected: { kind: 'createIfAbsent' } }
  if (record(expected) && expected.kind === 'replaceIfVersion' && typeof expected.version === 'string'
    && /^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(expected.version)) {
    return { ...base, expected: { kind: 'replaceIfVersion', version: FsVersion(expected.version) } }
  }
  throw new WorkerFailure('FS_PERMISSION_DENIED')
}

function textWrite(native: LinuxFdHelper, request: FdTextWriteRequest): FdWorkerReply {
  let opened = false
  let attempted = false
  try {
    if ((native.abiVersion !== 7 && native.abiVersion !== 8) || native.writeText === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
    native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode, request.root.rootMountId ?? '0')
    opened = true
    const expected = request.expected
    attempted = true
    const result = native.writeText(request.root.rootPath, request.relativePath, `.dsh-text-${randomUUID()}.tmp`,
      Buffer.from(request.content, 'utf8'), request.maxBytes,
      expected === undefined ? 'unconditional' : expected.kind === 'createIfAbsent' ? 'create' : 'replace',
      expected?.kind === 'replaceIfVersion' ? expected.version : '', new Int32Array(request.cancel))
    if (!record(result) || (result.operation !== 'create' && result.operation !== 'update')
      || typeof result.version !== 'string' || !/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(result.version)
      || (result.before !== null && (!(result.before instanceof Uint8Array) || result.before.byteLength > request.maxBytes))) {
      throw new AnchorCloseFailure('Text publication reply is unconfirmed')
    }
    let before: string | null = null
    if (result.before instanceof Uint8Array && !result.before.subarray(0, 8192).includes(0)) {
      try { before = new TextDecoder('utf-8', { fatal: true }).decode(result.before).replace(/\r\n?/g, '\n') }
      catch (error) { if (!(error instanceof TypeError)) throw error /* Non-text prior content has no contextual diff. */ }
    }
    closeAnchor(native)
    opened = false
    return { kind: 'text-write-reply', id: request.id, result: { operation: result.operation, version: result.version,
      before, after: request.content.replace(/\r\n?/g, '\n') } }
  } catch (error) {
    if (error instanceof AnchorCloseFailure) throw error
    if (opened) closeAnchor(native)
    const outcome = !attempted || record(error) && error.outcome === 'not-published' || error instanceof WorkerFailure ? 'not-published' : 'unknown'
    const observed = failure(error)
    const code = record(error) && error.code === 'DSH_TEXT_STALE' ? 'FS_STALE_VERSION'
      : record(error) && error.code === 'EEXIST' ? 'FS_NOT_OBSERVED'
        : record(error) && error.code === 'ECANCELED' ? 'FS_ABORTED'
          : record(error) && error.code === 'EFBIG' ? 'FS_TOO_LARGE'
            : record(error) && error.code === 'EISDIR' ? 'FS_NOT_REGULAR_FILE' : observed.code
    const syscallCode = code === 'FS_STALE_VERSION' ? 'ESTALE' : observed.syscallCode
    return { kind: 'text-write-failure', id: request.id, code: outcome === 'unknown' ? 'FS_IO_ERROR' : code, outcome,
      ...syscallCode === undefined ? {} : { syscallCode } }
  }
}

function contentRequest(value: unknown, limits: FdWorkerInput): FdContentRequest {
  if (!record(value) || !['lstat', 'list', 'range'].includes(String(value.kind))) throw new WorkerFailure('FS_PERMISSION_DENIED')
  const base = taskRequest({ ...value, kind: 'read', maxBytes: value.kind === 'range' ? value.maxBytes : 0 }, limits)
  const shared = { id: base.id, root: base.root, relativePath: base.relativePath, cancel: base.cancel }
  if (value.kind === 'lstat') return { ...shared, kind: 'lstat' }
  const config = limits.content
  if (config === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
  if (value.kind === 'list') {
    if (typeof value.maxEntries !== 'number' || !Number.isSafeInteger(value.maxEntries) || value.maxEntries < 1
      || value.maxEntries > config.maxEntries || typeof value.maxBytes !== 'number' || !Number.isSafeInteger(value.maxBytes)
      || value.maxBytes < 1 || value.maxBytes > config.maxReplyBytes) throw new WorkerFailure('FS_TOO_LARGE')
    return { ...shared, kind: 'list', maxEntries: value.maxEntries, maxBytes: value.maxBytes }
  }
  if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.length !== 'number' || !Number.isSafeInteger(value.length) || value.length < 0
    || !Number.isSafeInteger(value.offset + value.length) || value.length > base.maxBytes) throw new WorkerFailure('FS_TOO_LARGE')
  return { ...shared, kind: 'range', offset: value.offset, length: value.length, maxBytes: base.maxBytes }
}

function closeContentRead(native: LinuxFdHelper): void {
  try { native.closeRead() } catch (error) { throw new AnchorCloseFailure('Content FD close is unconfirmed', { cause: error }) }
}

function contentOperation(native: LinuxFdHelper, request: FdContentRequest, limits: FdWorkerInput): FdWorkerReply {
  let opened = false
  try {
    const config = limits.content
    if (native.abiVersion !== 8 || config === undefined || native.openPathMetadata === undefined
      || native.listDirectory === undefined || native.verifyContentAnchor === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
    const deadline = performance.now() + config.operationTimeoutMs
    const running = (): void => {
      if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) throw new WorkerFailure('FS_ABORTED', 'ECANCELED')
      if (performance.now() >= deadline) throw new WorkerFailure('FS_ABORTED', 'ETIMEDOUT')
    }
    if (request.kind === 'range' && request.length + 128 > config.maxReplyBytes) throw new WorkerFailure('FS_TOO_LARGE')
    running()
    native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode, request.root.rootMountId ?? '0')
    opened = true
    let reply: FdWorkerReply
    if (request.kind === 'list') {
      const rows = native.listDirectory(request.root.rootPath, request.relativePath, request.maxEntries,
        request.maxBytes, config.maxNameBytes, Math.max(1, Math.ceil(deadline - performance.now())), new Int32Array(request.cancel))
      if (!Array.isArray(rows) || rows.length > request.maxEntries) throw new AnchorCloseFailure('Unbounded native directory reply')
      const entries: FdDirectoryEntry[] = rows.map((row: unknown) => {
        running()
        if (!record(row) || !(row.nameBytes instanceof Uint8Array) || row.nameBytes.byteLength > config.maxNameBytes
          || typeof row.identity !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(row.identity)
          || typeof row.version !== 'string' || !/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(row.version)
          || !row.version.startsWith(row.identity + ':')
          || typeof row.size === 'number' && Number(row.version.split(':')[2]) !== row.size
          || !['file', 'directory', 'symlink', 'other'].includes(String(row.type))
          || (row.type === 'file' || row.type === 'symlink'
            ? typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0 : row.size !== undefined)) throw new AnchorCloseFailure('Invalid native directory metadata')
        let name: string
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(row.nameBytes) }
        catch (_error) { throw new WorkerFailure('FS_IO_ERROR') }
        if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new WorkerFailure('FS_PERMISSION_DENIED')
        return { name, identity: row.identity, version: row.version, type: row.type as FdPathMetadata['type'],
          ...typeof row.size === 'number' ? { size: row.size } : {} }
      })
      entries.sort((a, b) => { running(); return Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) })
      reply = { kind: 'list-reply', id: request.id, entries }
    } else {
      let fd: number | undefined, attempts = 0
      try {
        while (true) {
          running()
          try { fd = request.kind === 'lstat' ? native.openPathMetadata(request.relativePath) : native.openRead(request.relativePath); break }
          catch (error) {
            if (request.kind === 'lstat' && record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) break
            if (!record(error) || error.code !== 'EAGAIN' || attempts++ >= limits.maxResolveRetries) throw error
          }
        }
        if (request.kind === 'lstat') {
          let metadata: FdPathMetadata | undefined
          if (fd !== undefined) {
            const info = fstatSync(fd, { bigint: true })
            if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkerFailure('FS_TOO_LARGE')
            metadata = { identity: `${info.dev}:${info.ino}`, version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
              type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
              ...info.isFile() || info.isSymbolicLink() ? { size: Number(info.size) } : {} }
          }
          reply = { kind: 'lstat-reply', id: request.id, metadata }
        } else {
          if (fd === undefined) throw new WorkerFailure('FS_IO_ERROR')
          const info = fstatSync(fd, { bigint: true })
          if (!info.isFile() || info.nlink !== 1n) throw new WorkerFailure('FS_NOT_REGULAR_FILE')
          const bytes = new Uint8Array(request.length)
          let total = 0
          while (total < bytes.byteLength) {
            running()
            const count = readSync(fd, bytes, total, Math.min(limits.readChunkBytes, bytes.byteLength - total), request.offset + total)
            if (count === 0) break
            total += count
          }
          running()
          reply = { kind: 'range-reply', id: request.id, bytes: total === bytes.byteLength ? bytes : bytes.slice(0, total) }
        }
      } finally { if (fd !== undefined) closeContentRead(native) }
    }
    running()
    native.verifyContentAnchor(request.root.rootPath)
    closeAnchor(native); opened = false
    running()
    if (request.kind !== 'range' && Buffer.byteLength(JSON.stringify(reply)) > Math.min(config.maxReplyBytes,
      request.kind === 'list' ? request.maxBytes : 1024)) throw new WorkerFailure('FS_TOO_LARGE')
    return reply
  } catch (error) {
    if (error instanceof AnchorCloseFailure || record(error) && error.code === 'DSH_FD_CLOSE') throw error
    if (opened) closeAnchor(native)
    const observed = failure(error)
    const code = record(error) && error.code === 'EFBIG' ? 'FS_TOO_LARGE'
      : record(error) && error.code === 'ENOTDIR' ? 'FS_NOT_DIRECTORY'
        : record(error) && (error.code === 'ECANCELED' || error.code === 'ETIMEDOUT') ? 'FS_ABORTED' : observed.code
    return { kind: 'reply', id: request.id, ok: false, ...observed, code }
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
    root: { rootPath: value.root.rootPath, rootDevice: value.root.rootDevice, rootInode: value.root.rootInode, ...mountField(value.root) },
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
    native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode, request.root.rootMountId ?? '0')
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
  let storage: ReturnType<typeof createStorageWorker> | undefined
  try {
    const raw: unknown = workerData
    limits = input(raw)
    if (limits.storageProbe !== undefined) storage = createStorageWorker(limits.storageProbe, limits.maxPathBytes, limits.helperPath)
    native = helper(limits.helperPath)
    if (native.abiVersion === 8 && limits.content === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
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
    if (record(raw) && ['lstat', 'list', 'range'].includes(String(raw.kind))) {
      let request: FdContentRequest
      try { request = contentRequest(raw, limits) } catch (error) {
        if (error instanceof WorkerFailure && error.code === 'FS_TOO_LARGE') {
          port.postMessage({ kind: 'reply', id: raw.id, ok: false, code: error.code }); return
        }
        port.close(); return
      }
      const reply = contentOperation(native, request, limits)
      if (reply.kind === 'range-reply') port.postMessage(reply, [reply.bytes.buffer])
      else port.postMessage(reply)
      return
    }
    if (record(raw) && raw.kind === 'text-write') {
      let request: FdTextWriteRequest
      try { request = textWriteRequest(raw, limits) } catch (_error) { port.close(); return }
      port.postMessage(textWrite(native, request))
      return
    }
    if (record(raw) && ['storage-probe', 'storage-record', 'storage-view'].includes(String(raw.kind))) {
      if (storage === undefined) throw new WorkerFailure('FS_PERMISSION_DENIED')
      const request = storageRequest(raw, limits.maxPathBytes)
      if (Atomics.load(new Int32Array(request.cancel), 0) !== 0) {
        port.postMessage({ kind: 'reply', id: request.id, ok: false, code: 'FS_ABORTED' } satisfies FdWorkerReply)
      } else if (request.kind === 'storage-probe') {
        const frame = storage.probe(request.path)
        port.postMessage({ kind: 'storage-probe-reply', id: request.id, frame } satisfies FdWorkerReply, [frame.buffer])
      } else if (request.kind === 'storage-record') {
        const bytes = storage.record()
        port.postMessage({ kind: 'storage-record-reply', id: request.id, bytes } satisfies FdWorkerReply, [bytes.buffer])
      } else {
        const view = storage.view()
        port.postMessage({ kind: 'storage-view-reply', id: request.id, view } satisfies FdWorkerReply, [view.mountInfo.buffer, view.status.buffer])
      }
      return
    }
    if (record(raw) && (raw.kind === 'leaf-prepare' || raw.kind === 'leaf-cleanup')) {
      // Invalid frames/N-API exceptions are fatal; actual exit leaves creation ownership unknown.
      const request = leafRequest(raw, limits)
      const frame = leafOperation(native, request, limits)
      port.postMessage({ kind: request.kind === 'leaf-prepare' ? 'leaf-prepare-reply' : 'leaf-cleanup-reply',
        id: request.id, frame } satisfies FdWorkerReply, [frame.buffer])
      return
    }
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
      native.openAnchor(request.root.rootPath, request.root.rootDevice, request.root.rootInode, request.root.rootMountId ?? '0')
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
  port.postMessage({ kind: 'ready', abiVersion: native.abiVersion, ...storage === undefined ? {} : { storageProbeVersion: 1 as const } } satisfies FdWorkerReply)
}

start()
