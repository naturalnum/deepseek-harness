/**
 * Vocabulary for the filesystem Service Definition (`ctx.fs`): the opaque target/version
 * identities, the metadata `stat` returns, the write-intent and outcome shapes, the
 * literal-edit request/outcome, and the typed error taxonomy.
 * @module @deepseek-ai/dsh-fs/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
export type FsTargetKey = Branded<'FsTargetKey'>

/**
 * Brand a string as an {@link FsTargetKey}. For backend use only — a consumer
 * never manufactures a key, it receives one from `resolve()`.
 * @param key - the backend's raw key string (the local backend passes a realpath).
 * @returns the same string, branded; no validation is performed.
 */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from high-resolution stat identity and freshness
 * fields; a remote backend might use a revision id. The policy layer records it
 * for stale checks; consumers may display related metadata but MUST NOT
 * interpret this token.
 */
export type FsVersion = Branded<'FsVersion'>

/**
 * Brand a string as an {@link FsVersion}. For backend use only — a consumer
 * never manufactures a version, it receives one from `stat`/write/edit outcomes.
 * @param v - the backend's raw version string.
 * @returns the same string, branded; no validation is performed.
 */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}

/**
 * One authoritative observation of a target. A present observation carries the
 * version used by guarded replacement; an absent observation authorizes only a
 * guarded create, never an edit.
 */
export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }

/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
export interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}

/**
 * Metadata about a target — what {@link FileSystem.stat} returns. Lets the
 * policy layer reject directories/special files before reading and choose
 * `readText` vs `streamText` from `size` without probing by failure. `version`
 * is the freshness token. `undefined` from `stat` means the target is absent.
 */
export interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/**
 * Metadata about a path without following the final path component when it is a
 * symbolic link. Unlike {@link FsInfo}, this path-level probe can report
 * `symlink` so consumers with trust-boundary rules can reject repository-owned
 * links before resolving a target.
 */
export interface FsPathInfo {
  /** Opaque freshness token of the path entry right now. */
  version: FsVersion
  /** Whether the path entry is a regular file, directory, symlink, or other. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Byte size of the path entry, when the backend can report it. */
  size?: number
}

/**
 * One direct child returned by {@link FileSystem.listDir}. Listing returns
 * metadata and resolved targets only; it must not read file contents.
 */
export interface FsDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Resolved child target for follow-up operations. */
  target: FsTarget
  /** Opaque freshness token when the backend can report metadata cheaply. */
  version?: FsVersion
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/** Direct children with explicit completeness; a partial result grants no authority over omitted entries. */
export interface FsDirectoryListing {
  /** Returned children in stable name order; a partial subset need not be the directory's first names. */
  readonly entries: FsDirEntry[]
  /** Whether the provider stopped before observing every direct child. */
  readonly truncated: boolean
  /** Present only when this selected provider can open the independent optional page enumeration. */
  readonly directoryPaging?: true
}

/** Backend-issued identity and freshness of one held directory, never an offset or path. */
export type FsDirectoryVersion = Branded<'FsDirectoryVersion'>

/**
 * Brand a backend-admitted directory version.
 * @param value Original provider's opaque native directory token.
 * @returns The same token, branded; consumers never construct it.
 */
export function FsDirectoryVersion(value: string): FsDirectoryVersion { return value as FsDirectoryVersion }

/** A finite page from one unchanged directory; a successful EOF includes actual native closure. */
export type FsDirectoryPage = {
  readonly version: FsDirectoryVersion
  readonly entries: readonly FsDirEntry[]
} & (
  | { readonly eof: false; readonly closed: false }
  | { readonly eof: true; readonly closed: true }
)

/** One optional provider enumeration; no browser cursor or transport authority is represented here. */
export interface FsDirectoryEnumeration {
  readonly version: FsDirectoryVersion
  /** Original provider cap on each complete directory-control or result item. */
  readonly maxReplyBytes: number
  /** Completion/failure wakes a consumer waiting for credit, independently of its delivered page. */
  readonly ended: Promise<void>
  /** Recheck the original selection immediately before admitting credit or handing off a page. */
  assertCurrent(): void
  next(): Promise<FsDirectoryPage>
  /** Caller discards its current page first; completion confirms native closure, slot settlement and result release. */
  close(): Promise<void>
}

/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or mismatch with
 * `FS_STALE_VERSION`. Omitting the intent from `writeText` means unconditional
 * create-or-overwrite, not a third union arm.
 */
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

/** Outcome of a full-file write. */
export interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
  /**
   * The file's content BEFORE the write, or `null` when the file did not exist
   * (a create) or the backend declined a contextual basis (for example, a
   * binary/non-UTF-8 prior file or either overwrite side reaching its exclusive limit).
   * LF-normalized storage text (the diff basis), never a diff — a consumer
   * computes the result-time contextual diff from `before`/`after` when
   * `before` is present, else falls back to a whole-file diff.
   */
  before: string | null
  /** The file's content AFTER the write, LF-normalized to share `before`'s diff basis. */
  after: string
}

/** A literal-replacement edit request. */
export interface FsEditRequest {
  /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
  oldString: string
  /** Literal replacement text. An empty string deletes the matched text. */
  newString: string
  /** Replace every match instead of requiring exactly one. */
  replaceAll: boolean
}

/** Outcome of a literal edit. */
export interface FsEditOutcome {
  /** Opaque version of the file after the edit. */
  version: FsVersion
  /**
   * The file's content BEFORE the edit. Raw storage text (LF-normalized by the
   * backend), never a diff — a consumer computes the result-time contextual diff
   * (the applied hunk with context) from `before`/`after`.
   */
  before: string
  /** The file's content AFTER the edit. */
  after: string
}

/**
 * Stable, machine-routable codes for filesystem failures. Carried on
 * {@link FsError}; the tool registry exposes `{ name, code }` on `isError`
 * results so retry/permission/UI layers can branch without parsing messages.
 */
export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/**
 * Typed filesystem error. Extends {@link HarnessError} so it carries a stable
 * {@link FsErrorCode} and chains `cause`. `dsh-fs` owns this vocabulary so
 * backends and the policy layer raise the same codes instead of each inventing
 * message strings.
 */
export class FsError extends HarnessError {
  override readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
