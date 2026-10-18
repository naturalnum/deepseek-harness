/** Root-owned prestarted slots; tasks reuse workers and never allocate a replacement on failure. */
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { isAbsolute } from 'node:path'
import type { AccountBinding, DrainParticipant, OperationId, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FilesLimits } from './types.ts'
import type { FdWorkerInput, FdRootIdentity } from './worker-protocol.ts'
import type { FsInfo } from '@deepseek-ai/dsh-fs'
import { createFixedRootReader, decodeTextStream, nativeInfo } from './read-only.ts'
import type { FixedRootReader } from './read-only.ts'
import type { FdByteStream } from './worker-client.ts'
import type { FdMetadata } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'
import { FilesWorkOwner } from './work-owner.ts'
import { FdWorkerClient, FdWorkerFailure } from './worker-client.ts'
import { FilesFailure } from './error.ts'
import { createDirectoryReadPort } from './directory.ts'
import type { DirectoryReadPort } from './directory.ts'
import type { DirectoryIntent } from './directory-budget.ts'
import { directoryWorkBudget } from './directory-budget.ts'
import type { DirectoryObservation, DirectoryPrepareOutcome } from './directory-responsibility.ts'
import { createS2ProjectPort } from './s2-project.ts'
import { createBoundWorkspaceRegistry } from './workspace-adapter.ts'
import { RootStorageOwner } from './storage-owner.ts'
import type { StaticStorageConfig } from './storage-types.ts'
import { staticStorageReservation } from './storage-probe.ts'

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
      bind: (binding, root, current) => this.bind(binding, root, current),
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
  bind(binding: AccountBinding, root: FdRootIdentity, assertCurrent: () => void): PoolReadPort {
    this.assertHealthy()
    if (root.rootPath.length > this.config.maxPathBytes || !isAbsolute(root.rootPath)
      || root.rootPath.includes('\0') || root.rootPath.split('/').includes('..')
      || Buffer.byteLength(root.rootPath) > this.config.maxPathBytes
      || !/^\d{1,20}$/.test(root.rootDevice) || !/^\d{1,20}$/.test(root.rootInode)
      || (root.rootMountId !== undefined && !/^[1-9]\d{0,19}$/.test(root.rootMountId))) {
      throw new FdWorkerFailure('FS_PERMISSION_DENIED')
    }
    const fixedRoot = Object.freeze({ ...root })
    const port = this.owner.bind(binding, assertCurrent)
    const checkCurrent = (): void => { this.assertHealthy(); port.assertCurrent() }
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
    const stat = async (path: string, signal?: AbortSignal): Promise<ResidentResult<FdMetadata | undefined>> => {
      const reservation = pathBytes(path) + 4 * (256 + 64) + this.config.replyOverheadBytes
      return await run(reservation, (client, control) => client.stat(fixedRoot, path, control), signal)
    }
    const streamText = async (path: string, signal?: AbortSignal): Promise<AsyncIterable<string>> => {
      checkCurrent()
      if (signal?.aborted) throw new FdWorkerFailure('FS_ABORTED')
      // Includes raw worker/transfer buffers, decoder state, UTF-16 text and a held delivered chunk.
      const reservation = pathBytes(path) + 8 * (this.config.readChunkBytes + 4) + this.config.replyOverheadBytes
      const maxBytes = this.config.maxReadBytes
      const chunkBytes = this.config.readChunkBytes
      return await Promise.resolve((async function* (): AsyncIterable<string> {
        const started = Promise.withResolvers<FdByteStream>()
        const consumed = Promise.withResolvers<void>()
        const caller = new AbortController()
        const control = signal === undefined ? caller.signal : AbortSignal.any([caller.signal, signal])
        const work = run(reservation, async (client, actualControl) => {
          const stream = client.stream(fixedRoot, path, maxBytes, chunkBytes, actualControl)
          started.resolve(stream)
          try { await stream.finished } finally { await consumed.promise }
        }, control)
        void work.then((result) => { result.release() }, (error: unknown) => { started.reject(error) })
        try {
          const stream = await started.promise
          yield* decodeTextStream(stream, () => {
            checkCurrent()
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
    const directory = createDirectoryReadPort(fixedRoot.rootPath, {
      maxPathBytes: this.config.maxPathBytes, replyOverheadBytes: this.config.replyOverheadBytes, assertCurrent: checkCurrent,
      inspect: (relativePath, reservedBytes, signal) => run(reservedBytes + 4 * (fixedRoot.rootMountId?.length ?? 0),
        (client, control) => client.directory(fixedRoot, relativePath, this.config.maxPathBytes, control), signal),
    })
    const derivePreparedLeaf = (grant: IsolatedLeafGrant): PreparedLeafPort => {
      checkCurrent()
      if (grant.binding !== binding
        || grant.parent.rootPath !== fixedRoot.rootPath || grant.parent.rootDevice !== fixedRoot.rootDevice
        || grant.parent.rootInode !== fixedRoot.rootInode || grant.parent.rootMountId !== fixedRoot.rootMountId) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      const intent: DirectoryIntent = Object.freeze({ parent: fixedRoot, leaf: grant.leaf })
      directoryWorkBudget(intent, this.config)
      const exclusive = grant.assertExclusive
      const deployment = grant.backend === 'root-owned-isolated-ext4' ? grant.assertDeployment : undefined
      const backend = grant.backend === 'root-owned-isolated-ext4' ? 'ext4' : 'tmpfs'
      if (backend === 'ext4' && fixedRoot.rootMountId === undefined) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      const assertWindow = (): void => { deployment?.(); exclusive() }
      assertWindow()
      return Object.freeze({ prepare: () => {
        checkCurrent()
        assertWindow()
        const owned = port.prepareDirectory(intent, this.config, async (control, fixed): Promise<DirectoryPrepareOutcome> => {
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
        return createBoundWorkspaceRegistry({
          directory, defaultGrant, assertCurrent: assertGraph, assertWindow,
          prepareDefault: () => defaultPort.prepare(),
          prepareRegistration: (grant) => {
            assertWindow()
            const work = (grant === defaultGrant ? defaultPort : derivePreparedLeaf(grant)).prepare()
            const record = port.captureRegistration(work.observation)
            const assertCandidate = grant.assertExclusive
            return { work, record, assertWindow: () => {
              assertWindow(); assertCandidate()
              if (grant.backend === 'root-owned-isolated-ext4') grant.assertDeployment()
            } }
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
          identity: async (record) => {
            assertWindow()
            const held = await stat(record.intent.leaf)
            try {
              assertWindow()
              const value = held.value
              if (value?.type !== 'directory') throw new FdWorkerFailure('FS_PERMISSION_DENIED')
              // FdWorkerClient validates this private backend identity; public FsInfo.version stays opaque.
              const separator = value.identity.indexOf(':')
              return Object.freeze({ device: value.identity.slice(0, separator), inode: value.identity.slice(separator + 1) })
            } finally { held.release() }
          },
        })
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
