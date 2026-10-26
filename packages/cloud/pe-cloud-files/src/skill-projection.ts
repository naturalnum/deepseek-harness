/** Fixed two-file project receipts; exact issued objects are authorized by CloudAccountFiles. */
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FdProjectMetadataDirectory, FdRootIdentity } from './worker-protocol.ts'
import type { SkillVersion, SkillVersionId, SkillVersionLimits } from './skill-versions.ts'

/** Kernel scope for persistent source-namespace numbers; it is not a cross-namespace volume certificate. */
export interface SkillSourceContext { readonly bootId: string; readonly mountNamespace: string }

/**
 * Validate bounded kernel-scope observations returned by the original worker.
 * @param value Read-only fixed proc observations; never caller-provided authorization.
 * @returns Exact scope or undefined; matching numbers in another scope cannot substitute for it.
 */
export function skillSourceContext(value: unknown): SkillSourceContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  if (Object.keys(row).length !== 2 || typeof row.bootId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.bootId)
    || typeof row.mountNamespace !== 'string' || !/^mnt:\[[1-9][0-9]{0,19}\]$/.test(row.mountNamespace)) return undefined
  return Object.freeze({ bootId: row.bootId, mountNamespace: row.mountNamespace })
}

/** Explicit finite copy metadata, physical-record and retained-borrow limits; no defaults. */
export interface SkillProjectionLimits {
  readonly maxProjects: number
  readonly maxCopiesPerProject: number
  readonly maxCopiesPerOperation: number
  readonly maxParentBorrows: number
  readonly maxOperationBorrows: number
  readonly maxRecordBytes: number
  readonly maxMetadataBytes: number
  readonly maxMetadataInodes: number
  readonly reservationBytes: number
}

/**
 * Validate the closed deployment/worker budget fields, including one simultaneous atomic record temporary.
 * @param value Explicit deployment values.
 * @returns Frozen finite limits or undefined; no existing source allowance is silently reused.
 */
export function skillProjectionLimits(value: unknown): SkillProjectionLimits | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const keys = ['maxProjects', 'maxCopiesPerProject', 'maxCopiesPerOperation', 'maxParentBorrows', 'maxOperationBorrows',
    'maxRecordBytes', 'maxMetadataBytes', 'maxMetadataInodes', 'reservationBytes'] as const
  if (Object.keys(row).length !== keys.length || keys.some((k) => {
    const value = row[k]
    return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1
  })) return undefined
  const number = (k: typeof keys[number]): number => {
    const value = row[k]
    return typeof value === 'number' ? value : NaN
  }
  if (keys.some(k => k !== 'reservationBytes' && number(k) > 2147483647) || number('maxProjects') > 65536
    || number('maxCopiesPerProject') > 65536 || number('maxCopiesPerOperation') > number('maxCopiesPerProject')
    || number('maxParentBorrows') > 65536 || number('maxOperationBorrows') > 65536
    || (number('maxProjects') + 1) * number('maxRecordBytes') > number('maxMetadataBytes')
    || number('maxProjects') + 2 > number('maxMetadataInodes')) return undefined
  return Object.freeze({ maxProjects: number('maxProjects'), maxCopiesPerProject: number('maxCopiesPerProject'),
    maxCopiesPerOperation: number('maxCopiesPerOperation'), maxParentBorrows: number('maxParentBorrows'),
    maxOperationBorrows: number('maxOperationBorrows'), maxRecordBytes: number('maxRecordBytes'),
    maxMetadataBytes: number('maxMetadataBytes'),
    maxMetadataInodes: number('maxMetadataInodes'), reservationBytes: number('reservationBytes') })
}

/**
 * Model fixed maps, all source/copy/record buffers, scans, FD facts and simultaneous retained borrows.
 * @param limits Explicit projection limits.
 * @param source Original immutable-version limits.
 * @param bounds Original pool path/read/queue limits.
 * @returns Conservative bytes charged to the same original root and lane.
 */
export function skillProjectionBudget(limits: SkillProjectionLimits, source: SkillVersionLimits, bounds: {
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly maxRunningPerLane: number
  readonly maxQueuedPerLane: number
  readonly replyBytes: number
}): { readonly handles: number; readonly operation: number; readonly overlap: number } {
  const handles = limits.maxProjects * (8 * limits.maxRecordBytes + 8192 + limits.maxCopiesPerProject * 4096)
    + 4096 * (limits.maxParentBorrows + limits.maxOperationBorrows * (limits.maxCopiesPerOperation + 1))
  const operation = 64 * (2 * source.maxFileBytes * limits.maxCopiesPerOperation + bounds.maxReadBytes + 1024)
    + 64 * bounds.maxPathBytes + 16 * limits.maxRecordBytes * limits.maxProjects + 8 * bounds.replyBytes
      + 16384 * limits.maxProjects + 131072
  const overlap = source.reservationBytes + limits.reservationBytes * (limits.maxParentBorrows + limits.maxOperationBorrows
    + bounds.maxRunningPerLane + bounds.maxQueuedPerLane)
  if (![handles, operation, overlap].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Projection budget overflow')
  return Object.freeze({ handles, operation, overlap })
}

/** Original source-namespace project parent, retained through actual allocation/export release. */
export interface SkillProjectGrant {
  readonly binding: AccountBinding
  readonly workspaceId: Workspace['id']
  readonly project: FdRootIdentity & { readonly rootMountId: string
    readonly quota: { readonly device: string
      readonly mountId: string
      readonly maximumBytes: string
      readonly maximumInodes: string } }
  readonly metadataDirectory: FdProjectMetadataDirectory
  readonly skillsDirectory: FdProjectMetadataDirectory
}

/** Per-operation exact copies; its result stays charged until actual operation/local/physical settlement. */
export interface SkillOperationCopies {
  readonly project: SkillProjectGrant
  readonly copies: readonly SkillWorkingCopyGrant[]
}

/** A complete writable copy in the original project; no private source address is present. */
export interface SkillWorkingCopyGrant {
  readonly binding: AccountBinding
  readonly workspaceId: Workspace['id']
  readonly version: SkillVersion
  readonly resourceBase: string
  readonly metadataDirectory: FdProjectMetadataDirectory
  readonly skillsDirectory: FdProjectMetadataDirectory
  readonly copyDirectory: FdProjectMetadataDirectory
}

/** Worker-only bounded input from the same admitted source-read/project-write operation. */
export interface FdSkillProjectRequest {
  readonly kind: 'skill-project'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly metadata: FdProjectMetadataDirectory
  readonly uid: number
  readonly gid: number
  readonly version: SkillVersionId
  readonly skill: Uint8Array<ArrayBuffer>
  readonly resource: Uint8Array<ArrayBuffer>
  readonly limits: SkillVersionLimits
  readonly maximumCopies: number
  readonly expectedCopyInode: string
  readonly cancel: SharedArrayBuffer
}

/** Native completion includes all descriptors, publication and the three actual directory identities. */
export interface FdSkillProjectFacts {
  readonly outcome: 'projected' | 'not-published' | 'unknown'
  readonly closed: boolean
  readonly errno: number
  readonly reused: boolean
  readonly copies: number
  readonly metadataDirectory: FdProjectMetadataDirectory
  readonly skillsDirectory: FdProjectMetadataDirectory
  readonly copyDirectory: FdProjectMetadataDirectory
}

/**
 * Decode the independent fixed projection frame without inferring capability from ABI8.
 * @param raw Exact DSP1 frame from the reviewed helper.
 * @param request Original project, fixed contents and measured metadata directory.
 * @returns Checked actual facts, or undefined for incompatible/contradictory input.
 */
export function parseSkillProjectFrame(raw: unknown, request: Pick<FdSkillProjectRequest,
  'root' | 'metadata' | 'uid' | 'gid' | 'skill' | 'resource' | 'limits' | 'maximumCopies'>): FdSkillProjectFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0
    || raw.byteLength !== 192 || raw.buffer.byteLength !== 192 || request.root.rootMountId === undefined) return undefined
  const f = new DataView(raw.buffer), tag = raw[5], flags = raw[6]
  if (f.getUint32(0, false) !== 0x44535031 || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 3
    || flags === undefined || raw[7] !== 0 || raw.subarray(156).some(byte => byte !== 0)
    || f.getBigUint64(16, true) !== 0n || f.getBigUint64(24, true) !== 0n) return undefined
  const decimal = (at: number): string => f.getBigUint64(at, true).toString()
  if (decimal(32) !== request.root.rootDevice || decimal(40) !== request.root.rootInode
    || decimal(48) !== request.root.rootMountId) return undefined
  const errno = f.getUint32(8, true), copies = f.getUint32(12, true), closed = (flags & 1) !== 0
  const directory = (at: number): FdProjectMetadataDirectory => Object.freeze({ device: decimal(at), inode: decimal(at + 8),
    mountId: decimal(at + 16), uid: f.getUint32(144, true), gid: f.getUint32(148, true), mode: f.getUint32(152, true) })
  const metadataDirectory = directory(56), skillsDirectory = directory(80), copyDirectory = directory(104)
  if (errno > 4095 || copies > request.maximumCopies || (tag === 1
    ? errno !== 0 || (flags & 127) !== 127 || copies < 1
      || f.getBigUint64(128, true) !== BigInt(request.skill.byteLength) || f.getBigUint64(136, true) !== BigInt(request.resource.byteLength)
      || (['device', 'inode', 'mountId', 'uid', 'gid', 'mode'] as const).some(k => metadataDirectory[k] !== request.metadata[k])
      || [skillsDirectory, copyDirectory].some(d => d.device !== request.root.rootDevice || d.mountId !== request.root.rootMountId
        || d.inode === '0' || d.uid !== request.uid || d.gid !== request.gid || d.mode !== 0o40700)
    : errno === 0 || tag === 2 && (!closed || (flags & 112) !== 0))) return undefined
  return Object.freeze({ outcome: tag === 1 ? 'projected' : tag === 2 ? 'not-published' : 'unknown', closed, errno,
    reused: (flags & 128) !== 0, copies, metadataDirectory, skillsDirectory, copyDirectory })
}
