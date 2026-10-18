/** Strict static-record and fixed ABI1 decoding shared by the root owner and worker transport. */
import { posix } from 'node:path'
import type { StaticStorageAccount, StaticStorageAuxiliary, StaticStorageBacking, StaticStorageConfig,
  StaticStorageDomain, StaticStoragePlan, StorageProbeFacts } from './storage-types.ts'
import { FilesFailure } from './error.ts'

function invalid(): never { throw new FilesFailure('files/prerequisite-missing', 'Static storage facts are invalid or unavailable.') }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) invalid()
  return value
}
function path(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\\')
    || value.length > max || Buffer.byteLength(value) > max || posix.normalize(value) !== value || (value !== '/' && value.endsWith('/'))) invalid()
  return value
}
function backing(value: unknown, max: number): StaticStorageBacking {
  const v = shape(value, ['path', 'device', 'inode', 'bytes'])
  return Object.freeze({ path: path(v.path, max), device: decimal(v.device), inode: decimal(v.inode), bytes: decimal(v.bytes) })
}
function domain(value: unknown, max: number): StaticStorageDomain {
  const v = shape(value, ['rootPath', 'rootDevice', 'rootInode', 'rootMountId', 'minimumBytes', 'maximumBytes',
    'minimumInodes', 'maximumInodes', 'backing'])
  const result = { rootPath: path(v.rootPath, max), rootDevice: decimal(v.rootDevice), rootInode: decimal(v.rootInode),
    rootMountId: decimal(v.rootMountId), minimumBytes: decimal(v.minimumBytes), maximumBytes: decimal(v.maximumBytes),
    minimumInodes: decimal(v.minimumInodes), maximumInodes: decimal(v.maximumInodes), backing: backing(v.backing, max) }
  if (result.rootInode !== '2' || BigInt(result.minimumBytes) > BigInt(result.maximumBytes)
    || BigInt(result.minimumInodes) > BigInt(result.maximumInodes)) invalid()
  return Object.freeze(result)
}
function account(value: unknown, max: number): StaticStorageAccount {
  const v = shape(value, ['accountId', 'storageKey', 'accountRoot', 'private', 'projects'])
  if (typeof v.accountId !== 'string' || v.accountId.length === 0 || Buffer.byteLength(v.accountId) > max
    || typeof v.storageKey !== 'string' || !/^v1-[a-f0-9]{64}$/.test(v.storageKey)) invalid()
  return Object.freeze({ accountId: v.accountId as StaticStorageAccount['accountId'],
    storageKey: v.storageKey as StaticStorageAccount['storageKey'], accountRoot: path(v.accountRoot, max),
    private: domain(v.private, max), projects: domain(v.projects, max) })
}

/**
 * Decode only the bounded root deployment record; unknown fields cannot become approval switches.
 * @param bytes Exact bytes already read through the protected-record operation.
 * @param maxPathBytes Existing pool path bound.
 * @returns Detached fixed two-account selectors; live kernel verification remains mandatory.
 */
export function parseStaticStoragePlan(bytes: Uint8Array, maxPathBytes: number): StaticStoragePlan {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_error) { invalid() }
  const v = shape(raw, ['version', 'recipeVersion', 'appUid', 'appGid', 'arenaReserveBytes', 'arena', 'control',
    'accounts', 'baseConfigPath', 'installAnchor', 'auxiliary'])
  if (v.version !== 1 || typeof v.recipeVersion !== 'string' || v.recipeVersion.length < 1 || v.recipeVersion.length > 128
    || typeof v.appUid !== 'number' || !Number.isSafeInteger(v.appUid) || v.appUid < 1 || v.appUid > 4294967295
    || typeof v.appGid !== 'number' || !Number.isSafeInteger(v.appGid) || v.appGid < 1 || v.appGid > 4294967295
    || !Array.isArray(v.accounts) || v.accounts.length !== 2 || !Array.isArray(v.auxiliary) || v.auxiliary.length > 8) invalid()
  const a = account(v.accounts[0], maxPathBytes), b = account(v.accounts[1], maxPathBytes)
  if (a.accountId === b.accountId || a.storageKey === b.storageKey || a.accountRoot === b.accountRoot) invalid()
  const auxiliary: StaticStorageAuxiliary[] = v.auxiliary.map((entry: unknown) => {
    const item = shape(entry, ['path', 'maximumBytes', 'maximumInodes'])
    return Object.freeze({ path: path(item.path, maxPathBytes),
      maximumBytes: decimal(item.maximumBytes), maximumInodes: decimal(item.maximumInodes) })
  })
  return Object.freeze({ version: 1, recipeVersion: v.recipeVersion, appUid: v.appUid, appGid: v.appGid,
    arenaReserveBytes: decimal(v.arenaReserveBytes), arena: domain(v.arena, maxPathBytes), control: domain(v.control, maxPathBytes),
    accounts: Object.freeze([a, b] as const), baseConfigPath: path(v.baseConfigPath, maxPathBytes),
    installAnchor: path(v.installAnchor, maxPathBytes), auxiliary: Object.freeze(auxiliary) })
}

/**
 * Validate the exact fixed closed-FD binary result without pooled/partial buffers.
 * @param value Raw worker/native response.
 * @returns Measured facts, or undefined for a fatal wire/close failure.
 */
export function parseStorageProbeFrame(value: unknown): StorageProbeFacts | undefined {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
    || value.byteOffset !== 0 || value.byteLength !== 256 || value.buffer.byteLength !== 256) return undefined
  const v = new DataView(value.buffer), flags = v.getUint8(6)
  if (v.getUint32(0, false) !== 0x44535031 || value[4] !== 1 || value[5] !== 1 || value[7] !== 0
    || flags > 63 || (flags & 1) === 0 || v.getUint32(8, true) !== 0 || value.subarray(136).some(byte => byte !== 0)) return undefined
  const number = (offset: number) => v.getBigUint64(offset, true).toString()
  return Object.freeze({ flags, uid: v.getUint32(12, true), gid: v.getUint32(16, true), mode: v.getUint32(20, true),
    appUid: v.getUint32(24, true), appGid: v.getUint32(28, true), device: number(32), inode: number(40), mountId: number(48),
    filesystem: number(56), blockBytes: number(64), blocks: number(72), freeBlocks: number(80), availableBlocks: number(88),
    inodes: number(96), freeInodes: number(104), size: number(112), allocatedBytes: number(120), links: number(128) })
}

/**
 * Reserve retained root plan/facts and one probe's complete clone/decoder/native scratch peak.
 * @param config Explicit deployment parser, asset and root reservation bounds.
 * @param maxPathBytes Existing pool path limit.
 * @param workerCount Fixed prestarted slots loading the pinned probe asset.
 * @returns The required positive global root reservation; insufficient configured capacity rejects.
 */
export function staticStorageReservation(config: StaticStorageConfig, maxPathBytes: number, workerCount = 1): number {
  for (const n of [config.maxPlanBytes, config.maxMountInfoBytes, config.maxProbeAssetBytes,
    config.rootProbeReservationBytes, config.probeTimeoutMs]) {
    if (!Number.isSafeInteger(n) || n < 1) invalid()
  }
  if (config.maxPlanBytes > 262144 || config.maxMountInfoBytes > 1048576 || config.maxProbeAssetBytes > 4194304
    || config.probeTimeoutMs > 2147483647 || !/^[a-f0-9]{64}$/.test(config.planSha256)
    || !/^[a-f0-9]{64}$/.test(config.probeHelperSha256)) invalid()
  path(config.planPath, maxPathBytes); path(config.probeHelperPath, maxPathBytes)
  const bytes = 8 * config.maxPlanBytes + 64 * config.maxMountInfoBytes
    + 2 * config.maxProbeAssetBytes * workerCount + 8 * maxPathBytes + 16384
  if (!Number.isSafeInteger(bytes) || config.rootProbeReservationBytes < bytes) invalid()
  return config.rootProbeReservationBytes
}
