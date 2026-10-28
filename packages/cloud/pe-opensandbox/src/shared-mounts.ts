/** Retained directory ownership shared by protected legacy exports and stable shared-path storage. */
import type { VerifiedExecutionMount } from './lifecycle-types.ts'
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, statfsSync } from 'node:fs'
import { posix } from 'node:path'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import { parseStaticStoragePlan, accountEnvironmentBank } from '@deepseek-ai/dsh-pe-cloud-files/root'
import type { StaticStoragePlanV2, StaticStorageDomain } from '@deepseek-ai/dsh-pe-cloud-files/root'
import type { SkillProjectGrant } from './skill-files-types.ts'
import type { ExecutionExportShare, ManagedExecutionDeployment } from './managed-coordinator.ts'
import type { RetainedExecutionExports } from './export-share.ts'
import { ExecutionStateError } from './errors.ts'
import { SESSION_DIRECTORY_SERVER_IMAGE_DIGEST } from './bootstrap/deployment-input.ts'

/** Private Root failure; native callers receive the existing secret-free execution classification. */
export class ExecutionExportFailure extends ExecutionStateError {
  /** @param phase Failed private operation. @param privateCause Root-only original failure, omitted for measured mismatches. */
  constructor(readonly phase: 'manifest' | 'selection' | 'verification' | 'close-unknown', readonly privateCause?: unknown) {
    super('cloud/execution-unavailable', phase === 'close-unknown'
      ? 'Export descriptor closure is unconfirmed; retain the original allocation and Root responsibility.'
      : 'The original protected execution exports are unavailable or mismatched.')
    this.name = 'ExecutionExportFailure'
  }
}

/** Exact source geometry used to verify every retained directory. */
export interface ExecutionSourceFacts {
  readonly device: string
  readonly inode: string
  readonly mountId: string
  readonly mode: string
  readonly uid: string
  readonly gid: string
  readonly filesystem: string
  readonly blockBytes: string
  readonly blocks: string
  readonly inodes: string
}
/** Descriptor batch retains unknown closure even after the descriptor number is removed. */
export interface ExecutionMountBatch { readonly fds: Set<number>; unknown?: ExecutionExportFailure }
/** Process-local mount measurements that must remain stable during a share. */
export interface CapturedExecutionMounts { readonly projectMountId: string; readonly environmentMountId: string }
/** Exact directory identity from the original files grant. */
export interface ExecutionDirectoryIdentity {
  readonly device: string
  readonly inode: string
  readonly uid: number
  readonly gid: number
  readonly mode: number
}
/** Bounded local mount inventory, including propagation attributes. */
export interface ExecutionMountRow {
  readonly id: string
  readonly path: string
  readonly flags: readonly string[]
  readonly filesystem: string
  readonly optional: readonly string[]
}
type Facts = ExecutionSourceFacts
type Batch = ExecutionMountBatch
type Captured = CapturedExecutionMounts
type DirectoryIdentity = ExecutionDirectoryIdentity
type Mount = ExecutionMountRow
interface RetainedShare extends Batch { readonly binding: ExecutionMountGrant['binding']; released: boolean }
function invalid(phase: ExecutionExportFailure['phase']): never { throw new ExecutionExportFailure(phase) }

function open(batch: Batch, name: string, directory: boolean): number {
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0))
  batch.fds.add(fd)
  return fd
}
function close(batch: Batch, fd: number): void {
  // Remove before the syscall: an uncertain close never authorizes retrying a possibly reused descriptor number.
  batch.fds.delete(fd)
  try { closeSync(fd) }
  catch (cause) { batch.unknown ??= new ExecutionExportFailure('close-unknown', cause); throw batch.unknown }
}
function closeAll(batch: Batch): void {
  for (const fd of batch.fds) {
    try { close(batch, fd) }
    catch (_cause) { /* The batch retains the first close uncertainty; independently owned descriptors still settle. */ }
  }
  if (batch.unknown !== undefined) throw batch.unknown
}
function readProc(batch: Batch, name: string, maximum: number): string {
  const fd = open(batch, name, false)
  try {
    const bytes = Buffer.alloc(maximum + 1)
    let total = 0
    while (total <= maximum) {
      const count = readSync(fd, bytes, total, bytes.length - total, null)
      if (count === 0) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))
      total += count
    }
    return invalid('verification')
  } finally { close(batch, fd) }
}
function mountId(batch: Batch, fd: number): string {
  const matches = [...readProc(batch, `/proc/self/fdinfo/${fd}`, 4096).matchAll(/^mnt_id:\s+([1-9]\d{0,19})$/gm)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) invalid('verification')
  return matches[0][1]
}
function mounts(batch: Batch, maximum: number): readonly Mount[] {
  const result = readProc(batch, '/proc/self/mountinfo', maximum).split('\n').filter(Boolean).map((line): Mount => {
    const sides = line.split(' - '), left = sides[0]?.split(' '), right = sides[1]?.split(' ')
    const id = left?.[0], encoded = left?.[4], flags = left?.[5], filesystem = right?.[0]
    if (sides.length !== 2 || left === undefined || left.length < 6 || right === undefined || right.length < 3
      || id === undefined || !/^[1-9]\d{0,19}$/.test(id) || encoded === undefined || flags === undefined
      || filesystem === undefined) invalid('verification')
    const decoded = encoded.replace(/\\(040|011|012|134)/g, (_match, code: string) => String.fromCharCode(parseInt(code, 8)))
    return { id, path: decoded, flags: flags.split(','), filesystem, optional: left.slice(6) }
  })
  if (result.length === 0 || new Set(result.map(entry => entry.id)).size !== result.length) invalid('verification')
  return result
}
function protectedParents(name: string): void {
  let current = '/'
  for (const part of posix.dirname(name).slice(1).split('/')) {
    current = posix.join(current, part)
    const info = lstatSync(current, { bigint: true })
    if (!info.isDirectory() || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o022n) !== 0n) invalid('verification')
  }
}
function verifyDirectory(batch: Batch, fd: number, expected: DirectoryIdentity, domain: Facts, expectedMountId?: string): string {
  const info = fstatSync(fd, { bigint: true }), geometry = statfsSync(`/proc/self/fd/${fd}`, { bigint: true })
  const id = mountId(batch, fd)
  if (!info.isDirectory() || String(info.dev) !== expected.device || String(info.ino) !== expected.inode
    || info.uid !== BigInt(expected.uid) || info.gid !== BigInt(expected.gid) || info.mode !== BigInt(expected.mode)
    || geometry.type !== 61267n || String(geometry.bsize) !== domain.blockBytes || String(geometry.blocks) !== domain.blocks
    || String(geometry.files) !== domain.inodes || expectedMountId !== undefined && id !== expectedMountId) invalid('verification')
  return id
}
/** Per-mode source checks; the common owner controls all directory closure and retained counts. */
export interface ExecutionMountVerification<Selected> {
  /** Recheck the original protected plan or publication capability. */
  assertCurrent(): void
  /**
   * Select only sources belonging to this exact grant.
   * @param grant Original files grant.
   * @param skills Original optional skill grant.
   * @returns Account-selected sources.
   */
  select(grant: ExecutionMountGrant, skills?: SkillProjectGrant): Selected
  /**
   * Capture and verify descriptors under this batch's ownership.
   * @param batch Original descriptor owner.
   * @param selected Account-selected sources.
   * @param grant Original files grant.
   * @param skills Original optional skill grant.
   * @returns Local mount IDs.
   */
  capture(batch: ExecutionMountBatch, selected: Selected, grant: ExecutionMountGrant, skills?: SkillProjectGrant): CapturedExecutionMounts
  /**
   * Produce source paths only after capture succeeds.
   * @param selected Verified sources.
   * @param skills Original optional skill grant.
   * @returns SDK source paths.
   */
  paths(selected: Selected, skills?: SkillProjectGrant): VerifiedExecutionMount['exports']
}

/** Root-only FD measurements; callers keep each batch until every known descriptor has settled. */
export const executionMountFiles = Object.freeze({ open, closeAll, mounts, protectedParents, verifyDirectory })

/**
 * Own descriptors for either execution storage mode without releasing original files/native grants.
 * @param maximum Explicit retained share capacity, validated by the mode's factory.
 * @param verification Mode-specific source authority and measurements.
 * @returns Shares with idempotent settled release and sticky close uncertainty.
 */
export function createExecutionMountShares<Selected>(maximum: number,
  verification: ExecutionMountVerification<Selected>): RetainedExecutionExports {
  const retained = new Set<RetainedShare>()
  let failure: { readonly cause: unknown } | undefined, checking = false
  const available = (): void => {
    if (failure !== undefined) {
      throw failure.cause instanceof ExecutionExportFailure ? failure.cause : new ExecutionExportFailure('verification', failure.cause)
    }
    verification.assertCurrent()
  }
  const guard = (grant: ExecutionMountGrant, current: () => void): void => {
    current(); grant.binding.lifetime.throwIfAborted(); available()
  }
  const release = (record: RetainedShare): void => {
    if (record.released) return
    try { closeAll(record) }
    catch (cause) { failure ??= { cause }; throw cause }
    record.released = true; retained.delete(record)
  }
  const verify = (record: RetainedShare, selected: Selected, grant: ExecutionMountGrant, skills?: SkillProjectGrant): Captured => {
    try { return verification.capture(record, selected, grant, skills) }
    catch (cause) {
      failure ??= { cause }
      throw cause instanceof ExecutionExportFailure ? cause : new ExecutionExportFailure('verification', cause)
    }
  }
  const exclusive = <T>(action: () => T): T => {
    if (checking) invalid('verification')
    checking = true
    try { return action() } finally { checking = false }
  }
  const assertRetained = (record: RetainedShare): void => {
    if (record.released || record.unknown !== undefined) invalid('verification')
  }
  const shareNow = (grant: ExecutionMountGrant, current: () => void, skills?: VerifiedExecutionMount['skills']): ExecutionExportShare => exclusive(() => {
    guard(grant, current)
    const selected = verification.select(grant, skills?.grant)
    if (retained.size >= maximum) throw new ExecutionStateError('cloud/capacity', 'Execution export share capacity is exhausted.')
    const record: RetainedShare = { binding: grant.binding, fds: new Set(), released: false }
    retained.add(record)
    try {
      const captured = verify(record, selected, grant, skills?.grant)
      guard(grant, current)
      const value = Object.freeze({ grant, exports: verification.paths(selected, skills?.grant),
        ...skills === undefined ? {} : { skills },
        assertCurrent: (): void => { exclusive(() => {
          assertRetained(record)
          guard(grant, current)
          assertRetained(record)
          const temporary: RetainedShare = { binding: grant.binding, fds: new Set(), released: false }
          try {
            const measured = verify(temporary, selected, grant, skills?.grant)
            if (measured.projectMountId !== captured.projectMountId || measured.environmentMountId !== captured.environmentMountId) {
              failure ??= { cause: new ExecutionExportFailure('verification') }; throw failure.cause
            }
          } finally {
            try { closeAll(temporary) }
            catch (cause) {
              if (temporary.unknown !== undefined) record.unknown ??= temporary.unknown
              failure ??= { cause }; throw cause
            }
          }
          guard(grant, current)
          assertRetained(record)
        }) } })
      return Object.freeze({ value, release: () => { release(record) } })
    } catch (cause) {
      release(record)
      throw cause
    }
  })
  const share: ManagedExecutionDeployment['share'] = (grant, current, skills) => {
    try { return Promise.resolve(shareNow(grant, current, skills)) }
    catch (cause) { return Promise.reject(cause instanceof Error ? cause : new ExecutionExportFailure('verification', cause)) }
  }
  const assertEpochReleased: ManagedExecutionDeployment['assertEpochReleased'] = (binding) => {
    for (const record of retained) if (record.binding === binding) {
      throw record.unknown ?? new ExecutionExportFailure('verification')
    }
  }
  return Object.freeze({ share, assertEpochReleased, get retainedShares() { return retained.size }, assertCurrent: available })
}

/** Explicit Root capacities for the existing protected files plan and retained shared-path checks. */
export interface SharedPathExecutionLimits {
  readonly maxPlanBytes: number
  readonly maxMountInfoBytes: number
  readonly maxPathBytes: number
  readonly maxShares: number
  readonly maxResidentBytes: number
}

interface SharedSelection {
  readonly project: StaticStorageDomain
  readonly environment: StaticStorageDomain
  readonly environmentLeaf: string | undefined
  readonly leaf: string
  readonly uid: number
  readonly gid: number
}

function selectShared(plan: StaticStoragePlanV2, grant: ExecutionMountGrant, maximum: number, skills?: SkillProjectGrant): SharedSelection {
  const account = plan.accounts.find(account => account.accountId === grant.binding.accountId)
  if (account === undefined || grant.binding.recipeVersion !== plan.recipeVersion
    || posix.basename(account.accountRoot) !== account.storageKey
    || account.projects.rootPath !== `${account.accountRoot}/projects`) invalid('selection')
  const bank = accountEnvironmentBank(account)
  const environment = bank?.slots.find(slot => slot.slotId === grant.environment.slotId)?.domain
  if (bank?.bankId !== grant.environment.bankId || environment === undefined) invalid('selection')
  const project = account.projects, leaf = posix.relative(project.rootPath, grant.project.rootPath)
  const environmentLeaf = bank.mode === 'session-directories'
    ? posix.relative(environment.rootPath, grant.environment.rootPath) : undefined
  const environmentPath = environmentLeaf === undefined ? environment.rootPath : `${environment.rootPath}/${environmentLeaf}`
  if (leaf !== 'default-workspace'
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf)) invalid('selection')
  if (environmentLeaf !== undefined
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(environmentLeaf)) invalid('selection')
  if (grant.project.rootPath !== `${project.rootPath}/${leaf}` || grant.environment.rootPath !== environmentPath
    || Buffer.byteLength(`${grant.project.rootPath}/.pe`) > maximum
    || Buffer.byteLength(environmentPath) > maximum) invalid('selection')
  for (const [root, domain] of [[grant.project, project], [grant.environment, environment]] as const) {
    if (root.rootDevice !== domain.rootDevice || root.rootMountId !== domain.rootMountId
      || root.quota.device !== domain.rootDevice || root.quota.mountId !== domain.rootMountId
      || BigInt(root.quota.maximumBytes) < BigInt(domain.minimumBytes)
      || BigInt(root.quota.maximumBytes) > BigInt(domain.maximumBytes)
      || BigInt(root.quota.maximumInodes) < BigInt(domain.minimumInodes)
      || BigInt(root.quota.maximumInodes) > BigInt(domain.maximumInodes)) invalid('selection')
  }
  const uid = plan.appUid, gid = plan.appGid
  if ((environmentLeaf === undefined ? grant.environment.rootInode !== environment.rootInode
    : grant.environment.rootInode === environment.rootInode)
    || grant.project.mountVersion !== `${grant.project.rootDevice}:${grant.project.rootInode}:${grant.project.rootMountId}`
    || grant.project.metadataDirectory.mountId !== project.rootMountId
    || grant.project.metadataDirectory.device !== project.rootDevice || grant.project.metadataDirectory.uid !== uid
    || grant.project.metadataDirectory.gid !== gid || grant.project.metadataDirectory.mode !== 0o40700) invalid('selection')
  if (skills !== undefined && (skills.binding !== grant.binding || skills.workspaceId !== grant.workspaceId
    || skills.project.rootPath !== grant.project.rootPath || skills.project.rootDevice !== grant.project.rootDevice
    || skills.project.rootInode !== grant.project.rootInode || skills.project.rootMountId !== grant.project.rootMountId
    || skills.project.quota.device !== grant.project.quota.device || skills.project.quota.mountId !== grant.project.quota.mountId
    || skills.project.quota.maximumBytes !== grant.project.quota.maximumBytes
    || skills.project.quota.maximumInodes !== grant.project.quota.maximumInodes
    || Buffer.byteLength(`${grant.project.rootPath}/.pe/skills`) > maximum
    || (['device', 'inode', 'mountId', 'uid', 'gid', 'mode'] as const).some(key => skills.metadataDirectory[key] !== grant.project.metadataDirectory[key])
    || skills.skillsDirectory.device !== project.rootDevice || skills.skillsDirectory.mountId !== project.rootMountId
    || skills.skillsDirectory.uid !== uid || skills.skillsDirectory.gid !== gid || skills.skillsDirectory.mode !== 0o40700)) invalid('selection')
  for (const leaf of ['home', 'venv', 'tmp'] as const) {
    const expected = grant.environment.layout[leaf]
    if (expected.device !== environment.rootDevice || expected.mountId !== environment.rootMountId
      || expected.uid !== uid || expected.gid !== gid || expected.mode !== 0o40700) invalid('selection')
  }
  return { project, environment, environmentLeaf, leaf, uid, gid }
}

function sharedRoot(batch: Batch, domain: StaticStorageDomain, quota: ExecutionMountGrant['project']['quota'],
  inventory: readonly Mount[], executable: boolean, uid: number, gid: number): { readonly fd: number; readonly facts: Facts } {
  protectedParents(domain.rootPath)
  const fd = open(batch, domain.rootPath, true), geometry = statfsSync(`/proc/self/fd/${fd}`, { bigint: true })
  if (String(geometry.bsize * geometry.blocks) !== quota.maximumBytes
    || String(geometry.files) !== quota.maximumInodes) invalid('verification')
  const facts: Facts = { device: domain.rootDevice, inode: domain.rootInode, mountId: domain.rootMountId,
    uid: String(uid), gid: String(gid), mode: String(0o40700), filesystem: '61267',
    blockBytes: String(geometry.bsize), blocks: String(geometry.blocks), inodes: String(geometry.files) }
  const id = verifyDirectory(batch, fd, { device: domain.rootDevice, inode: domain.rootInode, uid, gid, mode: 0o40700 },
    facts, domain.rootMountId)
  const selected = inventory.find(row => row.id === id)
  if (selected?.path !== domain.rootPath || selected.filesystem !== 'ext4' || !selected.flags.includes('rw')
    || selected.flags.includes('ro') || !selected.flags.includes('nosuid') || !selected.flags.includes('nodev')
    || selected.flags.includes('noexec') === executable
    || selected.optional.some(option => /^(shared|master|propagate_from):/.test(option))
    || inventory.some(row => row.path.startsWith(domain.rootPath + '/'))) invalid('verification')
  return { fd, facts }
}

function captureShared(batch: Batch, selected: SharedSelection, grant: ExecutionMountGrant,
  maximum: number, skills?: SkillProjectGrant): Captured {
  const inventory = mounts(batch, maximum), { uid, gid } = selected
  const project = sharedRoot(batch, selected.project, grant.project.quota, inventory, false, uid, gid)
  const workspace = open(batch, `/proc/self/fd/${project.fd}/${selected.leaf}`, true)
  verifyDirectory(batch, workspace, { device: grant.project.rootDevice, inode: grant.project.rootInode, uid, gid, mode: 0o40700 },
    project.facts, selected.project.rootMountId)
  const metadata = open(batch, `/proc/self/fd/${workspace}/.pe`, true)
  verifyDirectory(batch, metadata, grant.project.metadataDirectory, project.facts, selected.project.rootMountId)
  if (skills !== undefined) verifyDirectory(batch, open(batch, `/proc/self/fd/${metadata}/skills`, true),
    skills.skillsDirectory, project.facts, selected.project.rootMountId)
  const environment = sharedRoot(batch, selected.environment, grant.environment.quota, inventory, true, uid, gid)
  let environmentFd = environment.fd
  if (selected.environmentLeaf !== undefined) {
    environmentFd = open(batch, `/proc/self/fd/${environment.fd}/${selected.environmentLeaf}`, true)
    verifyDirectory(batch, environmentFd, { device: grant.environment.rootDevice, inode: grant.environment.rootInode,
      uid, gid, mode: 0o40700 }, environment.facts, selected.environment.rootMountId)
    // Retain the selected child, not the whole pool; peak/retained FD counts remain within the original reservation.
    close(batch, environment.fd)
  }
  for (const leaf of ['home', 'venv', 'tmp'] as const) {
    verifyDirectory(batch, open(batch, `/proc/self/fd/${environmentFd}/${leaf}`, true), grant.environment.layout[leaf],
      environment.facts, selected.environment.rootMountId)
  }
  return { projectMountId: selected.project.rootMountId, environmentMountId: selected.environment.rootMountId }
}

/**
 * Verify stable source mounts selected from the existing protected files plan, without creating exports or owning persistent volumes.
 * @param bytes Original protected files-plan bytes retained by Root's existing lease.
 * @param digest Exact SHA-256 pinned by that lease.
 * @param assertPlanCurrent Current Root selection and protected files-plan lease.
 * Each share separately requires its original files/native current callback.
 * @param limits Explicit capacities including bounded plan/proc parsing and eight retained directory FDs per share.
 * @param serverImageDigest Protected Native selection; Session directories require the reviewed directory-aware guard.
 * @returns In-process shares retaining exact files grants until the allocation confirms physical stop and releases them.
 * @throws On plan, source, grant or quota mismatch; uncertain descriptor closure permanently retains Root responsibility.
 */
export function createSharedPathExecutionExports(bytes: Uint8Array, digest: string, assertPlanCurrent: () => void,
  limits: SharedPathExecutionLimits, serverImageDigest?: string): RetainedExecutionExports {
  limits = Object.freeze({ ...limits })
  for (const value of [limits.maxPlanBytes, limits.maxMountInfoBytes, limits.maxPathBytes, limits.maxShares, limits.maxResidentBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ExecutionStateError('cloud/invalid-config', 'Shared-path capacities must be explicit positive safe integers.')
    }
  }
  const reservation = 8 * limits.maxPlanBytes + 64 * limits.maxMountInfoBytes + 32 * limits.maxPathBytes + 65536
    + limits.maxShares * (32 * limits.maxPathBytes + 16896)
  if (limits.maxPlanBytes > 262144 || limits.maxMountInfoBytes > 4194304 || limits.maxPathBytes > 4096
    || !Number.isSafeInteger(reservation) || reservation > limits.maxResidentBytes || !Number.isSafeInteger(8 * limits.maxShares + 9)) {
    throw new ExecutionStateError('cloud/invalid-config', 'Shared-path capacities cannot retain the complete bounded verification and shares.')
  }
  assertPlanCurrent()
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxPlanBytes || !/^[a-f0-9]{64}$/.test(digest)
    || createHash('sha256').update(bytes).digest('hex') !== digest) invalid('manifest')
  let plan: ReturnType<typeof parseStaticStoragePlan>
  try { plan = parseStaticStoragePlan(bytes, limits.maxPathBytes) }
  catch (cause) { throw new ExecutionExportFailure('manifest', cause) }
  if (plan.version !== 2) invalid('manifest')
  if (plan.accounts.some(account => account.environmentBank.mode === 'session-directories')
    && serverImageDigest !== SESSION_DIRECTORY_SERVER_IMAGE_DIGEST) invalid('selection')
  assertPlanCurrent()
  return createExecutionMountShares(limits.maxShares, {
    assertCurrent: assertPlanCurrent,
    select: (grant, skills) => selectShared(plan, grant, limits.maxPathBytes, skills),
    capture: (batch, selected, grant, skills) => captureShared(batch, selected, grant, limits.maxMountInfoBytes, skills),
    paths: (selected, skills) => Object.freeze({ project: `${selected.project.rootPath}/${selected.leaf}`,
      protectedProject: `${selected.project.rootPath}/${selected.leaf}/.pe`,
      environment: selected.environmentLeaf === undefined ? selected.environment.rootPath
        : `${selected.environment.rootPath}/${selected.environmentLeaf}`,
      ...skills === undefined ? {} : { skills: `${selected.project.rootPath}/${selected.leaf}/.pe/skills` } }),
  })
}
