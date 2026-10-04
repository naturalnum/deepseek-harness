/** One OS-user writer slot shared by cooperating Device Profiles; unknown commands never expire. */
import { randomUUID } from 'node:crypto'
import { constants, fstatSync, fsyncSync, readSync, writeSync, type BigIntStats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { deviceClaimRequest, deviceDispatchRequest, deviceFinishReceipt, deviceFinishRequest,
  deviceStopObservation, ownedContainerOwner, ownedContainerReceipt,
  type DeviceStopRequestId, type OwnedContainerReceipt } from '@power-evolve/contracts/device-execution'
import { DeviceProcessLock, DeviceProcessLockError } from './process-lock.ts'

/** Frozen command identity saved before Platform claim or Docker creation, without paths or output. */
export const deviceWriterOwner = z.object({ kind: z.literal('command'),
  deviceId: ownedContainerOwner.shape.deviceId, enrollmentId: ownedContainerOwner.shape.enrollmentId,
  executionId: ownedContainerOwner.shape.executionId, processId: deviceClaimRequest.shape.processId,
  directoryId: deviceDispatchRequest.shape.directoryId, requestDigest: ownedContainerOwner.shape.requestDigest,
}).strict()
/** Original command owner; cold recovery retains its original process identity. */
export type DeviceWriterOwner = z.infer<typeof deviceWriterOwner>
/** Stop facts are supplied only after exact-container observation by the trusted Worker. */
export type DeviceStopObservation = z.infer<typeof deviceStopObservation>
/** Platform's original stop ACK; an unknown outcome keeps the local reservation. */
export type DeviceFinishReceipt = z.infer<typeof deviceFinishReceipt>
/** Persistent slot filename; the separate kernel-lock inode is never removed. */
export const DEVICE_WRITER_SLOT_FILENAME = 'writer-slot.json'
/** Fixed refusal codes contain no private paths, commands, credentials or Docker diagnostics. */
export class DeviceWriterError extends Error {
  constructor(readonly code: 'device_writer_busy' | 'device_writer_identity_changed' | 'device_writer_stop_unconfirmed'
    | 'device_writer_settlement_mismatch' | 'device_writer_slot_invalid' | 'device_writer_lease_released'
    | 'device_writer_waiting_unavailable') {
    super(code)
  }
}

function matching(owner: DeviceWriterOwner, receipt: OwnedContainerReceipt): boolean {
  return receipt.owner.deviceId === owner.deviceId && receipt.owner.enrollmentId === owner.enrollmentId
    && receipt.owner.executionId === owner.executionId && receipt.owner.requestDigest === owner.requestDigest
}
const commandSlot = z.object({ kind: z.literal('command'), owner: deviceWriterOwner,
  receipt: ownedContainerReceipt.nullable(), stop: z.object({ requestId: deviceFinishRequest.shape.requestId,
    observation: deviceStopObservation }).strict().nullable(),
}).strict().refine(slot => (slot.receipt === null || matching(slot.owner, slot.receipt))
  && (slot.stop === null || slot.receipt !== null && isDeepStrictEqual(slot.receipt, slot.stop.observation.receipt)))
const stateSchema = z.object({ version: z.literal(1), slot: z.discriminatedUnion('kind', [commandSlot,
  z.object({ kind: z.literal('transfer'), id: z.uuid() }).strict()]).nullable(),
  lockIdentity: z.object({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict(),
  interruptedTransfer: z.object({ id: z.uuid(), state: z.literal('interrupted') }).strict().nullable(),
}).strict()
type WriterState = z.infer<typeof stateSchema>
type CommandSlot = z.infer<typeof commandSlot>
function invalid(): DeviceWriterError { return new DeviceWriterError('device_writer_slot_invalid') }
function regular(entry: BigIntStats): void {
  if (!entry.isFile() || entry.nlink !== 1n || entry.uid !== BigInt(process.getuid!())
    || (entry.mode & 0o777n) !== 0o600n || entry.size > 65536n) throw invalid()
}
function same(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino }
function filesystemError(error: unknown): never {
  if (error instanceof DeviceWriterError || error instanceof DeviceProcessLockError) throw error
  throw invalid()
}
function assertNever(state: never): never {
  void state
  throw new DeviceWriterError('device_writer_settlement_mismatch')
}

class WriterSlotStore {
  private identity: BigIntStats | null = null
  private bytes: string | null = null
  private state: WriterState
  private initialized = false
  private readonly initializedMarker: Buffer
  private readonly path: string
  constructor(private readonly root: string, readonly lock: DeviceProcessLock) {
    this.path = join(root, DEVICE_WRITER_SLOT_FILENAME)
    const identity = fstatSync(lock.fd, { bigint: true })
    this.state = { version: 1, slot: null, interruptedTransfer: null,
      lockIdentity: { dev: identity.dev.toString(), ino: identity.ino.toString() } }
    this.initializedMarker = Buffer.from(`power-evolve/device-writer/v1:${identity.dev}:${identity.ino}\n`)
  }

  private marker(): Buffer {
    const buffer = Buffer.alloc(this.initializedMarker.length + 1)
    return buffer.subarray(0, readSync(this.lock.fd, buffer, 0, buffer.length, 0))
  }
  private initialize(): void {
    if (writeSync(this.lock.fd, this.initializedMarker, 0, this.initializedMarker.length, 0) !== this.initializedMarker.length) throw invalid()
    fsyncSync(this.lock.fd)
    this.initialized = true
  }
  private async readBytes(file: Awaited<ReturnType<typeof open>>): Promise<string> {
    const buffer = Buffer.alloc(65537)
    let size = 0
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > 65536) throw invalid()
    return buffer.subarray(0, size).toString('utf8')
  }

  async load(): Promise<void> {
    try {
      await this.lock.assertOwned()
      const marker = this.marker()
      if (marker.length > 0 && !marker.equals(this.initializedMarker)) throw invalid()
      this.initialized = marker.length > 0
      const entry = await lstat(this.path, { bigint: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (entry === null) {
        if (this.initialized) throw invalid()
        await this.save(this.state); this.initialize(); return
      }
      regular(entry)
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const held = await file.stat({ bigint: true }); regular(held)
        if (!same(entry, held)) throw invalid()
        const bytes = await this.readBytes(file), parsed = stateSchema.safeParse(JSON.parse(bytes))
        if (!parsed.success) throw invalid()
        if (!isDeepStrictEqual(parsed.data.lockIdentity, this.state.lockIdentity)) throw invalid()
        if (!this.initialized && (parsed.data.slot !== null || parsed.data.interruptedTransfer !== null)) throw invalid()
        this.identity = held; this.bytes = bytes; this.state = parsed.data
        if (!this.initialized) this.initialize()
        await this.assertUnchanged()
      } finally { await file.close() }
    } catch (error) { filesystemError(error) }
  }
  async assertUnchanged(): Promise<void> {
    await this.lock.assertOwned()
    if (this.initialized && !this.marker().equals(this.initializedMarker)) throw invalid()
    if (this.identity === null) {
      const entry = await lstat(this.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (entry !== null) throw invalid()
      return
    }
    const entry = await lstat(this.path, { bigint: true }); regular(entry)
    if (!same(entry, this.identity)) throw invalid()
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const held = await file.stat({ bigint: true }); regular(held)
      if (!same(held, this.identity) || await this.readBytes(file) !== this.bytes) throw invalid()
    } finally { await file.close() }
  }
  async current(): Promise<WriterState> {
    try { await this.assertUnchanged(); return this.state } catch (error) { filesystemError(error) }
  }
  async save(state: WriterState): Promise<void> {
    const temporary = join(this.root, `.writer-slot-${randomUUID()}.tmp`)
    let created = false
    try {
      await this.assertUnchanged()
      const parent = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        created = true
        const bytes = JSON.stringify(state) + '\n'
        let identity: BigIntStats
        try { await file.writeFile(bytes); await file.sync(); identity = await file.stat({ bigint: true }); regular(identity) }
        finally { await file.close() }
        await this.assertUnchanged()
        const pending = await lstat(temporary, { bigint: true }); regular(pending)
        if (!same(pending, identity)) throw invalid()
        await rename(temporary, this.path); created = false
        this.identity = identity; this.bytes = bytes; this.state = state
        await parent.sync()
        await this.assertUnchanged()
      } finally { await parent.close() }
    } catch (error) { filesystemError(error) }
    finally {
      if (created) {
        try { await unlink(temporary) }
        catch (error) {
          // An interrupted rename may already have consumed this private temporary file.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') filesystemError(error)
        }
      }
    }
  }
  async command(owner: DeviceWriterOwner): Promise<CommandSlot> {
    const state = await this.current()
    if (state.slot?.kind !== 'command' || !isDeepStrictEqual(state.slot.owner, owner)) {
      throw new DeviceWriterError('device_writer_identity_changed')
    }
    return state.slot
  }
  async interrupted(): Promise<void> {
    const state = await this.current()
    if (state.slot?.kind === 'transfer') {
      await this.save({ ...state, slot: null, interruptedTransfer: { id: state.slot.id, state: 'interrupted' } })
    }
  }
}

/** Held command slot; releasing the kernel descriptor never discards an unresolved reservation. */
export class DeviceWriterLease {
  private pending: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  constructor(private readonly store: WriterSlotStore, private readonly owner: DeviceWriterOwner) {}
  /** Descriptor for trusted helpers inheriting this command's shared kernel lock.
   * @returns Held descriptor; once release begins the lease supplies no further descriptor.
   */
  get fd(): number {
    if (this.closing) throw new DeviceWriterError('device_writer_lease_released')
    return this.store.lock.fd
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DeviceWriterError('device_writer_lease_released'))
    const result = this.pending.then(action)
    this.pending = result.then(() => {}, () => {})
    return result
  }
  /** Clear only a never-dispatched waiting intent under the caller's private journal lock.
   * The trusted Worker must have verified its durable waiting entry and must persist claiming before
   * any Platform claim or Docker create. Never call for claiming, uncertain, or captured work.
   * @returns Durable removal of this exact uncaptured intent; it grants no Platform execution authority.
   */
  abandonWaiting(): Promise<void> {
    return this.run(async () => {
      const slot = await this.store.command(this.owner)
      if (slot.receipt !== null || slot.stop !== null) throw new DeviceWriterError('device_writer_waiting_unavailable')
      await this.store.save({ ...await this.store.current(), slot: null })
    })
  }
  /** Persist an immutable capture before start; a different container or owner cannot replace it.
   * @param receipt Exact owned Docker identity, without a local path or command.
   * @returns Durable capture; identical retries retain the original receipt.
   */
  capture(receipt: OwnedContainerReceipt): Promise<void> {
    return this.run(async () => {
      const slot = await this.store.command(this.owner)
      if (!matching(this.owner, receipt) || slot.receipt !== null && !isDeepStrictEqual(slot.receipt, receipt)) {
        throw new DeviceWriterError('device_writer_identity_changed')
      }
      if (slot.receipt === null) await this.store.save({ ...await this.store.current(), slot: { ...slot, receipt } })
    })
  }
  /** Retain one exact non-running observation independently from the unknown command outcome.
   * @param observation Original captured container's stop facts supplied by the trusted Worker.
   * @param requestId Stable Platform stop request identity.
   * @returns Durable facts; a changed observation or request is refused.
   */
  recordStop(observation: DeviceStopObservation, requestId: DeviceStopRequestId): Promise<void> {
    return this.run(async () => {
      const slot = await this.store.command(this.owner)
      if (slot.receipt === null || !isDeepStrictEqual(slot.receipt, observation.receipt)) {
        throw new DeviceWriterError('device_writer_stop_unconfirmed')
      }
      const stop = { requestId, observation }
      if (slot.stop !== null && !isDeepStrictEqual(slot.stop, stop)) throw new DeviceWriterError('device_writer_identity_changed')
      if (slot.stop === null) await this.store.save({ ...await this.store.current(), slot: { ...slot, stop } })
    })
  }
  /** Clear a command only after the caller removed the exact container and received its matching ACK.
   * @param ack Original Platform stop receipt; unknown outcomes remain reserved until independent closure.
   * @returns True for known/closed_unknown settlement, false for uncertain without clearing the slot.
   */
  settle(ack: DeviceFinishReceipt): Promise<boolean> {
    return this.run(async () => {
      const slot = await this.store.command(this.owner)
      if (slot.receipt === null || slot.stop === null) throw new DeviceWriterError('device_writer_stop_unconfirmed')
      if (ack.executionId !== this.owner.executionId || ack.dispatchId !== slot.receipt.owner.creationId
        || ack.requestId !== slot.stop.requestId || !ack.stopConfirmed) throw new DeviceWriterError('device_writer_settlement_mismatch')
      switch (ack.state) {
        case 'uncertain': return false
        case 'succeeded': case 'failed': case 'cancelled': case 'closed_unknown': break
        default: return assertNever(ack.state)
      }
      await this.store.save({ ...await this.store.current(), slot: null })
      return true
    })
  }
  /** Wait for local slot writes and release kernel ownership while preserving unresolved command facts.
   * @returns Idempotent completion of descriptor closure, never an inferred Docker stop.
   */
  release(): Promise<void> {
    this.closing ??= this.pending.then(() => this.store.lock.release())
    return this.closing
  }
}

/** One coordination root for all cooperating Profiles of an OS user; a missing initialized slot blocks admission. */
export class DeviceWriterCoordinator {
  constructor(private readonly root: string) {}
  private async acquire(): Promise<WriterSlotStore> {
    const lock = await DeviceProcessLock.acquire(this.root), store = new WriterSlotStore(resolve(this.root), lock)
    try { await store.load(); await store.interrupted(); return store }
    catch (error) { await lock.release(); throw error }
  }
  /** Save command intent before claim/create; only an identical owner may recover a persistent slot.
   * @param owner Frozen original command identity; no PID, TTL, or missing container can clear another owner.
   * @returns Kernel-held command lease; release preserves unknown work.
   */
  async command(owner: DeviceWriterOwner): Promise<DeviceWriterLease> {
    const store = await this.acquire()
    try {
      const state = await store.current()
      if (state.slot !== null && (state.slot.kind !== 'command' || !isDeepStrictEqual(state.slot.owner, owner))) {
        throw new DeviceWriterError('device_writer_busy')
      }
      if (state.slot === null) await store.save({ ...state, slot: { kind: 'command', owner, receipt: null, stop: null } })
      return new DeviceWriterLease(store, owner)
    } catch (error) { await store.lock.release(); throw error }
  }
  /** Hold the global flock through a trusted helper's complete local action, with an inheritable descriptor.
   * @param action Trusted helper action; inherit lockFd explicitly and await the helper's exit.
   * @returns Action result. A rejected/interrupted action retains its intent until all inherited holders exit.
   */
  async transfer<T>(action: (lockFd: number) => Promise<T>): Promise<T> {
    const store = await this.acquire()
    try {
      const state = await store.current()
      if (state.slot !== null) throw new DeviceWriterError('device_writer_busy')
      await store.save({ ...state, slot: { kind: 'transfer', id: randomUUID() } })
      await store.lock.assertOwned()
      const result = await action(store.lock.fd)
      await store.save({ ...await store.current(), slot: null })
      return result
    } finally { await store.lock.release() }
  }
}
