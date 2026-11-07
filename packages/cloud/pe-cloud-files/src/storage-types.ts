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
  /** One Root-protected, hash-pinned cold-skill proof; omission supplies no revalidation authority. */
  readonly skillRevalidation?: { readonly proofPath: string; readonly proofSha256: string }
}

/** Exact process observed by the original worker, independent of a proof's declarations. */
export interface StorageProcessIdentity { readonly pid: number; readonly startTicks: string }
/** Closed protected read and measured recipient process, retained within the original root reservation. */
export interface ProtectedSkillProof { readonly bytes: Uint8Array<ArrayBuffer>; readonly process: StorageProcessIdentity }

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
export interface StaticStorageAccountV1 {
  readonly accountId: AccountId
  readonly storageKey: AccountStorageKey
  readonly accountRoot: string
  readonly private: StaticStorageDomain
  readonly projects: StaticStorageDomain
}

/** One preprovisioned independent filesystem; its private ownership record is never mounted into execution. */
export interface StaticEnvironmentSlot {
  readonly slotId: string
  readonly domain: StaticStorageDomain
}

/** A finite protected inventory, not a list of free slots or permission to create filesystems. */
export interface StaticEnvironmentBank {
  readonly bankId: string
  readonly slots: readonly StaticEnvironmentSlot[]
  /** Explicitly share each fixed filesystem between private per-Session directory roots. */
  readonly mode?: 'session-directories'
}

/** Version two requires a bank for each authentic account; version one grants no execution storage. */
export interface StaticStorageAccountV2 extends StaticStorageAccountV1 {
  readonly environmentBank: StaticEnvironmentBank
}

/** Account selectors follow their protected deployment record version. */
export type StaticStorageAccount = StaticStorageAccountV1 | StaticStorageAccountV2

/** Explicit bounded auxiliary writable filesystem in the application view. */
export interface StaticStorageAuxiliary {
  readonly path: string
  readonly maximumBytes: string
  readonly maximumInodes: string
}

/** Protected root deployment record, written only after actual preallocation, fsync and permission setup. */
interface StaticStoragePlanFields {
  readonly recipeVersion: string
  readonly appUid: number
  readonly appGid: number
  readonly arenaReserveBytes: string
  readonly arena: StaticStorageDomain
  readonly control: StaticStorageDomain
  readonly baseConfigPath: string
  readonly installAnchor: string
  readonly auxiliary: readonly StaticStorageAuxiliary[]
}

/** Existing closed-execution deployment record, preserved without added fields. */
export interface StaticStoragePlanV1 extends StaticStoragePlanFields {
  readonly version: 1
  readonly accounts: readonly [StaticStorageAccountV1, StaticStorageAccountV1]
}

/** Remote execution requires these additional independently verified persistent domains. */
export interface StaticStoragePlanV2 extends StaticStoragePlanFields {
  readonly version: 2
  readonly accounts: readonly [StaticStorageAccountV2, StaticStorageAccountV2]
}

/** Explicit record versions; a v1 deployment can never infer an environment bank. */
export type StaticStoragePlan = StaticStoragePlanV1 | StaticStoragePlanV2

/** One preallocated physical account slot; assignment to a user is held separately by Runtime. */
export interface StaticStorageSlot extends Omit<StaticStorageAccountV2, 'accountId'> {
  readonly slotId: string
  readonly templateId: string
}

/** Immutable physical inventory for accounts assigned after deployment initialization. */
export interface StaticStoragePlanV3 extends StaticStoragePlanFields {
  readonly version: 3
  /** Equals the preallocated slot count; Runtime separately limits resident account graphs. */
  readonly maxAccounts: number
  readonly slots: readonly StaticStorageSlot[]
}

/** Supported physical inventories; released fixed-account records retain their original decoding. */
export type StaticStorageDeploymentPlan = StaticStoragePlan | StaticStoragePlanV3

/** Runtime's persistent user-to-slot association; workflow status does not change its revision. */
export interface StaticAccountAssignment {
  readonly accountId: AccountId
  readonly slotId: string
  readonly revision: string
}

/** Root-installed synchronous view of Runtime's authenticated, bounded assignment registry. */
export interface StaticAccountAssignments {
  lookup(accountId: AccountId): StaticAccountAssignment | undefined
  list(): readonly StaticAccountAssignment[]
  assertCurrent(assignment: StaticAccountAssignment): void
}

/** Nonsecret deployment capacity for trusted provisioning; addresses and measured facts stay private. */
export interface StaticStorageInventory {
  readonly sha256: string
  readonly maxAccounts: number
  readonly slots: readonly Readonly<{ slotId: string; templateId: string }>[]
}

/** Trusted Root startup work between physical verification and cold-proof parsing; it grants no Files admission. */
export type StaticAccountInventoryInitializer = (inventory: StaticStorageInventory,
  installAssignments: (resolver: StaticAccountAssignments) => () => void) => Promise<void>

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
