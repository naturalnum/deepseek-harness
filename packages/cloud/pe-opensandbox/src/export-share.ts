/** Root-private exact files-grant exports; only the original allocation releases retained directory descriptors. */
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, statfsSync } from 'node:fs'
import { posix } from 'node:path'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ExecutionExportShare, ManagedExecutionDeployment } from './managed-coordinator.ts'
import { ExecutionStateError } from './errors.ts'

/** Original adopted keeper capability; Root binds it to these exact protected manifest bytes/digest before construction. */
export interface ExecutionExportKeeper {
  readonly signal: AbortSignal
  assertAvailable(): void
}

/** Explicit Root-only capacities; reservations include retained records and one synchronous verification's bounded copies. */
export interface ExecutionExportLimits {
  readonly maxManifestBytes: number
  readonly maxMountInfoBytes: number
  readonly maxPathBytes: number
  readonly maxShares: number
  readonly maxResidentBytes: number
}

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

/** This process's retained shares are not an all-Root/all-SDK stop proof. No keeper release or unmount capability is exposed. */
export interface RetainedExecutionExports {
  readonly share: ManagedExecutionDeployment['share']
  /** Original epoch cleanup, independent of business admission or keeper liveness. */
  readonly assertEpochReleased: ManagedExecutionDeployment['assertEpochReleased']
  /** Includes failed descriptor closure until actual Root process closure; EOF never decrements this count. */
  readonly retainedShares: number
  /** Recheck original keeper availability; Root still owns closing ingress and stopping existing allocations. */
  assertCurrent(): void
}

interface Facts {
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
interface ExportEntry {
  readonly accountId: string
  readonly storageKey: string
  readonly role: 'projects' | 'environment'
  readonly bankId: string | null
  readonly slotId: string | null
  readonly sourceDomainPath: string
  readonly sourceFacts: Facts
  readonly daemonPath: string
  readonly controlPath: string
}
interface Mount { readonly id: string; readonly path: string; readonly flags: readonly string[]; readonly filesystem: string }
interface Batch { readonly fds: Set<number>; unknown?: ExecutionExportFailure }
interface RetainedShare extends Batch { readonly binding: ExecutionMountGrant['binding']; released: boolean }
interface Selection { readonly project: ExportEntry; readonly environment: ExportEntry; readonly leaf: string }
interface Captured { readonly projectMountId: string; readonly environmentMountId: string }
interface DirectoryIdentity {
  readonly device: string
  readonly inode: string
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

function invalid(phase: ExecutionExportFailure['phase']): never { throw new ExecutionExportFailure(phase) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('manifest')
  return value as Record<string, unknown>
}
function token(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid('manifest')
  return value
}
function decimal(value: unknown): string {
  const result = token(value, /^[1-9]\d{0,19}$/)
  if (BigInt(result) > 18446744073709551615n) invalid('manifest')
  return result
}
function path(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\\')
    || value.length > maximum || Buffer.byteLength(value) > maximum || posix.normalize(value) !== value
    || value.endsWith('/')) invalid('manifest')
  return value
}
function facts(value: unknown): Facts {
  const v = object(value, ['device', 'inode', 'mountId', 'mode', 'uid', 'gid', 'filesystem', 'blockBytes', 'blocks', 'inodes'])
  const result = { device: decimal(v.device), inode: decimal(v.inode), mountId: decimal(v.mountId), mode: decimal(v.mode),
    uid: decimal(v.uid), gid: decimal(v.gid), filesystem: decimal(v.filesystem), blockBytes: decimal(v.blockBytes),
    blocks: decimal(v.blocks), inodes: decimal(v.inodes) }
  if (result.inode !== '2' || result.uid !== '2000' || result.gid !== '2000' || result.mode !== String(0o40700)
    || result.filesystem !== '61267') invalid('manifest')
  return Object.freeze(result)
}
function sameFacts(left: Facts, right: Facts): boolean {
  return left.device === right.device && left.inode === right.inode && left.uid === right.uid && left.gid === right.gid
    && left.mode === right.mode && left.filesystem === right.filesystem && left.blocks === right.blocks
    && left.blockBytes === right.blockBytes && left.inodes === right.inodes
}
function parseManifest(bytes: Uint8Array, digest: string, limits: ExecutionExportLimits): readonly ExportEntry[] {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxManifestBytes || !/^[a-f0-9]{64}$/.test(digest)
    || createHash('sha256').update(bytes).digest('hex') !== digest) invalid('manifest')
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch (cause) { throw new ExecutionExportFailure('manifest', cause) }
  const v = object(raw, ['schema', 'resourceId', 'runId', 'daemonNamespace', 'sourceNamespace',
    'keeper', 'liveness', 'privateExported', 'exports'])
  const resource = token(v.resourceId, /^[a-f0-9]{32}$/), run = token(v.runId, /^[a-f0-9]{32}$/)
  const daemon = token(v.daemonNamespace, /^mnt:\[[1-9]\d{0,19}\]$/), source = token(v.sourceNamespace, /^mnt:\[[1-9]\d{0,19}\]$/)
  const keeper = object(v.keeper, ['pid', 'startTicks', 'mountNamespace', 'comm'])
  if (v.schema !== 'root-daemon-exports-v1' || v.privateExported !== false || daemon === source
    || typeof keeper.pid !== 'number' || !Number.isSafeInteger(keeper.pid) || keeper.pid < 2 || keeper.pid > 2147483647) invalid('manifest')
  decimal(keeper.startTicks); token(keeper.mountNamespace, /^mnt:\[[1-9]\d{0,19}\]$/); token(keeper.comm, /^[^\0\r\n]{1,32}$/)
  const live = object(v.liveness, ['kind', 'device', 'inode', 'nonce', 'frameBytes'])
  if (live.kind !== 'inherited-fifo-v1' || live.frameBytes !== 128) invalid('manifest')
  decimal(live.device); decimal(live.inode); token(live.nonce, /^[a-f0-9]{64}$/)
  if (!Array.isArray(v.exports) || v.exports.length < 4 || v.exports.length > 6) invalid('manifest')
  const base = `/var/lib/docker/dsh-root-exports/${resource}/${run}`
  const entries = v.exports.map((rawEntry: unknown): ExportEntry => {
    const entry = object(rawEntry, ['accountId', 'storageKey', 'role', 'bankId', 'slotId',
      'sourceDomainPath', 'sourceFacts', 'daemon', 'control'])
    const accountId = token(entry.accountId, /^[^\0\r\n]{1,128}$/), storageKey = token(entry.storageKey, /^v1-[a-f0-9]{64}$/)
    if (entry.role !== 'projects' && entry.role !== 'environment') invalid('manifest')
    const role = entry.role, bankId = role === 'environment' ? token(entry.bankId, /^[a-zA-Z0-9_-]{1,64}$/) : null
    const slotId = role === 'environment' ? token(entry.slotId, /^[a-zA-Z0-9_-]{1,64}$/) : null
    if (role === 'projects' && (entry.bankId !== null || entry.slotId !== null)) invalid('manifest')
    const original = facts(entry.sourceFacts), observedDaemon = object(entry.daemon, ['namespace', 'path', 'mountId', 'facts', 'readonly'])
    const control = object(entry.control, ['namespace', 'path', 'mountId', 'facts', 'readonly'])
    const daemonFacts = facts(observedDaemon.facts), controlFacts = facts(control.facts)
    if (observedDaemon.namespace !== 'daemon' || observedDaemon.readonly !== false
      || control.namespace !== 'r8Init' || control.readonly !== true
      || decimal(observedDaemon.mountId) !== daemonFacts.mountId || decimal(control.mountId) !== controlFacts.mountId
      || !sameFacts(original, daemonFacts) || !sameFacts(original, controlFacts)) invalid('manifest')
    const daemonPath = path(observedDaemon.path, limits.maxPathBytes), controlPath = path(control.path, limits.maxPathBytes)
    if (daemonPath !== controlPath) invalid('manifest')
    return Object.freeze({ accountId, storageKey, role, bankId, slotId,
      sourceDomainPath: path(entry.sourceDomainPath, limits.maxPathBytes), sourceFacts: original, daemonPath, controlPath })
  })
  const projects = entries.filter(entry => entry.role === 'projects')
  if (projects.length !== 2 || projects[0]?.accountId === projects[1]?.accountId || projects[0]?.storageKey === projects[1]?.storageKey
    || new Set(entries.map(entry => entry.sourceFacts.device)).size !== entries.length) invalid('manifest')
  for (const [index, project] of projects.entries()) {
    const accountRoot = posix.dirname(project.sourceDomainPath), selected = entries.filter(entry => entry.accountId === project.accountId)
    const environments = selected.filter(entry => entry.role === 'environment')
    if (project.sourceDomainPath !== `${accountRoot}/projects` || posix.basename(accountRoot) !== project.storageKey
      || selected.some(entry => entry.storageKey !== project.storageKey) || environments.length < 1 || environments.length > 2
      || new Set(environments.map(entry => entry.slotId)).size !== environments.length
      || new Set(environments.map(entry => entry.bankId)).size !== 1) invalid('manifest')
    for (const entry of selected) {
      const suffix = entry.role === 'projects' ? 'projects' : `env-${entry.slotId}`
      if (entry.daemonPath !== `${base}/a${index}/${suffix}` || entry.role === 'environment'
        && entry.sourceDomainPath !== `${accountRoot}/environments/${entry.slotId}`) invalid('manifest')
    }
  }
  const banks = entries.filter(entry => entry.role === 'environment').map(entry => `${entry.accountId}:${entry.bankId}`)
  if (entries.some(entry => !projects.some(project => project.accountId === entry.accountId))
    || new Set(banks).size !== 2) invalid('manifest')
  return Object.freeze(entries)
}

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
    return { id, path: decoded, flags: flags.split(','), filesystem }
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
function verifyAlias(batch: Batch, entry: ExportEntry, inventory: readonly Mount[]): { readonly fd: number; readonly id: string } {
  protectedParents(entry.controlPath)
  const fd = open(batch, entry.controlPath, true), source = entry.sourceFacts
  const id = verifyDirectory(batch, fd, { device: source.device, inode: source.inode, uid: 2000, gid: 2000, mode: 0o40700 }, source)
  const selected = inventory.find(row => row.id === id)
  if (selected?.path !== entry.controlPath || selected.filesystem !== 'ext4' || !selected.flags.includes('ro')
    || selected.flags.includes('rw') || !selected.flags.includes('nosuid') || !selected.flags.includes('nodev')
    || selected.flags.includes('noexec') !== (entry.role === 'projects')
    || inventory.some(row => row.path.startsWith(entry.controlPath + '/'))) invalid('verification')
  return { fd, id }
}
function select(entries: readonly ExportEntry[], grant: ExecutionMountGrant, maximum: number): Selection {
  const project = entries.find(entry => entry.accountId === grant.binding.accountId && entry.role === 'projects')
  const environment = entries.find(entry => entry.accountId === grant.binding.accountId && entry.role === 'environment'
    && entry.bankId === grant.environment.bankId && entry.slotId === grant.environment.slotId)
  if (project === undefined || environment === undefined) invalid('selection')
  const leaf = posix.relative(project.sourceDomainPath, grant.project.rootPath)
  if (leaf !== 'default-workspace'
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf)) invalid('selection')
  if (grant.project.rootPath !== `${project.sourceDomainPath}/${leaf}` || grant.environment.rootPath !== environment.sourceDomainPath
    || Buffer.byteLength(`${project.daemonPath}/${leaf}/.pe`) > maximum
    || Buffer.byteLength(environment.daemonPath) > maximum) invalid('selection')
  for (const [root, entry] of [[grant.project, project], [grant.environment, environment]] as const) {
    if (root.rootDevice !== entry.sourceFacts.device || root.quota.device !== root.rootDevice || root.rootMountId === undefined
      || root.rootMountId !== root.quota.mountId
      || root.quota.maximumBytes !== String(BigInt(entry.sourceFacts.blockBytes) * BigInt(entry.sourceFacts.blocks))
      || root.quota.maximumInodes !== entry.sourceFacts.inodes) invalid('selection')
  }
  if (grant.environment.rootInode !== environment.sourceFacts.inode || grant.project.metadataDirectory.mountId !== grant.project.rootMountId
    || grant.project.metadataDirectory.device !== grant.project.rootDevice || grant.project.metadataDirectory.uid !== 2000
    || grant.project.metadataDirectory.gid !== 2000 || grant.project.metadataDirectory.mode !== 0o40700
    || grant.project.mountVersion !== `${grant.project.rootDevice}:${grant.project.rootInode}:${grant.project.rootMountId}`) {
    invalid('selection')
  }
  for (const leaf of ['home', 'venv', 'tmp'] as const) {
    const expected = grant.environment.layout[leaf]
    if (expected.device !== grant.environment.rootDevice || expected.mountId !== grant.environment.rootMountId
      || expected.uid !== 2000 || expected.gid !== 2000 || expected.mode !== 0o40700) invalid('selection')
  }
  return { project, environment, leaf }
}
function capture(batch: Batch, selected: Selection, grant: ExecutionMountGrant, maximum: number): Captured {
  const inventory = mounts(batch, maximum), project = verifyAlias(batch, selected.project, inventory)
  const workspace = open(batch, `/proc/self/fd/${project.fd}/${selected.leaf}`, true)
  const workspaceIdentity = { device: grant.project.rootDevice, inode: grant.project.rootInode, uid: 2000, gid: 2000, mode: 0o40700 }
  verifyDirectory(batch, workspace, workspaceIdentity, selected.project.sourceFacts, project.id)
  const metadata = open(batch, `/proc/self/fd/${workspace}/.pe`, true)
  verifyDirectory(batch, metadata, grant.project.metadataDirectory, selected.project.sourceFacts, project.id)
  const environment = verifyAlias(batch, selected.environment, inventory)
  for (const leaf of ['home', 'venv', 'tmp'] as const) {
    const expected = grant.environment.layout[leaf]
    verifyDirectory(batch, open(batch, `/proc/self/fd/${environment.fd}/${leaf}`, true), expected,
      selected.environment.sourceFacts, environment.id)
  }
  return { projectMountId: project.id, environmentMountId: environment.id }
}

/**
 * Compose Root's original protected publication with its already-ready keeper, without creating infrastructure or configuration entries.
 * @param manifest Original complete protected manifest bytes; Root binds these exact bytes/digest to keeper's retained-publication guard.
 * @param manifestSha256 Original protected digest, also used by that original keeper adoption.
 * @param keeper Original live adoption; this utility never adopts/closes its reader or releases exports.
 * @param limits Explicit capacities. Directory FD maximum is 7*maxShares plus one verification's seven FDs and one proc reader.
 * @returns Private deployment.share and this process's retained count; only original allocation release closes its directories.
 * @throws On invalid input or unavailable exports. Close uncertainty permanently rejects admission and retains the original share count.
 */
export function createRetainedExecutionExports(
  manifest: Uint8Array, manifestSha256: string, keeper: ExecutionExportKeeper, limits: ExecutionExportLimits,
): RetainedExecutionExports {
  limits = Object.freeze({ ...limits })
  for (const value of [limits.maxManifestBytes, limits.maxMountInfoBytes, limits.maxPathBytes, limits.maxShares, limits.maxResidentBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ExecutionStateError('cloud/invalid-config', 'Execution export capacities must be explicit positive safe integers.')
    }
  }
  const reservation = 8 * limits.maxManifestBytes + 64 * limits.maxMountInfoBytes + 32 * limits.maxPathBytes + 65536
    + limits.maxShares * (32 * limits.maxPathBytes + 16384)
  if (limits.maxManifestBytes > 131072 || limits.maxMountInfoBytes > 4194304 || limits.maxPathBytes > 4096
    || !Number.isSafeInteger(reservation) || reservation > limits.maxResidentBytes || !Number.isSafeInteger(7 * limits.maxShares + 8)) {
    throw new ExecutionStateError('cloud/invalid-config',
      'Execution export capacities cannot retain the complete bounded verification and shares.')
  }
  const entries = parseManifest(manifest, manifestSha256, limits), retained = new Set<RetainedShare>()
  let failure: { readonly cause: unknown } | undefined, checking = false
  const keeperSignalCurrent = (): void => { if (keeper.signal.aborted) invalid('verification') }
  const available = (): void => {
    if (failure !== undefined) {
      throw failure.cause instanceof ExecutionExportFailure ? failure.cause : new ExecutionExportFailure('verification', failure.cause)
    }
    keeperSignalCurrent()
    keeper.assertAvailable()
    keeperSignalCurrent()
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
  const verify = (record: RetainedShare, selected: Selection, grant: ExecutionMountGrant): Captured => {
    try { return capture(record, selected, grant, limits.maxMountInfoBytes) }
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
  const shareNow = (grant: ExecutionMountGrant, current: () => void): ExecutionExportShare => exclusive(() => {
    guard(grant, current)
    const selected = select(entries, grant, limits.maxPathBytes)
    if (retained.size >= limits.maxShares) throw new ExecutionStateError('cloud/capacity', 'Execution export share capacity is exhausted.')
    const record: RetainedShare = { binding: grant.binding, fds: new Set(), released: false }
    retained.add(record)
    try {
      const captured = verify(record, selected, grant)
      guard(grant, current)
      const value = Object.freeze({ grant, exports: Object.freeze({ project: `${selected.project.daemonPath}/${selected.leaf}`,
        protectedProject: `${selected.project.daemonPath}/${selected.leaf}/.pe`, environment: selected.environment.daemonPath }),
      assertCurrent: (): void => { exclusive(() => {
        assertRetained(record)
        guard(grant, current)
        assertRetained(record)
        const temporary: RetainedShare = { binding: grant.binding, fds: new Set(), released: false }
        try {
          const measured = verify(temporary, selected, grant)
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
  const share: ManagedExecutionDeployment['share'] = (grant, current) => {
    try { return Promise.resolve(shareNow(grant, current)) }
    catch (cause) { return Promise.reject(cause instanceof Error ? cause : new ExecutionExportFailure('verification', cause)) }
  }
  const assertEpochReleased: ManagedExecutionDeployment['assertEpochReleased'] = (binding) => {
    for (const record of retained) if (record.binding === binding) {
      throw record.unknown ?? new ExecutionExportFailure('verification')
    }
  }
  return Object.freeze({ share, assertEpochReleased, get retainedShares() { return retained.size }, assertCurrent: available })
}
