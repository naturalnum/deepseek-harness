/** Synthetic parsed-plan inputs; these do not supply a Linux probe or storage authority. */
export function physicalInventoryPlan() {
  const domain = (index: number) => ({ rootPath: `/domain-${index}`, rootDevice: String(index), rootInode: '2',
    rootMountId: String(index + 100), minimumBytes: '4096', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '200',
    backing: { path: `/backing-${index}`, device: index === 1 ? '900' : '1', inode: String(index + 1000), bytes: '8192' } })
  const arena = domain(1)
  arena.minimumBytes = arena.maximumBytes = arena.backing.bytes = '262144'
  return { version: 3, recipeVersion: 'inventory-test', appUid: 1000, appGid: 1000, arenaReserveBytes: '8192',
    arena, control: domain(2), baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [], maxAccounts: 3,
    slots: [1, 2, 3].map((index) => {
      const storageKey = `v1-${String(index).repeat(64)}`, accountRoot = `/accounts/${storageKey}`
      return { slotId: `account-slot-${index}`, templateId: 'standard', storageKey, accountRoot,
        private: { ...domain(2 * index + 1), rootPath: `${accountRoot}/private` },
        projects: { ...domain(2 * index + 2), rootPath: `${accountRoot}/projects` },
        environmentBank: { bankId: `bank-${index}`, mode: 'session-directories', slots: [0, 1].map(slotIndex => ({
          slotId: `slot-${slotIndex}`, domain: { ...domain(100 + 2 * index + slotIndex),
            rootPath: `${accountRoot}/environments/slot-${slotIndex}` },
        })) } }
    }) }
}

/** A second namespace and loop assignment over the same original backing files. */
export function remountInventoryPlan(plan: ReturnType<typeof physicalInventoryPlan>): void {
  const domains = [plan.arena, plan.control, ...plan.slots.flatMap(slot => [slot.private, slot.projects,
    ...slot.environmentBank.slots.map(entry => entry.domain)])]
  for (const domain of domains) {
    domain.rootDevice = String(BigInt(domain.rootDevice) + 2000n)
    domain.rootMountId = String(BigInt(domain.rootMountId) + 3000n)
  }
  for (const domain of domains.slice(1)) domain.backing.device = plan.arena.rootDevice
}
