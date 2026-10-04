/** Private parent IPC and durable residual facts for one owned Device process. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { deviceDrainReport, deviceLifecycleReady, deviceLifecycleRequest, deviceLifecycleResponse,
  type DeviceDrainEntry, type DeviceDrainReport, type DeviceLifecycleSnapshot,
  type DeviceLifecycleReady, type DeviceLifecycleResponse } from '@power-evolve/contracts/device-lifecycle'
import { sealedCreation } from './sealed-creations.ts'

function failed(): Error { return new Error('device_drain_read_failed') }
const correlation = z.object({ kind: deviceLifecycleRequest.shape.kind, version: deviceLifecycleRequest.shape.version,
  launchId: deviceLifecycleRequest.shape.launchId, type: deviceLifecycleRequest.shape.type,
  requestId: deviceLifecycleRequest.shape.requestId, action: deviceLifecycleRequest.shape.action })
function same(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino }
function owned(stat: BigIntStats, directory: boolean): void {
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw failed()
}
async function bytes(file: FileHandle, length: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let position = 0
  while (position < length) {
    const value = await file.read(result, position, length - position, position)
    if (!value.bytesRead) throw failed()
    position += value.bytesRead
  }
  return result
}
async function record(path: string, root: FileHandle, maximumBytes?: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const identity = await file.stat({ bigint: true }); owned(identity, false)
    const length = Number(identity.size)
    if (!Number.isSafeInteger(length) || maximumBytes !== undefined && length > maximumBytes) throw failed()
    const original = await bytes(file, length), value: unknown = JSON.parse(original.toString('utf8'))
    await file.sync(); await root.sync()
    const current = await lstat(path, { bigint: true }), held = await file.stat({ bigint: true })
    owned(current, false); owned(held, false)
    if (!same(identity, current) || !same(identity, held) || held.size !== identity.size
      || !original.equals(await bytes(file, length))) throw failed()
    return value
  } finally { await file.close() }
}

/** Read and resync original records under the Worker's retained private lock; never write or remove records.
 * @param privateDir Owned Device root.
 * @param journal Decode the original journal into bounded residual facts.
 * @param assertOwned Verify the Worker's kernel ownership before and after reading.
 * @returns Durable journal facts and the count of retained cleanup records.
 */
export async function collectDeviceDrainReport(privateDir: string, journal: (value: unknown) => DeviceDrainEntry[],
  assertOwned: () => Promise<void>): Promise<DeviceDrainReport> {
  const root = await open(privateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch(() => { throw failed() })
  try {
    await assertOwned()
    const identity = await root.stat({ bigint: true }); owned(identity, true)
    let entries: DeviceDrainEntry[] = []
    const journalPath = join(privateDir, 'journal.json')
    const journalExists = await lstat(journalPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (journalExists) entries = journal(await record(journalPath, root))
    let cleanupPending = 0
    const cleanupPath = join(privateDir, 'sealed-creations')
    let cleanup: FileHandle | undefined
    try { cleanup = await open(cleanupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (cleanup) {
      try {
        const cleanupIdentity = await cleanup.stat({ bigint: true }); owned(cleanupIdentity, true)
        const directory = await opendir(cleanupPath)
        for await (const entry of directory) {
          if (/^\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/u.test(entry.name)) continue
          const executionId = z.uuid().parse(/^([a-f0-9-]{36})\.json$/u.exec(entry.name)?.[1])
          const value = sealedCreation.parse(await record(join(cleanupPath, entry.name), cleanup, 65536))
          if (value.closure.executionId !== executionId) throw failed()
          cleanupPending++
        }
        await cleanup.sync()
        const current = await lstat(cleanupPath, { bigint: true }); owned(current, true)
        if (!same(cleanupIdentity, current)) throw failed()
      } finally { await cleanup.close() }
    }
    await root.sync(); await assertOwned()
    if (!same(identity, await lstat(privateDir, { bigint: true }))) throw failed()
    return deviceDrainReport.parse({ entries, cleanupPending })
  } catch (_readFailure) { throw failed() }
  finally { await root.close().catch(() => { throw failed() }) }
}

/** Worker work counts exclude secrets and paths; quiesce returns only durable residual facts. */
export interface DeviceLifecycleWorker {
  /** @returns Current admission and pending local work. */
  inspectLifecycle(): Pick<DeviceLifecycleSnapshot, 'admissionOpen' | 'pendingActions' | 'journalEntries'>
  /** @returns Quiescence after actual child exit and durable fact collection. */
  quiesce(): Promise<DeviceDrainReport>
}
/** One real IPC channel to the owning parent; tests replace transport, not lifecycle ordering. */
export interface DeviceParentChannel {
  readonly connected: boolean
  readonly pid: number
  /** @param value Validated private packet. @param done Actual IPC send completion. */
  send(value: DeviceLifecycleReady | DeviceLifecycleResponse, done: (error: Error | null) => void): void
  /** @param listener Private incoming packets. @returns Listener disposer. */
  onMessage(listener: (value: unknown) => void): () => void
  /** @param listener Parent channel loss. @returns Listener disposer. */
  onDisconnect(listener: () => void): () => void
}
/** Product-owned collaborators; no API is exposed to a Cloud document. */
export interface DeviceParentLifecycleOptions {
  launchId: string
  instanceId: string
  url: string
  channel: DeviceParentChannel
  worker: DeviceLifecycleWorker
  /** @returns Exit of the owned directory picker. */
  closePicker(): Promise<void>
  /** @param code Exit only after the product has finished draining. */
  exit(code: number): void
  /** @param code Fixed diagnostics without exception text or private paths. */
  failure(code: 'device_parent_ipc_failed' | 'device_parent_quiesce_failed'): void
}

/** Coalesced lifecycle of one explicit Electron launch; startup cancellation never publishes ready. */
export class DeviceParentLifecycle {
  private phase: DeviceLifecycleSnapshot['phase'] = 'starting'
  private drain: DeviceDrainReport | null = null
  private draining: Promise<void> | undefined
  private exiting = false
  private disposed = false
  private readonly readyPacket: DeviceLifecycleReady
  private readonly remove: (() => void)[]
  /** @param options One validated launch and its owned resources. */
  constructor(private readonly options: DeviceParentLifecycleOptions) {
    try { this.readyPacket = deviceLifecycleReady.parse({ kind: 'power-evolve-device-lifecycle', version: 1,
      launchId: options.launchId, type: 'ready', instanceId: options.instanceId, pid: options.channel.pid, url: options.url }) }
    catch (_invalidLaunch) { throw new Error('device_parent_invalid_launch') }
    this.remove = [options.channel.onMessage(value => { void this.request(value).catch(() => {
      options.failure('device_parent_ipc_failed'); this.channelLost()
    }) }),
      options.channel.onDisconnect(() => this.channelLost())]
    if (!options.channel.connected) this.channelLost()
  }
  /** Admission includes the starting phase; a cancelled startup cannot start polling. */
  get admissionOpen(): boolean { return this.phase === 'starting' || this.phase === 'ready' }
  /** Publish readiness only from the official launcher's effect-owned appReady listener. */
  ready(): void {
    if (this.disposed || !this.admissionOpen) return
    this.phase = 'ready'
    void this.send(this.readyPacket).catch(() => { this.options.failure('device_parent_ipc_failed'); this.channelLost() })
  }
  /** @returns Private process state; quiescence does not assert that every container stopped. */
  snapshot(): DeviceLifecycleSnapshot {
    const work = this.options.worker.inspectLifecycle()
    return { ...work, phase: this.phase, admissionOpen: this.admissionOpen && work.admissionOpen, drain: this.drain }
  }
  private send(value: DeviceLifecycleReady | DeviceLifecycleResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.options.channel.connected) { reject(new Error('device_parent_ipc_failed')); return }
      try { this.options.channel.send(value, error => { if (error) reject(error); else resolve() }) }
      catch (_sendFailure) { reject(new Error('device_parent_ipc_failed')) }
    })
  }
  private quiesce(): Promise<void> {
    return this.draining ??= (async () => {
      this.phase = 'draining'
      const results = await Promise.allSettled([this.options.worker.quiesce(), this.options.closePicker()])
      if (results[0].status === 'rejected' || results[1].status === 'rejected') {
        this.phase = 'error'; throw new Error('device_parent_quiesce_failed')
      }
      this.drain = results[0].value
      this.phase = 'quiescent'
    })()
  }
  private exit(code: number): void {
    if (this.exiting) return
    this.exiting = true; this.options.exit(code)
  }
  private channelLost(): void {
    if (this.disposed || this.exiting) return
    void this.quiesce().then(() => this.exit(0), () => {
      this.options.failure('device_parent_quiesce_failed'); this.exit(1)
    })
  }
  private async request(value: unknown): Promise<void> {
    if (this.disposed) return
    const envelope = correlation.safeParse(value)
    if (!envelope.success) return
    const request = envelope.data
    const base = { kind: this.readyPacket.kind, version: this.readyPacket.version, launchId: this.readyPacket.launchId,
      instanceId: this.readyPacket.instanceId, type: 'response' as const, requestId: request.requestId, action: request.action }
    const error = async (code: 'invalid_request' | 'wrong_instance' | 'not_quiescent' | 'quiesce_failed'): Promise<void> => {
      await this.send(deviceLifecycleResponse.parse({ ...base, status: 'error', code }))
    }
    const parsed = deviceLifecycleRequest.safeParse(value)
    if (!parsed.success) { await error('invalid_request'); return }
    if (request.launchId !== this.readyPacket.launchId) { await error('invalid_request'); return }
    if (parsed.data.instanceId !== null && parsed.data.instanceId !== this.readyPacket.instanceId) { await error('wrong_instance'); return }
    if (request.action === 'quiesce') {
      try { await this.quiesce() } catch (_quiesceFailure) { await error('quiesce_failed'); return }
    }
    if (request.action === 'terminate' && this.phase !== 'quiescent') { await error('not_quiescent'); return }
    await this.send(deviceLifecycleResponse.parse({ ...base, status: 'ok', snapshot: this.snapshot() }))
    if (request.action === 'terminate') this.exit(0)
  }
  /** Remove notifications before teardown; repeated calls join the original drain.
   * @returns Completion of picker, Worker and durable collection; failures remain visible.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const remove of this.remove.splice(0)) remove()
    await this.quiesce()
  }
}
