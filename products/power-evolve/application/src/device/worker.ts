/** Local device connector: explicit folder grants and status-first Docker command recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { deviceClaim, deviceJob, deviceContainerRegistration, deviceContainerRegistered,
  deviceStopObservation, deviceExecutionResult, deviceFinishRequest, deviceFinishReceipt } from '@power-evolve/contracts/device-execution'
import { DeviceProcessLock } from './process-lock.ts'
import { OwnedDeviceContainer, ownedContainerOwner, ownedContainerReceipt } from './owned-container.ts'

const directory = z.object({ id: z.uuid(), label: z.string(), path: z.string() }).strict()
const deviceState = z.object({
  deviceId: z.uuid(), token: z.string().min(32), instanceId: z.uuid(), directories: z.array(directory),
}).strict()
type DeviceState = z.infer<typeof deviceState>
const journalEntry = z.object({
  id: z.uuid(), container: z.string(), stage: z.enum(['claiming', 'claimed', 'created', 'started', 'finished']),
  owner: ownedContainerOwner.optional(), receipt: ownedContainerReceipt.optional(),
  queuedJob: deviceJob.optional(),
  claimed: deviceClaim.optional(), processId: deviceClaim.shape.processId.optional(),
  dispatchId: deviceClaim.shape.dispatchId.optional(), stopRequestId: deviceFinishRequest.shape.requestId.optional(),
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
    || entry.stage === 'claiming' && (!entry.queuedJob || !entry.processId || entry.claimed || entry.dispatchId
      || entry.owner || entry.imageId || entry.receipt || entry.stopObservation || entry.stopRequestId || entry.result)) {
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
}
function uncertain(): z.infer<typeof journalEntry>['result'] {
  return { state: 'uncertain', exitCode: null, stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false }
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

  constructor(private readonly platformUrl: string, private readonly privateDir: string,
    private readonly image: string, private readonly options: DesktopWorkerOptions,
    private readonly containers: OwnedDeviceContainer) {
    this.statePath = join(privateDir, 'device.json')
    this.journalPath = join(privateDir, 'journal.json')
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
    if (!response.ok) throw new Error(`platform_${response.status}`)
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
    const stat = await lstat(actual)
    if (!stat.isDirectory() || actual === '/' || actual === process.env.HOME || /[:,]/.test(actual)) {
      throw new Error('directory_not_allowed')
    }
    const previous = this.state.directories.find(item => item.path === actual)
    if (previous) return { directoryId: previous.id, label: previous.label, path: previous.path }
    const label = basename(actual)
    const result = await this.call('/devices/agent/directory', { label },
      z.object({ directoryId: z.uuid() }).strict(), this.state.token)
    this.state.directories.push({ id: result.directoryId, label, path: actual })
    await this.save(this.statePath, this.state)
    return { directoryId: result.directoryId, label, path: actual }
  }

  private async localPath(directoryId: string, relative: string): Promise<string> {
    const folder = this.state?.directories.find(item => item.id === directoryId)
    if (!folder) throw new Error('directory_not_authorized')
    if (!relative || relative.length > 512 || relative.includes('\\') || relative.includes('\0')) throw new Error('invalid_local_path')
    const segments = relative.split('/')
    if (segments.length > 16 || segments.some(part => !part || part === '.' || part === '..' || part.length > 100)) {
      throw new Error('invalid_local_path')
    }
    const root = await realpath(folder.path)
    if (root !== folder.path || !(await lstat(root)).isDirectory()) throw new Error('directory_changed')
    let parent = root
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment)
      const stat = await lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_local_path')
    }
    return join(parent, segments.at(-1)!)
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
    const target = await this.localPath(directoryId, localPath)
    try { await lstat(target); throw new Error('local_file_exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const cloud = await this.call('/devices/agent/files/read', { directoryId, path: cloudPath },
      z.object({ data: z.string().max(2_800_000), revision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), this.state.token)
    const bytes = Buffer.from(cloud.data, 'base64')
    if (bytes.length > 2 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== cloud.revision) {
      throw new Error('cloud_file_digest_mismatch')
    }
    const temporary = join(dirname(target), `.pe-transfer-${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      try { await file.writeFile(bytes); await file.sync() }
      finally { await file.close() }
      if (await this.localPath(directoryId, localPath) !== target) throw new Error('directory_changed')
      await link(temporary, target)
      const parent = await open(dirname(target), constants.O_RDONLY)
      try { await parent.sync() } finally { await parent.close() }
    } finally { await rm(temporary, { force: true }) }
    return { cloudPath, localPath, size: bytes.length, revision: cloud.revision }
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
    const source = await this.localPath(directoryId, localPath)
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('local_file_unavailable')
      bytes = await file.readFile()
      if (bytes.length > 2 * 1024 * 1024) throw new Error('local_file_too_large')
    } finally { await file.close() }
    return this.call('/devices/agent/files/put',
      { directoryId, requestId, path: cloudPath, data: bytes.toString('base64') },
      z.object({ path: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), this.state.token)
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
      await this.initialization?.catch((_startupFailure: unknown) => {
        // init() releases its descriptors before reporting a failed startup.
      })
      await Promise.allSettled([...this.localActions, this.polling, this.active])
      const lock = this.processLock
      this.processLock = null
      await lock?.release()
    })()
  }

  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        await this.assertOwned()
        if (this.state) {
          if (!this.active) {
            for (const entry of this.journal.values()) {
              if (entry.stage === 'claiming') {
                if (entry.processId !== this.processId) throw new Error('device_claiming_requires_review')
                this.activate(this.resumeClaim(this.state, entry))
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

  private async register(state: DeviceState, entry: JournalEntry): Promise<boolean> {
    const claimed = this.originalClaim(state, entry)
    if (!entry.receipt) throw new Error('device_container_identity_missing')
    const input = deviceContainerRegistration.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: claimed.processId, dispatchId: claimed.dispatchId, receipt: entry.receipt })
    const accepted = await this.call('/devices/agent/register', input, deviceContainerRegistered, state.token)
    if (accepted.executionId !== entry.id || accepted.dispatchId !== claimed.dispatchId
      || JSON.stringify(accepted.receipt) !== JSON.stringify(entry.receipt)) throw new Error('device_registration_identity_mismatch')
    return accepted.canStart
  }

  private async recover(state: DeviceState, entry: JournalEntry): Promise<void> {
    this.originalClaim(state, entry)
    if (!entry.owner || !entry.imageId) throw new Error('device_container_identity_missing')
    if (!entry.receipt) {
      const receipt = await this.containers.findCreated({ name: entry.container, imageId: entry.imageId, owner: entry.owner })
      if (!receipt) throw new Error('device_container_identity_missing')
      entry.receipt = receipt
      await this.saveJournal()
    }
    let registrationFailure: unknown
    try { await this.register(state, entry) }
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
      stage: 'claiming', startedAt: Date.now() }
    this.journal.set(id, entry)
    // Commit the frozen request before a remote claim can commit without its HTTP acknowledgement.
    await this.saveJournal()
    await this.resumeClaim(state, entry)
  }

  private async resumeClaim(state: DeviceState, entry: JournalEntry): Promise<void> {
    const job = entry.queuedJob, id = entry.id, name = entry.container
    if (entry.stage !== 'claiming' || entry.processId !== this.processId || !job) throw new Error('device_claiming_requires_review')
    if (job.digest !== this.requestDigest(state, job)) throw new Error('device_dispatch_changed')
    if (this.stop.signal.aborted) throw new Error('device_closed_before_claim')
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
    const folder = state.directories.find(item => item.id === claimed.directoryId)
    if (!folder) throw new Error('directory_not_authorized')
    const root = await realpath(folder.path)
    if (root !== folder.path || !(await lstat(root)).isDirectory()) throw new Error('directory_changed')
    const requested = resolve(root, claimed.cwd)
    if (requested !== root && !requested.startsWith(root + '/')) throw new Error('cwd_outside_directory')
    const actual = await realpath(requested)
    if (actual !== root && !actual.startsWith(root + '/')) throw new Error('cwd_outside_directory')
    entry.imageId = await this.containers.resolveImage(this.image)
    await this.saveJournal()
    if (this.stop.signal.aborted) throw new Error('device_closed_before_create')
    entry.receipt = await this.containers.create({ name, owner, imageId: entry.imageId,
      options: ['--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--memory', '768m', '--cpus', '1', '--user', '1000:1000',
        '--mount', `type=bind,source=${root},target=/workspace`,
        '--workdir', `/workspace${claimed.cwd ? '/' + claimed.cwd : ''}`, '--entrypoint', '/bin/bash'],
      command: ['-lc', claimed.command] })
    entry.stage = 'created'
    await this.saveJournal()
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
        else await this.containers.start(receipt)
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
    const input = deviceFinishRequest.parse({ instanceId: state.instanceId, executionId: entry.id,
      processId: claimed.processId, dispatchId: claimed.dispatchId, requestId: entry.stopRequestId,
      observation: entry.stopObservation, result: entry.result })
    const accepted = await this.call('/devices/agent/finish', input, deviceFinishReceipt, state.token)
    if (accepted.executionId !== entry.id || accepted.dispatchId !== claimed.dispatchId
      || accepted.requestId !== entry.stopRequestId) throw new Error('device_result_identity_mismatch')
    if (observed) await this.containers.remove(entry.receipt)
    // Missing is acceptable only after an exact stop observation was saved before removal.
    this.journal.delete(entry.id)
    try { await this.saveJournal() }
    catch (error) { this.journal.set(entry.id, entry); throw error }
  }
}
