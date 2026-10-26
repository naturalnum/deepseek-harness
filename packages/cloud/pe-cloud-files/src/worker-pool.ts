/** Root-owned prestarted slots; tasks reuse workers and never allocate a replacement on failure. */
import { skillBundleLimits } from './bundle-codec.ts'
import type { BundleTree } from './bundle-codec.ts'
import type { SkillBundleVersion } from './skill-bundles.ts'
import { createSkillProjectWork } from './skill-project-work.ts'
import type { SkillProjectPort } from './skill-project-work.ts'
import type { SkillRecordRevalidation } from './skill-revalidation.ts'
import { skillProjectionLimits, skillProjectionBudget } from './skill-projection.ts'
import type { SkillVersion, SkillVersionId } from './skill-versions.ts'
import { createSkillVersionWork, retireSkillVersionsAfterDrain } from './skill-version-work.ts'
import { SKILL_VERSION_HANDLE_BYTES, skillVersionLimits } from './skill-versions.ts'
import type { SkillVersionPort } from './skill-versions.ts'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { isAbsolute, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountUse, DrainParticipant, OperationId, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import type { FdWorkerInput, FdRootIdentity, FdStagingLimits } from './worker-protocol.ts'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode, FsInfo, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { createFixedRootReader, decodeTextStream, nativeInfo } from './read-only.ts'
import type { FixedRootReader } from './read-only.ts'
import type { FdByteStream } from './worker-client.ts'
import type { FdMetadata } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'
import { FilesWorkOwner } from './work-owner.ts'
import { FdWorkerClient, FdWorkerFailure, FdMutationFailure, FdTextWriteFailure, FdStageFailure } from './worker-client.ts'
import { createTextProjectFileSystem, decodeBoundedText } from './text-project.ts'
import type { NativeTextFileSystemConstructor, ResolveAccountFileProject, TextProjectBackend } from './text-project.ts'
import type { AccountFilesProject } from './account-service.ts'
import { FilesFailure } from './error.ts'
import { createDirectoryReadPort } from './directory.ts'
import type { DirectoryReadPort } from './directory.ts'
import { DirectoryMetadataFailure } from './directory-error.ts'
import type { DirectoryIntent } from './directory-budget.ts'
import { directoryWorkBudget } from './directory-budget.ts'
import type { DirectoryObservation, DirectoryPrepareOutcome } from './directory-responsibility.ts'
import { createS2ProjectPort } from './s2-project.ts'
import { createBoundWorkspaceRegistry } from './workspace-adapter.ts'
import type { WorkspacePreparation } from './workspace-adapter.ts'
import { RootStorageOwner } from './storage-owner.ts'
import type { StaticStorageConfig } from './storage-types.ts'
import { staticStorageReservation } from './storage-probe.ts'
import { runInstructionReadWork } from './instruction-read-work.ts'
import type { InstructionReadReaders } from './instruction-read-work.ts'
import { executeStageBatch, planStageBatch, validateStagingLimits } from './stage-bridge.ts'
import type { StageSources, StageFileResult, StageBatchPlan } from './stage-bridge.ts'
import { environmentQuota, environmentWorkBytes, prepareEnvironmentSlot } from './environment-bank.ts'
import type { EnvironmentBankAuthority, EnvironmentBankState, EnvironmentSessionId, ExecutionMountGrant } from './environment-bank.ts'
import type { StaticEnvironmentBank } from './storage-types.ts'

/** Privileged fixture input; layout/stat/mode/name alone never establishes this namespace guarantee. */
export type IsolatedLeafGrant = {
  readonly binding: AccountBinding
  readonly leaf: string
  /** Held by trusted deployment composition, never an RPC-supplied assertion. */
  assertExclusive(this: void): void
} & ({
  readonly backend: 'root-owned-isolated-linux-tmpfs'
  readonly parent: FdRootIdentity
} | {
  readonly backend: 'root-owned-isolated-ext4'
  readonly parent: FdRootIdentity & { readonly rootMountId: string }
  /** Deployment owner verifies ext4 driver, exact backing ownership, privilege exclusion and hard reserve; statfs is insufficient. */
  assertDeployment(this: void): void
})

/** Fixed-grant component only; no caller-selected path, callback, transfer or recursive ensure. */
export interface PreparedLeafPort {
  prepare(): {
    readonly observation: DirectoryObservation
    readonly control: { expose(): string; cleanup(signal?: AbortSignal): Promise<'cleaned' | 'unknown'> }
  }
}

/** Required finite root capacities; no storage or account-readiness evidence is represented here. */
export interface FilesPoolConfig extends FilesLimits, Omit<FdWorkerInput, 'storageProbe' | 'staging'> {
  readonly staging?: FdStagingLimits
  readonly staticStorage?: StaticStorageConfig
  readonly workerCount: number
  readonly minimumHealthyWorkers: number
  readonly workerReservationBytes: number
  readonly replyOverheadBytes: number
  readonly readyTimeoutMs: number
  readonly drainTimeoutMs: number
}

/** Internal fixed-root read capability, not the native FileSystem or a client-facing project scope. */
export interface PoolReadPort {
  /** Exact account-private capability, issued only after real static storage verification. */
  skillVersions(): SkillVersionPort
  /** Original bound projection issuer; omission of explicit limits or the independent helper refuses. */
  skillProjection(): SkillProjectPort
  readonly reader: FixedRootReader
  readonly directory: DirectoryReadPort
  /** Require this current healthy lane, explicit content limits and actual ABI8 handshakes for every pool slot. */
  assertContentAvailable(): void
  /** Require the separate staging companion on the original current pool; omission rejects. */
  assertStagingAvailable(): void
  /**
   * Prepare fixed private metadata and verified mounts within one original mutation operation.
   * @param workspace Exact registered project selected by Root's native Agent/Session guard.
   * @param sessionId Native Session identity already approved against this project; a string alone cannot authorize it.
   * @param environmentVersion Approved image/architecture/Python/init version.
   * @param authority Original storage lease's protected finite inventory; no request or public FS may supply it.
   * @param assertRegistered Exact project/provider/current guard.
   * @param signal Observer cancellation; actual metadata work remains owned until settled.
   * @returns Measured mounts only after confirmed private binding; release returns memory, never a persistent slot.
   */
  prepareExecutionMounts(
    workspace: Workspace, sessionId: EnvironmentSessionId, environmentVersion: string,
    authority: EnvironmentBankAuthority, assertRegistered: () => void, signal?: AbortSignal,
  ): Promise<ResidentResult<ExecutionMountGrant>>
  /**
   * Stage a trusted native-source batch in one actual mutation reservation and borrowed worker.
   * @param workspace Exact native Registry object selected by account admission.
   * @param sources Native refs and original-provider closures; lazy collection runs under the reservation before source/sink open.
   * @param assertRegistered Original providers, binding and exact Workspace guard.
   * @param signal Observation cancellation signals actual work; ownership remains until closed or unknown.
   * @returns Closed results retained through release; unknown preserves the original task and mutation block.
   */
  stageFiles(
    workspace: Workspace, sources: StageSources, assertRegistered: () => void, signal?: AbortSignal,
  ): Promise<ResidentResult<readonly StageFileResult[]>>
  /**
   * Controlled native intake work on this same mutation owner; no intake business or receipt service is supplied here.
   * @param reservationBytes Complete Root-reviewed source/storage/result/cleanup reservation.
   * @param assertCurrent Original selected owner/provider guard.
   * @param execute Trusted native operation joined through actual closure; only proven closed failures may use FdMutationFailure.
   * @param signal Observation cancellation signals actual work without releasing its ownership.
   * @returns Actual result retained through release; plain/unconfirmed failures preserve unknown work.
   */
  runNativeMutation<T>(
    reservationBytes: number, assertCurrent: () => void, execute: (control: AbortSignal) => Promise<T>, signal?: AbortSignal,
  ): Promise<ResidentResult<T>>
  /**
   * Prepare an opt-in text provider for the actual registered default Workspace, without installing it.
   * @param workspace Original native Registry object; never a client-selected root.
   * @param assertInstalled Owning graph/provider checks, repeated by the native constructor and every call.
   * @param resolveProject Trusted asynchronous caller selection, captured before interpreting each model path.
   * @returns Native constructor bound to a verified project FD root on this same lane; requires ABI7 for writes.
   */
  createTextFileSystem(
    workspace: Workspace, assertInstalled: (ctx: Context) => void, resolveProject: ResolveAccountFileProject,
    mapProcessPath?: (caller: Context, hostPath: string) => string | undefined,
  ): Promise<NativeTextFileSystemConstructor>
  /** Derive a directory capability only after the owning Registry selected its exact object. */
  projectFor(workspace: Workspace, assertRegistered: () => void, signal?: AbortSignal): Promise<AccountFilesProject>
  /**
   * Read independent account/project instruction sources on this original lane.
   * @param workspace Exact Registry object approved by the account owner.
   * @param reservedBytes Complete snapshot construction and retained-result storage.
   * @param build Consumes fixed readers inside one reservation and one borrowed worker slot.
   * @param signal Turn/account cancellation; actual work remains tracked to settlement.
   * @param assertRegistered Original provider and exact native Registry object guard.
   * @returns Complete retained result; absence of a verified private parent rejects before content I/O.
   */
  withInstructionReaders<T>(
    this: void, workspace: Workspace, reservedBytes: number,
    build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal: AbortSignal,
    assertRegistered: () => void,
  ): Promise<ResidentResult<T>>
  derivePreparedLeaf(grant: IsolatedLeafGrant): PreparedLeafPort
  /**
   * Fix the native Workspace dependency before its graph starts; this grants no production authority.
   * @param defaultGrant Trusted fixed default leaf under this exact binding and parent.
   * @param assertUnpublished Trusted recipe guard for installation, preparation and registration; reads use the bound current check.
   * @returns Native subclass with same-lane metadata and privately completed directory transfer.
   */
  createWorkspaceRegistry(defaultGrant: IsolatedLeafGrant, assertUnpublished: () => void): ReturnType<typeof createBoundWorkspaceRegistry>
  stat(relativePath: string, signal?: AbortSignal): Promise<ResidentResult<FsInfo | undefined>>
  streamText(relativePath: string, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(relativePath: string, maxBytes: number, signal?: AbortSignal): Promise<ResidentResult<Uint8Array<ArrayBuffer>>>
}

/** Root resource observation is separate from an account ParticipantReceipt. */
export interface FilesPoolStopReceipt {
  readonly status: 'confirmed' | 'unknown'
  readonly pendingWorkerIds: readonly OperationId[]
  readonly pendingOperationIds: readonly OperationId[]
}

interface Slot {
  readonly id: OperationId
  readonly client: FdWorkerClient
  busy: boolean
  exited: boolean
}

function workerInput(config: FilesPoolConfig): FdWorkerInput {
  return {
    helperPath: config.helperPath, maxReadBytes: config.maxReadBytes, maxPathBytes: config.maxPathBytes,
    maxResolveRetries: config.maxResolveRetries, readChunkBytes: config.readChunkBytes,
    ...config.content === undefined ? {} : { content: { ...config.content } },
    ...config.skillProjection === undefined ? {} : { skillProjection: { ...config.skillProjection } },
    ...config.skillBundles === undefined ? {} : { skillBundles: { ...config.skillBundles } },
    ...config.skillVersions === undefined ? {} : { skillVersions: { ...config.skillVersions } },
    ...config.staging === undefined ? {} : { staging: { ...config.staging, maxReplyBytes: config.replyOverheadBytes } },
    ...config.staticStorage === undefined ? {} : { storageProbe: config.staticStorage },
  }
}

function skillMetadataBytes(config: FilesPoolConfig): number {
  const projection = config.skillProjection
  return (config.skillVersions?.maxVersions ?? 0) * (SKILL_VERSION_HANDLE_BYTES
    + (config.skillBundles === undefined ? 0 : 8 * config.skillBundles.maxManifestBytes))
    + (projection === undefined || config.skillVersions === undefined ? 0 : skillProjectionBudget(projection, config.skillVersions, {
      ...config, replyBytes: config.content?.maxReplyBytes ?? 0 }).handles)
}

function rootReservation(config: FilesPoolConfig): number {
  return config.workerCount * config.workerReservationBytes
    + (config.staticStorage === undefined ? 0 : staticStorageReservation(config.staticStorage, config.maxPathBytes, config.workerCount))
    + config.maxLanes * skillMetadataBytes(config)
}

function limits(config: FilesPoolConfig): FilesLimits {
  const rootBytes = rootReservation(config)
  return {
    maxLanes: config.maxLanes, maxRunning: config.maxRunning, maxRunningPerLane: config.maxRunningPerLane,
    maxQueued: config.maxQueued, maxQueuedPerLane: config.maxQueuedPerLane,
    maxResidentBytes: config.maxResidentBytes - rootBytes, maxResidentBytesPerLane
    : config.maxResidentBytesPerLane - skillMetadataBytes(config),
    waitTimeoutMs: config.waitTimeoutMs,
  }
}

function deadline(value: number): number {
  const remaining = value - Date.now()
  if (!Number.isSafeInteger(value) || remaining > 2_147_483_647) {
    throw new FilesFailure('files/prerequisite-missing', 'files requires a bounded absolute server deadline')
  }
  return Math.max(0, remaining)
}

function validate(config: FilesPoolConfig): void {
  if (config.skillBundles !== undefined) {
    const b = skillBundleLimits(config.skillBundles), v = config.skillVersions, p = config.skillProjection, content = config.content
    const required = b === undefined ? Infinity : 64 * (b.maxInputBytes + b.maxArchiveBytes + b.maxExpandedArchiveBytes
      + b.maxContentBytes * (p?.maxCopiesPerOperation ?? 1) + b.maxDownloadBytes + b.maxCatalogBytes
      + b.maxManifestBytes + b.maxRequestBytes + b.maxReplyBytes)
    if (b === undefined || v === undefined || p === undefined || content === undefined || config.staticStorage === undefined
      || b.maxInstallations > v.maxVersions || b.maxFileBytes > v.maxFileBytes || b.maxFileBytes > config.maxReadBytes
      || b.maxManifestBytes > config.maxReadBytes || b.maxCatalogBytes > config.maxReadBytes
      || b.maxCatalogBytes * 2 + b.maxStagingBytes > v.maxTotalBytes
      || b.maxRequestBytes < b.maxContentBytes + b.maxManifestBytes
      + (b.maxFiles + b.maxDirectories + 2) * (2 * b.maxPathBytes + 256) + 2048
      || b.maxReplyBytes > content.maxReplyBytes || b.maxReplyBytes < 128
      || Math.max(b.maxFiles + b.maxDirectories + 2, v.maxVersions + 1) > content.maxEntries || b.maxPathBytes > content.maxNameBytes
      || b.maxPathBytes + 96 > config.maxPathBytes || b.reservationBytes < required
      || b.reservationBytes + p.reservationBytes + v.reservationBytes + skillMetadataBytes(config) > config.maxResidentBytesPerLane
      || b.reservationBytes > config.staticStorage.rootProbeReservationBytes) {
      throw new FilesFailure('files/prerequisite-missing', 'Managed bundle complete input, tree, catalog, staging or resident capacities are unavailable')
    }
  }
  if (config.skillProjection !== undefined) {
    const configured = skillProjectionLimits(config.skillProjection), originalSource = config.skillVersions
    const value = configured === undefined ? undefined : { ...configured,
      reservationBytes: Math.max(configured.reservationBytes, config.skillBundles?.reservationBytes ?? 0) }
    const source = originalSource === undefined ? undefined : { ...originalSource,
      reservationBytes: Math.max(originalSource.reservationBytes, config.skillBundles?.reservationBytes ?? 0) }
    if (value === undefined || source === undefined || config.content === undefined || config.staticStorage === undefined) {
      throw new FilesFailure('files/prerequisite-missing',
        'Projection requires explicit finite budgets and original skill/static storage capabilities')
    }
    const model = skillProjectionBudget(value, source, { ...config, replyBytes: config.content.maxReplyBytes })
    if (value.maxRecordBytes > config.maxReadBytes || value.maxRecordBytes < 8 * config.maxPathBytes + 1024
      + value.maxCopiesPerProject * 1024
      || value.reservationBytes < model.operation || config.content.maxEntries < Math.max(value.maxProjects, value.maxCopiesPerProject)
      || config.content.maxNameBytes < 77 || config.content.maxReplyBytes < Math.max(192, 1024 * value.maxProjects,
      1024 * value.maxCopiesPerProject)
      || model.overlap + skillMetadataBytes(config) > config.maxResidentBytesPerLane
      || config.maxLanes * model.overlap + rootReservation(config) > config.maxResidentBytes) {
      throw new FilesFailure('files/prerequisite-missing',
        'Projection metadata, scans, borrows and overlapping source/copy work exceed explicit capacities')
    }
  }
  if (config.skillVersions !== undefined) {
    const value = skillVersionLimits(config.skillVersions)
    const required = value === undefined ? Infinity : 64 * (2 * value.maxFileBytes + config.maxReadBytes + 1024)
      + 32 * config.maxPathBytes + 131072
    if (value === undefined || config.content === undefined || config.content.maxReplyBytes < 128 || config.maxReadBytes < 512
      || value.maxFileBytes > config.maxReadBytes || value.reservationBytes < required
      || value.reservationBytes + skillMetadataBytes(config) > config.maxResidentBytesPerLane || config.staticStorage === undefined
      || config.staticStorage.rootProbeReservationBytes < value.reservationBytes) {
      throw new FilesFailure('files/prerequisite-missing',
        'Skill versions require explicit bounded storage, content and complete resident capacities')
    }
  }
  if (config.staging !== undefined) validateStagingLimits(config.staging, config.maxPathBytes, config.readChunkBytes)
  const content = config.content
  if (content !== undefined && ([content.maxEntries, content.maxNameBytes, content.maxReplyBytes, content.operationTimeoutMs]
    .some(value => !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    || content.maxNameBytes > config.maxPathBytes)) {
    throw new FilesFailure('files/prerequisite-missing', 'files content capacities require explicit bounded values')
  }
  for (const value of [
    config.workerCount, config.minimumHealthyWorkers, config.workerReservationBytes, config.replyOverheadBytes,
    config.readyTimeoutMs, config.drainTimeoutMs, config.maxReadBytes, config.maxPathBytes, config.readChunkBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new FilesFailure('files/prerequisite-missing',
      'files pool capacities must be positive safe integers')
  }
  if (!Number.isSafeInteger(config.maxResolveRetries) || config.maxResolveRetries < 0
    || !isAbsolute(config.helperPath) || !config.helperPath.endsWith('.node')
    || Buffer.byteLength(config.helperPath) > config.maxPathBytes
    || config.maxReadBytes > 2_147_483_646 || config.maxPathBytes > 16384
    || config.readChunkBytes > config.maxReadBytes + 1
    || config.readyTimeoutMs > 2_147_483_647 || config.drainTimeoutMs > 2_147_483_647
    || config.minimumHealthyWorkers > config.workerCount || config.maxRunning > config.workerCount
    || !Number.isSafeInteger(rootReservation(config))) {
    throw new FilesFailure('files/prerequisite-missing', 'files pool configuration exceeds its declared limits')
  }
}

/**
 * One root pool and files participant; configured static storage is verified before startup completes.
 * Omission grants healthy fixed slots only. Neither mode certifies a complete account recipe or readiness.
 */
export class LinuxFilesPool implements DrainParticipant {
  readonly id: Extract<DrainParticipant['id'], 'files'> = 'files'
  /** Observe only the original healthy pool and actual account lane.
   * @param binding Exact native generation.
   * @returns False for root probe work, pending lane work, ordinary results or unavailable health; passive leases stay owned.
   */
  isEpochIdle(binding: AccountBinding): boolean {
    this.assertHealthy()
    return this.rootOperation === undefined && this.owner.isEpochIdle(binding)
  }
  private readonly owner: FilesWorkOwner
  private readonly slots: Slot[] = []
  private readonly closed = Promise.withResolvers<void>()
  private readonly closedObservers = new Set<() => void>()
  private state: 'new' | 'starting' | 'running' | 'closing' | 'closed' = 'new'
  private startTask: Promise<void> | undefined
  private readonly storageOwner?: RootStorageOwner
  private rootOperation: { readonly id: OperationId; readonly settled: Promise<void>; failure?: unknown } | undefined

  constructor(
    private readonly config: FilesPoolConfig,
    private readonly createWorker: (input: FdWorkerInput) => Worker = input =>
      new Worker(new URL('./file-worker.js', import.meta.url), { workerData: input, execArgv: [] }),
  ) {
    validate(config)
    this.owner = new FilesWorkOwner(limits(config))
    const storage = config.staticStorage
    if (storage !== undefined) this.storageOwner = new RootStorageOwner(storage, config.maxPathBytes, {
      record: () => this.probeOperation((client, signal) => client.storageRecord(storage.maxPlanBytes, signal)),
      probe: path => this.probeOperation((client, signal) => client.storageProbe(path, signal)),
      view: () => this.probeOperation((client, signal) => client.storageView(storage.maxMountInfoBytes, signal)),
      skillProof: () => this.probeOperation((client, signal) => client.storageSkillProof(storage.maxPlanBytes, signal)),
      assertPoolCurrent: () => { this.assertHealthy() },
      bind: (binding, root, current, privateParent, revalidation) => this.bind(binding, root, current, privateParent, revalidation),
      joinEpoch: binding => this.owner.joinEpoch(binding),
      retireSkillVersions: async (binding, root, uid, gid) => {
        const config = this.config.skillVersions
        if (config === undefined) return
        this.requireStorageOwner().assertRootCurrent()
        await this.probeOperation(async (client, signal) => {
          await retireSkillVersionsAfterDrain({ binding, root, uid, gid, limits: config,
            projectionConfigured: this.config.skillProjection !== undefined,
            ...this.config.skillBundles === undefined || this.config.skillProjection === undefined || this.config.content === undefined
              ? {} : { bundles: { limits: this.config.skillBundles, projectionLimits: this.config.skillProjection,
                maxPathBytes: this.config.maxPathBytes, maxReplyBytes: this.config.content.maxReplyBytes } },
            assertCurrent: () => { this.requireStorageOwner().assertRootCurrent() } }, client, signal)
        }, true)
      },
    })
  }

  /** Prebuild exactly the configured number of slots; any handshake failure stops the entire startup. */
  start(): Promise<void> {
    if (this.startTask !== undefined) return this.startTask
    if (this.state !== 'new') return Promise.reject(new FilesFailure('files/prerequisite-missing', 'files pool cannot restart'))
    this.state = 'starting'
    this.startTask = this.startAll()
    return this.startTask
  }

  /**
   * Require the actual verified storage owner after successful root startup.
   * @returns Original root-only owner; omission, incomplete startup or closure rejects.
   */
  requireStorageOwner(): RootStorageOwner {
    if (this.storageOwner === undefined) throw new FilesFailure('files/prerequisite-missing', 'files root has no static storage owner')
    this.storageOwner.assertRootCurrent()
    return this.storageOwner
  }

  /**
   * Read the original configured full-tree limits after actual Root and independent helper readiness.
   * @returns A frozen numeric policy; this grants no account, source or projection authority.
   * @throws FilesFailure while complete source, projection or helper support is unavailable.
   */
  requireSkillBundleLimits(): import('./skill-bundles.ts').SkillBundleLimits {
    this.requireStorageOwner()
    const limits = this.config.skillBundles
    if (limits === undefined || this.config.skillVersions === undefined || this.config.skillProjection === undefined
      || this.config.content === undefined || this.slots.some(slot => !slot.client.supportsSkillBundles
        || !slot.client.supportsSkillVersions || !slot.client.supportsSkillProjection)) {
      throw new FilesFailure('files/prerequisite-missing', 'Complete skill source and projection capabilities are unavailable.')
    }
    return Object.freeze({ ...limits })
  }

  /**
   * Bind exact runtime input to one already-authorized root. No worker is created here.
   * @param binding Runtime-owned immutable account generation.
   * @param root Independently verified root identity; this method does not grant authorization or quota.
   * @param assertCurrent Trusted factory's owner/admission check, invoked for every operation.
   * @param privateParent Optional verified private-files parent for instruction reads and environment banks;
   * omission leaves those operations unavailable.
   * @param revalidation Optional single-record authority minted only by the original verified Root lease.
   * @returns A fixed-root internal read port with no shared-pool close capability.
   */
  bind(
    binding: AccountBinding, root: FdRootIdentity, assertCurrent: () => void,
    privateParent?: FdRootIdentity & { readonly rootMountId: string },
    revalidation?: SkillRecordRevalidation,
  ): PoolReadPort {
    this.assertHealthy()
    if (root.rootPath.length > this.config.maxPathBytes || !isAbsolute(root.rootPath)
      || root.rootPath.includes('\0') || root.rootPath.split('/').includes('..')
      || Buffer.byteLength(root.rootPath) > this.config.maxPathBytes
      || !/^\d{1,20}$/.test(root.rootDevice) || !/^\d{1,20}$/.test(root.rootInode)
      || (root.rootMountId !== undefined && !/^[1-9]\d{0,19}$/.test(root.rootMountId))) {
      throw new FdWorkerFailure('FS_PERMISSION_DENIED')
    }
    const fixedRoot = Object.freeze({ ...root })
    const preferencesParent = privateParent === undefined ? undefined : Object.freeze({ ...privateParent })
    const port = this.owner.bind(binding, assertCurrent)
    const checkCurrent = (): void => { this.assertHealthy(); port.assertCurrent() }
    const assertContentAvailable = (): void => {
      checkCurrent()
      if (this.config.content === undefined || this.slots.some(slot => !slot.client.supportsContentReads)) {
        throw new FilesFailure('files/prerequisite-missing', 'The original files pool has no verified ABI8 content capability.')
      }
    }
    const assertStagingAvailable = (): void => {
      checkCurrent()
      if (this.config.staging === undefined || this.slots.some(slot => !slot.client.supportsStaging)) {
        throw new FilesFailure('files/prerequisite-missing', 'The original pool has no verified staging companion.')
      }
    }
    const pathBytes = (path: string): number => {
      if (path.length === 0 || isAbsolute(path) || path.includes('\0') || path.split('/').includes('..')) {
        throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      const bytes = Buffer.byteLength(path)
      if (bytes > this.config.maxPathBytes) throw new FdWorkerFailure('FS_TOO_LARGE')
      return 2 * (bytes + Buffer.byteLength(fixedRoot.rootPath)) + 4 * (fixedRoot.rootMountId?.length ?? 0)
    }
    const run = <T>(
      bytes: number, work: (client: FdWorkerClient, control: AbortSignal) => Promise<T>, signal?: AbortSignal,
    ): Promise<ResidentResult<T>> =>
      port.run(bytes, control => this.withSlot(false, client => work(client, control)), signal)
    const stat = async (
      path: string, signal?: AbortSignal, assertProject: () => void = checkCurrent,
    ): Promise<ResidentResult<FdMetadata | undefined>> => {
      assertProject()
      const reservation = pathBytes(path) + 4 * (256 + 64) + this.config.replyOverheadBytes
      return await run(reservation, (client, control) => { assertProject(); return client.stat(fixedRoot, path, control) }, signal)
    }
    const streamText = async (
      path: string, signal?: AbortSignal, readRoot = fixedRoot, assertProject: () => void = checkCurrent,
    ): Promise<AsyncIterable<string>> => {
      checkCurrent()
      assertProject()
      if (signal?.aborted) throw new FdWorkerFailure('FS_ABORTED')
      // Includes raw worker/transfer buffers, decoder state, UTF-16 text and a held delivered chunk.
      const projectBytes = readRoot === fixedRoot ? 0 : 2 * Buffer.byteLength(readRoot.rootPath)
      const reservation = pathBytes(path) + projectBytes + 8 * (this.config.readChunkBytes + 4) + this.config.replyOverheadBytes
      const maxBytes = this.config.maxReadBytes
      const chunkBytes = this.config.readChunkBytes
      return await Promise.resolve((async function* (): AsyncIterable<string> {
        const started = Promise.withResolvers<FdByteStream>()
        const consumed = Promise.withResolvers<void>()
        const caller = new AbortController()
        const control = signal === undefined ? caller.signal : AbortSignal.any([caller.signal, signal])
        const work = run(reservation, async (client, actualControl) => {
          assertProject()
          const stream = client.stream(readRoot, path, maxBytes, chunkBytes, actualControl)
          started.resolve(stream)
          try { await stream.finished } finally { await consumed.promise }
        }, control)
        void work.then((result) => { result.release() }, (error: unknown) => { started.reject(error) })
        try {
          const stream = await started.promise
          yield* decodeTextStream(stream, () => {
            checkCurrent()
            assertProject()
            if (control.aborted) throw new FdWorkerFailure('FS_ABORTED')
          })
        } finally {
          caller.abort(new FdWorkerFailure('FS_ABORTED'))
          consumed.resolve()
        }
      })())
    }
    const reader = createFixedRootReader(fixedRoot.rootPath, {
      maxPathBytes: this.config.maxPathBytes, assertCurrent: checkCurrent, stat, streamText,
    })
    const directoryFor = (assertProject: () => void): DirectoryReadPort => createDirectoryReadPort(fixedRoot.rootPath, {
      maxPathBytes: this.config.maxPathBytes, replyOverheadBytes: this.config.replyOverheadBytes,
      assertCurrent: () => { checkCurrent(); assertProject() },
      inspect: (relativePath, reservedBytes, signal) => run(reservedBytes + 4 * (fixedRoot.rootMountId?.length ?? 0),
        (client, control) => {
          assertProject()
          return client.directory(fixedRoot, relativePath, this.config.maxPathBytes, control)
        }, signal),
    })
    const directory = directoryFor(checkCurrent)
    const projectLeaf = (workspace: Workspace): string => {
      const leaf = posix.relative(fixedRoot.rootPath, workspace.path)
      if (leaf !== 'default-workspace' && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf)) {
        throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      directoryWorkBudget({ parent: fixedRoot, leaf }, this.config)
      return leaf
    }
    const projectRoot = async (
      workspace: Workspace, signal?: AbortSignal, assertRegistered: () => void = checkCurrent,
    ): Promise<FdRootIdentity> => {
      checkCurrent()
      assertRegistered()
      const leaf = projectLeaf(workspace)
      const canonical = await directoryFor(assertRegistered).canonicalPath(workspace.path, signal)
      assertRegistered()
      if (canonical !== workspace.path) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      const held = await stat(leaf, signal, assertRegistered)
      try {
        checkCurrent()
        assertRegistered()
        const info = held.value
        if (info?.type !== 'directory') throw new FdWorkerFailure('FS_NOT_DIRECTORY')
        const [rootDevice, rootInode] = info.identity.split(':')
        if (rootDevice === undefined || rootInode === undefined) throw new FdWorkerFailure('FS_IO_ERROR')
        return Object.freeze({ rootPath: workspace.path, rootDevice, rootInode,
          ...fixedRoot.rootMountId === undefined ? {} : { rootMountId: fixedRoot.rootMountId } })
      } finally { held.release() }
    }
    let mutationTail = Promise.resolve()
    let mutationUnknown = false
    const environmentBanks = new WeakMap<StaticEnvironmentBank, EnvironmentBankState>()
    // Only trusted same-lane executors enter here; observation never settles their actual work.
    const runMutation = <T>(
      reservation: number, assertProject: () => void,
      execute: (client: FdWorkerClient, control: AbortSignal) => Promise<T>,
      failure: (outcome: 'not-published' | 'unknown', code: FsErrorCode, cause?: unknown) => FdMutationFailure,
      signal?: AbortSignal, delivery: 'native-handoff' | 'retained-result' | 'retained-lease' = 'native-handoff',
    ): Promise<ResidentResult<T>> => {
      checkCurrent()
      assertProject()
      if (mutationUnknown) return Promise.reject(failure('unknown', 'FS_IO_ERROR'))
      const answer = Promise.withResolvers<ResidentResult<T>>()
      let invoked = false
      const work = port.run<T>(reservation, async (control) => {
        invoked = true
        const previous = mutationTail
        const turn = Promise.withResolvers<void>()
        mutationTail = turn.promise
        try {
          await previous
          checkCurrent()
          assertProject()
          if (control.aborted) throw failure('not-published', 'FS_ABORTED')
          if (mutationUnknown) throw failure('not-published', 'FS_IO_ERROR')
          const execution = { entered: false }
          try {
            const value = await this.withSlot(false, (client) => { execution.entered = true; return execute(client, control) })
            // Stage releases running capacity at actual closure; the original queue keeps its resident result.
            if (delivery !== 'native-handoff') return value
            const consumed = Promise.withResolvers<void>()
            // Actual publication facts survive cancellation/deadline of the queue observer.
            answer.resolve({ value, release: consumed.resolve })
            await consumed.promise
            return value
          } catch (error) {
            if (!execution.entered && error instanceof FilesFailure) throw failure('not-published', 'FS_IO_ERROR', error)
            if (!(error instanceof FdMutationFailure) || error.outcome === 'unknown') {
              mutationUnknown = true
              answer.reject(error)
              turn.resolve()
              console.error('Cloud file publication or cleanup is unconfirmed; '
                + 'account operation and budget remain retained. Do not retry the write.')
              // Unresolved publication/cleanup keeps this original operation and its complete reservation.
              await new Promise<never>(() => {})
            }
            throw error
          }
        } catch (error) {
          answer.reject(error)
          throw error
        } finally { turn.resolve() }
      }, signal, delivery === 'retained-lease' ? 'lease' : undefined)
      void work.then((result) => {
        if (delivery !== 'native-handoff') answer.resolve(result)
        else result.release()
      }, (error: unknown) => {
        if (!invoked || delivery !== 'native-handoff') answer.reject(signal?.aborted && delivery === 'native-handoff'
          ? failure('not-published', 'FS_ABORTED', error) : error)
      })
      return answer.promise
    }
    const skillCell: { port?: SkillVersionPort
      bundleRead?: (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<BundleTree>
      bundleResolve?: (version: Omit<SkillBundleVersion, 'binding'>) => SkillBundleVersion
      bundleAuthorize?: (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<void>
      projection?: SkillProjectPort
      resolve?: (id: SkillVersionId, expected
      : Omit<SkillVersion, 'binding'>) => SkillVersion | undefined
      read?: (client: FdWorkerClient, version: SkillVersion, control
      : AbortSignal) => Promise<{ skill: Uint8Array<ArrayBuffer>; resource: Uint8Array<ArrayBuffer> }> } = {}
    const skillVersions = (): SkillVersionPort => {
      checkCurrent()
      const config = this.config.skillVersions
      if (config === undefined || preferencesParent === undefined || this.slots.some(slot => !slot.client.supportsSkillVersions)) {
        throw new FilesFailure('files/prerequisite-missing', 'Fixed private skill capability is unavailable')
      }
      const current = (): void => {
        checkCurrent()
        this.requireStorageOwner().skillStorageIdentity(binding, preferencesParent)
      }
      current()
      const identity = this.requireStorageOwner().skillStorageIdentity(binding, preferencesParent)
      const bundleLimits = this.config.skillBundles
      if (bundleLimits !== undefined && this.slots.some(slot => !slot.client.supportsSkillBundles)) {
        throw new FilesFailure('files/prerequisite-missing', 'Independent complete bundle helper is unavailable')
      }
      const reservation = Math.max(config.reservationBytes, bundleLimits?.reservationBytes ?? 0)
      skillCell.port ??= createSkillVersionWork({
        ...bundleLimits === undefined || this.config.skillProjection === undefined || this.config.content === undefined ? {} : { bundles: {
          limits: bundleLimits, reclaim: { projectionLimits: this.config.skillProjection, maxPathBytes: this.config.maxPathBytes,
            maxReplyBytes: this.config.content.maxReplyBytes },
          bind: (read, resolve, authorize) => {
            skillCell.bundleRead = read; skillCell.bundleResolve = resolve; skillCell.bundleAuthorize = authorize
          },
          materialize: (project, version, signal) => skillProjection().materializeBundle(project, version, signal),
        } }, binding, root: preferencesParent, uid: identity.uid, gid: identity.gid, limits
        : config, maxReadBytes: this.config.maxReadBytes,
        assertCurrent: current,
        bindProjectionRead: (read, resolve) => { skillCell.read = read; skillCell.resolve = resolve },
        mutate: (kind, work, signal) => runMutation(reservation, current, work,
          (outcome, code, cause) => new FdMutationFailure(outcome, code, undefined, { cause }), signal,
          kind === 'prepare' ? 'retained-result' : 'native-handoff'),
        read: (work, signal) => run(reservation, (client, control) => { current(); return work(client, control) }, signal),
      })
      return skillCell.port
    }
    const skillProjection = (): SkillProjectPort => {
      checkCurrent(); skillVersions()
      const config = this.config.skillProjection, sourceConfig = this.config.skillVersions, privateRoot = preferencesParent
      const sourceRead = skillCell.read, resolveSource = skillCell.resolve
      if (config === undefined || sourceConfig === undefined || privateRoot === undefined || sourceRead === undefined
        || resolveSource === undefined
        || this.config.content === undefined || this.slots.some(slot => !slot.client.supportsSkillProjection)) {
        throw new FilesFailure('files/prerequisite-missing', 'Independent fixed project-copy helper or explicit budget is unavailable')
      }
      const identity = this.requireStorageOwner().skillStorageIdentity(binding, privateRoot)
      if (fixedRoot.rootPath !== identity.projects.rootPath || fixedRoot.rootDevice !== identity.projects.rootDevice
        || fixedRoot.rootInode !== identity.projects.rootInode || fixedRoot.rootMountId !== identity.projects.rootMountId
        || BigInt(config.maxMetadataBytes) + BigInt(sourceConfig.maxTotalBytes) > BigInt(identity.privateDomain.minimumBytes)
        || BigInt(config.maxMetadataInodes) + BigInt(sourceConfig.maxTotalInodes) > BigInt(identity.privateDomain.minimumInodes)) {
        throw new FilesFailure('files/prerequisite-missing',
          'Projection metadata and source storage do not fit the original qualified hard domains')
      }
      const current = (): void => { checkCurrent(); this.requireStorageOwner().skillStorageIdentity(binding, privateRoot) }
      skillCell.projection ??= createSkillProjectWork({
        ...this.config.skillBundles === undefined ? {} : { bundleLimits: this.config.skillBundles,
          bundleSource: async (client, version, control) => {
            if (skillCell.bundleRead === undefined) throw new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED')
            return skillCell.bundleRead(client, version, control)
          },
          bundleAuthorize: async (client, version, control) => {
            if (skillCell.bundleAuthorize === undefined) throw new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED')
            return skillCell.bundleAuthorize(client, version, control)
          },
          resolveBundle: (version) => {
            if (skillCell.bundleResolve === undefined) throw new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED')
            return skillCell.bundleResolve(version)
          },
        }, binding, privateRoot, uid: identity.uid, gid: identity.gid,
        quota: identity.projects, limits: config, sourceLimits: sourceConfig, maxReadBytes: this.config.maxReadBytes,
        maxPathBytes: this.config.maxPathBytes,
        maxReplyBytes: this.config.content.maxReplyBytes, assertCurrent: current, source: sourceRead,
        ...revalidation === undefined ? {} : { revalidation },
        resolveSource: descriptor => resolveSource(descriptor.id, descriptor),
        project: async (client, workspace, control) => {
          current(); const leaf = projectLeaf(workspace)
          const info = await client.stat(fixedRoot, leaf, control), directory = await client.directory(fixedRoot, leaf,
            this.config.maxPathBytes, control)
          const [device, inode] = info?.identity.split(':') ?? []
          if (info?.type !== 'directory' || device !== fixedRoot.rootDevice || inode === undefined || fixedRoot.rootMountId === undefined
            || !directory.directory || directory.canonicalPath !== workspace.path) throw new FdMutationFailure('not-published',
            'FS_PERMISSION_DENIED')
          return Object.freeze({ rootPath: workspace.path, rootDevice: device, rootInode: inode, rootMountId: fixedRoot.rootMountId })
        },
        mutate: (work, signal, retention) => runMutation(
          Math.max(config.reservationBytes, this.config.skillBundles?.reservationBytes ?? 0), current, work,
          (outcome, code, cause) => new FdMutationFailure(outcome, code, undefined, { cause }), signal,
          retention === 'lease' ? 'retained-lease' : 'retained-result'),
      })
      return skillCell.projection
    }
    const writeText = (
      project: FdRootIdentity, path: string, content: string, expected: FsWriteIntent | undefined, signal?: AbortSignal,
      assertProject: () => void = checkCurrent,
    ): Promise<ResidentResult<FsWriteOutcome>> => {
      checkCurrent()
      assertProject()
      if (mutationUnknown) return Promise.reject(new FdTextWriteFailure('unknown', 'FS_IO_ERROR'))
      if (this.slots.some(slot => !slot.client.supportsTextWrites)) return Promise.reject(new FdTextWriteFailure('not-published',
        'FS_PERMISSION_DENIED'))
      if (Buffer.byteLength(content) > this.config.maxReadBytes) return Promise.reject(new FdTextWriteFailure('not-published',
        'FS_TOO_LARGE'))
      const reservation = pathBytes(path) + 2 * Buffer.byteLength(project.rootPath)
        + 32 * (this.config.maxReadBytes + 1) + 8 * Buffer.byteLength(content) + 4 * 320 + this.config.replyOverheadBytes
      return runMutation(reservation, assertProject, async (client, control) => {
        const value = await client.writeText(project, path, content, expected, this.config.maxReadBytes, control)
        return { ...value, version: FsVersion(value.version) }
      }, (outcome, code, cause) => new FdTextWriteFailure(outcome, code, undefined,
        cause === undefined ? undefined : { cause }), signal)
    }
    const projectBackend = async (
      workspace: Workspace, assertRegistered: () => void, assertInstalled: (ctx: Context) => void, signal?: AbortSignal,
    ): Promise<TextProjectBackend> => {
      const current = (): void => { checkCurrent(); assertRegistered() }
      current()
      const project = await projectRoot(workspace, signal, current)
      const projectStat = (path: string, control?: AbortSignal): Promise<ResidentResult<FdMetadata | undefined>> => {
        current()
        return run(pathBytes(path) + 2 * Buffer.byteLength(project.rootPath) + 4 * 320 + this.config.replyOverheadBytes,
          (client, actual) => { current(); return client.stat(project, path, actual) }, control)
      }
      const projectReader = createFixedRootReader(project.rootPath, {
        maxPathBytes: this.config.maxPathBytes, assertCurrent: current, stat: projectStat,
        streamText: (path, control) => streamText(path, control, project, current),
      })
      const projectDirectory = createDirectoryReadPort(project.rootPath, {
        maxPathBytes: this.config.maxPathBytes, replyOverheadBytes: this.config.replyOverheadBytes, assertCurrent: current,
        inspect: (path, reservation, control) => run(reservation,
          (client, actual) => { current(); return client.directory(project, path, this.config.maxPathBytes, actual) }, control),
      })
      const contentLimits = () => {
        current()
        try { assertContentAvailable() } catch (error) { throw new FsError('ABI8 content capability is unavailable.',
          'FS_PERMISSION_DENIED', { cause: error }) }
        if (this.config.content === undefined) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
        return this.config.content
      }
      const contentBudget = (path: string, resultBytes: number, entries = 0): number => {
        const bytes = pathBytes(path) + 4 * Buffer.byteLength(project.rootPath) + 12 * (this.config.maxPathBytes + 1)
          + 8 * resultBytes + entries * (2048 + 8 * (Buffer.byteLength(path) + this.config.maxPathBytes + 128))
          + 4 * this.config.replyOverheadBytes
        if (!Number.isSafeInteger(bytes) || bytes <= 0
          || bytes > this.config.maxResidentBytesPerLane) throw new FdWorkerFailure('FS_TOO_LARGE')
        return bytes
      }
      const contentRun = <T>(
        bytes: number, work: (client: FdWorkerClient, actual: AbortSignal) => Promise<T>, control?: AbortSignal,
      ): Promise<ResidentResult<T>> => run(bytes, (client, actual) => {
        current()
        assertContentAvailable()
        return work(client, actual)
      }, control).catch((error: unknown) => {
        if ((control?.aborted === true && error === control.reason)
          || error instanceof FilesFailure && error.code === 'files/aborted') {
          throw new FsError('File operation aborted.', 'FS_ABORTED', { cause: error })
        }
        throw error
      })
      return Object.freeze({ binding, workspace, reader: projectReader, maxPathBytes: this.config.maxPathBytes,
        assertInstalled, assertCurrent: current,
        lstat: (path: string, control?: AbortSignal) => {
          contentLimits()
          // The ABI8 transport fixes this complete metadata frame ceiling at 1024 bytes.
          return contentRun(contentBudget(path, 1024), (client, actual) => client.lstat(project, path, actual), control)
        },
        listDir: (path: string, control?: AbortSignal) => {
          const content = contentLimits()
          // Covers native rows, decoded/transport copies, main-thread entries, issued targets and their retained paths.
          return contentRun(contentBudget(path, content.maxReplyBytes, content.maxEntries),
            (client, actual) => client.list(project, path, content.maxEntries, content.maxReplyBytes, actual), control)
        },
        readBytes: (path: string, maxBytes: number, control?: AbortSignal) => {
          const content = contentLimits()
          if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || content.maxReplyBytes < 128) throw new FdWorkerFailure('FS_TOO_LARGE')
          const cap = Math.min(maxBytes, this.config.maxReadBytes, content.maxReplyBytes - 128)
          return contentRun(contentBudget(path, cap + 1), (client, actual) => client.read(project, path, cap, actual), control)
        },
        readByteRange: (path: string, range: { offset: number; length: number }, control?: AbortSignal) => {
          const content = contentLimits()
          const { offset, length } = range
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
            || !Number.isSafeInteger(offset + length) || length > this.config.maxReadBytes
            || length + 128 > content.maxReplyBytes) throw new FdWorkerFailure('FS_TOO_LARGE')
          return contentRun(contentBudget(path, length),
            (client, actual) => client.readRange(project, path, offset, length, length, actual), control)
        },
        canonicalPath: (path: string, control?: AbortSignal) => projectDirectory.canonicalPath(posix.join(project.rootPath, path), control),
        readText: (path: string, control?: AbortSignal) => {
          current()
          return run(pathBytes(path) + 2 * Buffer.byteLength(project.rootPath)
            + 8 * (this.config.maxReadBytes + 1) + this.config.replyOverheadBytes,
          async (client, actual) => {
            current()
            return decodeBoundedText(await client.read(project, path, this.config.maxReadBytes, actual))
          }, control)
        },
        writeText: (path: string, content: string, expected?: FsWriteIntent, control?: AbortSignal) => {
          current()
          return writeText(project, path, content, expected, control, current)
        },
      })
    }
    const derivePreparedLeaf = (grant: IsolatedLeafGrant, retainedBytes = 0): PreparedLeafPort => {
      checkCurrent()
      if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) throw new FdWorkerFailure('FS_TOO_LARGE')
      if (grant.binding !== binding
        || grant.parent.rootPath !== fixedRoot.rootPath || grant.parent.rootDevice !== fixedRoot.rootDevice
        || grant.parent.rootInode !== fixedRoot.rootInode
          || grant.parent.rootMountId !== fixedRoot.rootMountId) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      const intent: DirectoryIntent = Object.freeze({ parent: fixedRoot, leaf: grant.leaf })
      const directoryLimits = { maxPathBytes: this.config.maxPathBytes, replyOverheadBytes: this.config.replyOverheadBytes + retainedBytes }
      directoryWorkBudget(intent, directoryLimits)
      const exclusive = grant.assertExclusive
      const deployment = grant.backend === 'root-owned-isolated-ext4' ? grant.assertDeployment : undefined
      const backend = grant.backend === 'root-owned-isolated-ext4' ? 'ext4' : 'tmpfs'
      if (backend === 'ext4' && fixedRoot.rootMountId === undefined) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      const assertWindow = (): void => { deployment?.(); exclusive() }
      assertWindow()
      return Object.freeze({ prepare: () => {
        checkCurrent()
        assertWindow()
        const owned = port.prepareDirectory(intent, directoryLimits, async (control, fixed): Promise<DirectoryPrepareOutcome> => {
          try { assertWindow(); this.assertHealthy() } catch (_error) {
            return { kind: 'not-created-failure', failure: { errno: 13, phase: 0 } }
          }
          if (!this.slots.some(slot => !slot.busy && slot.client.available)) {
            return { kind: 'not-created-failure', failure: { errno: 11, phase: 0 } }
          }
          return await this.withSlot(false, client => client.prepareLeaf(fixed.parent, fixed.leaf, control, backend))
        })
        return Object.freeze({ observation: owned.observation, control: Object.freeze({
          expose: () => { assertWindow(); return owned.control.expose() },
          cleanup: (signal?: AbortSignal) => owned.control.cleanup(async (identity, control, fixed) => {
            assertWindow()
            return await this.withSlot(true, client => client.removeEmptyLeaf(fixed.parent, fixed.leaf, identity, control, backend))
          }, signal),
        }) })
      } })
    }
    return Object.freeze({
      reader,
      directory,
      assertContentAvailable,
      assertStagingAvailable,
      prepareExecutionMounts: async (
        workspace: Workspace, sessionId: EnvironmentSessionId, environmentVersion: string,
        authority: EnvironmentBankAuthority, assertRegistered: () => void, signal?: AbortSignal,
      ): Promise<ResidentResult<ExecutionMountGrant>> => {
        const current = (): void => { checkCurrent(); assertRegistered() }
        current()
        assertContentAvailable()
        if (this.slots.some(slot => !slot.client.supportsProjectMetadata)) {
          throw new FilesFailure('files/prerequisite-missing', 'The original files pool has no verified fixed project metadata capability.')
        }
        if (this.slots.some(slot => !slot.client.supportsEnvironmentLayout)) {
          throw new FilesFailure('files/prerequisite-missing',
            'The original files pool has no verified fixed environment layout capability.')
        }
        if (preferencesParent === undefined || fixedRoot.rootMountId === undefined) {
          throw new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED')
        }
        const privateRoot = preferencesParent
        const leaf = projectLeaf(workspace)
        const reservation = environmentWorkBytes(authority.bank.slots.length, this.config)
        let bankState = environmentBanks.get(authority.bank)
        if (bankState === undefined) { bankState = { blocked: false }; environmentBanks.set(authority.bank, bankState) }
        const state = bankState
        const held = await runMutation(reservation, current, async (client, actual) => {
          const running = (): void => {
            current()
            if (actual.aborted) throw new FdMutationFailure('not-published', 'FS_ABORTED', undefined, { cause: actual.reason })
          }
          try {
            running()
            const directory = await client.directory(fixedRoot, leaf, this.config.maxPathBytes, actual)
            running()
            if (!directory.directory || directory.canonicalPath !== workspace.path) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
            const info = await client.stat(fixedRoot, leaf, actual)
            if (info?.type !== 'directory') throw new FdWorkerFailure('FS_NOT_DIRECTORY')
            const [device, inode] = info.identity.split(':')
            if (device === undefined || inode === undefined) throw new FdWorkerFailure('FS_IO_ERROR')
            const quota = environmentQuota(authority.projects, await client.storageProbe(authority.projects.rootPath, actual), authority)
            const metadata = await client.prepareProjectMetadata({ rootPath: workspace.path, rootDevice: device,
              rootInode: inode, rootMountId: quota.mountId }, authority.appUid, authority.appGid, actual)
            running()
            const assignment = await prepareEnvironmentSlot({
              read: async (path) => {
                pathBytes(path)
                const before = await client.stat(privateRoot, path, actual)
                if (before?.type !== 'file' || before.size === undefined || before.size > this.config.maxReadBytes) {
                  throw new FdWorkerFailure('FS_IO_ERROR')
                }
                const bytes = await client.read(privateRoot, path, this.config.maxReadBytes, actual)
                const after = await client.stat(privateRoot, path, actual)
                if (after?.version !== before.version) throw new FdWorkerFailure('FS_STALE_VERSION')
                return { bytes, version: before.version }
              },
              write: async (path, content, version) => {
                pathBytes(path)
                await client.writeText(privateRoot, path, content, { kind: 'replaceIfVersion', version: FsVersion(version) },
                  this.config.maxReadBytes, actual)
              },
              probe: domain => client.storageProbe(domain.rootPath, actual),
              prepareLayout: domain => client.prepareEnvironmentLayout(domain, authority.appUid, authority.appGid, actual),
            }, authority, state, { sessionId, workspaceId: workspace.id, environmentVersion }, this.config.maxPathBytes, running)
            const domain = assignment.slot.domain
            return Object.freeze<ExecutionMountGrant>({ binding, sessionId, workspaceId: workspace.id,
              project: Object.freeze({ rootPath: workspace.path, rootDevice: device, rootInode: inode,
                rootMountId: quota.mountId, mountVersion: `${device}:${inode}:${quota.mountId}`, quota,
                readOnlyPaths: Object.freeze(['.pe'] as const),
                metadataDirectory: Object.freeze({ ...metadata.directory, relativePath: '.pe' }) }),
              environment: Object.freeze({ rootPath: domain.rootPath, rootDevice: domain.rootDevice, rootInode: domain.rootInode,
                rootMountId: domain.rootMountId, targetPath: '/opt/session-env', bankId: authority.bank.bankId,
                rootReadOnly: true, writablePaths: Object.freeze(['home', 'venv', 'tmp'] as const), layout: assignment.layout,
                slotId: assignment.slot.slotId, slotGeneration: assignment.record.slotGeneration, environmentVersion,
                quota: assignment.quota }) })
          } catch (error) {
            if (error instanceof FdWorkerFailure && !(error instanceof FdMutationFailure)) {
              throw new FdMutationFailure('not-published', error.code, error.syscallCode, { cause: error })
            }
            throw error
          }
        }, (outcome, code, cause) => new FdMutationFailure(outcome, code, undefined, { cause }), signal, 'retained-lease')
        try { current(); signal?.throwIfAborted(); return held } catch (error) { held.release(); throw error }
      },
      runNativeMutation: <T>(reservationBytes: number, assertOwner: () => void,
        execute: (control: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<ResidentResult<T>> => {
        assertStagingAvailable()
        if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1 || reservationBytes > this.config.maxResidentBytesPerLane) {
          return Promise.reject(new FdMutationFailure('not-published', 'FS_TOO_LARGE'))
        }
        return runMutation(reservationBytes, () => { checkCurrent(); assertOwner() }, (_client, actual) => execute(actual),
          (outcome, code, cause) => new FdMutationFailure(outcome, code, undefined, cause === undefined ? undefined : { cause }), signal)
      },
      stageFiles: async (workspace: Workspace, sources: StageSources, assertRegistered: () => void, signal?: AbortSignal) => {
        const current = (): void => { checkCurrent(); assertRegistered() }
        current()
        assertStagingAvailable()
        const staging = this.config.staging
        if (staging === undefined) throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
        const leaf = projectLeaf(workspace)
        if (!Number.isSafeInteger(staging.reservationBytes) || staging.reservationBytes < 1
          || staging.reservationBytes > this.config.maxResidentBytesPerLane) throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
        const selection = { rootPath: workspace.path,
          ...fixedRoot.rootMountId === undefined ? {} : { rootMountId: fixedRoot.rootMountId } }
        const supplied = typeof sources === 'function' || sources.length === 0
          ? undefined : planStageBatch(sources, selection, staging, this.config)
        const result = await runMutation(staging.reservationBytes, current, async (client, control) => {
          let plan: StageBatchPlan
          try {
            const collected = typeof sources === 'function' ? sources() : sources
            if (Array.isArray(collected) && collected.length === 0) return Object.freeze([])
            plan = supplied ?? planStageBatch(collected, selection, staging, this.config)
          } catch (error) {
            // Collection and planning have opened neither source nor sink; no publication or cleanup is pending.
            throw new FdStageFailure('not-published', error instanceof FdWorkerFailure ? error.code : 'FS_IO_ERROR', undefined,
              { cause: error })
          }
          // Derive the real project identity inside this same reservation/slot, never via another lane run.
          let selected: FdRootIdentity
          try {
            const directory = await client.directory(fixedRoot, leaf, this.config.maxPathBytes, control)
            current()
            if (!directory.directory || directory.canonicalPath !== workspace.path) throw new FdStageFailure('not-published',
              'FS_PERMISSION_DENIED')
            const info = await client.stat(fixedRoot, leaf, control)
            current()
            if (info?.type !== 'directory') throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
            const [device, inode] = info.identity.split(':')
            if (device === undefined || inode === undefined || fixedRoot.rootMountId === undefined) {
              throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
            }
            selected = Object.freeze({ rootPath: workspace.path, rootDevice: device, rootInode: inode, rootMountId: fixedRoot.rootMountId })
          } catch (error) {
            if (error instanceof DirectoryMetadataFailure || error instanceof FdWorkerFailure || error instanceof FilesFailure) {
              throw error instanceof FdMutationFailure ? error : new FdStageFailure('not-published',
                error instanceof FdWorkerFailure ? error.code : 'FS_IO_ERROR', undefined, { cause: error })
            }
            throw error
          }
          return await executeStageBatch({ beginStage: (root, file, chunk, actual) =>
            client.beginStage(root, file, chunk, this.config.replyOverheadBytes, actual) }, selected, plan, staging,
          this.config.readChunkBytes, current, control)
        }, (outcome, code, cause) => new FdStageFailure(outcome, code, undefined,
          cause === undefined ? undefined : { cause }), signal, 'retained-result')
        try { current(); return result } catch (error) { result.release(); throw error }
      },
      derivePreparedLeaf,
      createWorkspaceRegistry: (defaultGrant: IsolatedLeafGrant, assertUnpublished: () => void) => {
        const defaultPort = derivePreparedLeaf(defaultGrant)
        const assertGraph = (): void => {
          checkCurrent()
          if (defaultGrant.backend === 'root-owned-isolated-ext4') defaultGrant.assertDeployment()
        }
        const assertWindow = (): void => {
          assertGraph(); assertUnpublished(); defaultGrant.assertExclusive()
          if (defaultGrant.backend === 'root-owned-isolated-ext4') defaultGrant.assertDeployment()
        }
        const registration = (grant: IsolatedLeafGrant, guard: () => void, retainedBytes = 0): WorkspacePreparation => {
          guard()
          const work = (grant === defaultGrant && retainedBytes === 0 ? defaultPort : derivePreparedLeaf(grant, retainedBytes)).prepare()
          const record = port.captureRegistration(work.observation)
          const current = (): void => {
            guard(); grant.assertExclusive()
            if (grant.backend === 'root-owned-isolated-ext4') grant.assertDeployment()
          }
          return { work, record, assertWindow: current, readIdentity: async () => {
            current()
            const held = await stat(record.intent.leaf)
            try {
              current()
              const value = held.value
              if (value?.type !== 'directory') throw new FdWorkerFailure('FS_PERMISSION_DENIED')
              const [device, inode] = value.identity.split(':')
              if (device === undefined || inode === undefined) throw new FdWorkerFailure('FS_IO_ERROR')
              return Object.freeze({ device, inode })
            } finally { held.release() }
          } }
        }
        return createBoundWorkspaceRegistry({
          directory, defaultGrant, assertCurrent: assertGraph, assertWindow,
          prepareDefault: () => defaultPort.prepare(),
          prepareRegistration: grant => registration(grant, assertWindow),
          prepareAdmittedRegistration: (grant: IsolatedLeafGrant, use: AccountUse, title: string | undefined) => {
            const titleBytes = title === undefined ? 0 : Buffer.byteLength(title)
            if (titleBytes > this.config.maxPathBytes) throw new FdWorkerFailure('FS_TOO_LARGE')
            const admitted = (): void => {
              assertGraph(); use.assertCurrent()
              if (use.binding !== binding) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
            }
            // Native title storage remains reserved through registration, on this same responsibility.
            return registration(grant, admitted, 4 * titleBytes)
          },
          project: async (workspace, assertRegistryCurrent, assertInstalled) => {
            assertRegistryCurrent()
            const canonical = await directory.canonicalPath(workspace.path)
            assertRegistryCurrent()
            const held = await stat('default-workspace')
            let projectRoot: FdRootIdentity
            try {
              assertRegistryCurrent()
              const value = held.value
              if (value?.type !== 'directory' || canonical !== workspace.path) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
              const separator = value.identity.indexOf(':')
              projectRoot = Object.freeze({ rootPath: canonical, rootDevice: value.identity.slice(0, separator),
                rootInode: value.identity.slice(separator + 1),
                ...fixedRoot.rootMountId === undefined ? {} : { rootMountId: fixedRoot.rootMountId } })
            } finally { held.release() }
            const projectReader = createFixedRootReader(projectRoot.rootPath, {
              maxPathBytes: this.config.maxPathBytes, assertCurrent: assertRegistryCurrent,
              stat: (path, signal) => {
                assertRegistryCurrent()
                const reservation = 2 * (Buffer.byteLength(path) + Buffer.byteLength(projectRoot.rootPath))
                  + 4 * (256 + 64) + this.config.replyOverheadBytes + 4 * (projectRoot.rootMountId?.length ?? 0)
                return run(reservation, (client, control) => client.stat(projectRoot, path, control), signal)
              },
              // S2 never grants content reads; no stream is dispatched through this reader.
              streamText: () => Promise.reject(new FdWorkerFailure('FS_PERMISSION_DENIED')),
            })
            return createS2ProjectPort({ binding, workspace, reader: projectReader, assertCurrent: assertRegistryCurrent, assertInstalled })
          },

        })
      },
      createTextFileSystem: async (
        workspace: Workspace, assertInstalled: (ctx: Context) => void, resolveProject: ResolveAccountFileProject,
        mapProcessPath?: (caller: Context, hostPath: string) => string | undefined,
      ): Promise<NativeTextFileSystemConstructor> => {
        checkCurrent()
        await projectRoot(workspace)
        return createTextProjectFileSystem({ binding, bootstrapWorkspace: workspace, resolveProject, assertInstalled,
          ...mapProcessPath === undefined ? {} : { mapProcessPath },
          assertCurrent: checkCurrent,
          project: (selected, assertSelection, signal) => projectBackend(selected, assertSelection, assertInstalled, signal) })
      },
      projectFor: async (workspace: Workspace, assertRegistered: () => void, signal?: AbortSignal): Promise<AccountFilesProject> => {
        const backend = await projectBackend(workspace, assertRegistered, () => { assertRegistered() }, signal)
        const projectDirectory = Object.freeze({ binding, prepare: async (cwd: string): Promise<void> => {
          backend.assertCurrent()
          if (cwd !== workspace.path) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
          const target = await backend.reader.resolve('.')
          const info = await backend.reader.stat(target)
          backend.assertCurrent()
          if (info?.type !== 'directory' || backend.reader.processPath(target) !== workspace.path) {
            throw new FdWorkerFailure('FS_NOT_DIRECTORY')
          }
        } })
        backend.assertCurrent()
        return Object.freeze({ binding, workspace, projectDirectory })
      },
      skillVersions,
      skillProjection,
      withInstructionReaders: async <T>(
        workspace: Workspace, reservedBytes: number,
        build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal: AbortSignal,
        assertRegistered: () => void,
      ): Promise<ResidentResult<T>> => {
        const current = (): void => { checkCurrent(); assertRegistered() }
        current()
        if (preferencesParent === undefined) {
          throw new FilesFailure('files/prerequisite-missing', 'The account instruction storage owner is unavailable.')
        }
        return runInstructionReadWork({ projectRoot: await projectRoot(workspace, signal, current), privateParent: preferencesParent,
          requestedResidentBytes: reservedBytes, build, signal, assertCurrent: current,
          config: { maxPathBytes: this.config.maxPathBytes, maxReadBytes: this.config.maxReadBytes,
            readChunkBytes: this.config.readChunkBytes, replyOverheadBytes: this.config.replyOverheadBytes,
            maxReservationBytes: this.config.maxResidentBytesPerLane },
          execute: (bytes, work, control) => run(bytes, (client, actual) => work(client, actual), control) })
      },
      stat: async (path: string, signal?: AbortSignal): Promise<ResidentResult<FsInfo | undefined>> => {
        const held = await stat(path, signal)
        return { value: held.value === undefined ? undefined : nativeInfo(held.value), release: () => { held.release() } }
      },
      streamText,
      readBytes: async (relativePath: string, maxBytes: number, signal?: AbortSignal) => {
        const paths = pathBytes(relativePath)
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
          || maxBytes > this.config.maxReadBytes) throw new FdWorkerFailure('FS_TOO_LARGE')
        return await run(2 * (maxBytes + 1) + paths + this.config.replyOverheadBytes,
          (client, control) => client.read(fixedRoot, relativePath, maxBytes, control), signal)
      },
    })
  }

  /** Stop only this account's queue and active I/O; shared idle workers stay alive for other accounts. */
  stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt> {
    return this.owner.stopEpoch(binding, deadlineAtMs)
  }

  /**
   * Request root shutdown and return bounded observations without deleting unresolved resources.
   * @param deadlineAtMs Finite absolute server-time deadline bounding this observation wait.
   * @returns Confirmed only after actual exits and result release, otherwise unknown with pending ids.
   */
  async stop(deadlineAtMs: number): Promise<FilesPoolStopReceipt> {
    const remaining = deadline(deadlineAtMs)
    this.requestStop()
    if (this.state !== 'closed' && remaining > 0) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          this.closedObservers.delete(finish)
          resolve()
        }
        const timer = setTimeout(finish, remaining)
        this.closedObservers.add(finish)
      })
    }
    return {
      status: this.state === 'closed' ? 'confirmed' : 'unknown',
      pendingWorkerIds: this.slots.filter(slot => !slot.exited).map(slot => slot.id),
      pendingOperationIds: [...this.owner.pending(), ...this.rootOperation === undefined ? [] : [this.rootOperation.id]],
    }
  }

  /** Complete only after every actual worker exit and account-held result has settled. */
  whenClosed(): Promise<void> { return this.closed.promise }

  /**
   * Inspect finite root capacity and health; this is not product readiness.
   * @returns Current pool state, worker counts, and the retained root byte reservation.
   */
  inspect(): Readonly<{
    state: 'new' | 'starting' | 'running' | 'closing' | 'closed'
    workers: number
    healthy: number
    busy: number
    exited: number
    rootReservedBytes: number
    work: ReturnType<FilesWorkOwner['inspect']>
  }> {
    return {
      state: this.state, workers: this.slots.length,
      healthy: this.slots.filter(slot => slot.client.available).length,
      busy: this.slots.filter(slot => slot.busy).length,
      exited: this.slots.filter(slot => slot.exited).length,
      rootReservedBytes: this.state === 'closed' ? 0 : rootReservation(this.config),
      work: this.owner.inspect(),
    }
  }

  private async startAll(): Promise<void> {
    try {
      for (let i = 0; i < this.config.workerCount; i++) {
        const client = new FdWorkerClient(this.createWorker(workerInput(this.config)))
        const slot: Slot = { id: randomUUID() as OperationId, client, busy: false, exited: false }
        this.slots.push(slot)
        void client.exited.then(() => { slot.exited = true })
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new FdWorkerFailure('FS_IO_ERROR')) }, this.config.readyTimeoutMs)
        void Promise.all(this.slots.map(slot => slot.client.ready)).then(() => {
          clearTimeout(timer)
          resolve()
        }, (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new FdWorkerFailure('FS_IO_ERROR'))
        })
      })
      if (this.slots.some(slot => slot.client.supportsContentReads !== (this.config.content !== undefined))) {
        throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      if (this.slots.some(slot =>
        slot.client.supportsStaging !== (this.config.staging !== undefined))) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      if (this.config.skillBundles !== undefined && this.slots.some(slot => !slot.client.supportsSkillBundles)) {
        throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      if (this.config.skillVersions !== undefined && this.slots.some(slot =>
        !slot.client.supportsSkillVersions)) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      if (this.config.skillProjection !== undefined && this.slots.some(slot =>
        !slot.client.supportsSkillProjection)) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      if (this.state !== 'starting') throw new FdWorkerFailure('FS_IO_ERROR')
      this.state = 'running'
      this.assertHealthy()
      await this.storageOwner?.initializeStatic()
    } catch (error) {
      this.requestStop()
      throw error
    }
  }

  private requestStop(): void {
    if (this.state === 'closing' || this.state === 'closed') return
    this.state = 'closing'
    this.storageOwner?.closeAdmission()
    this.owner.close()
    void Promise.all([this.owner.whenClosed(), this.rootOperation?.settled]).then(async () => {
      for (const slot of this.slots) void slot.client.close()
      await Promise.all(this.slots.map(slot => slot.client.exited))
      this.state = 'closed'
      this.closed.resolve()
      for (const finish of this.closedObservers) finish()
      this.closedObservers.clear()
    })
  }

  private probeOperation<T>(work: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>, retainUnknown = false): Promise<T> {
    this.assertHealthy()
    const storage = this.config.staticStorage
    if (storage === undefined) throw new FilesFailure('files/prerequisite-missing', 'files root has no static probe configuration')
    if (this.rootOperation !== undefined) throw new FilesFailure('cloud/capacity', 'files root probe is still active')
    const controller = new AbortController()
    const observed = Promise.withResolvers<T>()
    const actual = this.withSlot(false, client => work(client, controller.signal))
    const completion = Promise.withResolvers<void>()
    const operation: { readonly id: OperationId; readonly settled: Promise<void>; failure?: unknown } = { id
    : randomUUID() as OperationId, settled: completion.promise }
    this.rootOperation = operation
    const timer = setTimeout(() => {
      controller.abort()
      observed.reject(new FilesFailure('files/prerequisite-missing',
        'files root probe observation expired; actual operation remains owned'))
    }, storage.probeTimeoutMs)
    const finish = (): void => {
      clearTimeout(timer)
      if (this.rootOperation === operation) this.rootOperation = undefined
      completion.resolve()
    }
    void actual.then((value) => { finish(); observed.resolve(value) }, (error: unknown) => {
      if (retainUnknown && error instanceof FdMutationFailure && error.outcome === 'unknown') {
        clearTimeout(timer)
        operation.failure = error
        observed.reject(error)
        return
      }
      finish(); observed.reject(error)
    })
    return observed.promise
  }

  private async withSlot<T>(cleanup: boolean, work: (client: FdWorkerClient) => Promise<T>): Promise<T> {
    if (cleanup) {
      if (this.state !== 'running' && this.state !== 'closing') throw new FdWorkerFailure('FS_IO_ERROR')
    } else this.assertHealthy()
    const slot = this.slots.find(candidate => !candidate.busy && candidate.client.available)
    if (slot === undefined) throw new FilesFailure('cloud/capacity', 'files has no healthy idle worker slot')
    slot.busy = true
    try { return await work(slot.client) } finally { slot.busy = false }
  }

  private assertHealthy(): void {
    if (this.state !== 'running' || this.slots.filter(slot => slot.client.available).length < this.config.minimumHealthyWorkers) {
      throw new FilesFailure('files/prerequisite-missing', 'files pool is stopped or below its healthy-worker requirement')
    }
  }
}
