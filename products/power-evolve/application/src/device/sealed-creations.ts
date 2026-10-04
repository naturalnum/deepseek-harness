/** Durable cleanup of permanently unstarted creations, independent from command writer admission. */
import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { deviceClaimClosureReceipt, deviceStopObservation, ownedContainerOwner, ownedContainerReceipt } from '@power-evolve/contracts/device-execution'
import type { OwnedDeviceContainer } from './owned-container.ts'

/** Only immutable creation identities and cleanup facts belong in this private record. */
export const sealedCreation = z.object({ closure: deviceClaimClosureReceipt,
  name: z.string().regex(/^pe-local-[a-f0-9]{32}$/u), owner: ownedContainerOwner,
  imageId: ownedContainerReceipt.shape.imageId.nullable(), receipt: ownedContainerReceipt.optional(),
  observation: deviceStopObservation.optional(), removalConfirmed: z.boolean(),
}).strict().superRefine((record, ctx) => {
  const { closure, owner, receipt, observation } = record
  if (record.name !== 'pe-local-' + closure.executionId.replaceAll('-', '')
    || owner.deviceId !== closure.deviceId || owner.enrollmentId !== closure.instanceId
    || owner.executionId !== closure.executionId || owner.creationId !== closure.dispatchId
    || owner.requestDigest !== closure.digest
    || receipt && (receipt.imageId !== record.imageId || !isDeepStrictEqual(receipt.owner, owner))
    || observation && (!receipt || !isDeepStrictEqual(observation.receipt, receipt))
    || record.removalConfirmed && !observation) {
    ctx.addIssue({ code: 'custom', message: 'sealed_creation_identity_mismatch' })
  }
})
/** Validated no-start receipt and exact local cleanup progress; no command or local path is retained. */
export type SealedCreation = z.infer<typeof sealedCreation>
type Identity = Pick<SealedCreation['owner'], 'deviceId' | 'enrollmentId'>
/** Fixed errors never include private paths, credential values, or persisted JSON. */
export class SealedCreationError extends Error {
  constructor(readonly code: 'sealed_creation_invalid' | 'sealed_creation_identity_changed'
    | 'sealed_creation_running' | 'sealed_creation_stop_unconfirmed' | 'sealed_creations_closed') { super(code) }
}
function invalid(): SealedCreationError { return new SealedCreationError('sealed_creation_invalid') }
function ownerOnly(stat: BigIntStats, directory: boolean): void {
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n || stat.size > 65536n)) throw invalid()
}
function same(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino }
function requireIdentity(record: SealedCreation, identity: Identity): void {
  if (record.owner.deviceId !== identity.deviceId || record.owner.enrollmentId !== identity.enrollmentId) {
    throw new SealedCreationError('sealed_creation_identity_changed')
  }
}
function compatible(prior: SealedCreation, next: SealedCreation): void {
  if (!isDeepStrictEqual(prior.closure, next.closure) || !isDeepStrictEqual(prior.owner, next.owner)
    || prior.name !== next.name || prior.imageId !== next.imageId
    || prior.receipt && !isDeepStrictEqual(prior.receipt, next.receipt)
    || prior.observation && !isDeepStrictEqual(prior.observation, next.observation)
    || prior.removalConfirmed && !next.removalConfirmed) throw new SealedCreationError('sealed_creation_identity_changed')
}

/** A bounded disk iterator reconciles at most one record per poll under the Worker's private flock. */
export class SealedDeviceCreations {
  private readonly root: string
  private handle: FileHandle | null = null
  private identity: BigIntStats | null = null
  private iterator: AsyncIterableIterator<Dirent> | null = null
  private closed = false
  constructor(privateRoot: string, private readonly assertOwned: () => Promise<void>) { this.root = join(privateRoot, 'sealed-creations') }
  private async owned(): Promise<void> {
    if (this.closed) throw new SealedCreationError('sealed_creations_closed')
    await this.assertOwned()
    try {
      if (!this.handle) {
        await mkdir(this.root, { mode: 0o700, recursive: true })
        const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          const stat = await handle.stat({ bigint: true }); ownerOnly(stat, true)
          this.identity = stat; this.handle = handle
        } catch (error) { await handle.close(); throw error }
      }
      const [current, held] = await Promise.all([lstat(this.root, { bigint: true }), this.handle.stat({ bigint: true })])
      ownerOnly(current, true)
      if (!this.identity || !same(current, this.identity) || !same(current, held)) throw invalid()
    } catch (error) { if (error instanceof SealedCreationError) throw error; throw invalid() }
  }
  private path(id: SealedCreation['closure']['executionId']): string { return join(this.root, `${id}.json`) }
  private async read(id: SealedCreation['closure']['executionId']): Promise<SealedCreation | null> {
    await this.owned()
    let file: FileHandle
    try { file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw invalid() }
    try {
      const stat = await file.stat({ bigint: true }); ownerOnly(stat, false)
      const bytes = Buffer.alloc(65537)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > 65536) throw invalid()
      const parsed = sealedCreation.safeParse(JSON.parse(bytes.subarray(0, length).toString('utf8')))
      if (!parsed.success || parsed.data.closure.executionId !== id) throw invalid()
      const current = await lstat(this.path(id), { bigint: true }); ownerOnly(current, false)
      if (!same(current, stat)) throw invalid()
      await this.owned()
      return parsed.data
    } catch (error) { if (error instanceof SealedCreationError) throw error; throw invalid() }
    finally { await file.close() }
  }
  /** Preserve or sync the original tombstone before retiring any command slot.
   * @param input Validated original identities; retries cannot replace cleanup facts.
   * @returns Existing progressed record or the newly synced record.
   */
  async preserve(input: SealedCreation): Promise<SealedCreation> {
    const prior = await this.read(input.closure.executionId)
    if (prior) {
      compatible({ ...prior, receipt: undefined, observation: undefined, removalConfirmed: false }, input)
      if (input.receipt && prior.receipt && !isDeepStrictEqual(input.receipt, prior.receipt)) {
        throw new SealedCreationError('sealed_creation_identity_changed')
      }
      return prior
    }
    await this.write(input)
    return input
  }
  private async write(record: SealedCreation): Promise<void> {
    try {
      await this.owned()
      const prior = await this.read(record.closure.executionId)
      if (prior) compatible(prior, record)
      const temporary = join(this.root, `.${record.closure.executionId}.${randomUUID()}.tmp`)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync() }
      finally { await file.close() }
      await this.owned()
      await rename(temporary, this.path(record.closure.executionId))
      await this.handle!.sync()
    } catch (error) { if (error instanceof SealedCreationError) throw error; throw invalid() }
  }
  /** Inspect/remove one sealed creation, never creating, starting, registering or reporting a command.
   * @param id Original sealed execution identity.
   * @param identity Current Device enrollment; foreign records are refused.
   * @param containers Exact-identity Docker adapter.
   * @returns Synced progress; a missing name remains pending without blocking writer admission.
   */
  async cleanup(id: SealedCreation['closure']['executionId'], identity: Identity, containers: OwnedDeviceContainer): Promise<SealedCreation> {
    let record = await this.read(id)
    if (!record) throw invalid()
    requireIdentity(record, identity)
    if (record.removalConfirmed || record.imageId === null) return record
    if (!record.receipt) {
      const receipt = await containers.findCreated({ name: record.name, imageId: record.imageId, owner: record.owner })
      if (!receipt) return record
      record = { ...record, receipt }; await this.write(record)
    }
    const receipt = record.receipt!
    const observed = await containers.inspect(receipt)
    if (!observed) {
      if (!record.observation) throw new SealedCreationError('sealed_creation_stop_unconfirmed')
      record = { ...record, removalConfirmed: true }; await this.write(record); return record
    }
    if (observed.Running) throw new SealedCreationError('sealed_creation_running')
    const parsed = deviceStopObservation.safeParse({ ...observed, receipt })
    if (!parsed.success) throw new SealedCreationError('sealed_creation_stop_unconfirmed')
    if (record.observation && !isDeepStrictEqual(record.observation, parsed.data)) throw new SealedCreationError('sealed_creation_identity_changed')
    record = { ...record, observation: parsed.data }; await this.write(record)
    try { await containers.remove(receipt) }
    catch (error) { if (await containers.inspect(receipt)) throw error }
    record = { ...record, removalConfirmed: true }; await this.write(record)
    return record
  }
  /** Advance a disk iterator once; an absent creation's tombstone remains available for later polls.
   * @param identity Current Device enrollment.
   * @param containers Exact-identity Docker adapter.
   * @param pending Whether the original command journal still requires the cleanup facts.
   * @returns Completion of at most one cleanup, without touching global command admission.
   */
  async reconcileOne(identity: Identity, containers: OwnedDeviceContainer,
    pending: (executionId: SealedCreation['closure']['executionId']) => boolean): Promise<void> {
    await this.owned()
    if (!this.iterator) {
      try { this.iterator = (await opendir(this.root))[Symbol.asyncIterator]() }
      catch (_directoryUnavailable) { throw invalid() }
    }
    let next: IteratorResult<Dirent>
    try { next = await this.iterator.next() }
    catch (_directoryReadFailure) { throw invalid() }
    if (next.done) { this.iterator = null; return }
    if (/^\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/u.test(next.value.name)) return
    const match = /^([a-f0-9-]{36})\.json$/u.exec(next.value.name)
    const id = deviceClaimClosureReceipt.shape.executionId.safeParse(match?.[1])
    if (!id.success) throw invalid()
    if (pending(id.data)) return
    const progress = await this.cleanup(id.data, identity, containers)
    if (!progress.removalConfirmed && progress.imageId !== null) return
    try {
      await this.owned()
      const current = await this.read(id.data)
      if (!isDeepStrictEqual(current, progress)) throw new SealedCreationError('sealed_creation_identity_changed')
      await unlink(this.path(id.data))
      await this.handle!.sync()
    } catch (error) { if (error instanceof SealedCreationError) throw error; throw invalid() }
  }
  /** Close retained iterator/descriptors after the Worker has awaited its poller.
   * @returns Descriptor closure; tombstones and lock files remain intact.
   */
  async close(): Promise<void> {
    this.closed = true
    try { if (this.iterator?.return) await this.iterator.return() }
    finally { this.iterator = null; const handle = this.handle; this.handle = null; await handle?.close() }
  }
}
