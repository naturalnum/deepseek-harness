/** Persistent physical identity is separate from the namespace-specific deployment plan pin. */
import { createHash } from 'node:crypto'
import type { StaticStorageBacking, StaticStorageDomain, StaticStorageInventory, StaticStoragePlanV3 } from './storage-types.ts'

/** Derive association metadata from a parsed, physically verified v3 plan; this issues no Files authority.
 * @param plan Original plan whose complete hash and live physical facts the storage owner verifies separately.
 * @returns Stable physical inventory digest and bounded public slot identifiers, without storage addresses.
 */
export function createStaticStorageInventory(plan: StaticStoragePlanV3): StaticStorageInventory {
  const arenaBacking = backingIdentity(plan.arena.backing)
  const domain = (value: StaticStorageDomain, arenaMember: boolean) => ({
    rootPath: value.rootPath, rootInode: value.rootInode,
    minimumBytes: value.minimumBytes, maximumBytes: value.maximumBytes,
    minimumInodes: value.minimumInodes, maximumInodes: value.maximumInodes,
    backing: { path: value.backing.path, device: arenaMember ? { arenaBacking } : value.backing.device,
      inode: value.backing.inode, bytes: value.backing.bytes },
  })
  const slots = plan.slots.toSorted((a, b) => a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0)
  const identity = { format: 'pe-static-account-inventory-v1', appUid: plan.appUid, appGid: plan.appGid,
    arenaReserveBytes: plan.arenaReserveBytes, maxAccounts: plan.maxAccounts,
    arena: domain(plan.arena, false), control: domain(plan.control, true),
    slots: slots.map(slot => ({ slotId: slot.slotId, templateId: slot.templateId, storageKey: slot.storageKey,
      accountRoot: slot.accountRoot, private: domain(slot.private, true), projects: domain(slot.projects, true),
      environmentBank: { bankId: slot.environmentBank.bankId, mode: slot.environmentBank.mode ?? null,
        slots: slot.environmentBank.slots.toSorted((a, b) => a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0)
          .map(entry => ({ slotId: entry.slotId, domain: domain(entry.domain, true) })) } })) }
  // Verification requires every child backing device to equal the current arena device. Its stable
  // identity is the containing arena backing, rather than that arena's temporary loop device number.
  return Object.freeze({ sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    maxAccounts: plan.maxAccounts,
    slots: Object.freeze(slots.map(slot => Object.freeze({ slotId: slot.slotId, templateId: slot.templateId }))) })
}

function backingIdentity(value: StaticStorageBacking): StaticStorageBacking {
  return { path: value.path, device: value.device, inode: value.inode, bytes: value.bytes }
}
