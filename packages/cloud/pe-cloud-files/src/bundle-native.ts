/** Fixed full-tree helper protocol; original ABI8 and legacy frames remain independent. */
import type { OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SkillBundleLimits } from './skill-bundles.ts'
import type { SkillVersionId, SkillVersionLimits } from './skill-versions.ts'
import type { FdRootIdentity, FdProjectMetadataDirectory } from './worker-protocol.ts'
import type { BundleTree } from './bundle-codec.ts'

/** One original-lane request. Reclaim contains a complete retained-id set plus exact pointer revision. */
export interface FdBundleRequest {
  readonly kind: 'bundle-prepare' | 'bundle-project' | 'bundle-reclaim'
  readonly id: OperationId
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly version: SkillVersionId
  readonly tree: BundleTree
  readonly metadata: FdProjectMetadataDirectory | null
  readonly expectedCopyInode: string
  readonly retained: readonly SkillVersionId[]
  readonly revision: string
  readonly limits: SkillBundleLimits
  readonly storage: SkillVersionLimits
  readonly cancel: SharedArrayBuffer
}

/** Measured complete inventory; unknown effects and close failures keep the original owner blocked. */
export interface FdBundleFacts {
  readonly outcome: 'complete' | 'not-published' | 'unknown'
  readonly closed: boolean
  readonly reused: boolean
  readonly errno: number
  readonly versions: number
  readonly chargedBytes: number
  readonly chargedInodes: number
  readonly removed: number
  readonly directory: FdProjectMetadataDirectory
}

/**
 * Validate full measured frames; no assumed three-inode cost or synthetic closure.
 * @param raw Exact native receipt bytes.
 * @param request The original submitted operation, root, expected copy and explicit capacities.
 * @returns Validated measured facts, or undefined for incompatible or contradictory frames.
 */
export function parseBundleFrame(raw: unknown, request: Pick<FdBundleRequest, 'kind' | 'root' | 'uid' | 'gid' | 'storage' | 'limits' | 'tree' | 'expectedCopyInode'>)
  : FdBundleFacts | undefined {
  if (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.byteOffset !== 0
    || raw.byteLength !== 128 || raw.buffer.byteLength !== 128 || request.root.rootMountId === undefined) return undefined
  const f = new DataView(raw.buffer), magic = request.kind === 'bundle-prepare' ? 0x44534231
    : request.kind === 'bundle-project' ? 0x44425031 : 0x44425231
  const tag = raw[5], flags = raw[6]
  if (f.getUint32(0, false) !== magic || raw[4] !== 1 || tag === undefined || tag < 1 || tag > 3
    || flags === undefined || flags > 15 || raw[7] !== 0 || raw.subarray(84).some(b => b !== 0)) return undefined
  const decimal = (at: number): string => f.getBigUint64(at, true).toString()
  if (decimal(32) !== request.root.rootDevice || decimal(40) !== request.root.rootInode
    || decimal(48) !== request.root.rootMountId) return undefined
  const errno = f.getUint32(8, true), versions = f.getUint32(12, true), chargedBytes = Number(f.getBigUint64(16, true))
  const chargedInodes = Number(f.getBigUint64(24, true)), removed = f.getUint32(80, true), closed = (flags & 1) !== 0
  if (errno > 4095 || !Number.isSafeInteger(chargedBytes) || !Number.isSafeInteger(chargedInodes)
    || tag === 1 && (errno !== 0 || !closed || (flags & 2) === 0 || versions > request.storage.maxVersions
      || chargedBytes > request.storage.maxTotalBytes || chargedInodes > request.storage.maxTotalInodes
      || request.kind !== 'bundle-reclaim' && (decimal(56) !== request.root.rootDevice || decimal(64) === '0'
        || decimal(72) !== request.root.rootMountId))
    || tag !== 1 && (errno === 0 || tag === 2 && (!closed || (flags & 4) !== 0))) return undefined
  if (tag === 1) {
    const content = request.tree.files.reduce((sum, file) => sum + file.data.byteLength, 0)
    if (request.kind === 'bundle-reclaim') {
      if (removed + versions > request.storage.maxVersions || (flags & 8) !== 0
        || decimal(56) !== '0' || decimal(64) !== '0' || decimal(72) !== '0'
        || chargedBytes < 2 * request.limits.maxCatalogBytes || chargedInodes < 3
        || ((flags & 4) !== 0) !== (removed > 0)) return undefined
    } else {
      const controlInodes = request.kind === 'bundle-prepare' ? 3 : 1
      const reused = (flags & 8) !== 0
      if (versions < 1 || removed !== 0
        || chargedInodes < (reused ? 2 : controlInodes + 1 + request.tree.files.length + request.tree.directories.length)
        || chargedBytes < (reused ? 0 : content + (request.kind === 'bundle-prepare' ? 2 * request.limits.maxCatalogBytes : 0))) return undefined
      if (request.kind === 'bundle-prepare' ? reused || (flags & 4) === 0
        : reused !== (request.expectedCopyInode !== '0') || reused && decimal(64) !== request.expectedCopyInode
          || ((flags & 4) !== 0) === reused) return undefined
    }
  }
  return Object.freeze({ outcome: tag === 1 ? 'complete' : tag === 2 ? 'not-published' : 'unknown', closed,
    reused: (flags & 8) !== 0, errno, versions, chargedBytes, chargedInodes, removed,
    directory: Object.freeze({ device: decimal(56), inode: decimal(64), mountId: decimal(72), uid: request.uid, gid: request.gid,
      mode: request.kind === 'bundle-project' ? 0o40700 : 0o40500 }) })
}
