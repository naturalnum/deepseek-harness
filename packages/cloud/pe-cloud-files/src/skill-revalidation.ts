/** Bounded Root attestations for one old complete record; facts alone never constitute an account capability. */
import { isDeepStrictEqual } from 'node:util'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { StaticStorageAccount, StaticStorageDomain, StorageProcessIdentity } from './storage-types.ts'
import { FilesFailure } from './error.ts'

type Process = { readonly pid: number; readonly startTicks: string }
type Generation = { readonly instanceId: string; readonly epoch: string; readonly process: Process }
type Volume = {
  readonly uuid: string
  readonly device: string
  readonly inode: string
  readonly mountId: string
  readonly filesystem: string
  readonly blockBytes: string
  readonly blocks: string
  readonly inodes: string
  readonly backing: { readonly path: string; readonly device: string; readonly inode: string; readonly bytes: string }
}
/** Only an original Root lease constructs this private callback from a pinned proof and authentic mount input. */
export interface SkillRecordRevalidation {
  readonly workspaceId: string
  readonly recordSha256: string
  /** False only after this original Root has observed the exact revalidation CAS commit. */
  readonly pending: boolean
  /** @param revision Current native version read beside the exact old protected association bytes. */
  assertRecord(revision: string): void
  /**
   * Retain actual original CAS completion even after observation/lifetime cancellation; this issues no capability.
   * @param previousRevision Exact old revision checked immediately before the original CAS.
   * @param committedRevision Native revision returned by that confirmed successful CAS.
   */
  confirmRecord(previousRevision: string, committedRevision: string): void
}
/** Detached pinned facts; original RootStorageOwner still checks its actual plan, lease, process and binding. */
export interface RootSkillRevalidationProof {
  readonly accountId: string
  readonly storageKey: string
  readonly workspaceId: string
  readonly recordSha256: string
  readonly recordRevision: string
  readonly previous: Generation
  readonly recipient: { readonly process: Process; readonly planSha256: string }
  readonly volumes: { readonly private: Volume; readonly projects: Volume }
}
function reject(): never { throw new FilesFailure('cloud/stale-generation', 'The protected skill revalidation proof is unavailable or mismatched.') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) reject()
  return row
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 16384 || value.includes('\0')) reject()
  return value
}
function digest(value: unknown): string { const v = text(value); if (!/^[a-f0-9]{64}$/.test(v)) reject(); return v }
function decimal(value: unknown): string {
  const v = text(value); if (!/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > 0xffffffffffffffffn) reject(); return v
}
function processIdentity(value: unknown): Process {
  const v = object(value, ['pid', 'startTicks'])
  if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid < 1 || v.pid > 2147483647) reject()
  return Object.freeze({ pid: v.pid, startTicks: decimal(v.startTicks) })
}
function generation(value: unknown): Generation {
  const v = object(value, ['instanceId', 'epoch', 'process'])
  return Object.freeze({ instanceId: text(v.instanceId), epoch: decimal(v.epoch), process: processIdentity(v.process) })
}
function volume(value: unknown): Volume {
  const v = object(value, ['uuid', 'device', 'inode', 'mountId', 'filesystem', 'blockBytes', 'blocks', 'inodes', 'backing'])
  const uuid = text(v.uuid), b = object(v.backing, ['path', 'device', 'inode', 'bytes'])
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid)) reject()
  return Object.freeze({ uuid, device: decimal(v.device), inode: decimal(v.inode), mountId: decimal(v.mountId),
    filesystem: decimal(v.filesystem), blockBytes: decimal(v.blockBytes), blocks: decimal(v.blocks), inodes: decimal(v.inodes),
    backing: Object.freeze({ path: text(b.path), device: decimal(b.device), inode: decimal(b.inode), bytes: decimal(b.bytes) }) })
}

/**
 * Decode only bytes already read through the original worker's protected, hash-pinned Root carrier.
 * @param bytes Complete finite proof; the Root publisher binds its original evidence receipts to these bytes.
 * @param observed Recipient PID/start actually measured by that same worker, never taken from the proof itself.
 * @param planSha256 Actual independently pinned current deployment plan.
 * @returns Detached single-record facts capturing this actual receiver; unknown receipts or the prior process refuse.
 */
export function parseRootSkillRevalidation(bytes: Uint8Array, observed: StorageProcessIdentity,
  planSha256: string): RootSkillRevalidationProof {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_invalid) { reject() }
  const v = object(raw, ['schema', 'accountId', 'storageKey', 'workspaceId', 'recordSha256', 'recordRevision',
    'previous', 'retirement', 'lineage'])
  if (v.schema !== 1) reject()
  const previous = generation(v.previous)
  const recipient = Object.freeze({ process: processIdentity(observed), planSha256: digest(planSha256) })
  if (isDeepStrictEqual(previous.process, recipient.process)) reject()
  const retirement = object(v.retirement, ['processExit', 'filesTerminal', 'writersTerminal', 'ownerRecoverySha256'])
  const exit = object(retirement.processExit, ['process', 'kind', 'exitCode', 'receiptSha256'])
  if (exit.kind !== 'normal-exit' || exit.exitCode !== 0 || !isDeepStrictEqual(processIdentity(exit.process), previous.process)) reject()
  digest(exit.receiptSha256); digest(retirement.ownerRecoverySha256)
  const files = object(retirement.filesTerminal, ['kind', 'instanceId', 'epoch', 'pendingOperationIds', 'receiptSha256'])
  if ((files.kind !== 'lane-joined' && files.kind !== 'physical-terminal') || files.instanceId !== previous.instanceId
    || files.epoch !== previous.epoch || !Array.isArray(files.pendingOperationIds) || files.pendingOperationIds.length !== 0) reject()
  digest(files.receiptSha256)
  const writers = object(retirement.writersTerminal, ['kind', 'process', 'receiptSha256'])
  if (writers.kind !== 'complete-scope-terminal' || !isDeepStrictEqual(processIdentity(writers.process), previous.process)) reject()
  digest(writers.receiptSha256)
  const lineage = object(v.lineage, ['oldArchiveSha256', 'oldRetirementSha256', 'oldJournalSha256',
    'newJournalSha256', 'newManifestSha256', 'before', 'after'])
  for (const name of ['oldArchiveSha256', 'oldRetirementSha256', 'oldJournalSha256', 'newJournalSha256', 'newManifestSha256']) {
    digest(lineage[name])
  }
  const before = object(lineage.before, ['private', 'projects']), after = object(lineage.after, ['private', 'projects'])
  const volumes = Object.freeze({ private: volume(after.private), projects: volume(after.projects) })
  if (!isDeepStrictEqual(volume(before.private), volumes.private)
    || !isDeepStrictEqual(volume(before.projects), volumes.projects)) reject()
  const recordRevision = text(v.recordRevision)
  if (!/^-?\d{1,30}(?::-?\d{1,30}){4}$/.test(recordRevision)) reject()
  const storageKey = text(v.storageKey)
  if (!/^v1-[a-f0-9]{64}$/.test(storageKey)) reject()
  return Object.freeze({ accountId: text(v.accountId), storageKey, workspaceId: text(v.workspaceId),
    recordSha256: digest(v.recordSha256), recordRevision, previous, recipient, volumes })
}

/**
 * Match a protected attestation to this original factory input and the already measured current domains.
 * @param proof Root-only pinned facts, never an account-supplied object.
 * @param input Actual factory process/generation, whose lifetime is retained by the original lease.
 * @param account Current independently verified fixed deployment assignment.
 * @returns Nothing; an ended/preceding generation or different backing refuses this record exception only.
 */
export function assertRootSkillRevalidation(proof: RootSkillRevalidationProof, input: AccountMountInput,
  account: StaticStorageAccount): void {
  if (proof.accountId !== input.binding.accountId || proof.accountId !== account.accountId
    || proof.storageKey !== account.storageKey || proof.storageKey !== input.layout.storageKey
    || proof.previous.instanceId === input.instanceId || !/^[1-9][0-9]{0,19}$/.test(input.binding.epoch)
    || BigInt(proof.previous.epoch) >= BigInt(input.binding.epoch) || input.binding.lifetime.aborted) reject()
  const domain = (v: Volume, d: StaticStorageDomain): void => {
    if (v.device !== d.rootDevice || v.inode !== d.rootInode || v.filesystem !== '61267'
      || BigInt(v.blockBytes) * BigInt(v.blocks) !== BigInt(d.minimumBytes) || d.minimumBytes !== d.maximumBytes
      || v.inodes !== d.minimumInodes || d.minimumInodes !== d.maximumInodes || !isDeepStrictEqual(v.backing, d.backing)) reject()
  }
  domain(proof.volumes.private, account.private); domain(proof.volumes.projects, account.projects)
}
