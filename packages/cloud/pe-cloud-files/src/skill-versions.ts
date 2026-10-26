/** Fixed two-file skill storage types and closed native receipt validation; no independent owner. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SkillBundlePort } from './skill-bundles.ts'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { AccountBinding, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'

/** Fixed-schema handle/map overhead reserved per possible retained version; not a whole-process RSS bound. */
export const SKILL_VERSION_HANDLE_BYTES = 2048

/** Explicit logical limits inside the original independent private hard domain. */
export interface SkillVersionLimits {
  readonly maxVersions: number
  readonly maxTotalBytes: number
  readonly maxTotalInodes: number
  readonly maxFileBytes: number
  readonly reservationBytes: number
}

/**
 * Decode explicit config/wire limits without accepting partial or extra budget fields.
 * @param value Parsed configuration or cloned worker fields.
 * @returns Complete finite limits, or undefined for invalid input.
 */
export function skillVersionLimits(value: unknown): SkillVersionLimits | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const names = ['maxVersions', 'maxTotalBytes', 'maxTotalInodes', 'maxFileBytes', 'reservationBytes'] as const
  if (Object.keys(row).length !== names.length || names.some(name => typeof row[name] !== 'number'
    || !Number.isSafeInteger(row[name]) || row[name] < 1)) return undefined
  const { maxVersions, maxTotalBytes, maxTotalInodes, maxFileBytes, reservationBytes } = row
  if (typeof maxVersions !== 'number' || typeof maxTotalBytes !== 'number' || typeof maxTotalInodes !== 'number'
    || typeof maxFileBytes !== 'number' || typeof reservationBytes !== 'number' || maxVersions > 65536
    || maxTotalBytes > 2147483647 || maxTotalBytes < 1024 || maxTotalInodes < 6 || maxTotalInodes > 2147483647
    || maxFileBytes > 2147483646) return undefined
  return Object.freeze({ maxVersions, maxTotalBytes, maxTotalInodes, maxFileBytes, reservationBytes })
}

/** Server-derived fixed private version identity, never a caller path. */
export type SkillVersionId = Branded<'SkillVersionId'>

/** The original files instance recognizes this exact object; serializing it conveys no authority. */
export interface SkillVersion {
  readonly binding: AccountBinding
  readonly id: SkillVersionId
  readonly skillSha256: string
  readonly resourceSha256: string
  readonly skillBytes: number
  readonly resourceBytes: number
}

/** The only two accepted file contents. No directory, archive, executable or host path input. */
export interface SkillVersionInput {
  readonly skillMarkdown: string
  /** Complete owned backing, unchanged until actual preparation settles; a slice into a larger buffer is refused. */
  readonly resource: Uint8Array<ArrayBuffer>
}

/** Private readonly snapshot; methods expire after consumption and share one finite repeated-copy allowance. */
export interface SkillVersionSource {
  readonly version: SkillVersion
  readText(name: 'SKILL.md', signal?: AbortSignal): Promise<string>
  readBytes(name: 'SKILL.md' | 'resource.bin', signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
}

/** Actual durable pointer observation; no cross-authority transaction or account clean receipt is implied. */
export interface SkillCurrent {
  readonly version: SkillVersion
  readonly revision: FsVersion
}

/** Original account files methods; the caller joins each mutation inside its existing API save turn. */
export interface SkillVersionPort {
  /** Optional full-tree capability on this same original owner; absence never implies an empty catalog. */
  readonly bundles?: SkillBundlePort
  prepare(input: SkillVersionInput, signal: AbortSignal): Promise<ResidentResult<SkillVersion>>
  current(signal: AbortSignal): Promise<ResidentResult<SkillCurrent | undefined>>
  commit(version: SkillVersion, expected: FsVersion | null, signal: AbortSignal): Promise<ResidentResult<SkillCurrent>>
  withSource<T>(version: SkillVersion, consume: (source: SkillVersionSource, control: AbortSignal) => Promise<T>,
    signal: AbortSignal): Promise<ResidentResult<T>>
}

/** Worker-only fixed operation, carrying original static identity and bounded trusted bytes. */
export interface FdSkillPrepareRequest {
  readonly kind: 'skill-prepare'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly version: SkillVersionId
  readonly skill: Uint8Array<ArrayBuffer>
  readonly resource: Uint8Array<ArrayBuffer>
  readonly limits: SkillVersionLimits
  readonly cancel: SharedArrayBuffer
}

/** Measured inventory includes reserved pointer bytes/inodes; unknown effects remain original-operation owned. */
export interface FdSkillFacts {
  readonly outcome: 'prepared' | 'not-prepared' | 'unknown'
  readonly closed: boolean
  readonly flags: number
  readonly errno: number
  readonly versions: number
  readonly chargedBytes: number
  readonly chargedInodes: number
  readonly skillBytes: number
  readonly resourceBytes: number
  readonly versionRoot: FdRootIdentity
}

/** Only the original storage lease's post-drain driver may submit this private request. */
export interface FdSkillRetireRequest {
  readonly kind: 'skill-retire'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly current: { readonly id: SkillVersionId; readonly revision: FsVersion } | undefined
  readonly cancel: SharedArrayBuffer
}

/** Actual closed cleanup facts; retained current data continues to occupy the private hard domain. */
export interface FdSkillRetireFacts {
  readonly outcome: 'retired' | 'not-retired' | 'unknown'
  readonly closed: boolean
  readonly errno: number
  readonly retiredVersions: number
  readonly retainedVersions: number
  readonly retainedContentBytes: number
}

/**
 * Decode the exact native post-drain receipt without interpreting observation cancellation as cleanup.
 * @param raw Exact DSR1 frame from the reviewed native asset.
 * @param root Original private domain identity.
 * @param maximum Original finite version count.
 * @returns Checked cleanup facts, or undefined for incompatible or contradictory frames.
 */
export function parseSkillRetireFrame(raw: unknown, root: FdRootIdentity, maximum: number): FdSkillRetireFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0
    || raw.byteLength !== 96 || raw.buffer.byteLength !== 96 || root.rootMountId === undefined) return undefined
  const f = new DataView(raw.buffer), tag = raw[5], flags = raw[6]
  if (f.getUint32(0, false) !== 0x44535231 || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 3
    || flags === undefined || flags > 3 || raw[7] !== 0 || raw.subarray(56).some(byte => byte !== 0)
    || f.getBigUint64(32, true).toString() !== root.rootDevice || f.getBigUint64(40, true).toString() !== root.rootInode
    || f.getBigUint64(48, true).toString() !== root.rootMountId) return undefined
  const errno = f.getUint32(8, true), closed = (flags & 1) !== 0, retiredVersions = f.getUint32(12, true)
  const retainedVersions = Number(f.getBigUint64(16, true)), retainedContentBytes = Number(f.getBigUint64(24, true))
  if (errno > 4095 || !Number.isSafeInteger(retainedContentBytes) || !Number.isSafeInteger(retainedVersions)
    || retiredVersions > maximum || retainedVersions > maximum || (tag === 1 ? errno !== 0 || flags !== 3
      || retainedVersions > 1 || retiredVersions + retainedVersions > maximum
    : errno === 0 || tag === 2 && (!closed || retiredVersions !== 0))) return undefined
  return Object.freeze({ outcome: tag === 1 ? 'retired' : tag === 2 ? 'not-retired' : 'unknown', closed, errno,
    retiredVersions, retainedVersions, retainedContentBytes })
}

/**
 * Validate all native closure, publication and identity facts before delivering a version.
 * @param raw Exact DSV1 native frame.
 * @param request Original fixed worker request.
 * @returns Checked measured facts, or undefined for malformed or contradictory frames.
 */
export function parseSkillFrame(
  raw: unknown, request: Pick<FdSkillPrepareRequest, 'root' | 'version' | 'skill' | 'resource' | 'limits'>,
): FdSkillFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0 || raw.byteLength !== 128
    || raw.buffer.byteLength !== 128 || request.root.rootMountId === undefined) return undefined
  const f = new DataView(raw.buffer), tag = raw[5], flags = raw[6]
  if (f.getUint32(0, false) !== 0x44535631 || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 3
    || flags === undefined || raw[7] !== 0 || raw.subarray(96).some(byte => byte !== 0)) return undefined
  const decimal = (at: number): string => f.getBigUint64(at, true).toString()
  if (decimal(32) !== request.root.rootDevice || decimal(40) !== request.root.rootInode
    || decimal(48) !== request.root.rootMountId) return undefined
  const errno = f.getUint32(8, true), closed = (flags & 1) !== 0
  const versions = f.getUint32(12, true)
  const chargedBytes = Number(f.getBigUint64(16, true)), chargedInodes = Number(f.getBigUint64(24, true))
  const skillBytes = Number(f.getBigUint64(80, true)), resourceBytes = Number(f.getBigUint64(88, true))
  if (errno > 4095 || ![chargedBytes, chargedInodes, skillBytes, resourceBytes].every(Number.isSafeInteger)) return undefined
  if (tag === 1 ? errno !== 0 || (flags & 251) !== 251 || versions < 1 || versions > request.limits.maxVersions
    || chargedBytes > request.limits.maxTotalBytes || chargedInodes !== 3 + versions * 3 || chargedInodes > request.limits.maxTotalInodes
    || skillBytes !== request.skill.byteLength || resourceBytes !== request.resource.byteLength
    || chargedBytes < 1024 + skillBytes + resourceBytes
    || decimal(56) !== request.root.rootDevice || decimal(72) !== request.root.rootMountId || decimal(64) === '0'
    : errno === 0 || tag === 2 && (!closed || (flags & 252) !== 0)) return undefined
  return Object.freeze({ outcome: tag === 1 ? 'prepared' : tag === 2 ? 'not-prepared' : 'unknown', closed, flags, errno,
    versions, chargedBytes, chargedInodes, skillBytes, resourceBytes,
    versionRoot: Object.freeze({ rootPath: `${request.root.rootPath}/skills/${request.version}`,
      rootDevice: decimal(56), rootInode: decimal(64), rootMountId: decimal(72) }) })
}
