/** Internal worker messages, not account authorization or a public filesystem protocol. */
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { DirectoryCreatedIdentity } from './directory-responsibility.ts'
import type { StaticStorageConfig } from './storage-types.ts'

/** Internal verified-root identity; the runtime factory still owns authorization and quota. */
export interface FdRootIdentity {
  readonly rootPath: string
  readonly rootDevice: string
  readonly rootInode: string
  /** Exact verified Linux mount id for a deployment-isolated persistent domain/project. */
  readonly rootMountId?: string
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
}

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
  | { readonly kind: 'ready'; readonly abiVersion: 6 | 7 | 8; readonly storageProbeVersion?: 1 }
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
