/** Measured preallocated storage admission; Runtime owns user assignments and the original pool owns actual I/O. */
import { posix } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AccountBinding, AccountMountInput, AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { AccountFilesPreparation } from './account-service.ts'
import type { PoolReadPort } from './worker-pool.ts'
import type { FdRootIdentity, FdStorageView } from './worker-protocol.ts'
import type { StaticStorageAccount, StaticStorageAccountV2, StaticStorageConfig, StaticStorageDomain, StaticStorageDeploymentPlan,
  StaticStoragePlanV3, StaticStorageSlot, StaticAccountAssignment, StaticAccountAssignments, StaticStorageInventory,
  StorageProbeFacts } from './storage-types.ts'
import { accountEnvironmentBank, parseStorageDeploymentPlan } from './storage-probe.ts'
import { FilesFailure } from './error.ts'
import type { ResolveAccountFileProject } from './text-project.ts'
import { parseRootSkillRevalidations, assertRootSkillRevalidation } from './skill-revalidation.ts'
import type { RootSkillRevalidationProof, SkillRecordRevalidation } from './skill-revalidation.ts'
import type { ProtectedSkillProof } from './storage-types.ts'

interface SkillRevalidationQualification {
  readonly proof: RootSkillRevalidationProof
  committedRevision?: string
}

/** Root initialization/probing uses the original prestarted slots and its separate finite resident reservation. */
export interface StaticStorageDriver {
  record(): Promise<Uint8Array<ArrayBuffer>>
  probe(path: string): Promise<StorageProbeFacts>
  view(): Promise<FdStorageView>
  /** Original worker reads only the fixed Root-configured protected proof, with independent process measurement. */
  skillProof?(): Promise<ProtectedSkillProof>
  assertPoolCurrent(): void
  bind(
    binding: AccountBinding, root: FdRootIdentity, current: () => void,
    privateParent?: FdRootIdentity & { readonly rootMountId: string },
    revalidation?: readonly SkillRecordRevalidation[],
  ): PoolReadPort
  joinEpoch(binding: AccountBinding): Promise<void>
  /** Omission conservatively retains every old original; actual root pool supplies this only for its configured native capability. */
  retireSkillVersions?(binding: AccountBinding, root: FdRootIdentity, uid: number, gid: number): Promise<void>
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

function failure(): never { throw new FilesFailure('files/prerequisite-missing',
  'The actual static storage deployment is unavailable or mismatched.') }
function stale(): never { throw new FilesFailure('cloud/stale-generation',
  'The static storage lease is closed or belongs to another generation.') }
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

function physicalAccounts(plan: StaticStorageDeploymentPlan): readonly (StaticStorageAccount | StaticStorageSlot)[] {
  return plan.version === 3 ? plan.slots : plan.accounts
}

function assignedAccount(slot: StaticStorageSlot, accountId: AccountId): StaticStorageAccountV2 {
  const { slotId: _slotId, templateId: _templateId, ...storage } = slot
  return Object.freeze({ accountId, ...storage })
}

/**
 * Decode the bounded process view and require the actual non-root, no-capability application identity.
 * @param view Closed-FD bounded proc results from the actual worker.
 * @param plan Protected deployment requirements, not permission assertions.
 * @returns The bounded live mount inventory for driver and writable-surface matching.
 */
export function validateStorageView(view: FdStorageView, plan: StaticStorageDeploymentPlan): readonly Mount[] {
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
  private plan?: StaticStorageDeploymentPlan
  private assignments?: { readonly resolver: StaticAccountAssignments; active: boolean }
  private readonly selectedAccounts = new Map<AccountId, {
    readonly assignment: StaticAccountAssignment
    readonly account: StaticStorageAccountV2
  }>()
  private skillProofs: readonly SkillRevalidationQualification[] = []
  private preparationTail: Promise<void> = Promise.resolve()
  private readonly leases: Array<{ input: AccountMountInput; result: Promise<StaticAccountStorageLease> }> = []

  /**
   * @param config Explicit root parser and resident bounds.
   * @param maxPathBytes Original pool path bound.
   * @param driver Original pool's operations; never installed in an account graph.
   * @param maxSkillProjects Original per-account projection bound; omission allows only one proof.
   */
  constructor(
    private readonly config: StaticStorageConfig, private readonly maxPathBytes: number, private readonly driver: StaticStorageDriver,
    private readonly maxSkillProjects?: number,
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
        if (this.plan.version !== 3 && this.assignments !== undefined) failure()
        await this.verify(this.plan)
        if (this.config.skillRevalidation !== undefined) {
          if (this.driver.skillProof === undefined) failure()
          const protectedProof = await this.driver.skillProof()
          if (protectedProof.bytes.byteLength > this.config.maxPlanBytes || createHash('sha256').update(protectedProof.bytes).digest('hex')
            !== this.config.skillRevalidation.proofSha256) failure()
          const proofs = parseRootSkillRevalidations(protectedProof.bytes, protectedProof.process, this.config.planSha256,
            this.proofAccounts(this.plan), this.maxSkillProjects)
          this.skillProofs = proofs.map(proof => ({ proof }))
        }
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

  /** Require a verified inventory with execution banks; v1 remains valid only for closed execution. */
  assertExecutionStorageAvailable(): void {
    this.assertRootCurrent()
    if (this.plan?.version === 1) failure()
  }

  /**
   * Install Runtime's sole assignment registry before or after physical initialization.
   * @param resolver Root-owned registry; user requests cannot supply paths or assignment objects.
   * @returns Idempotent withdrawal; existing leases retain cleanup ownership and reject new work.
   */
  installAccountAssignments(resolver: StaticAccountAssignments): () => void {
    if (this.assignments !== undefined || this.state === 'closed' || this.state === 'failed'
      || this.plan !== undefined && this.plan.version !== 3) failure()
    const installed = { resolver, active: true }
    this.assignments = installed
    return () => { installed.active = false }
  }

  /**
   * Read verified deployment capacity without exposing storage addresses or issuing a lease.
   * @returns Slot identifiers and templates for v3; legacy deployments have no dynamic inventory.
   */
  staticInventory(): StaticStorageInventory | undefined {
    this.assertRootCurrent()
    const plan = this.plan
    if (plan === undefined || plan.version !== 3) return undefined
    return Object.freeze({ sha256: this.config.planSha256, maxAccounts: plan.maxAccounts,
      slots: Object.freeze(plan.slots.map(slot => Object.freeze({ slotId: slot.slotId, templateId: slot.templateId }))) })
  }

  /**
   * Resolve Runtime's current account assignment against already measured physical domains.
   * @param accountId Server-authenticated user identity supplied by trusted Runtime.
   * @returns Immutable addresses only; callers still need the original preparation and installed binding.
   */
  resolveAccountStorage(accountId: AccountId): StaticStorageAccount {
    this.assertRootCurrent()
    const plan = this.plan
    if (plan === undefined) failure()
    if (plan.version !== 3) return plan.accounts.find(row => row.accountId === accountId) ?? failure()
    return this.selectAssignedAccount(plan, accountId).account
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
    const account = this.resolveAccountStorage(input.binding.accountId)
    const assertAssignment = plan.version === 3 ? this.selectAssignedAccount(plan, input.binding.accountId).current : () => {}
    if (account.storageKey !== input.layout.storageKey || input.binding.recipeVersion !== plan.recipeVersion
      || input.binding.lifetime.aborted) failure()
    const skillProofs = this.skillProofs.filter(row => row.proof.accountId === account.accountId
      && row.proof.storageKey === account.storageKey)
    const existing = this.leases.find(row => row.input.binding.accountId === input.binding.accountId)
    if (existing !== undefined) {
      if (existing.input.binding !== input.binding || existing.input.layout !== input.layout
        || existing.input.instanceId !== input.instanceId) stale()
      return existing.result
    }
    if (this.leases.length >= (plan.version === 3 ? plan.maxAccounts : 2)) failure()
    const entry: { input: AccountMountInput; result: Promise<StaticAccountStorageLease> } = {
      input, result: this.preparationTail.then(async () => {
        this.assertRootCurrent()
        assertAssignment()
        assertLifetime(input.binding.lifetime)
        try {
          await this.readPlan()
          await this.verify(plan)
        } catch (error) { this.failedInitialization(); throw error }
        this.assertRootCurrent()
        assertAssignment()
        assertLifetime(input.binding.lifetime)
        const lease = new StaticAccountStorageLease(this, account, input, plan, this.driver, () => {
          const index = this.leases.indexOf(entry)
          if (index >= 0) this.leases.splice(index, 1)
        }, skillProofs, assertAssignment)
        lease.assertLayout()
        return lease
      }),
    }
    this.leases.push(entry)
    // The entry retains the original rejection; the tail joins only its actual settlement.
    this.preparationTail = entry.result.then(() => {}, () => {})
    return entry.result
  }

  /**
   * Match a skill port to the actual protected private domain and an original retained account lease.
   * @param binding Original installed generation, sharing the factory's authentic epoch/lifetime.
   * @param root Captured private anchor, never a model path.
   * @returns Actual application identity from the verified deployment record.
   */
  skillStorageIdentity(binding: AccountBinding, root: FdRootIdentity): { readonly uid: number
    readonly gid: number
    readonly projects: StaticStorageDomain
    readonly privateDomain: StaticStorageDomain } {
    this.assertRootCurrent()
    const plan = this.plan
    const entry = this.leases.find(row => row.input.binding.accountId === binding.accountId
      && row.input.binding.epoch === binding.epoch && row.input.binding.lifetime === binding.lifetime
      && row.input.binding.recipeVersion === binding.recipeVersion)
    if (entry === undefined || plan === undefined || binding.lifetime.aborted) stale()
    const account = this.resolveAccountStorage(binding.accountId)
    if (account.storageKey !== entry.input.layout.storageKey
      || root.rootPath !== account.private.rootPath || root.rootDevice !== account.private.rootDevice
      || root.rootInode !== account.private.rootInode || root.rootMountId !== account.private.rootMountId) stale()
    return Object.freeze({ uid: plan.appUid, gid: plan.appGid, projects: account.projects, privateDomain: account.private })
  }

  /** Stop new preparation and revoke existing lease admission; actual work and physical capacity stay owned. */
  closeAdmission(): void { this.state = 'closed' }

  private finishInitialization(): void { if (this.state !== 'checking') stale(); this.state = 'open' }

  private failedInitialization(): void { if (this.state !== 'closed') this.state = 'failed' }

  private async readPlan(): Promise<StaticStorageDeploymentPlan> {
    const record = await this.driver.record()
    if (record.byteLength > this.config.maxPlanBytes
      || createHash('sha256').update(record).digest('hex') !== this.config.planSha256) failure()
    return parseStorageDeploymentPlan(record, this.maxPathBytes)
  }

  private selectAssignedAccount(plan: StaticStoragePlanV3, accountId: AccountId): {
    readonly account: StaticStorageAccountV2
    readonly current: () => void
  } {
    const installed = this.assignments
    if (installed === undefined || !installed.active) failure()
    const assignment = installed.resolver.lookup(accountId)
    if (assignment === undefined || assignment.accountId !== accountId) failure()
    installed.resolver.assertCurrent(assignment)
    const slot = plan.slots.find(row => row.slotId === assignment.slotId)
    if (slot === undefined) failure()
    let selected = this.selectedAccounts.get(accountId)
    if (selected === undefined) {
      if (this.selectedAccounts.size >= plan.maxAccounts
        || [...this.selectedAccounts.values()].some(row => row.assignment.slotId === assignment.slotId)) failure()
      selected = { assignment, account: assignedAccount(slot, accountId) }
      this.selectedAccounts.set(accountId, selected)
    }
    if (selected.assignment !== assignment) stale()
    const current = (): void => {
      this.assertRootCurrent()
      if (this.assignments !== installed || !installed.active || installed.resolver.lookup(accountId) !== assignment) stale()
      installed.resolver.assertCurrent(assignment)
    }
    return { account: selected.account, current }
  }

  private proofAccounts(plan: StaticStorageDeploymentPlan): readonly StaticStorageAccount[] {
    if (plan.version !== 3) return plan.accounts
    const installed = this.assignments
    if (installed === undefined || !installed.active) failure()
    const assignments = installed.resolver.list()
    if (assignments.length > plan.maxAccounts
      || new Set(assignments.map(row => row.accountId)).size !== assignments.length
      || new Set(assignments.map(row => row.slotId)).size !== assignments.length) failure()
    return assignments.map((assignment) => {
      if (installed.resolver.lookup(assignment.accountId) !== assignment) failure()
      installed.resolver.assertCurrent(assignment)
      const slot = plan.slots.find(row => row.slotId === assignment.slotId)
      if (slot === undefined) failure()
      return assignedAccount(slot, assignment.accountId)
    })
  }

  private async verify(plan: StaticStorageDeploymentPlan): Promise<void> {
    const mounts = validateStorageView(await this.driver.view(), plan)
    const root = await this.driver.probe('/')
    if (!directory(root) || (root.flags & 32) === 0 || (root.flags & 4) !== 0
      || root.appUid !== plan.appUid || root.appGid !== plan.appGid) failure()
    for (const path of [plan.baseConfigPath, plan.installAnchor]) readonlyObject(await this.driver.probe(path))
    const accounts = physicalAccounts(plan)
    const domains = [plan.arena, plan.control, ...accounts.flatMap(account => [account.private, account.projects,
      ...accountEnvironmentBank(account)?.slots.map(slot => slot.domain) ?? []])]
    const bankIds = accounts.flatMap((account) => {
      const bank = accountEnvironmentBank(account)
      return bank === undefined ? [] : [bank.bankId]
    })
    if (new Set(bankIds).size !== bankIds.length) failure()
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
    for (const account of accounts) {
      if (account.accountRoot !== posix.join(posix.dirname(account.accountRoot), account.storageKey)
        || account.private.rootPath !== posix.join(account.accountRoot, 'private')
        || account.projects.rootPath !== posix.join(account.accountRoot, 'projects')) failure()
      for (const domain of [account.private, account.projects, ...accountEnvironmentBank(account)?.slots.map(slot => slot.domain) ?? []]) {
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
    const exportRoots = accounts.flatMap(account => [account.projects.rootPath, posix.join(account.accountRoot, 'environments')])
    // Exported trees admit only declared domains, including when a foreign submount is read-only or a pseudo filesystem.
    const pseudo = new Set(['proc', 'sysfs', 'cgroup2', 'cgroup', 'devpts', 'mqueue', 'pstore', 'securityfs', 'debugfs',
      'tracefs', 'fusectl', 'configfs', 'binfmt_misc', 'autofs', 'hugetlbfs', 'nsfs', 'bpf', 'rpc_pipefs'])
    for (const mount of mounts) {
      if (exportRoots.some(root => mount.path === root || mount.path.startsWith(root + '/'))
        && !domains.some(domain => domain.rootMountId === mount.id && domain.rootPath === mount.path)) failure()
      if (!mount.writable || pseudo.has(mount.filesystem) || writableIds.has(mount.id)
        || domains.some(domain => domain.rootMountId === mount.id)) continue
      if (mount.path === '/dev' && mount.filesystem === 'tmpfs' && ((await this.driver.probe('/dev')).flags & 4) === 0) continue
      failure()
    }
  }
}

/** Retained exact-generation use of already provisioned domains; it cannot close the shared pool or issue another account. */
export class StaticAccountStorageLease {
  private installed?: { binding: AccountBinding; preparation: AccountFilesPreparation; resolveProject: ResolveAccountFileProject }
  private closing?: Promise<void>

  /**
   * @param owner Original verified root owner.
   * @param account Fixed authentic deployment assignment.
   * @param input Original factory generation, not an HTTP borrow.
   * @param plan Original protected deployment record.
   * @param driver Original shared-pool operations.
   * @param release Remove only this actual runtime lease after its files lane has ended.
   * @param skillProofs Original Root qualifications for this account; ordinary account admission is unchanged.
   * @param assertAssignment Original v3 binding check; omission preserves legacy fixed-account admission.
   */
  constructor(private readonly owner: RootStorageOwner, private readonly account: StaticStorageAccount,
    private readonly input: AccountMountInput, private readonly plan: StaticStorageDeploymentPlan,
    private readonly driver: StaticStorageDriver, private readonly release: () => void,
    private readonly skillProofs: readonly SkillRevalidationQualification[] = [],
    private readonly assertAssignment: () => void = () => {}) {}

  /** Require current root and original graph lifetime without granting business readiness. */
  assertCurrent(): void {
    this.owner.assertRootCurrent()
    this.assertAssignment()
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
   * @param resolveProject Trusted runtime selection derived asynchronously from the current native caller.
   * @returns Existing M8R inputs over exactly one same-pool projects lane.
   */
  bindInstalled(
    binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void, assertUnpublished: () => void,
    resolveProject: ResolveAccountFileProject,
  ): AccountFilesPreparation {
    this.assertLayout()
    const original = this.input.binding
    if (binding.accountId !== original.accountId || binding.epoch !== original.epoch || binding.recipeVersion !== original.recipeVersion
      || binding.lifetime !== original.lifetime) stale()
    assertCurrent(binding)
    if (this.installed !== undefined) {
      if (this.installed.binding !== binding || this.installed.resolveProject !== resolveProject) stale()
      return this.installed.preparation
    }
    assertUnpublished()
    const current = (): void => { this.assertCurrent(); assertCurrent(binding) }
    const parent = Object.freeze({ rootPath: this.account.projects.rootPath, rootDevice: this.account.projects.rootDevice,
      rootInode: this.account.projects.rootInode, rootMountId: this.account.projects.rootMountId })
    const privateParent = Object.freeze({ rootPath: this.account.private.rootPath, rootDevice: this.account.private.rootDevice,
      rootInode: this.account.private.rootInode, rootMountId: this.account.private.rootMountId })
    const revalidation: readonly SkillRecordRevalidation[] | undefined = this.skillProofs.length === 0 ? undefined
      : Object.freeze(this.skillProofs.map((qualification) => {
        const proof = qualification.proof
        return Object.freeze({
          workspaceId: proof.workspaceId, recordSha256: proof.recordSha256, recordRevision: proof.recordRevision,
          get pending() { return qualification.committedRevision === undefined },
          assertRecord: (revision: string) => {
            current()
            if (this.installed?.binding !== binding || qualification.committedRevision !== undefined
              || revision !== proof.recordRevision) stale()
            assertRootSkillRevalidation(proof, this.input, this.account)
          },
          confirmRecord: (previousRevision: string, committedRevision: string) => {
            if (previousRevision !== proof.recordRevision || qualification.committedRevision !== undefined) stale()
            qualification.committedRevision = committedRevision
          },
        })
      }))
    const port = this.driver.bind(binding, parent, current, privateParent, revalidation)
    const bank = accountEnvironmentBank(this.account)
    const preparation: AccountFilesPreparation = Object.freeze<AccountFilesPreparation>({ binding, port,
      assertContentAvailable: () => { port.assertContentAvailable() },
      attachments: port,
      createFileSystem: (workspace, assertInstalled, mapProcessPath, enforceSessionFilePolicy) =>
        port.createTextFileSystem(workspace, assertInstalled, resolveProject, mapProcessPath, enforceSessionFilePolicy),
      projectFor: (workspace, assertRegistered, signal) => port.projectFor(workspace, assertRegistered, signal),
      ...bank === undefined ? {} : { prepareExecutionMounts: (workspace, sessionId, environmentVersion, assertRegistered, signal) => {
        this.owner.assertExecutionStorageAvailable()
        current()
        return port.prepareExecutionMounts(workspace, sessionId, environmentVersion,
          { bank, appUid: this.plan.appUid, appGid: this.plan.appGid, projects: this.account.projects }, assertRegistered, signal)
      } },
      createProject: async (registry, use, title, signal) => {
        signal.throwIfAborted()
        use.assertCurrent()
        current()
        if (use.binding !== binding) stale()
        const assertOperation = (): void => { current(); use.assertCurrent() }
        const grant = Object.freeze({ binding, parent, backend: 'root-owned-isolated-ext4' as const, leaf: randomUUID(),
          assertDeployment: assertOperation, assertExclusive: assertOperation })
        return await registry.createAdmittedProject(use, grant, title, signal)
      },
      withInstructionReaders: port.withInstructionReaders,
      skillVersions: () => port.skillVersions(),
      skillProjection: () => port.skillProjection(),
      defaultGrant: Object.freeze({ binding, parent, backend: 'root-owned-isolated-ext4', leaf: 'default-workspace',
        assertDeployment: current, assertExclusive: current }),
      assertMountCurrent: (actual: AccountBinding) => { if (actual !== binding) stale(); current() },
      assertUnpublished: () => { current(); assertUnpublished() } })
    this.installed = { binding, preparation, resolveProject }
    return preparation
  }

  /**
   * Join the original files lane after runtime has stopped its native/save/execution writers.
   * This never releases persistent domains or certifies another participant's cleanup.
   * @returns The one retained actual join; unresolved directory responsibility continues to hold it.
   */
  closeAfterActualDrain(): Promise<void> {
    this.closing ??= (async () => {
      if (this.installed !== undefined) {
        await this.driver.joinEpoch(this.installed.binding)
        await this.driver.retireSkillVersions?.(this.installed.binding, { rootPath: this.account.private.rootPath,
          rootDevice: this.account.private.rootDevice, rootInode: this.account.private.rootInode, rootMountId
          : this.account.private.rootMountId },
        this.plan.appUid, this.plan.appGid)
      }
      this.release()
    })()
    return this.closing
  }
}
