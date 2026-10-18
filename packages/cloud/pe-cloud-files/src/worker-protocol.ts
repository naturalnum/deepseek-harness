/** Internal worker messages, not account authorization or a public filesystem protocol. */
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'

/** Internal verified-root identity; the runtime factory still owns authorization and quota. */
export interface FdRootIdentity {
  readonly rootPath: string
  readonly rootDevice: string
  readonly rootInode: string
}

/** Root bootstrap creates idle workers before any account/project is selected. */
export interface FdWorkerInput {
  readonly helperPath: string
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly maxResolveRetries: number
  readonly readChunkBytes: number
}

/** One bounded operation beneath the port's fixed root. */
export interface FdTaskRequest {
  readonly kind: 'read' | 'stat' | 'stream'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly relativePath: string
  readonly maxBytes: number
  readonly cancel: SharedArrayBuffer
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
  | { readonly kind: 'ready'; readonly abiVersion: 4 }
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
