/** Local device connector: explicit folder grants and status-first Docker command recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { deviceClaim, deviceJob, deviceContainerRegistration, deviceContainerRegistered,
  deviceStopObservation, deviceExecutionResult, deviceFinishRequest, deviceFinishReceipt,
  deviceClaimClosureRequest, deviceClaimClosureReceipt } from '@power-evolve/contracts/device-execution'
import { DeviceProcessLock } from './process-lock.ts'
import { OwnedDeviceContainer, ownedContainerOwner, ownedContainerReceipt } from './owned-container.ts'
import { LocalDeviceFiles } from './local-files.ts'
import { DeviceWriterCoordinator, deviceWriterOwner, type DeviceWriterLease, type DeviceWriterOwner } from './writer-coordinator.ts'
import { SealedDeviceCreations, sealedCreation } from './sealed-creations.ts'

const directoryIdentity = z.object({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict()
const directory = z.object({ id: z.uuid(), label: z.string(), path: z.string(), identity: directoryIdentity.optional() }).strict()
type AuthorizedDirectory = z.infer<typeof directory> & { identity: z.infer<typeof directoryIdentity> }
const deviceState = z.object({
  deviceId: z.uuid(), token: z.string().min(32), instanceId: z.uuid(), directories: z.array(directory),
}).strict()
type DeviceState = z.infer<typeof deviceState>
const journalEntry = z.object({
  id: z.uuid(), container: z.string(), stage: z.enum(['waiting', 'claiming', 'claimed', 'created', 'started', 'finished']),
  owner: ownedContainerOwner.optional(), receipt: ownedContainerReceipt.optional(),
  queuedJob: deviceJob.optional(),
  claimed: deviceClaim.optional(), processId: deviceClaim.shape.processId.optional(),
  dispatchId: deviceClaim.shape.dispatchId.optional(), stopRequestId: deviceFinishRequest.shape.requestId.optional(),
  claimClosureRequestId: deviceClaimClosureRequest.shape.requestId.optional(),
  claimClosureReceipt: deviceClaimClosureReceipt.optional(),
  imageId: ownedContainerReceipt.shape.imageId.optional(),
  stopObservation: deviceStopObservation.optional(),
  startedAt: z.number(), result: deviceExecutionResult.optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.owner && entry.owner.executionId !== entry.id
    || entry.receipt && (entry.receipt.owner.executionId !== entry.id
      || JSON.stringify(entry.receipt.owner) !== JSON.stringify(entry.owner)
      || entry.receipt.imageId !== entry.imageId)
    || entry.stopObservation && JSON.stringify(entry.stopObservation.receipt) !== JSON.stringify(entry.receipt)
    || entry.claimed && (entry.claimed.executionId !== entry.id || entry.claimed.processId !== entry.processId
      || entry.claimed.dispatchId !== entry.dispatchId || entry.claimed.digest !== entry.owner?.requestDigest)
    || entry.dispatchId && entry.owner?.creationId !== entry.dispatchId
    || entry.queuedJob && (entry.queuedJob.executionId !== entry.id || entry.queuedJob.state !== 'queued')
    || (entry.stage === 'waiting' || entry.stage === 'claiming') && (!entry.queuedJob || !entry.processId || entry.claimed || entry.dispatchId
      || entry.owner || entry.imageId || entry.receipt || entry.stopObservation || entry.stopRequestId || entry.result)
    || entry.claimClosureRequestId && entry.stage === 'waiting'
    || entry.claimClosureReceipt && (!['claiming', 'claimed', 'created'].includes(entry.stage)
      || entry.result || entry.stopObservation || entry.stopRequestId)
    || entry.claimClosureReceipt && (entry.claimClosureReceipt.requestId !== entry.claimClosureRequestId
      || entry.claimClosureReceipt.executionId !== entry.id || entry.claimClosureReceipt.processId !== entry.processId
      || entry.claimClosureReceipt.directoryId !== (entry.claimed ?? entry.queuedJob)?.directoryId
      || entry.claimClosureReceipt.digest !== (entry.claimed ?? entry.queuedJob)?.digest
      || entry.claimed && entry.claimClosureReceipt.dispatchId !== entry.claimed.dispatchId)) {
    ctx.addIssue({ code: 'custom', message: 'device_journal_identity_mismatch' })
  }
})
type JournalEntry = z.infer<typeof journalEntry>
type Job = z.infer<typeof deviceJob>

/** Profile-selected polling and loss-of-contact deadlines for the local worker. */
export interface DesktopWorkerOptions {
  pollMs: number
  contactGraceMs: number
  commandPollMs: number
  platformRequestTimeoutMs: number
  coordinationRoot: string
  pythonExecutable: string
  fileOperationTimeoutMs: number
}
function uncertain(): z.infer<typeof journalEntry>['result'] {
  return { state: 'uncertain', exitCode: null, stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false }
}
class DevicePlatformError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) { super(`platform_${status}`) }
}

/** A single local device process holds its credential and folder paths outside the cloud. */
export class DesktopWorker {
  private readonly statePath: string
  private readonly journalPath: string
  private state: DeviceState | null = null
  private readonly journal = new Map<string, JournalEntry>()
  private readonly processId = deviceClaim.shape.processId.parse(randomUUID())
  private processLock: DeviceProcessLock | null = null
  private initialization: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private readonly localActions = new Set<Promise<unknown>>()
  private actionTail: Promise<void> = Promise.resolve()
  private readonly stop = new AbortController()
  private polling: Promise<void> | null = null
  private active: Promise<void> | null = null
  private readonly jobs = new Map<string, Job>()
  private lastContact = Date.now()
  private notice = ''
  private readonly coordination: DeviceWriterCoordinator
  private readonly files: LocalDeviceFiles
  private readonly sealed: SealedDeviceCreations
  private writer: { owner: DeviceWriterOwner; lease: DeviceWriterLease } | null = null

  constructor(private readonly platformUrl: string, private readonly privateDir: string,
    private readonly image: string, private readonly options: DesktopWorkerOptions,
    private readonly containers: OwnedDeviceContainer) {
    this.statePath = join(privateDir, 'device.json')
    this.journalPath = join(privateDir, 'journal.json')
    this.coordination = new DeviceWriterCoordinator(options.coordinationRoot)
    this.files = new LocalDeviceFiles({ pythonExecutable: options.pythonExecutable, timeoutMs: options.fileOperationTimeoutMs })
    this.sealed = new SealedDeviceCreations(privateDir, () => this.assertOwned())
  }

  /** Acquire kernel ownership before loading the private credentials and journal.
   * @returns Shared initialization completion; failure releases owned descriptors.
   */
  init(): Promise<void> {
    if (this.stop.signal.aborted) return Promise.reject(new Error('device_closed'))
    return this.initialization ??= (async () => {
      const lock = await DeviceProcessLock.acquire(this.privateDir)
      this.processLock = lock
      try {
        try { this.state = deviceState.parse(JSON.parse(await readFile(this.statePath, 'utf8'))) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try {
          const entries = z.array(journalEntry).parse(JSON.parse(await readFile(this.journalPath, 'utf8')))
          for (const entry of entries) this.journal.set(entry.id, entry)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await lock.assertOwned()
      } catch (error) {
        this.processLock = null
        await lock.release()
        throw error
      }
    })()
  }

  private async assertOwned(): Promise<void> {
    if (!this.processLock) throw new Error('device_not_initialized')
    await this.processLock.assertOwned()
  }

  private localAction<T>(action: () => Promise<T>): Promise<T> {
    if (this.stop.signal.aborted) return Promise.reject(new Error('device_closed'))
    const pending = this.actionTail.then(async () => {
      if (this.stop.signal.aborted) throw new Error('device_closed')
      await this.assertOwned()
      return action()
    }).finally(() => this.localActions.delete(pending))
    this.actionTail = pending.then(() => undefined, () => undefined)
    this.localActions.add(pending)
    return pending
  }

  private async save(path: string, value: unknown): Promise<void> {
    await this.assertOwned()
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    await this.assertOwned()
    await rename(temporary, path)
    const parent = await open(dirname(path), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
  }
  private saveJournal(): Promise<void> { return this.save(this.journalPath, [...this.journal.values()]) }
  /** Read local authorization status, including private paths for the loopback UI only.
   * @returns Pairing, directory labels/paths, contact state and the last bounded diagnostic.
   */
  status(): unknown { return { paired: !!this.state, deviceId: this.state?.deviceId ?? null,
    directories: this.state?.directories.map(({ id, label, path }) => ({ directoryId: id, label, path })) ?? [],
    online: this.state !== null && Date.now() - this.lastContact < this.options.contactGraceMs, notice: this.notice } }

  private async call<T>(path: string, input: unknown, parser: z.ZodType<T>, token?: string): Promise<T> {
    const response = await fetch(new URL(path, this.platformUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input), signal: AbortSignal.timeout(this.options.platformRequestTimeoutMs),
    })
    if (!response.ok) {
      let body: unknown
      try { body = await response.json() }
      catch (_invalidErrorBody) { throw new DevicePlatformError(response.status, undefined) }
      const parsed = z.object({ error: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u) }).strict().safeParse(body)
      throw new DevicePlatformError(response.status, parsed.success ? parsed.data.error : undefined)
    }
    return parser.parse(await response.json())
  }

  /** Enroll this unpaired worker and persist its private credential under kernel ownership.
   * @param code One-use owner-issued pairing code.
   * @param name Device label shown to its owner.
   * @returns Local authorization status, excluding the private token.
   */
  pair(code: string, name: string): Promise<unknown> { return this.localAction(() => this.pairLocal(code, name)) }
  private async pairLocal(code: string, name: string): Promise<unknown> {
    if (this.state) throw new Error('device_already_paired')
    const instanceId = randomUUID()
    const result = await this.call('/devices/enroll', { code, name, instanceId },
      z.object({ deviceId: z.uuid(), token: z.string().min(32) }).strict())
    this.state = deviceState.parse({ ...result, instanceId, directories: [] })
    await this.save(this.statePath, this.state)
    this.lastContact = Date.now()
    return this.status()
  }

  /** Register a project selected by the local OS user; only its ID and label reach the platform.
   * @param path Explicitly authorized absolute project directory.
   * @returns Local grant identity, label and path.
   */
  authorize(path: string): Promise<unknown> { return this.localAction(() => this.authorizeLocal(path)) }
  private async authorizeLocal(path: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    if (!isAbsolute(path)) throw new Error('directory_must_be_absolute')
    const actual = await realpath(path)
    const privateRoot = await realpath(this.privateDir), sharedRoot = resolve(this.options.coordinationRoot)
    const overlaps = (protectedRoot: string): boolean => actual === protectedRoot
      || actual.startsWith(protectedRoot + '/') || protectedRoot.startsWith(actual + '/')
    if (actual === '/' || actual === await realpath(homedir()) || /[:,]/.test(actual)
      || overlaps(privateRoot) || overlaps(sharedRoot)) {
      throw new Error('directory_not_allowed')
    }
    const identity = await this.files.inspect(actual)
    const previous = this.state.directories.find(item => item.path === actual)
    if (previous && (!previous.identity || this.sameDirectory(previous.identity, identity))) {
      // Upgrading a legacy grant requires this explicit local authorization action.
      previous.identity = identity
      await this.save(this.statePath, this.state)
      return { directoryId: previous.id, label: previous.label, path: previous.path }
    }
    const label = basename(actual)
    const result = await this.call('/devices/agent/directory', { label },
      z.object({ directoryId: z.uuid() }).strict(), this.state.token)
    this.state.directories.push({ id: result.directoryId, label, path: actual, identity })
    await this.save(this.statePath, this.state)
    return { directoryId: result.directoryId, label, path: actual }
  }

  private authorizedDirectory(directoryId: string): AuthorizedDirectory {
    const folder = this.state?.directories.find(item => item.id === directoryId)
    if (!folder) throw new Error('directory_not_authorized')
    if (!folder.identity) throw new Error('directory_requires_local_reauthorization')
    return { ...folder, identity: folder.identity }
  }

  private sameDirectory(left: z.infer<typeof directoryIdentity>, right: z.infer<typeof directoryIdentity>): boolean {
    return left.dev === right.dev && left.ino === right.ino
  }

  private async inspectDirectory(folder: AuthorizedDirectory, relative = '.'): Promise<void> {
    const current = await this.files.inspect(folder.path, relative || '.')
    if (!this.sameDirectory(folder.identity, current)) throw new Error('directory_changed')
  }

  /** Create one local file from an explicit cloud transfer while this worker has no journaled writer.
   * @param directoryId Registered local directory identity.
   * @param cloudPath Owned cloud workspace source.
   * @param localPath Relative new destination; existing files are refused.
   * @returns Transfer metadata after the bounded digest-checked write.
   */
  importFile(directoryId: string, cloudPath: string, localPath: string): Promise<unknown> {
    return this.localAction(() => this.importLocal(directoryId, cloudPath, localPath))
  }
  private async importLocal(directoryId: string, cloudPath: string, localPath: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    if (this.journal.size > 0) throw new Error('device_directory_busy')
    const state = this.state, folder = this.authorizedDirectory(directoryId)
    return this.coordination.transfer(async fd => {
      await this.inspectDirectory(folder)
      const cloud = await this.call('/devices/agent/files/read', { directoryId, path: cloudPath },
        z.object({ data: z.string().max(2_800_000), revision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), state.token)
      const bytes = Buffer.from(cloud.data, 'base64')
      if (bytes.length > 2 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== cloud.revision) {
        throw new Error('cloud_file_digest_mismatch')
      }
      await this.files.create(folder.path, folder.identity, localPath, cloud.data, fd)
      return { cloudPath, localPath, size: bytes.length, revision: cloud.revision }
    })
  }

  /** Transfer a bounded local file explicitly while this worker has no journaled writer.
   * @param directoryId Registered local directory identity.
   * @param localPath Relative local source.
   * @param cloudPath Owned cloud workspace destination.
   * @param requestId Stable platform file request identity.
   * @returns Platform file receipt.
   */
  exportFile(directoryId: string, localPath: string, cloudPath: string, requestId: string): Promise<unknown> {
    return this.localAction(() => this.exportLocal(directoryId, localPath, cloudPath, requestId))
  }
  private async exportLocal(directoryId: string, localPath: string, cloudPath: string, requestId: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    if (this.journal.size > 0) throw new Error('device_directory_busy')
    const state = this.state, folder = this.authorizedDirectory(directoryId)
    return this.coordination.transfer(async fd => {
      const file = await this.files.read(folder.path, folder.identity, localPath, fd)
      return this.call('/devices/agent/files/put',
        { directoryId, requestId, path: cloudPath, data: file.base64 },
        z.object({ path: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), state.token)
    })
  }

  /** Start one poller only after the private journal has kernel ownership. */
  start(): void {
    if (!this.processLock) throw new Error('device_not_initialized')
    if (this.stop.signal.aborted) throw new Error('device_closed')
    this.polling ??= this.poll()
  }

  /**
   * Close admission and await local actions and the current bounded stop attempt. Unconfirmed
   * Docker writers remain in the journal; closing this process does not certify their termination.
   * @returns Quiescence of this worker and release of its kernel journal lock.
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stop.abort()
      await this.files.close()
      await this.initialization?.catch((_startupFailure: unknown) => {
        // init() releases its descriptors before reporting a failed startup.
      })
      await Promise.allSettled([...this.localActions, this.polling, this.active])
      const writer = this.writer
      this.writer = null
      const lock = this.processLock
      this.processLock = null
      const released = await Promise.allSettled([this.sealed.close(), writer?.lease.release(), lock?.release()])
      const failures = released.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'device_lock_release_failed')
    })()
  }

  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        await this.assertOwned()
        if (this.state) {
          await this.sealed.reconcileOne({ deviceId: ownedContainerOwner.shape.deviceId.parse(this.state.deviceId),
            enrollmentId: ownedContainerOwner.shape.enrollmentId.parse(this.state.instanceId) }, this.containers, id => this.journal.has(id))
          if (!this.active) {
            for (const entry of this.journal.values()) {
              if (entry.stage === 'waiting') {
                this.activate(this.resumeWaiting(this.state, entry))
                break
              }
              if (entry.stage === 'claiming') {
                this.activate(entry.processId !== this.processId
                  ? this.closeColdClaim(this.state, entry) : this.resumeClaim(this.state, entry))
                break
              }
              await this.recover(this.state, entry)
              if (this.stop.signal.aborted) break
            }
          }
          if (this.stop.signal.aborted) break
          const result = await this.call('/devices/agent/jobs', { instanceId: this.state.instanceId },
            z.object({ jobs: z.array(deviceJob).max(20), directories: z.array(z.uuid()) }).strict(), this.state.token)
          this.lastContact = Date.now()
          if (!this.active && this.journal.size === 0) this.notice = ''
          const allowed = new Set(result.directories)
          // Retain original directory metadata while its journal still requires reconciliation.
          if (!this.active && this.journal.size === 0 && this.state.directories.some(item => !allowed.has(item.id))) {
            this.state.directories = this.state.directories.filter(item => allowed.has(item.id))
            await this.save(this.statePath, this.state)
          }
          this.jobs.clear()
          for (const job of result.jobs) this.jobs.set(job.executionId, job)
          if (!this.active && this.journal.size === 0 && this.localActions.size === 0 && !this.stop.signal.aborted) {
            const next = result.jobs[0]
            if (next) this.activate(this.run(next))
          }
        }
      } catch (error) { this.notice = error instanceof Error ? error.message : 'platform_unavailable' }
      try { await delay(this.options.pollMs, undefined, { signal: this.stop.signal }) }
      catch (_aborted) { /* close() waits for the current bounded command operation. */ }
    }
  }

  private activate(operation: Promise<void>): void {
    const running = operation.catch((error: unknown) => {
      this.notice = error instanceof Error ? error.message : 'device_error'
    }).finally(() => { if (this.active === running) this.active = null })
    this.active = running
  }

  private requestDigest(state: DeviceState, job: Pick<z.infer<typeof deviceClaim>, 'command' | 'cwd' | 'timeoutMs' | 'directoryId'>): string {
    return createHash('sha256').update(JSON.stringify({ command: job.command, cwd: job.cwd,
      timeoutMs: job.timeoutMs, deviceId: state.deviceId, directoryId: job.directoryId })).digest('hex')
  }

  private writerOwner(state: DeviceState, entry: JournalEntry): DeviceWriterOwner {
    const request = entry.claimed ?? entry.queuedJob
    if (!request || !entry.processId || request.digest !== this.requestDigest(state, request)) {
      throw new Error('device_writer_identity_missing')
    }
    return deviceWriterOwner.parse({ kind: 'command', deviceId: state.deviceId,
      enrollmentId: state.instanceId, executionId: entry.id, processId: entry.processId,
      directoryId: request.directoryId, requestDigest: request.digest })
  }

  private async takeWriter(state: DeviceState, entry: JournalEntry): Promise<DeviceWriterLease> {
    const owner = this.writerOwner(state, entry)
    if (this.writer) {
      if (JSON.stringify(this.writer.owner) !== JSON.stringify(owner)) throw new Error('device_writer_busy')
      return this.writer.lease
    }
    const lease = await this.coordination.command(owner)
    this.writer = { owner, lease }
    return lease
  }

  private async closeColdClaim(state: DeviceState, entry: JournalEntry): Promise<void> {
    if (entry.stage !== 'claiming' || !entry.processId || entry.processId === this.processId || !entry.queuedJob
      || entry.owner || entry.imageId || entry.claimed || entry.dispatchId || entry.receipt
      || entry.stopObservation || entry.stopRequestId || entry.result) throw new Error('device_claiming_requires_review')
    const owner = this.writerOwner(state, entry)
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
    entry.claimClosureRequestId ??= deviceClaimClosureRequest.shape.requestId.parse(randomUUID())
    if (!entry.claimClosureReceipt) {
      const writer = await this.takeWriter(state, entry)
      await writer.verifyUncapturedClaim()
      if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
    }
    // Sync the stable identity before every first/retried request, including an earlier failed save.
    await this.saveJournal()
    const input = deviceClaimClosureRequest.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: entry.processId, directoryId: entry.queuedJob.directoryId, digest: entry.queuedJob.digest,
      requestId: entry.claimClosureRequestId })
    const accepted = entry.claimClosureReceipt ?? await this.call('/devices/agent/claim/close', input, deviceClaimClosureReceipt, state.token)
    if (accepted.deviceId !== owner.deviceId || accepted.instanceId !== input.instanceId
      || accepted.executionId !== input.executionId || accepted.processId !== input.processId
      || accepted.directoryId !== input.directoryId || accepted.digest !== input.digest || accepted.requestId !== input.requestId) {
      throw new Error('device_claim_closure_identity_mismatch')
    }
    entry.claimClosureReceipt = accepted
    // A response held only in memory cannot release durable admission, even on the next poll.
    await this.saveJournal()
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
    if (this.writer) {
      if (JSON.stringify(this.writer.owner) !== JSON.stringify(owner)) throw new Error('device_writer_busy')
      await this.writer.lease.release()
      this.writer = null
    }
    await this.coordination.retireClaim(owner, accepted)
    this.journal.delete(entry.id)
    try { await this.saveJournal() }
    catch (error) { this.journal.set(entry.id, entry); throw error }
  }

  private async observeStopped(entry: JournalEntry): Promise<boolean> {
    if (!entry.receipt) return false
    const observed = await this.containers.inspect(entry.receipt)
    if (!observed || observed.Running) return false
    const stopped = deviceStopObservation.safeParse({ ...observed, receipt: entry.receipt })
    if (!stopped.success) return false
    entry.stopObservation = stopped.data
    await this.saveJournal()
    return true
  }

  private originalClaim(state: DeviceState, entry: JournalEntry): z.infer<typeof deviceClaim> {
    if (!entry.owner || !entry.claimed || !entry.processId || !entry.dispatchId
      || entry.owner.deviceId !== state.deviceId || entry.owner.enrollmentId !== state.instanceId) {
      throw new Error('device_legacy_journal_requires_review')
    }
    if (entry.claimed.executionId !== entry.id || entry.claimed.processId !== entry.processId
      || entry.claimed.dispatchId !== entry.dispatchId || entry.owner.creationId !== entry.dispatchId
      || entry.claimed.digest !== entry.owner.requestDigest
      || entry.claimed.digest !== this.requestDigest(state, entry.claimed)) throw new Error('device_dispatch_changed')
    return entry.claimed
  }

  private async register(state: DeviceState, entry: JournalEntry, existing = false): Promise<boolean> {
    const claimed = this.originalClaim(state, entry)
    if (!entry.receipt) throw new Error('device_container_identity_missing')
    const input = deviceContainerRegistration.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: claimed.processId, dispatchId: claimed.dispatchId, receipt: entry.receipt })
    const accepted = await this.call(existing ? '/devices/agent/registered' : '/devices/agent/register', input, deviceContainerRegistered, state.token)
    if (accepted.executionId !== entry.id || accepted.dispatchId !== claimed.dispatchId
      || JSON.stringify(accepted.receipt) !== JSON.stringify(entry.receipt)) throw new Error('device_registration_identity_mismatch')
    if (existing && accepted.canStart) throw new Error('device_recovery_start_permission')
    return accepted.canStart
  }

  private async sealCreation(state: DeviceState, entry: JournalEntry): Promise<void> {
    const claimed = this.originalClaim(state, entry), owner = this.writerOwner(state, entry)
    if (!['claimed', 'created'].includes(entry.stage) || entry.result || entry.stopObservation || entry.stopRequestId) {
      throw new Error('device_creation_requires_review')
    }
    if (!entry.claimClosureReceipt) {
      if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
      await (await this.takeWriter(state, entry)).verifyCreation(entry.receipt)
      entry.claimClosureRequestId ??= deviceClaimClosureRequest.shape.requestId.parse(randomUUID())
    }
    await this.saveJournal()
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
    const input = deviceClaimClosureRequest.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: claimed.processId, directoryId: claimed.directoryId, digest: claimed.digest, requestId: entry.claimClosureRequestId })
    const closure = entry.claimClosureReceipt ?? await this.call('/devices/agent/claim/close', input, deviceClaimClosureReceipt, state.token)
    if (closure.deviceId !== owner.deviceId || closure.instanceId !== input.instanceId || closure.executionId !== entry.id
      || closure.processId !== claimed.processId || closure.directoryId !== claimed.directoryId || closure.digest !== claimed.digest
      || closure.requestId !== input.requestId || closure.dispatchId !== claimed.dispatchId) throw new Error('device_claim_closure_identity_mismatch')
    entry.claimClosureReceipt = closure
    await this.saveJournal()
    await this.sealed.preserve(sealedCreation.parse({ closure, name: entry.container, owner: entry.owner,
      imageId: entry.imageId ?? null, ...(entry.receipt ? { receipt: entry.receipt } : {}), removalConfirmed: false }))
    const progress = await this.sealed.cleanup(closure.executionId, { deviceId: closure.deviceId, enrollmentId: closure.instanceId }, this.containers)
    if (progress.receipt && (!progress.removalConfirmed || !progress.observation)) throw new Error('device_creation_cleanup_unconfirmed')
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim_closure')
    if (this.writer) { await this.writer.lease.release(); this.writer = null }
    await this.coordination.retireCreation(owner, closure, progress.receipt && progress.observation
      ? { receipt: progress.receipt, observation: progress.observation } : undefined)
    this.journal.delete(entry.id)
    try { await this.saveJournal() }
    catch (error) { this.journal.set(entry.id, entry); throw error }
  }

  private async recover(state: DeviceState, entry: JournalEntry): Promise<void> {
    this.originalClaim(state, entry)
    if (['claimed', 'created'].includes(entry.stage) && !entry.result && !entry.stopObservation && !entry.stopRequestId) {
      try { await this.sealCreation(state, entry); return }
      catch (error) {
        if (!(error instanceof DevicePlatformError) || error.status !== 409 || error.code !== 'device_claim_start_unconfirmed') throw error
      }
    }
    const writer = await this.takeWriter(state, entry)
    if (!entry.owner || !entry.imageId) throw new Error('device_container_identity_missing')
    if (!entry.receipt) {
      const receipt = await this.containers.findCreated({ name: entry.container, imageId: entry.imageId, owner: entry.owner })
      if (!receipt) throw new Error('device_container_identity_missing')
      entry.receipt = receipt
      await this.saveJournal()
    }
    await writer.capture(entry.receipt)
    let registrationFailure: unknown
    try { await this.register(state, entry, true) }
    catch (error: unknown) { registrationFailure = error }
    // A failed remote registration cannot prevent this Device from stopping its exact old writer.
    const observed = await this.containers.inspect(entry.receipt)
    if (observed?.Running) {
      delete entry.stopObservation
      entry.result = uncertain()
      await this.saveJournal()
      try { await this.containers.stop(entry.receipt) }
      catch (_stopUnconfirmed) { /* Only a subsequent exact-ID observation can record termination. */ }
    }
    if (!entry.stopObservation && !await this.observeStopped(entry)) throw new Error('device_stop_observation_missing')
    // A cold recovery never starts an old created container or repeats its command.
    entry.result ??= uncertain()
    entry.stage = 'finished'
    await this.saveJournal()
    if (registrationFailure !== undefined) throw registrationFailure
    await this.report(state, entry)
  }

  private async run(job: Job): Promise<void> {
    const state = this.state
    if (!state) return
    const id = job.executionId, name = `pe-local-${id.replaceAll('-', '')}`
    if (this.journal.has(id)) throw new Error('device_recovery_required')
    if (job.state !== 'queued') {
      this.journal.set(id, { id, container: name, stage: 'finished', startedAt: Date.now(), result: uncertain() })
      await this.saveJournal()
      this.notice = 'device_container_identity_missing'
      return
    }
    const entry: JournalEntry = { id, container: name, queuedJob: job, processId: this.processId,
      stage: 'waiting', startedAt: Date.now() }
    this.journal.set(id, entry)
    // Waiting records precede global admission; they have never submitted a Platform claim.
    await this.saveJournal()
    await this.resumeWaiting(state, entry)
  }

  private async resumeWaiting(state: DeviceState, entry: JournalEntry): Promise<void> {
    if (entry.stage !== 'waiting' || !entry.processId || !entry.queuedJob) throw new Error('device_waiting_identity_missing')
    if (entry.processId !== this.processId) {
      // A durable waiting intent cannot have reached claim; first retire its exact old admission.
      const previous = await this.takeWriter(state, entry)
      await previous.abandonWaiting()
      await previous.release()
      this.writer = null
      entry.processId = this.processId
      await this.saveJournal()
    }
    const folder = this.authorizedDirectory(entry.queuedJob.directoryId)
    await this.inspectDirectory(folder, entry.queuedJob.cwd)
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim')
    await this.takeWriter(state, entry)
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim')
    entry.stage = 'claiming'
    await this.resumeClaim(state, entry)
  }

  private async resumeClaim(state: DeviceState, entry: JournalEntry): Promise<void> {
    const job = entry.queuedJob, id = entry.id, name = entry.container
    if (entry.stage !== 'claiming' || entry.processId !== this.processId || !job
      || entry.claimClosureRequestId || entry.claimClosureReceipt) throw new Error('device_claiming_requires_review')
    if (job.digest !== this.requestDigest(state, job)) throw new Error('device_dispatch_changed')
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim')
    const writer = await this.takeWriter(state, entry)
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim')
    // Every outbound attempt follows a synced claiming generation, including recovery after a failed save.
    await this.saveJournal()
    const claimed = await this.call('/devices/agent/claim', { instanceId: state.instanceId, executionId: id,
      processId: entry.processId }, deviceClaim, state.token)
    if (claimed.executionId !== id || claimed.directoryId !== job.directoryId || claimed.command !== job.command
      || claimed.cwd !== job.cwd || claimed.timeoutMs !== job.timeoutMs || claimed.digest !== job.digest
      || claimed.processId !== this.processId || claimed.digest !== this.requestDigest(state, claimed)) throw new Error('device_dispatch_changed')
    const owner = ownedContainerOwner.parse({ deviceId: state.deviceId, enrollmentId: state.instanceId,
      executionId: id, creationId: claimed.dispatchId, requestDigest: claimed.digest })
    entry.owner = owner
    entry.claimed = claimed
    entry.dispatchId = claimed.dispatchId
    entry.stage = 'claimed'
    await this.saveJournal()
    const folder = this.authorizedDirectory(claimed.directoryId), root = folder.path
    await this.inspectDirectory(folder, claimed.cwd)
    entry.imageId = await this.containers.resolveImage(this.image)
    await this.saveJournal()
    if (this.stop.signal.aborted) throw new Error('device_closed_before_create')
    await this.inspectDirectory(folder, claimed.cwd)
    entry.receipt = await this.containers.create({ name, owner, imageId: entry.imageId,
      options: ['--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--memory', '768m', '--cpus', '1', '--user', '1000:1000',
        '--mount', `type=bind,source=${root},target=/workspace`,
        '--workdir', `/workspace${claimed.cwd ? '/' + claimed.cwd : ''}`, '--entrypoint', '/bin/bash'],
      command: ['-lc', claimed.command] })
    entry.stage = 'created'
    await this.saveJournal()
    await writer.capture(entry.receipt)
    const receipt = entry.receipt
    const canStart = await this.register(state, entry)
    // Persist the intent before start: a lost response or a crash cannot authorize a second start.
    if (!canStart || this.stop.signal.aborted || this.jobs.get(id)?.cancelRequested) {
      entry.result = uncertain()
    } else {
      entry.stage = 'started'
      entry.startedAt = Date.now()
      await this.saveJournal()
      try {
        if (this.stop.signal.aborted || this.jobs.get(id)?.cancelRequested) entry.result = uncertain()
        else {
          await this.inspectDirectory(folder, claimed.cwd)
          await this.containers.start(receipt)
        }
      }
      catch (_startUnconfirmed) {
        const observed = await this.containers.inspect(receipt)
        if (!observed || observed.Status === 'created') entry.result = uncertain()
      }
    }
    let timedOut = false, cancelled = false, contactLost = false
    while (!entry.result) {
      const observed = await this.containers.inspect(receipt)
      if (!observed) { entry.result = uncertain(); break }
      if (!observed.Running) break
      const current = this.jobs.get(id)
      timedOut ||= Date.now() - entry.startedAt > claimed.timeoutMs
      cancelled ||= !!current?.cancelRequested || (!current && Date.now() - this.lastContact < this.options.contactGraceMs)
        || this.stop.signal.aborted
      contactLost ||= Date.now() - this.lastContact > this.options.contactGraceMs
      if (timedOut || cancelled || contactLost) {
        try { await this.containers.stop(receipt) }
        catch (_stopUnconfirmed) { /* An acknowledgement cannot replace the next observation. */ }
        if (!await this.observeStopped(entry)) { entry.result = uncertain(); break }
        break
      }
      await delay(this.options.commandPollMs)
    }
    const stopped = entry.stopObservation !== undefined || await this.observeStopped(entry)
    if (!entry.result) {
      if (!stopped) entry.result = uncertain()
      else {
        const output = await this.containers.logs(receipt)
        entry.result = { state: contactLost ? 'uncertain' : cancelled ? 'cancelled'
          : timedOut || entry.stopObservation!.ExitCode !== 0 ? 'failed' : 'succeeded',
          exitCode: entry.stopObservation!.ExitCode, ...output, timedOut }
      }
    }
    entry.stage = 'finished'
    await this.saveJournal()
    if (stopped) await this.report(state, entry)
    else this.notice = 'device_stop_observation_missing'
  }

  private async report(state: DeviceState, entry: JournalEntry): Promise<void> {
    const claimed = this.originalClaim(state, entry)
    if (!entry.result || !entry.receipt || !entry.stopObservation) throw new Error('device_stop_observation_missing')
    const observed = await this.containers.inspect(entry.receipt)
    if (observed?.Running) {
      delete entry.stopObservation
      entry.result = uncertain()
      await this.saveJournal()
      throw new Error('device_container_running')
    }
    if (!entry.stopRequestId) {
      entry.stopRequestId = deviceFinishRequest.shape.requestId.parse(randomUUID())
      await this.saveJournal()
    }
    const writer = await this.takeWriter(state, entry)
    await writer.recordStop(entry.stopObservation, entry.stopRequestId)
    const input = deviceFinishRequest.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: claimed.processId, dispatchId: claimed.dispatchId, requestId: entry.stopRequestId,
      observation: entry.stopObservation, result: entry.result })
    const accepted = await this.call('/devices/agent/finish', input, deviceFinishReceipt, state.token)
    if (accepted.executionId !== entry.id || accepted.dispatchId !== claimed.dispatchId
      || accepted.requestId !== entry.stopRequestId) throw new Error('device_result_identity_mismatch')
    if (observed) await this.containers.remove(entry.receipt)
    if (!await writer.settle(accepted)) {
      this.notice = 'device_unknown_result_requires_approval'
      return
    }
    await writer.release()
    this.writer = null
    // Missing is acceptable only after an exact stop observation was saved before removal.
    this.journal.delete(entry.id)
    try { await this.saveJournal() }
    catch (error) { this.journal.set(entry.id, entry); throw error }
  }
}
