/** Reuses storage-probe.spec synthetic geometry; no Linux, FD, quota or deployment authority. */
import { createHash } from 'node:crypto'
import { parseStaticStoragePlan, accountEnvironmentBank } from '../../src/storage-probe.ts'
import type { StaticStorageConfig, StorageProbeFacts } from '../../src/storage-types.ts'
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function domain(index: number) {
  return { rootPath: `/domain-${index}`, rootDevice: `${index}`, rootInode: '2', rootMountId: `${index + 10}`,
    minimumBytes: '4096', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '200',
    backing: { path: `/backing-${index}`, device: '9', inode: `${index + 20}`, bytes: '8192' } }
}
function raw() {
  return { version: 1, recipeVersion: 'static-first-trial', appUid: 1000, appGid: 1000, arenaReserveBytes: '8192',
    arena: domain(1), control: domain(2), accounts: [1, 2].map(index => ({ accountId: `account-${index}`,
      storageKey: `v1-${String(index).repeat(64)}`, accountRoot: `/accounts/v1-${String(index).repeat(64)}`,
      private: domain(2 * index + 1), projects: domain(2 * index + 2) })),
    baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [] }
}
const config: StaticStorageConfig = { planPath: '/deployment/plan.json', planSha256: '1'.repeat(64),
  probeHelperPath: '/deployment/storage.node', probeHelperSha256: '2'.repeat(64), maxProbeAssetBytes: 1024,
  maxPlanBytes: 16384, maxMountInfoBytes: 16384, rootProbeReservationBytes: 2_000_000, probeTimeoutMs: 1000 }
const status = ['Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000', 'Groups:\t1000',
  ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(key => `${key}:\t0000000000000000`),
  'NoNewPrivs:\t1', 'Seccomp:\t2'].join('\n')

/** Return the original v1 storage geometry and wire replies for a component-only lifetime test. */
export function staticStorageProtocol() {
  const record = raw()
  record.arena.minimumBytes = record.arena.maximumBytes = record.arena.backing.bytes = '65536'
  for (const row of record.accounts) {
    row.private.rootPath = `${row.accountRoot}/private`
    row.projects.rootPath = `${row.accountRoot}/projects`
  }
  for (const domain of [record.control, ...record.accounts.flatMap(row => [row.private, row.projects])]) {
    domain.backing.device = record.arena.rootDevice
  }
  const encoded = encode(record), plan = parseStaticStoragePlan(encoded, 1024)
  const domains = [plan.arena, plan.control, ...plan.accounts.flatMap(row => [row.private, row.projects,
    ...accountEnvironmentBank(row)?.slots.map(slot => slot.domain) ?? []])]
  const facts = new Map<string, StorageProbeFacts>()
  const fact = (change: Partial<StorageProbeFacts>): StorageProbeFacts => ({ flags: 3, uid: 0, gid: 0, mode: 0o40755,
    appUid: 1000, appGid: 1000, device: '99', inode: '2', mountId: '1', filesystem: '61267',
    blockBytes: '4096', blocks: '2', freeBlocks: '1', availableBlocks: '1', inodes: '100', freeInodes: '99',
    size: '0', allocatedBytes: '0', links: '1', ...change })
  facts.set('/', fact({ flags: 35 }))
  for (const path of [plan.baseConfigPath, plan.installAnchor]) facts.set(path, fact({ mode: 0o100444, flags: 11 }))
  for (const [index, domain] of domains.entries()) {
    facts.set(domain.rootPath, fact({ device: domain.rootDevice, inode: domain.rootInode, mountId: domain.rootMountId,
      flags: index < 2 ? 3 : 31, uid: index < 2 ? 0 : 1000, gid: index < 2 ? 0 : 1000,
      mode: index < 2 ? 0o40755 : 0o40700,
      blocks: index === 0 ? String(BigInt(record.arena.maximumBytes) / 4096n) : '2',
      availableBlocks: index === 0 ? String(BigInt(record.arena.maximumBytes) / 4096n) : '1' }))
    facts.set(domain.backing.path, fact({ device: domain.backing.device, inode: domain.backing.inode,
      mode: 0o100600, size: domain.backing.bytes, allocatedBytes: domain.backing.bytes }))
  }
  const mounts = ['1 0 8:0 / / ro - ext4 /dev/test-root ro', ...domains.map((domain, index) =>
    `${domain.rootMountId} 1 8:${index + 1} / ${domain.rootPath} rw - ext4 /dev/test-${index} rw`)].join('\n')
  const planSha256 = createHash('sha256').update(encoded).digest('hex')

  return { record, plan, encoded, facts: Object.fromEntries(facts), mounts, status, config: { ...config, planSha256 } }
}
