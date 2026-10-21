/** Internal worker messages, not account authorization or a public filesystem protocol. */
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { DirectoryCreatedIdentity } from './directory-responsibility.ts'
import type { StaticStorageConfig } from './storage-types.ts'
import type { StagingFacts } from './staging-native.ts'

/** Internal verified-root identity; the runtime factory still owns authorization and quota. */
export interface FdRootIdentity {
  readonly rootPath: string
  readonly rootDevice: string
  readonly rootInode: string
  /** Exact verified Linux mount id for a deployment-isolated persistent domain/project. */
  readonly rootMountId?: string
}

/** Actual fixed .pe identity; no arbitrary child name or private path is supplied. */
export interface FdProjectMetadataDirectory {
  readonly device: string
  readonly inode: string
  readonly mountId: string
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

/** Fixed native capability-v1 receipt; unknown remains owned even when known descriptors have closed. */
export interface FdProjectMetadataFacts {
  readonly outcome: 'existing' | 'created' | 'not-prepared' | 'unknown'
  readonly closed: boolean
  readonly created: boolean
  readonly attempted: boolean
  readonly rootValidated: boolean
  readonly directoryValidated: boolean
  readonly directorySynced: boolean
  readonly parentSynced: boolean
  readonly errno: number
  readonly directory: FdProjectMetadataDirectory
}

/** Completed durable preparation retained through the original operation result. */
export interface FdProjectMetadataResult {
  readonly created: boolean
  readonly directory: FdProjectMetadataDirectory
}

/** Fixed environment entry names; each identity belongs to the original environment hard domain. */
export interface FdEnvironmentLayout {
  readonly home: FdProjectMetadataDirectory
  readonly venv: FdProjectMetadataDirectory
  readonly tmp: FdProjectMetadataDirectory
}

/** Closed native layout receipt; partial or uncertain effects retain the original mutation. */
export interface FdEnvironmentLayoutFacts {
  readonly outcome: 'existing' | 'created' | 'not-prepared' | 'unknown'
  readonly closed: boolean
  readonly rootValidated: boolean
  readonly errno: number
  readonly createdMask: number
  readonly layout: FdEnvironmentLayout
}

/** Private fixed layout request; no child name, mode or arbitrary mkdir operation crosses the wire. */
export interface FdEnvironmentLayoutRequest {
  readonly kind: 'environment-layout-prepare'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly cancel: SharedArrayBuffer
}

/**
 * Verify the exact DEL1 frame against the selected environment anchor and expected application identity.
 * @param raw Fixed native or worker frame.
 * @param root Original protected environment identity.
 * @param uid Expected application UID.
 * @param gid Expected application GID.
 * @returns Fixed directory identities and effect facts, or undefined for an invalid receipt.
 */
export function parseEnvironmentLayoutFrame(
  raw: unknown, root: FdRootIdentity, uid: number, gid: number,
): FdEnvironmentLayoutFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0
    || raw.byteLength !== 256 || raw.buffer.byteLength !== 256 || root.rootMountId === undefined) return undefined
  const frame = new DataView(raw.buffer), tag = raw[5], flags = raw[6]
  if (frame.getUint32(0, false) !== 0x44454c31 || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 4
    || flags === undefined || flags > 3 || raw[7] !== 0 || raw.subarray(12, 24).some(byte => byte !== 0)
    || raw.subarray(240).some(byte => byte !== 0)) return undefined
  const decimal = (offset: number): string => frame.getBigUint64(offset, true).toString()
  if (decimal(24) !== root.rootDevice || decimal(32) !== root.rootInode || decimal(40) !== root.rootMountId) return undefined
  const errno = frame.getUint32(8, true), closed = (flags & 1) !== 0, rootValidated = (flags & 2) !== 0
  let createdMask = 0, synchronized = false
  const directories: FdProjectMetadataDirectory[] = []
  for (let index = 0; index < 3; index++) {
    const offset = 48 + index * 64, bits = raw[offset]
    if (bits === undefined || bits > 31 || raw.subarray(offset + 1, offset + 4).some(byte => byte !== 0)
      || raw.subarray(offset + 40, offset + 64).some(byte => byte !== 0)
      || (bits & 2) !== 0 && (bits & 16) === 0 || (bits & 4) !== 0 && (bits & 1) === 0
      || (bits & 8) !== 0 && (bits & 4) === 0 || bits !== 0 && !rootValidated) return undefined
    if ((bits & 2) !== 0) createdMask |= 1 << index
    if ((bits & 12) !== 0) synchronized = true
    const directory = Object.freeze({ uid: frame.getUint32(offset + 4, true), gid: frame.getUint32(offset + 8, true),
      mode: frame.getUint32(offset + 12, true), device: decimal(offset + 16), inode: decimal(offset + 24),
      mountId: decimal(offset + 32) })
    if (tag < 3 && ((bits & 13) !== 13 || directory.uid !== uid || directory.gid !== gid || directory.mode !== 0o40700
      || directory.device !== root.rootDevice || directory.mountId !== root.rootMountId || directory.inode === '0'
      || directory.inode === root.rootInode || directories.some(other => other.inode === directory.inode))) return undefined
    directories.push(directory)
  }
  if (errno > 4095 || (tag < 3 ? errno !== 0 || !closed || !rootValidated || (createdMask !== 0) !== (tag === 2)
    : errno === 0 || tag === 3 && (!closed || createdMask !== 0 || synchronized))) return undefined
  const [home, venv, tmp] = directories
  if (home === undefined || venv === undefined || tmp === undefined) return undefined
  return Object.freeze({ outcome: tag === 1 ? 'existing' : tag === 2 ? 'created' : tag === 3 ? 'not-prepared' : 'unknown',
    closed, rootValidated, errno, createdMask, layout: Object.freeze({ home, venv, tmp }) })
}

/** Private fixed operation; metadata names, mkdir arguments and unverified directory assertions cannot cross the wire. */
export interface FdProjectMetadataRequest {
  readonly kind: 'project-metadata-prepare'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly cancel: SharedArrayBuffer
}

/**
 * Decode the exact closed/native receipt and verify every successful identity against its original request.
 * @param raw Native or worker binary frame, never a success assertion from configuration.
 * @param root Original selected project anchor.
 * @param uid Expected deployment application UID.
 * @param gid Expected deployment application GID.
 * @returns Bounded facts, or undefined for incompatible, malformed or contradictory replies.
 */
export function parseProjectMetadataFrame(
  raw: unknown, root: FdRootIdentity, uid: number, gid: number,
): FdProjectMetadataFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0
    || raw.byteLength !== 96 || raw.buffer.byteLength !== 96 || root.rootMountId === undefined) return undefined
  const frame = new DataView(raw.buffer), tag = raw[5], flags = raw[6]
  if (frame.getUint32(0, false) !== 0x44504d31 || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 4
    || flags === undefined || flags > 127 || raw[7] !== 0 || raw.subarray(72).some(byte => byte !== 0)) return undefined
  const decimal = (offset: number): string => frame.getBigUint64(offset, true).toString()
  if (decimal(24) !== root.rootDevice || decimal(32) !== root.rootInode || decimal(40) !== root.rootMountId) return undefined
  const directory = Object.freeze({ device: decimal(48), inode: decimal(56), mountId: decimal(64),
    uid: frame.getUint32(12, true), gid: frame.getUint32(16, true), mode: frame.getUint32(20, true) })
  const errno = frame.getUint32(8, true), closed = (flags & 1) !== 0, created = (flags & 32) !== 0
  const rootValidated = (flags & 2) !== 0, directoryValidated = (flags & 4) !== 0
  const directorySynced = (flags & 8) !== 0, parentSynced = (flags & 16) !== 0, attempted = (flags & 64) !== 0
  if (created && !attempted || directoryValidated && !rootValidated || directorySynced && !directoryValidated
    || parentSynced && !directorySynced || errno > 4095) return undefined
  if (tag < 3) {
    if (errno !== 0 || !closed || !rootValidated || !directoryValidated || !directorySynced || !parentSynced
      || created !== (tag === 2) || directory.uid !== uid || directory.gid !== gid || directory.mode !== 0o40700
      || directory.device !== root.rootDevice || directory.inode === '0' || directory.inode === root.rootInode
      || directory.mountId !== root.rootMountId) return undefined
  } else if (errno === 0 || tag === 3 && (!closed || created || directorySynced || parentSynced)) return undefined
  return Object.freeze({ outcome: tag === 1 ? 'existing' : tag === 2 ? 'created' : tag === 3 ? 'not-prepared' : 'unknown',
    closed, created, attempted, rootValidated, directoryValidated, directorySynced, parentSynced, errno, directory })
}

/** Root bootstrap creates idle workers before any account/project is selected. */
export interface FdWorkerInput {
  readonly helperPath: string
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly maxResolveRetries: number
  readonly readChunkBytes: number
  /** Explicit ABI8 content capacities; absent on ABI6/7 workers. */
  readonly content?: FdContentLimits
  readonly storageProbe?: StaticStorageConfig
  /** Omission disables the separate companion; no capability is inferred from ABI8. */
  readonly staging?: FdStagingWorkerInput
}

/** Root-selected staging capacities; every field is required when staging is enabled. */
export interface FdStagingLimits {
  readonly helperPath: string
  readonly maxFileBytes: number
  readonly maxBatchRefs: number
  readonly maxBatchBytes: number
  readonly maxSourceChunkBytes: number
  readonly operationTimeoutMs: number
  /** Root-approved complete batch reservation, including separately reviewed opaque overhead. */
  readonly reservationBytes: number
}

/** The pool forwards its existing complete metadata-frame capacity; there is no new default. */
export interface FdStagingWorkerInput extends FdStagingLimits {
  readonly maxReplyBytes: number
}

/** Derived only after native-ref authorization; this private descriptor grants no account authority. */
export interface FdStageFile {
  readonly digest: string
  readonly name: string
  readonly expectedBytes: number
}

/**
 * Shared pure spelling gate; the native companion independently enforces every component again.
 * @param name One proposed attachment filename, without directory components.
 * @returns Whether the name is a valid UTF-8 portable leaf within255 bytes and excludes reserved device names.
 */
export function validStageName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && name.trim() === name && !/[. ]$/.test(name)
    && !/[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name) && Buffer.byteLength(name) <= 255
    && Buffer.from(name).toString('utf8') === name && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
}

/** Native closed publication facts; source closure is independently joined by the main bridge. */
export interface FdStageResult {
  readonly outcome: 'published' | 'reused'
  readonly facts: StagingFacts
}

/** A single-credit transaction; completion is a message captured by a worker-owned promise. */
export type FdStageRequest = {
  readonly kind: 'stage-begin'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly file: FdStageFile
  readonly cancel: SharedArrayBuffer
} | { readonly kind: 'stage-chunk'; readonly id: OperationId; readonly sequence: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'stage-source-complete' | 'stage-finish' | 'stage-abort'; readonly id: OperationId }

/** Frames are finite metadata only; binary chunks travel solely toward the sink. */
export type FdStageReply =
  | { readonly kind: 'stage-ready'; readonly id: OperationId }
  | { readonly kind: 'stage-ack'; readonly id: OperationId; readonly sequence: number; readonly total: number }
  | { readonly kind: 'stage-result'; readonly id: OperationId; readonly result: FdStageResult }
  | { readonly kind: 'stage-rejected'; readonly id: OperationId; readonly code: FsErrorCode }
  | { readonly kind: 'stage-failure'; readonly id: OperationId; readonly code: FsErrorCode; readonly facts: StagingFacts }

/** Root-only static deployment commands; they never use a fabricated account lane. */
export type FdStorageRequest = {
  readonly id: OperationId
  readonly cancel: SharedArrayBuffer
} & ({ readonly kind: 'storage-probe'; readonly path: string }
  | { readonly kind: 'storage-record' }
  | { readonly kind: 'storage-view' })

/** Bounded process view; every buffer is exact and closed before transfer. */
export interface FdStorageView {
  readonly mountInfo: Uint8Array<ArrayBuffer>
  readonly status: Uint8Array<ArrayBuffer>
}

/** Deployment-selected bounds for the independent content-capable worker. */
export interface FdContentLimits {
  readonly maxEntries: number
  readonly maxNameBytes: number
  readonly maxReplyBytes: number
  readonly operationTimeoutMs: number
}

/** Final-component nofollow metadata; observing a symlink grants no read authority. */
export interface FdPathMetadata {
  readonly identity: string
  readonly version: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size?: number
}

/** One direct child observed without following its final component. */
export interface FdDirectoryEntry extends FdPathMetadata {
  readonly name: string
}

/** ABI8-only read commands; complete reply bytes include names and metadata. */
export type FdContentRequest = {
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly relativePath: string
  readonly cancel: SharedArrayBuffer
} & (
  | { readonly kind: 'lstat' }
  | { readonly kind: 'list'; readonly maxEntries: number; readonly maxBytes: number }
  | { readonly kind: 'range'; readonly offset: number; readonly length: number; readonly maxBytes: number }
)

/** One bounded operation beneath the port's fixed root. */
export interface FdTaskRequest {
  readonly kind: 'read' | 'stat' | 'stream'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly relativePath: string
  readonly maxBytes: number
  readonly cancel: SharedArrayBuffer
}

/** ABI7 text mutation; the existing parent must already be beneath the fixed anchor. */
export interface FdTextWriteRequest {
  readonly kind: 'text-write'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly relativePath: string
  readonly content: string
  readonly expected?: FsWriteIntent
  readonly maxBytes: number
  readonly cancel: SharedArrayBuffer
}

/** Closed-descriptor successful publication; text decoding belongs to the worker. */
export interface FdTextWriteResult {
  readonly operation: 'create' | 'update'
  readonly version: string
  readonly before: string | null
  readonly after: string
}

/** One read-only directory observation, routed beneath a previously approved anchor. */
export interface FdDirectoryRequest {
  readonly kind: 'directory'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly relativePath: string
  readonly cancel: SharedArrayBuffer
}

/** Kernel-verified physical spelling and actual directory classification. */
export interface FdDirectoryObservation {
  readonly anchorPath: string
  readonly canonicalPath: string
  readonly directory: boolean
}

/** Two explicit helper branches; neither value grants storage authority. */
export type LeafBackend = 'tmpfs' | 'ext4'

/** Fixed-parent single-leaf commands; only a trusted isolated-fixture grant may issue them. */
export type FdLeafRequest = {
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly leaf: string
  readonly backend: LeafBackend
  readonly cancel: SharedArrayBuffer
} & ({ readonly kind: 'leaf-prepare' } | { readonly kind: 'leaf-cleanup'; readonly identity: DirectoryCreatedIdentity })

/** Bounded FD metadata; native brands are constructed by the owning backend. */
export interface FdMetadata {
  readonly identity: string
  readonly version: string
  readonly type: 'file' | 'directory'
  readonly size?: number
}

/** A stream permits one pull at a time; cancellation does not claim actual completion. */
export interface FdStreamControl {
  readonly kind: 'stream-pull' | 'stream-cancel'
  readonly id: OperationId
}

/** Success follows FD closure except stream-ready/chunk, which retain actual operation ownership. */
export type FdWorkerReply =
  | FdStageReply
  | {
    readonly kind: 'ready'
    readonly abiVersion: 6 | 7 | 8
    readonly storageProbeVersion?: 1
    readonly stagingAbiVersion?: 1
    readonly projectMetadataVersion?: 1
    readonly environmentLayoutVersion?: 1
  }
  | { readonly kind: 'project-metadata-reply'; readonly id: OperationId; readonly frame: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'environment-layout-reply'; readonly id: OperationId; readonly frame: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'lstat-reply'; readonly id: OperationId; readonly metadata: FdPathMetadata | undefined }
  | { readonly kind: 'list-reply'; readonly id: OperationId; readonly entries: readonly FdDirectoryEntry[] }
  | { readonly kind: 'range-reply'; readonly id: OperationId; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'text-write-reply'; readonly id: OperationId; readonly result: FdTextWriteResult }
  | {
    readonly kind: 'text-write-failure'
    readonly id: OperationId
    readonly code: FsErrorCode
    readonly syscallCode?: string
    readonly outcome: 'not-published' | 'unknown'
  }
  | { readonly kind: 'storage-probe-reply'; readonly id: OperationId; readonly frame: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'storage-record-reply'; readonly id: OperationId; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'storage-view-reply'; readonly id: OperationId; readonly view: FdStorageView }
  | { readonly kind: 'leaf-prepare-reply' | 'leaf-cleanup-reply'; readonly id: OperationId; readonly frame: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'startup-failed'; readonly code: FsErrorCode; readonly syscallCode?: string }
  | { readonly kind: 'reply'; readonly id: OperationId; readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'stat-reply'; readonly id: OperationId; readonly metadata: FdMetadata | undefined }
  | { readonly kind: 'stream-ready' | 'stream-end'; readonly id: OperationId }
  | { readonly kind: 'stream-chunk'; readonly id: OperationId; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'reply'; readonly id: OperationId; readonly ok: false; readonly code: FsErrorCode; readonly syscallCode?: string }
  | { readonly kind: 'directory-reply'; readonly id: OperationId; readonly ok: true; readonly value: FdDirectoryObservation }
  | {
    readonly kind: 'directory-reply'
    readonly id: OperationId
    readonly ok: false
    readonly phase: 'anchor' | 'target' | 'verify'
    readonly code: FsErrorCode
    readonly syscallCode?: string
  }
