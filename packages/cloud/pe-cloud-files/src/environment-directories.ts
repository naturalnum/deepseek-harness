/** Per-Session roots inside the original finite filesystems; no filesystem or compute slot is created here. */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { DirectoryPrepareOutcome } from './directory-responsibility.ts'
import type { FdRootIdentity, FdEnvironmentLayout } from './worker-protocol.ts'
import type { StaticEnvironmentBank, StaticEnvironmentSlot, StaticStorageDomain, StorageProbeFacts } from './storage-types.ts'
import { environmentQuota, environmentRecordLeaf, parseEnvironmentSlotRecord } from './environment-bank.ts'
import type { EnvironmentBankAuthority, EnvironmentBankState, EnvironmentSessionId, ExecutionMountQuota } from './environment-bank.ts'
import { FdMutationFailure, FdWorkerFailure } from './worker-client.ts'
import { FilesFailure } from './error.ts'

/** One durable logical binding, followed by a CAS-pinned actual directory identity. */
export interface SessionDirectoryRecord {
  readonly schema: 2
  readonly bankId: string
  readonly sessionId: EnvironmentSessionId
  readonly workspaceId: Workspace['id']
  readonly environmentVersion: string
  readonly slotId: string
  readonly slotGeneration: number
  readonly leaf: string
  readonly identity: null | { readonly device: string; readonly inode: string }
}

/** Original closed-FD methods, borrowed in the existing reserved mutation serial section. */
export interface SessionDirectoryIO {
  read(leaf: string): Promise<{ readonly bytes: Uint8Array; readonly version: string } | undefined>
  write(leaf: string, content: string, intent: { readonly kind: 'createIfAbsent' }
    | { readonly kind: 'replaceIfVersion'; readonly version: string }): Promise<void>
  probe(domain: StaticStorageDomain): Promise<StorageProbeFacts>
  prepareLeaf(domain: StaticStorageDomain, leaf: string): Promise<DirectoryPrepareOutcome>
  inspect(domain: StaticStorageDomain, leaf: string): Promise<FdRootIdentity>
  prepareLayout(root: FdRootIdentity): Promise<FdEnvironmentLayout>
}

function refused(message: string, cause?: unknown): FdMutationFailure {
  return new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED', undefined,
    { cause: cause ?? new FilesFailure('files/prerequisite-missing', message) })
}

function capacity(message: string): FdMutationFailure {
  return new FdMutationFailure('not-published', 'FS_TOO_LARGE', 'ENOSPC',
    { cause: new FilesFailure('cloud/capacity', message) })
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function label(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
    && Buffer.byteLength(value) <= maximum && Buffer.from(value).toString('utf8') === value
}

function positive(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
}

/**
 * Address only the current Session's private binding; this never scans historical Sessions.
 * @param bank Original protected bank identifier.
 * @param sessionId Actual native Session identifier, checked against the request before I/O.
 * @returns One bounded basename under the account's original private root.
 */
export function sessionEnvironmentRecordLeaf(bank: StaticEnvironmentBank, sessionId: EnvironmentSessionId): string {
  return `.pe-env-session-${bank.bankId}-${createHash('sha256').update(sessionId).digest('hex')}.json`
}

function record(bytes: Uint8Array, authority: EnvironmentBankAuthority, maximum: number): SessionDirectoryRecord {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (cause) {
    throw refused('Session environment binding is unreadable.', cause)
  }
  const keys = ['schema', 'bankId', 'sessionId', 'workspaceId', 'environmentVersion', 'slotId', 'slotGeneration', 'leaf', 'identity']
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.schema !== 2 || value.bankId !== authority.bank.bankId
    || !label(value.sessionId, maximum) || !label(value.workspaceId, maximum) || !label(value.environmentVersion, maximum)
    || typeof value.slotId !== 'string' || !authority.bank.slots.some(slot => slot.slotId === value.slotId)
    || typeof value.slotGeneration !== 'number' || !Number.isSafeInteger(value.slotGeneration) || value.slotGeneration < 1
    || typeof value.leaf !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.leaf)) {
    throw refused('Session environment binding does not match this bank.')
  }
  const identity = value.identity
  if (identity !== null && (!object(identity) || Object.keys(identity).length !== 2
    || !Object.hasOwn(identity, 'device') || !Object.hasOwn(identity, 'inode') || !positive(identity.device) || !positive(identity.inode))) {
    throw refused('Session environment binding has no valid directory identity.')
  }
  return Object.freeze({ schema: 2, bankId: authority.bank.bankId, sessionId: value.sessionId as EnvironmentSessionId,
    workspaceId: value.workspaceId as Workspace['id'], environmentVersion: value.environmentVersion, slotId: value.slotId,
    slotGeneration: value.slotGeneration, leaf: value.leaf,
    identity: identity === null ? null : Object.freeze({ device: identity.device as string, inode: identity.inode as string }) })
}

function aborted(cause: unknown): boolean {
  return cause instanceof FdWorkerFailure && cause.code === 'FS_ABORTED'
    && (!(cause instanceof FdMutationFailure) || cause.outcome === 'not-published')
}

/**
 * Prepare one persistent Session directory without consuming an entire preprovisioned filesystem.
 * @param io Same original worker and closed-FD methods under the existing mutation reservation.
 * @param authority Protected account bank; its old slot records are never rewritten.
 * @param state Current bank refusal latch; uncertain mutations remain owned and refuse new grants.
 * @param request Exact native Session/workspace membership and approved environment version.
 * @param maximum Existing bounded metadata/path ceiling.
 * @param current Original graph and actual-operation cancellation guard.
 * @returns A verified child root, original physical quota and positively checked writable layout.
 */
export async function prepareSessionEnvironmentDirectory(
  io: SessionDirectoryIO, authority: EnvironmentBankAuthority, state: EnvironmentBankState,
  request: {
    readonly sessionId: EnvironmentSessionId
    readonly workspaceId: Workspace['id']
    readonly environmentVersion: string
  },
  maximum: number, current: () => void,
): Promise<{
  readonly slot: StaticEnvironmentSlot
  readonly record: SessionDirectoryRecord
  readonly root: FdRootIdentity
  readonly quota: ExecutionMountQuota
  readonly layout: FdEnvironmentLayout
}> {
  if (state.blocked) throw refused('Environment bank requires ownership reconciliation.')
  if (authority.bank.mode !== 'session-directories'
    || ![request.sessionId, request.workspaceId, request.environmentVersion].every(value => label(value, maximum))) {
    throw refused('Session directory mode or native membership is invalid.')
  }
  const leaf = sessionEnvironmentRecordLeaf(authority.bank, request.sessionId)
  const entries: { slot: StaticEnvironmentSlot; generation: number }[] = []
  const sessions = new Set<string>()
  let legacySlotId: string | undefined
  let saved: Awaited<ReturnType<SessionDirectoryIO['read']>>
  let binding: SessionDirectoryRecord | undefined
  try {
    for (const slot of authority.bank.slots) {
      current()
      const input = await io.read(environmentRecordLeaf(authority.bank, slot))
      if (input === undefined) throw refused('Original environment pool record is missing.')
      const old = parseEnvironmentSlotRecord(input.bytes, authority.bank, slot, maximum)
      if (old.state === 'bound') {
        if (sessions.has(old.sessionId)) throw refused('Environment bank has duplicate retained Session ownership.')
        sessions.add(old.sessionId)
        if (old.sessionId === request.sessionId) {
          if (old.workspaceId !== request.workspaceId || old.environmentVersion !== request.environmentVersion) {
            throw refused('Retained Session environment membership or version changed.')
          }
          legacySlotId = old.slotId
        }
      }
      entries.push({ slot, generation: old.slotGeneration })
    }
    current()
    saved = await io.read(leaf)
    if (saved !== undefined) binding = record(saved.bytes, authority, maximum)
  } catch (cause) {
    if (!aborted(cause)) state.blocked = true
    throw refused('Session environment records require reconciliation.', cause)
  }
  if (binding !== undefined && (binding.sessionId !== request.sessionId || binding.workspaceId !== request.workspaceId
    || binding.environmentVersion !== request.environmentVersion)) throw refused('Retained Session environment membership or version changed.')
  if (legacySlotId !== undefined && (binding === undefined || binding.identity === null || binding.slotId !== legacySlotId)) {
    throw refused('This retained Session environment requires explicit directory migration.')
  }
  const retainedSlotId = binding?.slotId
  let selected = retainedSlotId === undefined ? undefined : entries.find(entry => entry.slot.slotId === retainedSlotId)
  if (binding !== undefined && (selected === undefined || selected.generation !== binding.slotGeneration)) {
    state.blocked = true
    throw refused('Retained Session environment pool generation changed.')
  }
  let quota: ExecutionMountQuota | undefined
  let mostAvailable = -1n
  try {
    for (const entry of selected === undefined ? entries : [selected]) {
      current()
      const facts = await io.probe(entry.slot.domain), measured = environmentQuota(entry.slot.domain, facts, authority)
      if (binding !== undefined) { quota = measured; break }
      // The leaf and its three fixed directories need four positive inode/block opportunities.
      const available = BigInt(facts.availableBlocks) * BigInt(facts.blockBytes)
      if (BigInt(facts.availableBlocks) >= 4n && BigInt(facts.freeInodes) >= 4n && available > mostAvailable) {
        selected = entry; quota = measured; mostAvailable = available
      }
    }
  } catch (cause) {
    if (!aborted(cause)) state.blocked = true
    throw refused('Session environment pool storage verification failed.', cause)
  }
  if (selected === undefined || quota === undefined) throw capacity('The existing environment filesystems have insufficient free space or inodes.')
  if (binding === undefined) {
    binding = Object.freeze({ schema: 2, bankId: authority.bank.bankId, ...request, slotId: selected.slot.slotId,
      slotGeneration: selected.generation, leaf: randomUUID(), identity: null })
    current()
    try {
      await io.write(leaf, JSON.stringify(binding), { kind: 'createIfAbsent' })
      current()
      saved = await io.read(leaf)
      if (saved === undefined || JSON.stringify(record(saved.bytes, authority, maximum)) !== JSON.stringify(binding)) {
        throw refused('The new Session environment binding was not read back exactly.')
      }
    } catch (cause) {
      if (!(cause instanceof FdMutationFailure) || cause.outcome === 'unknown' || cause.code === 'FS_STALE_VERSION'
        || cause.code === 'FS_NOT_OBSERVED') state.blocked = true
      throw cause
    }
  }
  const fixed = binding
  let createdIdentity: { readonly device: string; readonly inode: string } | undefined
  current()
  if (fixed.identity === null) {
    let prepared: DirectoryPrepareOutcome
    try { prepared = await io.prepareLeaf(selected.slot.domain, fixed.leaf) } catch (cause) {
      state.blocked = true
      throw cause
    }
    if (prepared.kind === 'not-created-failure') {
      if (prepared.failure.errno === 28 || prepared.failure.errno === 122) throw capacity('The existing environment filesystem has insufficient free space or inodes.')
      throw new FdMutationFailure('not-published', prepared.failure.errno === 125 ? 'FS_ABORTED' : 'FS_IO_ERROR')
    }
    if (prepared.kind !== 'created' && prepared.kind !== 'unchanged') {
      state.blocked = true
      throw new FdMutationFailure('unknown', 'FS_IO_ERROR')
    }
    if (prepared.kind === 'created') createdIdentity = prepared.identity
  }
  current()
  let root: FdRootIdentity, layout: FdEnvironmentLayout
  try {
    root = await io.inspect(selected.slot.domain, fixed.leaf)
    if (root.rootPath !== posix.join(selected.slot.domain.rootPath, fixed.leaf)
      || root.rootDevice !== selected.slot.domain.rootDevice || root.rootMountId !== selected.slot.domain.rootMountId
      || !positive(root.rootDevice) || !positive(root.rootInode)
      || createdIdentity !== undefined && (root.rootDevice !== createdIdentity.device || root.rootInode !== createdIdentity.inode)
      || fixed.identity !== null && (root.rootDevice !== fixed.identity.device || root.rootInode !== fixed.identity.inode)) {
      throw refused('Retained Session environment directory identity changed.')
    }
    current()
    layout = await io.prepareLayout(root)
    current()
  } catch (cause) {
    if (!aborted(cause)) state.blocked = true
    throw cause
  }
  if (fixed.identity === null) {
    if (saved === undefined) { state.blocked = true; throw refused('Session environment binding version is unavailable.') }
    const pinned = Object.freeze({ ...fixed, identity: Object.freeze({ device: root.rootDevice, inode: root.rootInode }) })
    try { await io.write(leaf, JSON.stringify(pinned), { kind: 'replaceIfVersion', version: saved.version }) } catch (cause) {
      state.blocked = true
      throw cause
    }
    binding = pinned
  }
  return Object.freeze({ slot: selected.slot, record: binding, root, quota, layout })
}
