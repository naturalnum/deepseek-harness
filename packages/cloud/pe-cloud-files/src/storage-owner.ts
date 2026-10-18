/** Static two-account guest storage admission; actual native services and shared-pool lifetime keep their original owners. */
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import type { AccountBinding, AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { AccountFilesPreparation } from './account-service.ts'
import type { PoolReadPort } from './worker-pool.ts'
import type { FdRootIdentity, FdStorageView } from './worker-protocol.ts'
import type { StaticStorageAccount, StaticStorageConfig, StaticStorageDomain, StaticStoragePlan, StorageProbeFacts } from './storage-types.ts'
import { parseStaticStoragePlan } from './storage-probe.ts'
import { FilesFailure } from './error.ts'

/** Root initialization/probing uses the original prestarted slots and its separate finite resident reservation. */
export interface StaticStorageDriver {
  record(): Promise<Uint8Array<ArrayBuffer>>
  probe(path: string): Promise<StorageProbeFacts>
  view(): Promise<FdStorageView>
  assertPoolCurrent(): void
  bind(binding: AccountBinding, root: FdRootIdentity, current: () => void): PoolReadPort
  joinEpoch(binding: AccountBinding): Promise<void>
}

/** Native boot addresses inspected before its first Profile/patch access. */
export interface StaticStorageProfile {
  readonly dir: string
  readonly patchPath: string
  readonly home: string
  readonly cwd: string
  readonly installAnchor: string
}

interface Mount {
  readonly id: string
  readonly path: string
  readonly filesystem: string
  readonly source: string
  readonly writable: boolean
}

function failure(): never { throw new FilesFailure('files/prerequisite-missing', 'The actual static storage deployment is unavailable or mismatched.') }
function stale(): never { throw new FilesFailure('cloud/stale-generation', 'The static storage lease is closed or belongs to another generation.') }
function assertLifetime(signal: AbortSignal): void { if (signal.aborted) stale() }
function text(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
function bytes(facts: StorageProbeFacts): bigint { return BigInt(facts.blockBytes) * BigInt(facts.blocks) }
function directory(facts: StorageProbeFacts): boolean { return (facts.mode & 0o170000) === 0o040000 }
function protectedParents(facts: StorageProbeFacts): void { if ((facts.flags & 3) !== 3) failure() }
function readonlyObject(facts: StorageProbeFacts): void {
  protectedParents(facts)
  if ((facts.mode & 0o170000) !== 0o100000 || facts.uid !== 0 || (facts.mode & 0o022) !== 0
    || (facts.flags & 4) !== 0 || (facts.flags & 8) === 0) failure()
}

/**
 * Decode the bounded process view and require the actual non-root, no-capability application identity.
 * @param view Closed-FD bounded proc results from the actual worker.
 * @param plan Protected deployment requirements, not permission assertions.
 * @returns The bounded live mount inventory for driver and writable-surface matching.
 */
export function validateStorageView(view: FdStorageView, plan: StaticStoragePlan): readonly Mount[] {
  const status = new Map<string, string>()
  for (const line of text(view.status).split('\n').filter(Boolean)) {
    const separator = line.indexOf(':'), key = line.slice(0, separator)
    if (separator < 1 || status.has(key)) failure()
    status.set(key, line.slice(separator + 1).trim())
  }
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) if (!/^0+$/.test(status.get(name) ?? '')) failure()
  const ids = (key: string): readonly number[] => (status.get(key) ?? '').split(/\s+/).filter(Boolean).map(Number)
  if (status.get('NoNewPrivs') !== '1' || status.get('Seccomp') !== '2'
    || ids('Uid').length !== 4 || ids('Uid').some(id => id !== plan.appUid)
    || ids('Gid').length !== 4 || ids('Gid').some(id => id !== plan.appGid)
    || ids('Groups').some(id => id !== plan.appGid)) failure()
  const unescape = (s: string): string =>
    s.replace(/\\(040|011|012|134)/g, (_match, code: string) => String.fromCharCode(parseInt(code, 8)))
  const mounts: Mount[] = []
  const idsSeen = new Set<string>()
  for (const line of text(view.mountInfo).split('\n').filter(Boolean)) {
    const sides = line.split(' - '), left = sides[0]?.split(' '), right = sides[1]?.split(' ')
    const [id, , , , path, options] = left ?? [], [filesystem, source] = right ?? []
    if (sides.length !== 2 || left === undefined || left.length < 6 || right === undefined || right.length < 3
      || id === undefined || path === undefined || options === undefined || filesystem === undefined || source === undefined
      || !/^[1-9]\d*$/.test(id) || idsSeen.has(id)) failure()
    idsSeen.add(id)
    mounts.push({ id, path: unescape(path), filesystem, source: unescape(source), writable: options.split(',').includes('rw') })
  }
  if (mounts.length === 0) failure()
  return mounts
}

/** Actual owner retained only by the original root pool; successful initialization grants guest-scope storage admission. */
export class RootStorageOwner {
  private state: 'new' | 'checking' | 'open' | 'closed' | 'failed' = 'new'
  private initialization?: Promise<void>
  private plan?: StaticStoragePlan
  private preparationTail: Promise<void> = Promise.resolve()
  private readonly leases: Array<{ input: AccountMountInput; result: Promise<StaticAccountStorageLease> }> = []

  /**
   * @param config Explicit root parser and resident bounds.
   * @param maxPathBytes Original pool path bound.
   * @param driver Original pool's operations; never installed in an account graph.
   */
  constructor(
    private readonly config: StaticStorageConfig, private readonly maxPathBytes: number, private readonly driver: StaticStorageDriver,
  ) {}

  /**
   * Verify the protected record and actual application view before issuing storage admission.
   * @returns Retained root initialization, rejecting without issuing authority on any mismatch.
   */
  initializeStatic(): Promise<void> {
    this.initialization ??= (async () => {
      if (this.state !== 'new' || process.platform !== 'linux') failure()
      this.state = 'checking'
      try {
        this.plan = await this.readPlan()
        await this.verify(this.plan)
        this.finishInitialization()
      } catch (error) { this.failedInitialization(); throw error }
    })()
    void this.initialization.catch(() => {})
    return this.initialization
  }

  /** Require the original live root owner; no configuration bit can satisfy this check. */
  assertRootCurrent(): void {
    this.driver.assertPoolCurrent()
    if (this.state !== 'open' || this.plan === undefined) failure()
  }

  /**
   * Verify a preplaced authentic assignment before any native Profile I/O; this never allocates or remounts.
   * @param input Original factory input, carrying its PG generation and server-derived layout.
   * @returns The same retained preparation for the same original generation; another live generation rejects.
   * The two retained assignments verify serially; closed admission or an ended lifetime rejects before queued I/O.
   */
  prepareAccount(input: AccountMountInput): Promise<StaticAccountStorageLease> {
    this.assertRootCurrent()
    const plan = this.plan
    if (plan === undefined) failure()
    const account = plan.accounts.find(row => row.accountId === input.binding.accountId && row.storageKey === input.layout.storageKey)
    if (account === undefined || input.binding.recipeVersion !== plan.recipeVersion || input.binding.lifetime.aborted) failure()
    const existing = this.leases.find(row => row.input.binding.accountId === input.binding.accountId)
    if (existing !== undefined) {
      if (existing.input.binding !== input.binding || existing.input.layout !== input.layout
        || existing.input.instanceId !== input.instanceId) stale()
      return existing.result
    }
    if (this.leases.length >= 2) failure()
    const entry: { input: AccountMountInput; result: Promise<StaticAccountStorageLease> } = {
      input, result: this.preparationTail.then(async () => {
        this.assertRootCurrent()
        assertLifetime(input.binding.lifetime)
        try {
          await this.readPlan()
          await this.verify(plan)
        } catch (error) { this.failedInitialization(); throw error }
        this.assertRootCurrent()
        assertLifetime(input.binding.lifetime)
        const lease = new StaticAccountStorageLease(this, account, input, plan, this.driver, () => {
          const index = this.leases.indexOf(entry)
          if (index >= 0) this.leases.splice(index, 1)
        })
        lease.assertLayout()
        return lease
      }),
    }
    this.leases.push(entry)
    // The entry retains the original rejection; the tail joins only its actual settlement.
    this.preparationTail = entry.result.then(() => {}, () => {})
    return entry.result
  }

  /** Stop new preparation and revoke existing lease admission; actual work and physical capacity stay owned. */
  closeAdmission(): void { this.state = 'closed' }

  private finishInitialization(): void { if (this.state !== 'checking') stale(); this.state = 'open' }

  private failedInitialization(): void { if (this.state !== 'closed') this.state = 'failed' }

  private async readPlan(): Promise<StaticStoragePlan> {
    const record = await this.driver.record()
    if (record.byteLength > this.config.maxPlanBytes
      || createHash('sha256').update(record).digest('hex') !== this.config.planSha256) failure()
    return parseStaticStoragePlan(record, this.maxPathBytes)
  }

  private async verify(plan: StaticStoragePlan): Promise<void> {
    const mounts = validateStorageView(await this.driver.view(), plan)
    const root = await this.driver.probe('/')
    if (!directory(root) || (root.flags & 32) === 0 || (root.flags & 4) !== 0
      || root.appUid !== plan.appUid || root.appGid !== plan.appGid) failure()
    for (const path of [plan.baseConfigPath, plan.installAnchor]) readonlyObject(await this.driver.probe(path))
    const domains = [plan.arena, plan.control, ...plan.accounts.flatMap(account => [account.private, account.projects])]
    if (new Set(domains.map(d => d.rootDevice)).size !== domains.length || new Set(domains.map(d => d.rootMountId)).size !== domains.length
      || new Set(domains.map(d => d.rootPath)).size !== domains.length
      || new Set(domains.map(d => d.backing.path)).size !== domains.length
      || new Set(domains.map(d => `${d.backing.device}:${d.backing.inode}`)).size !== domains.length) failure()
    const facts = new Map<StaticStorageDomain, StorageProbeFacts>()
    const measured = (domain: StaticStorageDomain): StorageProbeFacts => facts.get(domain) ?? failure()
    for (const domain of domains) {
      const observed = await this.driver.probe(domain.rootPath)
      protectedParents(observed)
      if (!directory(observed) || observed.device !== domain.rootDevice || observed.inode !== domain.rootInode
        || observed.mountId !== domain.rootMountId || observed.filesystem !== '61267'
        || observed.appUid !== plan.appUid || observed.appGid !== plan.appGid
        || bytes(observed) < BigInt(domain.minimumBytes) || bytes(observed) > BigInt(domain.maximumBytes)
        || BigInt(observed.inodes) < BigInt(domain.minimumInodes) || BigInt(observed.inodes) > BigInt(domain.maximumInodes)
        || (observed.flags & 32) !== 0) failure()
      const mount = mounts.find(row => row.id === observed.mountId)
      if (mount?.filesystem !== 'ext4' || mount.path !== domain.rootPath || !mount.writable) failure()
      const backing = await this.driver.probe(domain.backing.path)
      protectedParents(backing)
      if ((backing.mode & 0o170000) !== 0o100000 || backing.uid !== 0 || (backing.mode & 0o077) !== 0
        || (backing.flags & 12) !== 0 || backing.links !== '1' || backing.device !== domain.backing.device
        || backing.inode !== domain.backing.inode || backing.size !== domain.backing.bytes
        || BigInt(backing.allocatedBytes) < BigInt(backing.size) || bytes(observed) > BigInt(backing.size)) failure()
      facts.set(domain, observed)
    }
    const arena = measured(plan.arena)
    const assigned = domains.slice(1).reduce((sum, domain) => sum + BigInt(domain.backing.bytes), BigInt(plan.arenaReserveBytes))
    if (assigned > bytes(arena) || BigInt(arena.availableBlocks) * BigInt(arena.blockBytes) < BigInt(plan.arenaReserveBytes)
      || domains.slice(1).some(domain => domain.backing.device !== arena.device)) failure()
    const writableIds = new Set<string>()
    for (const account of plan.accounts) {
      if (account.accountRoot !== posix.join(posix.dirname(account.accountRoot), account.storageKey)
        || account.private.rootPath !== posix.join(account.accountRoot, 'private')
        || account.projects.rootPath !== posix.join(account.accountRoot, 'projects')) failure()
      for (const domain of [account.private, account.projects]) {
        const observed = measured(domain)
        if (observed.uid !== plan.appUid || observed.gid !== plan.appGid
          || (observed.mode & 0o7777) !== 0o700 || (observed.flags & 28) !== 28) failure()
        writableIds.add(observed.mountId)
      }
    }
    for (const domain of [plan.arena, plan.control]) if ((measured(domain).flags & 4) !== 0) failure()
    for (const auxiliary of plan.auxiliary) {
      const observed = await this.driver.probe(auxiliary.path)
      const mount = mounts.find(row => row.id === observed.mountId)
      if (!directory(observed) || mount?.path !== auxiliary.path || observed.filesystem !== '16914836'
        || bytes(observed) <= 0 || bytes(observed) > BigInt(auxiliary.maximumBytes)
        || BigInt(observed.inodes) <= 0 || BigInt(observed.inodes) > BigInt(auxiliary.maximumInodes)) failure()
      writableIds.add(observed.mountId)
    }
    // Root guarantees a read-only application view; every ordinary writable filesystem must be a declared fixed domain.
    const pseudo = new Set(['proc', 'sysfs', 'cgroup2', 'cgroup', 'devpts', 'mqueue', 'pstore', 'securityfs', 'debugfs',
      'tracefs', 'fusectl', 'configfs', 'binfmt_misc', 'autofs', 'hugetlbfs', 'nsfs', 'bpf', 'rpc_pipefs'])
    for (const mount of mounts) {
      if (!mount.writable || pseudo.has(mount.filesystem) || writableIds.has(mount.id)
        || domains.some(domain => domain.rootMountId === mount.id)) continue
      if (mount.path === '/dev' && mount.filesystem === 'tmpfs' && ((await this.driver.probe('/dev')).flags & 4) === 0) continue
      failure()
    }
  }
}

/** Retained exact-generation use of already provisioned domains; it cannot close the shared pool or issue another account. */
export class StaticAccountStorageLease {
  private installed?: { binding: AccountBinding; preparation: AccountFilesPreparation }
  private closing?: Promise<void>

  /**
   * @param owner Original verified root owner.
   * @param account Fixed authentic deployment assignment.
   * @param input Original factory generation, not an HTTP borrow.
   * @param plan Original protected deployment record.
   * @param driver Original shared-pool operations.
   * @param release Remove only this actual runtime lease after its files lane has ended.
   */
  constructor(private readonly owner: RootStorageOwner, private readonly account: StaticStorageAccount,
    private readonly input: AccountMountInput, private readonly plan: StaticStoragePlan,
    private readonly driver: StaticStorageDriver, private readonly release: () => void) {}

  /** Require current root and original graph lifetime without granting business readiness. */
  assertCurrent(): void {
    this.owner.assertRootCurrent()
    if (this.closing !== undefined || this.input.binding.lifetime.aborted || this.installed?.binding.lifetime.aborted) stale()
  }

  /** Check the complete server-derived layout before exposing any native private path. */
  assertLayout(): void {
    this.assertCurrent()
    const l = this.input.layout, a = this.account, p = a.private.rootPath
    if (l.storageKey !== a.storageKey || l.accountRoot !== a.accountRoot || l.privateRoot !== p || l.projectsRoot !== a.projects.rootPath
      || l.profileRoot !== posix.join(p, 'profile') || l.patchPath !== posix.join(p, 'profile', 'cordis.patch.yml')
      || l.credentialsRoot !== posix.join(p, 'credentials') || l.sessionsRoot !== posix.join(p, 'sessions')
      || l.storageRoot !== posix.join(p, 'storage') || l.attachmentsRoot !== posix.join(p, 'attachments')
      || l.skillsRoot !== posix.join(p, 'skills') || l.instructionsRoot !== posix.join(p, 'instructions')
      || l.environmentsRoot !== posix.join(a.accountRoot, 'environments')) failure()
  }

  /**
   * Admit only the original native read set before readProfilePatches or seed I/O.
   * @param profile Original graph's native Profile addresses.
   * @param baseConfigPath Read-only deployment base recipe.
   */
  assertBeforeNativeRead(profile: StaticStorageProfile, baseConfigPath: string): void {
    this.assertLayout()
    const l = this.input.layout
    if (profile.dir !== l.profileRoot || profile.patchPath !== l.patchPath || profile.home !== l.privateRoot
      || profile.cwd !== posix.join(l.projectsRoot, 'default-workspace') || profile.installAnchor !== this.plan.installAnchor
      || baseConfigPath !== this.plan.baseConfigPath) failure()
  }

  /**
   * Bind once after the original factory records the canonical installed runtime binding.
   * @param binding Exact installed object, carrying the original lifetime and PG generation.
   * @param assertCurrent Factory's current check, valid before business publication.
   * @param assertUnpublished Original factory registration window, never a ready flag.
   * @returns Existing M8R inputs over exactly one same-pool projects lane.
   */
  bindInstalled(
    binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void, assertUnpublished: () => void,
  ): AccountFilesPreparation {
    this.assertLayout()
    const original = this.input.binding
    if (binding.accountId !== original.accountId || binding.epoch !== original.epoch || binding.recipeVersion !== original.recipeVersion
      || binding.lifetime !== original.lifetime) stale()
    assertCurrent(binding)
    if (this.installed !== undefined) {
      if (this.installed.binding !== binding) stale()
      return this.installed.preparation
    }
    assertUnpublished()
    const current = (): void => { this.assertCurrent(); assertCurrent(binding) }
    const parent = Object.freeze({ rootPath: this.account.projects.rootPath, rootDevice: this.account.projects.rootDevice,
      rootInode: this.account.projects.rootInode, rootMountId: this.account.projects.rootMountId })
    const port = this.driver.bind(binding, parent, current)
    const preparation: AccountFilesPreparation = Object.freeze({ binding, port,
      defaultGrant: Object.freeze({ binding, parent, backend: 'root-owned-isolated-ext4', leaf: 'default-workspace',
        assertDeployment: current, assertExclusive: current }),
      assertMountCurrent: (actual: AccountBinding) => { if (actual !== binding) stale(); current() },
      assertUnpublished: () => { current(); assertUnpublished() } })
    this.installed = { binding, preparation }
    return preparation
  }

  /**
   * Join the original files lane after runtime has stopped its native/save/execution writers.
   * This never releases persistent domains or certifies another participant's cleanup.
   * @returns The one retained actual join; unresolved directory responsibility continues to hold it.
   */
  closeAfterActualDrain(): Promise<void> {
    this.closing ??= (async () => {
      if (this.installed !== undefined) await this.driver.joinEpoch(this.installed.binding)
      this.release()
    })()
    return this.closing
  }
}
