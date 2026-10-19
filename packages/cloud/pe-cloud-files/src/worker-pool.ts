/** Root-owned prestarted slots; tasks reuse workers and never allocate a replacement on failure. */
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { isAbsolute, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding, AccountUse, DrainParticipant, OperationId, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import type { FdWorkerInput, FdRootIdentity } from './worker-protocol.ts'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { createFixedRootReader, decodeTextStream, nativeInfo } from './read-only.ts'
import type { FixedRootReader } from './read-only.ts'
import type { FdByteStream } from './worker-client.ts'
import type { FdMetadata } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'
import { FilesWorkOwner } from './work-owner.ts'
import { FdWorkerClient, FdWorkerFailure, FdTextWriteFailure } from './worker-client.ts'
import { createTextProjectFileSystem, decodeBoundedText } from './text-project.ts'
import type { NativeTextFileSystemConstructor, ResolveAccountFileProject, TextProjectBackend } from './text-project.ts'
import type { AccountFilesProject } from './account-service.ts'
import { FilesFailure } from './error.ts'
import { createDirectoryReadPort } from './directory.ts'
import type { DirectoryReadPort } from './directory.ts'
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
export interface FilesPoolConfig extends FilesLimits, Omit<FdWorkerInput, 'storageProbe'> {
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
  readonly reader: FixedRootReader
  readonly directory: DirectoryReadPort
  /** Require this current healthy lane, explicit content limits and actual ABI8 handshakes for every pool slot. */
  assertContentAvailable(): void
  /**
   * Prepare an opt-in text provider for the actual registered default Workspace, without installing it.
   * @param workspace Original native Registry object; never a client-selected root.
   * @param assertInstalled Owning graph/provider checks, repeated by the native constructor and every call.
   * @param resolveProject Trusted asynchronous caller selection, captured before interpreting each model path.
   * @returns Native constructor bound to a verified project FD root on this same lane; requires ABI7 for writes.
   */
  createTextFileSystem(
    workspace: Workspace, assertInstalled: (ctx: Context) => void, resolveProject: ResolveAccountFileProject,
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
    ...config.staticStorage === undefined ? {} : { storageProbe: config.staticStorage },
  }
}

function rootReservation(config: FilesPoolConfig): number {
  return config.workerCount * config.workerReservationBytes
    + (config.staticStorage === undefined ? 0 : staticStorageReservation(config.staticStorage, config.maxPathBytes, config.workerCount))
}

function limits(config: FilesPoolConfig): FilesLimits {
  const rootBytes = rootReservation(config)
  return {
    maxLanes: config.maxLanes, maxRunning: config.maxRunning, maxRunningPerLane: config.maxRunningPerLane,
    maxQueued: config.maxQueued, maxQueuedPerLane: config.maxQueuedPerLane,
    maxResidentBytes: config.maxResidentBytes - rootBytes, maxResidentBytesPerLane: config.maxResidentBytesPerLane,
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
  const content = config.content
  if (content !== undefined && (Object.values(content).some(value => !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    || content.maxNameBytes > config.maxPathBytes
    || [content.maxEntries, content.maxNameBytes, content.maxReplyBytes, content.operationTimeoutMs].some(value => value === undefined))) {
    throw new FilesFailure('files/prerequisite-missing', 'files content capacities require explicit bounded values')
  }
  for (const value of [
    config.workerCount, config.minimumHealthyWorkers, config.workerReservationBytes, config.replyOverheadBytes,
    config.readyTimeoutMs, config.drainTimeoutMs, config.maxReadBytes, config.maxPathBytes, config.readChunkBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new FilesFailure('files/prerequisite-missing', 'files pool capacities must be positive safe integers')
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
  private readonly owner: FilesWorkOwner
  private readonly slots: Slot[] = []
  private readonly closed = Promise.withResolvers<void>()
  private readonly closedObservers = new Set<() => void>()
  private state: 'new' | 'starting' | 'running' | 'closing' | 'closed' = 'new'
  private startTask: Promise<void> | undefined
  private readonly storageOwner?: RootStorageOwner
  private rootOperation: { readonly id: OperationId; readonly settled: Promise<void> } | undefined

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
      assertPoolCurrent: () => { this.assertHealthy() },
      bind: (binding, root, current, privateParent) => this.bind(binding, root, current, privateParent),
      joinEpoch: binding => this.owner.joinEpoch(binding),
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
   * Bind exact runtime input to one already-authorized root. No worker is created here.
   * @param binding Runtime-owned immutable account generation.
   * @param root Independently verified root identity; this method does not grant authorization or quota.
   * @param assertCurrent Trusted factory's owner/admission check, invoked for every operation.
   * @returns A fixed-root internal read port with no shared-pool close capability.
   */
  bind(
    binding: AccountBinding, root: FdRootIdentity, assertCurrent: () => void,
    privateParent?: FdRootIdentity & { readonly rootMountId: string },
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
    const projectRoot = async (
      workspace: Workspace, signal?: AbortSignal, assertRegistered: () => void = checkCurrent,
    ): Promise<FdRootIdentity> => {
      checkCurrent()
      assertRegistered()
      const leaf = posix.relative(fixedRoot.rootPath, workspace.path)
      if (leaf !== 'default-workspace' && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf)) {
        throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      directoryWorkBudget({ parent: fixedRoot, leaf }, this.config)
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
    let textTail = Promise.resolve()
    let textUnknown = false
    const writeText = (
      project: FdRootIdentity, path: string, content: string, expected: FsWriteIntent | undefined, signal?: AbortSignal,
      assertProject: () => void = checkCurrent,
    ): Promise<ResidentResult<FsWriteOutcome>> => {
      checkCurrent()
      assertProject()
      if (textUnknown) return Promise.reject(new FdTextWriteFailure('unknown', 'FS_IO_ERROR'))
      if (this.slots.some(slot => !slot.client.supportsTextWrites)) return Promise.reject(new FdTextWriteFailure('not-published', 'FS_PERMISSION_DENIED'))
      if (Buffer.byteLength(content) > this.config.maxReadBytes) return Promise.reject(new FdTextWriteFailure('not-published', 'FS_TOO_LARGE'))
      const reservation = pathBytes(path) + 2 * Buffer.byteLength(project.rootPath)
        + 32 * (this.config.maxReadBytes + 1) + 8 * Buffer.byteLength(content) + 4 * 320 + this.config.replyOverheadBytes
      const answer = Promise.withResolvers<ResidentResult<FsWriteOutcome>>()
      let invoked = false
      const work = port.run(reservation, async (control) => {
        invoked = true
        const previous = textTail
        const turn = Promise.withResolvers<void>()
        textTail = turn.promise
        try {
          await previous
          checkCurrent()
          assertProject()
          if (control.aborted) throw new FdTextWriteFailure('not-published', 'FS_ABORTED')
          if (textUnknown) throw new FdTextWriteFailure('not-published', 'FS_IO_ERROR')
          try {
            const value = await this.withSlot(false,
              client => client.writeText(project, path, content, expected, this.config.maxReadBytes, control))
            const consumed = Promise.withResolvers<void>()
            // A native write waits for actual publication facts even if its queue observer has left.
            answer.resolve({ value: { ...value, version: FsVersion(value.version) }, release: consumed.resolve })
            await consumed.promise
          } catch (error) {
            if (error instanceof FilesFailure) throw new FdTextWriteFailure('not-published', 'FS_IO_ERROR', undefined, { cause: error })
            if (!(error instanceof FdTextWriteFailure) || error.outcome === 'unknown') {
              textUnknown = true
              answer.reject(error)
              turn.resolve()
              console.error('Cloud text publication or cleanup is unconfirmed; '
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
      }, signal)
      void work.then((result) => { result.release() }, (error: unknown) => {
        if (!invoked) answer.reject(signal?.aborted
          ? new FdTextWriteFailure('not-published', 'FS_ABORTED', undefined, { cause: error }) : error)
      })
      return answer.promise
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
        try { assertContentAvailable() } catch (error) { throw new FsError('ABI8 content capability is unavailable.', 'FS_PERMISSION_DENIED', { cause: error }) }
        if (this.config.content === undefined) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
        return this.config.content
      }
      const contentBudget = (path: string, resultBytes: number, entries = 0): number => {
        const bytes = pathBytes(path) + 4 * Buffer.byteLength(project.rootPath) + 12 * (this.config.maxPathBytes + 1)
          + 8 * resultBytes + entries * (2048 + 8 * (Buffer.byteLength(path) + this.config.maxPathBytes + 128))
          + 4 * this.config.replyOverheadBytes
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.config.maxResidentBytesPerLane) throw new FdWorkerFailure('FS_TOO_LARGE')
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
        || grant.parent.rootInode !== fixedRoot.rootInode || grant.parent.rootMountId !== fixedRoot.rootMountId) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
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
      ): Promise<NativeTextFileSystemConstructor> => {
        checkCurrent()
        await projectRoot(workspace)
        return createTextProjectFileSystem({ binding, bootstrapWorkspace: workspace, resolveProject, assertInstalled,
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
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > this.config.maxReadBytes) throw new FdWorkerFailure('FS_TOO_LARGE')
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

  private probeOperation<T>(work: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertHealthy()
    const storage = this.config.staticStorage
    if (storage === undefined) throw new FilesFailure('files/prerequisite-missing', 'files root has no static probe configuration')
    if (this.rootOperation !== undefined) throw new FilesFailure('cloud/capacity', 'files root probe is still active')
    const controller = new AbortController()
    const observed = Promise.withResolvers<T>()
    const actual = this.withSlot(false, client => work(client, controller.signal))
    const completion = Promise.withResolvers<void>()
    const operation = { id: randomUUID() as OperationId, settled: completion.promise }
    this.rootOperation = operation
    const timer = setTimeout(() => {
      controller.abort()
      observed.reject(new FilesFailure('files/prerequisite-missing', 'files root probe observation expired; actual operation remains owned'))
    }, storage.probeTimeoutMs)
    const finish = (): void => {
      clearTimeout(timer)
      if (this.rootOperation === operation) this.rootOperation = undefined
      completion.resolve()
    }
    void actual.then((value) => { finish(); observed.resolve(value) }, (error: unknown) => { finish(); observed.reject(error) })
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
