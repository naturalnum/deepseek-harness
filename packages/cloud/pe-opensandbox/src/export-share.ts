/** Root-private exact files-grant exports; only the original allocation releases retained directory descriptors. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillProjectGrant } from './skill-files-types.ts'
import type { ManagedExecutionDeployment } from './managed-coordinator.ts'
import { ExecutionStateError } from './errors.ts'
import { ExecutionExportFailure, createExecutionMountShares, executionMountFiles } from './shared-mounts.ts'
import type { ExecutionSourceFacts as Facts, ExecutionMountBatch as Batch, CapturedExecutionMounts as Captured, ExecutionMountRow as Mount } from './shared-mounts.ts'

export { ExecutionExportFailure, createSharedPathExecutionExports } from './shared-mounts.ts'
export type { SharedPathExecutionLimits } from './shared-mounts.ts'
const { open, mounts, protectedParents, verifyDirectory } = executionMountFiles

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

/** This process's retained shares are not an all-Root/all-SDK stop proof. Persistent sources remain deployment-owned. */
export interface RetainedExecutionExports {
  readonly share: ManagedExecutionDeployment['share']
  /** Original epoch cleanup, independent of business admission or source availability. */
  readonly assertEpochReleased: ManagedExecutionDeployment['assertEpochReleased']
  /** Includes failed descriptor closure until actual Root process closure; authority loss never decrements this count. */
  readonly retainedShares: number
  /** Recheck the original protected source capability; Root owns closing ingress and stopping existing allocations. */
  assertCurrent(): void
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
interface Selection { readonly project: ExportEntry; readonly environment: ExportEntry; readonly leaf: string }

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
function select(entries: readonly ExportEntry[], grant: ExecutionMountGrant, maximum: number, skills?: SkillProjectGrant): Selection {
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
  if (skills !== undefined && (skills.binding !== grant.binding || skills.workspaceId !== grant.workspaceId
    || skills.project.rootPath !== grant.project.rootPath || skills.project.rootDevice !== grant.project.rootDevice
    || skills.project.rootInode !== grant.project.rootInode || skills.project.rootMountId !== grant.project.rootMountId
    || skills.project.quota.device !== grant.project.quota.device
    || skills.project.quota.mountId !== grant.project.quota.mountId
    || skills.project.quota.maximumBytes !== grant.project.quota.maximumBytes
    || skills.project.quota.maximumInodes !== grant.project.quota.maximumInodes
    || Buffer.byteLength(`${project.daemonPath}/${leaf}/.pe/skills`) > maximum
    || (['device', 'inode', 'mountId', 'uid', 'gid', 'mode'] as const).some(key => skills.metadataDirectory[key] !== grant.project.metadataDirectory[key])
    || skills.skillsDirectory.device !== grant.project.rootDevice || skills.skillsDirectory.mountId !== grant.project.rootMountId
    || skills.skillsDirectory.uid !== 2000 || skills.skillsDirectory.gid !== 2000 || skills.skillsDirectory.mode !== 0o40700)) invalid('selection')
  for (const leaf of ['home', 'venv', 'tmp'] as const) {
    const expected = grant.environment.layout[leaf]
    if (expected.device !== grant.environment.rootDevice || expected.mountId !== grant.environment.rootMountId
      || expected.uid !== 2000 || expected.gid !== 2000 || expected.mode !== 0o40700) invalid('selection')
  }
  return { project, environment, leaf }
}
function capture(batch: Batch, selected: Selection, grant: ExecutionMountGrant, maximum: number, skills?: SkillProjectGrant): Captured {
  const inventory = mounts(batch, maximum), project = verifyAlias(batch, selected.project, inventory)
  const workspace = open(batch, `/proc/self/fd/${project.fd}/${selected.leaf}`, true)
  const workspaceIdentity = { device: grant.project.rootDevice, inode: grant.project.rootInode, uid: 2000, gid: 2000, mode: 0o40700 }
  verifyDirectory(batch, workspace, workspaceIdentity, selected.project.sourceFacts, project.id)
  const metadata = open(batch, `/proc/self/fd/${workspace}/.pe`, true)
  verifyDirectory(batch, metadata, grant.project.metadataDirectory, selected.project.sourceFacts, project.id)
  if (skills !== undefined) verifyDirectory(batch, open(batch, `/proc/self/fd/${metadata}/skills`, true),
    skills.skillsDirectory, selected.project.sourceFacts, project.id)
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
 * @param limits Explicit capacities. Directory FD maximum is 8*maxShares plus one verification's eight FDs and one proc reader.
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
    + limits.maxShares * (32 * limits.maxPathBytes + 16896)
  if (limits.maxManifestBytes > 131072 || limits.maxMountInfoBytes > 4194304 || limits.maxPathBytes > 4096
    || !Number.isSafeInteger(reservation) || reservation > limits.maxResidentBytes || !Number.isSafeInteger(8 * limits.maxShares + 9)) {
    throw new ExecutionStateError('cloud/invalid-config',
      'Execution export capacities cannot retain the complete bounded verification and shares.')
  }
  const entries = parseManifest(manifest, manifestSha256, limits)
  const keeperSignalCurrent = (): void => { if (keeper.signal.aborted) invalid('verification') }
  return createExecutionMountShares(limits.maxShares, {
    assertCurrent: () => {
      keeperSignalCurrent()
      keeper.assertAvailable()
      keeperSignalCurrent()
    },
    select: (grant, skills) => select(entries, grant, limits.maxPathBytes, skills),
    capture: (batch, selected, grant, skills) => capture(batch, selected, grant, limits.maxMountInfoBytes, skills),
    paths: (selected, skills) => Object.freeze({ project: `${selected.project.daemonPath}/${selected.leaf}`,
      protectedProject: `${selected.project.daemonPath}/${selected.leaf}/.pe`, environment: selected.environment.daemonPath,
      ...skills === undefined ? {} : { skills: `${selected.project.daemonPath}/${selected.leaf}/.pe/skills` } }),
  })
}
