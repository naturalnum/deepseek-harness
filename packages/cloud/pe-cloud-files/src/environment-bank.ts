/** Fixed private ownership records for a finite preprovisioned bank; execution allocations remain execution-owned. */
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { FdProjectMetadataDirectory, FdEnvironmentLayout } from './worker-protocol.ts'
import type { StaticEnvironmentBank, StaticEnvironmentSlot, StaticStorageDomain, StorageProbeFacts } from './storage-types.ts'
import { FdMutationFailure, FdWorkerFailure } from './worker-client.ts'
import { FilesFailure } from './error.ts'

/** Original native identity; a string supplied without Root's actual Session check grants no authority. */
export type EnvironmentSessionId = Workspace['sessionIds'][number]

/** Durable slot ownership is independent of a compute allocation or graph epoch. */
export type EnvironmentSlotRecord = {
  readonly schema: 1
  readonly bankId: string
  readonly slotId: string
  readonly slotGeneration: number
} & ({ readonly state: 'free' } | {
  readonly state: 'bound'
  readonly sessionId: EnvironmentSessionId
  readonly workspaceId: Workspace['id']
  readonly environmentVersion: string
})

/** Original parsed bank and deployment identity, captured only by the actual storage lease. */
export interface EnvironmentBankAuthority {
  readonly bank: StaticEnvironmentBank
  readonly appUid: number
  readonly appGid: number
  readonly projects: StaticStorageDomain
}

/** A mismatch closes the bank to new grants; it never guesses which unreadable slot was free. */
export interface EnvironmentBankState { blocked: boolean }

/** Existing same-slot ABI operations; all callbacks settle actual native descriptor ownership. */
export interface EnvironmentBankIO {
  read(leaf: string): Promise<{ readonly bytes: Uint8Array; readonly version: string }>
  write(leaf: string, content: string, version: string): Promise<void>
  probe(domain: StaticStorageDomain): Promise<StorageProbeFacts>
  prepareLayout(domain: StaticStorageDomain): Promise<FdEnvironmentLayout>
}

/** Physical limits are measured filesystem geometry, independent of current free-space telemetry. */
export interface ExecutionMountQuota {
  readonly device: string
  readonly mountId: string
  readonly maximumBytes: string
  readonly maximumInodes: string
}

/** In-process files grant; only the issuing CloudAccountFiles accepts its exact object identity. */
export interface ExecutionMountGrant {
  readonly binding: AccountBinding
  readonly sessionId: EnvironmentSessionId
  readonly workspaceId: Workspace['id']
  readonly project: FdRootIdentity & {
    readonly mountVersion: string
    readonly quota: ExecutionMountQuota
    readonly readOnlyPaths: readonly ['.pe']
    readonly metadataDirectory: FdProjectMetadataDirectory & { readonly relativePath: '.pe' }
  }
  readonly environment: FdRootIdentity & {
    readonly targetPath: '/opt/session-env'
    readonly bankId: string
    readonly slotId: string
    readonly slotGeneration: number
    readonly environmentVersion: string
    readonly quota: ExecutionMountQuota
    readonly rootReadOnly: true
    readonly writablePaths: readonly ['home', 'venv', 'tmp']
    readonly layout: FdEnvironmentLayout
  }
}

/**
 * Reserve all retained records, JSON/UTF-16 copies, atomic old/new buffers, paths and bounded reply overhead.
 * @param count Original finite bank inventory length.
 * @param bounds Existing pool bounds; no deployment capacity is inferred or defaulted.
 * @returns One conservative positive resident reservation; this does not bound whole-process RSS.
 */
export function environmentWorkBytes(count: number, bounds: {
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly replyOverheadBytes: number
  readonly maxResidentBytesPerLane: number
}): number {
  // Additional fixed-directory paths, C scratch (native static assertion), four receipt copies and decoded facts.
  const metadataBytes = 12 * (bounds.maxPathBytes + 1) + 4096 + 4 * 96 + 8 * bounds.replyOverheadBytes
  const layoutBytes = 12 * (bounds.maxPathBytes + 1) + 4096 + 4 * 256 + 24 * bounds.replyOverheadBytes
  const bytes = 16 * (count + 2) * (bounds.maxReadBytes + bounds.maxPathBytes)
    + 8 * (count + 4) * bounds.replyOverheadBytes + metadataBytes + layoutBytes
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > bounds.maxResidentBytesPerLane) {
    throw new FilesFailure('cloud/capacity', 'Environment metadata exceeds the original lane reservation.')
  }
  return bytes
}

function refused(message: string, cause?: unknown): FdMutationFailure {
  return new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED', undefined,
    { cause: cause ?? new FilesFailure('files/prerequisite-missing', message) })
}

function label(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !value.includes('\0') && Buffer.byteLength(value) <= maximum && Buffer.from(value).toString('utf8') === value
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Derive one fixed private leaf from protected identifiers; callers cannot supply a private path.
 * @param bank Original parsed bank.
 * @param slot Its original finite inventory entry.
 * @returns A direct child of the captured private anchor.
 */
export function environmentRecordLeaf(bank: StaticEnvironmentBank, slot: StaticEnvironmentSlot): string {
  return `.pe-env-${bank.bankId}-${slot.slotId}.json`
}

/**
 * Parse one bounded original slot record, including retained legacy Session membership.
 * @param bytes Exact stable private record read.
 * @param bank Protected finite bank selector.
 * @param slot Original pool entry whose generation must remain unchanged.
 * @param maximum Existing bounded membership string ceiling.
 * @returns The closed schema-one record; no ownership is inferred from a directory name.
 */
export function parseEnvironmentSlotRecord(
  bytes: Uint8Array, bank: StaticEnvironmentBank, slot: StaticEnvironmentSlot, maximum: number,
): EnvironmentSlotRecord {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (cause) {
    throw refused('Environment ownership record is unreadable.', cause)
  }
  if (!object(raw)) throw refused('Environment ownership record is invalid.')
  const value = raw
  const keys = ['schema', 'bankId', 'slotId', 'slotGeneration', 'state',
    ...value.state === 'bound' ? ['sessionId', 'workspaceId', 'environmentVersion'] : []]
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.schema !== 1 || value.bankId !== bank.bankId || value.slotId !== slot.slotId
    || typeof value.slotGeneration !== 'number' || !Number.isSafeInteger(value.slotGeneration) || value.slotGeneration < 1) {
    throw refused('Environment ownership record does not match this bank slot.')
  }
  const base = { schema: 1 as const, bankId: bank.bankId, slotId: slot.slotId, slotGeneration: value.slotGeneration }
  if (value.state === 'free') return Object.freeze({ ...base, state: 'free' })
  if (value.state !== 'bound' || !label(value.sessionId, maximum) || !label(value.workspaceId, maximum)
    || !label(value.environmentVersion, maximum)) throw refused('Environment ownership record has invalid membership.')
  return Object.freeze({ ...base, state: 'bound', sessionId: value.sessionId as EnvironmentSessionId,
    workspaceId: value.workspaceId as Workspace['id'], environmentVersion: value.environmentVersion })
}

/**
 * Recheck the actual selected filesystem with the existing closed-FD probe, without granting a path.
 * @param domain Original verified deployment selector.
 * @param observed Actual probe result from the borrowed worker.
 * @param authority Original storage-lease identity.
 * @returns Measured immutable physical byte/inode limits.
 */
export function environmentQuota(
  domain: StaticStorageDomain, observed: StorageProbeFacts, authority: Pick<EnvironmentBankAuthority, 'appUid' | 'appGid'>,
): ExecutionMountQuota {
  const bytes = BigInt(observed.blockBytes) * BigInt(observed.blocks)
  if ((observed.mode & 0o177777) !== 0o40700 || observed.uid !== authority.appUid || observed.gid !== authority.appGid
    || observed.appUid !== authority.appUid || observed.appGid !== authority.appGid
    || (observed.flags & 63) !== 31 || observed.filesystem !== '61267'
    || observed.device !== domain.rootDevice || observed.inode !== domain.rootInode || observed.mountId !== domain.rootMountId
    || bytes < BigInt(domain.minimumBytes) || bytes > BigInt(domain.maximumBytes)
    || BigInt(observed.inodes) < BigInt(domain.minimumInodes) || BigInt(observed.inodes) > BigInt(domain.maximumInodes)) {
    throw refused('Environment storage identity or hard limits changed.')
  }
  return Object.freeze({ device: observed.device, mountId: observed.mountId,
    maximumBytes: String(bytes), maximumInodes: observed.inodes })
}

/**
 * Read every bounded private record and confirm one binding before any SDK create may occur.
 * @param io Same original worker/positive mutation reservation; never a second scheduler.
 * @param authority Protected bank with actual deployment identity.
 * @param state Original account bank refusal latch, accessed only in the mutation serial section.
 * @param request Root-authorized native membership and approved environment version.
 * @param maximum Existing finite metadata/path string ceiling.
 * @param current Exact original project/graph guard plus actual cancellation before I/O.
 * @returns A confirmed retained binding; a late confirmed write stays bound even if its observer left.
 */
export async function prepareEnvironmentSlot(
  io: EnvironmentBankIO, authority: EnvironmentBankAuthority, state: EnvironmentBankState,
  request: {
    readonly sessionId: EnvironmentSessionId
    readonly workspaceId: Workspace['id']
    readonly environmentVersion: string
  },
  maximum: number, current: () => void,
): Promise<{ readonly slot: StaticEnvironmentSlot
  readonly record: EnvironmentSlotRecord & { readonly state: 'bound' }
  readonly quota: ExecutionMountQuota
  readonly layout: FdEnvironmentLayout }> {
  if (state.blocked) throw refused('Environment bank requires ownership reconciliation.')
  if (![request.sessionId, request.workspaceId, request.environmentVersion].every(value => label(value, maximum))) {
    throw refused('Environment membership or version exceeds its existing bound.')
  }
  const entries: { slot: StaticEnvironmentSlot; record: EnvironmentSlotRecord; version: string }[] = []
  const sessions = new Set<string>()
  try {
    for (const slot of authority.bank.slots) {
      current()
      const input = await io.read(environmentRecordLeaf(authority.bank, slot))
      const parsed = parseEnvironmentSlotRecord(input.bytes, authority.bank, slot, maximum)
      if (parsed.state === 'bound') {
        if (sessions.has(parsed.sessionId)) throw refused('Environment bank has duplicate Session ownership.')
        sessions.add(parsed.sessionId)
      }
      entries.push({ slot, record: parsed, version: input.version })
    }
  } catch (cause) {
    if (!(cause instanceof FdWorkerFailure && cause.code === 'FS_ABORTED')) state.blocked = true
    throw refused('Environment bank records require reconciliation.', cause)
  }
  const existing = entries.find(entry => entry.record.state === 'bound' && entry.record.sessionId === request.sessionId)
  if (existing?.record.state === 'bound'
    && (existing.record.workspaceId !== request.workspaceId || existing.record.environmentVersion !== request.environmentVersion)) {
    throw refused('The retained Session environment needs explicit stop and cleanup before replacement.')
  }
  const chosen = existing ?? entries.find(entry => entry.record.state === 'free')
  if (chosen === undefined) throw new FdMutationFailure('not-published', 'FS_TOO_LARGE', undefined,
    { cause: new FilesFailure('cloud/capacity', 'No explicitly free environment slot is available.') })
  current()
  let quota: ExecutionMountQuota
  try { quota = environmentQuota(chosen.slot.domain, await io.probe(chosen.slot.domain), authority) } catch (cause) {
    if (!(cause instanceof FdWorkerFailure && cause.code === 'FS_ABORTED')) state.blocked = true
    throw refused('Environment slot storage verification failed.', cause)
  }
  current()
  let layout: FdEnvironmentLayout
  try { layout = await io.prepareLayout(chosen.slot.domain) } catch (cause) {
    if (!(cause instanceof FdMutationFailure && cause.outcome === 'not-published' && cause.code === 'FS_ABORTED')) state.blocked = true
    throw cause
  }
  current()
  const bound = Object.freeze({ schema: 1 as const, bankId: authority.bank.bankId, slotId: chosen.slot.slotId,
    slotGeneration: chosen.record.slotGeneration, state: 'bound' as const, ...request })
  if (chosen.record.state === 'free') {
    current()
    try { await io.write(environmentRecordLeaf(authority.bank, chosen.slot), JSON.stringify(bound), chosen.version) } catch (cause) {
      if (!(cause instanceof FdMutationFailure) || cause.outcome === 'unknown' || cause.code === 'FS_STALE_VERSION') state.blocked = true
      throw cause
    }
  }
  // A confirmed atomic write is retained on disk even when observation was cancelled during its reply.
  return Object.freeze({ slot: chosen.slot, record: bound, quota, layout })
}
