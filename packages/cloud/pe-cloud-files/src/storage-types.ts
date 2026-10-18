/** Static deployment selectors and measured Linux probe facts; none is an approval or client capability. */
import type { AccountId, AccountStorageKey } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Optional root-only deployment verification; omission grants no storage owner. */
export interface StaticStorageConfig {
  readonly planPath: string
  readonly planSha256: string
  readonly probeHelperPath: string
  readonly probeHelperSha256: string
  readonly maxProbeAssetBytes: number
  readonly rootProbeReservationBytes: number
  readonly maxPlanBytes: number
  readonly maxMountInfoBytes: number
  readonly probeTimeoutMs: number
}

/** Root's actual preallocated backing object, checked without granting its contents or write access. */
export interface StaticStorageBacking {
  readonly path: string
  readonly device: string
  readonly inode: string
  readonly bytes: string
}

/** A statically provisioned independent ext4 mount; limits are requirements checked against live geometry. */
export interface StaticStorageDomain {
  readonly rootPath: string
  readonly rootDevice: string
  readonly rootInode: string
  readonly rootMountId: string
  readonly minimumBytes: string
  readonly maximumBytes: string
  readonly minimumInodes: string
  readonly maximumInodes: string
  readonly backing: StaticStorageBacking
}

/** One fixed authentic account assignment, not a request-selected disk or a second account database. */
export interface StaticStorageAccount {
  readonly accountId: AccountId
  readonly storageKey: AccountStorageKey
  readonly accountRoot: string
  readonly private: StaticStorageDomain
  readonly projects: StaticStorageDomain
}

/** Explicit bounded auxiliary writable filesystem in the application view. */
export interface StaticStorageAuxiliary {
  readonly path: string
  readonly maximumBytes: string
  readonly maximumInodes: string
}

/** Protected root deployment record, written only after actual preallocation, fsync and permission setup. */
export interface StaticStoragePlan {
  readonly version: 1
  readonly recipeVersion: string
  readonly appUid: number
  readonly appGid: number
  readonly arenaReserveBytes: string
  readonly arena: StaticStorageDomain
  readonly control: StaticStorageDomain
  readonly accounts: readonly [StaticStorageAccount, StaticStorageAccount]
  readonly baseConfigPath: string
  readonly installAnchor: string
  readonly auxiliary: readonly StaticStorageAuxiliary[]
}

/** Exact closed-FD probe ABI1 facts. Decimal strings keep kernel-sized quantities lossless. */
export interface StorageProbeFacts {
  readonly flags: number
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly appUid: number
  readonly appGid: number
  readonly device: string
  readonly inode: string
  readonly mountId: string
  readonly filesystem: string
  readonly blockBytes: string
  readonly blocks: string
  readonly freeBlocks: string
  readonly availableBlocks: string
  readonly inodes: string
  readonly freeInodes: string
  readonly size: string
  readonly allocatedBytes: string
  readonly links: string
}
