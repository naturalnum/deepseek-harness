/** Optional Linux root probe implementation; blocking filesystem and bounded proc reads stay on an existing worker. */
import { constants, openSync, readSync, closeSync, fstatSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import type { StaticStorageConfig } from './storage-types.ts'
import type { ProtectedSkillProof } from './storage-types.ts'
import type { FdStorageRequest, FdStorageView } from './worker-protocol.ts'
import { parseStorageProbeFrame, staticStorageReservation } from './storage-probe.ts'

interface NativeStorageProbe {
  readonly abiVersion: 1
  probe(path: string, maxPathBytes: number): unknown
  readRecord(path: string, maximum: number, maxPathBytes: number): unknown
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function isNative(value: unknown): value is NativeStorageProbe {
  return record(value) && value.abiVersion === 1 && typeof value.probe === 'function' && typeof value.readRecord === 'function'
}
function failed(): never { throw new Error('Root storage probe is unavailable.') }
function exact(value: unknown, limit: number): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.byteOffset === 0
    && value.byteLength === value.buffer.byteLength && value.byteLength > 0 && value.byteLength <= limit
}

function readBounded(path: string, limit: number, protectedAsset: boolean): Uint8Array<ArrayBuffer> {
  if (protectedAsset) {
    let current = '/'
    for (const part of path.slice(1).split('/')) {
      current = posix.join(current, part)
      const info = lstatSync(current)
      if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink()
        || (current !== path && !info.isDirectory()) || (current === path && (!info.isFile() || info.nlink !== 1))) failed()
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (protectedAsset && (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.nlink !== 1 || info.size > limit)) failed()
    const bytes = new Uint8Array(limit + 1)
    let total = 0
    for (;;) {
      const count = readSync(fd, bytes, total, bytes.byteLength - total, null)
      if (count === 0) break
      total += count
      if (total > limit) failed()
    }
    const result = new Uint8Array(total)
    result.set(bytes.subarray(0, total))
    return result
  } finally { closeSync(fd) }
}

/**
 * Load only a root-protected, hash-pinned ABI1 asset in a non-root Linux application view.
 * @param config Root deployment parser, path and resident bounds.
 * @param maxPathBytes Existing pool path bound.
 * @param fileHelperPath Existing ABI6 helper; protection is checked before loading its code.
 * @returns Fixed helper operations; a close error or malformed fact is fatal to its worker.
 */
export function createStorageWorker(config: StaticStorageConfig, maxPathBytes: number, fileHelperPath: string): {
  probe(path: string): Uint8Array<ArrayBuffer>
  record(): Uint8Array<ArrayBuffer>
  skillProof(): ProtectedSkillProof
  view(): FdStorageView
} {
  staticStorageReservation(config, maxPathBytes)
  if (process.platform !== 'linux' || process.getuid?.() === 0 || process.geteuid?.() === 0) failed()
  if (posix.normalize(fileHelperPath) !== fileHelperPath || !fileHelperPath.startsWith('/')) failed()
  readBounded(fileHelperPath, config.maxProbeAssetBytes, true)
  const asset = readBounded(config.probeHelperPath, config.maxProbeAssetBytes, true)
  if (createHash('sha256').update(asset).digest('hex') !== config.probeHelperSha256) failed()
  const loaded: unknown = createRequire(import.meta.url)(config.probeHelperPath)
  if (!isNative(loaded)) failed()
  const native = loaded
  return {
    probe: (path) => {
      const value = native.probe(path, maxPathBytes)
      if (!exact(value, 256) || parseStorageProbeFrame(value) === undefined) failed()
      return value
    },
    record: () => {
      const value = native.readRecord(config.planPath, config.maxPlanBytes, maxPathBytes)
      if (!exact(value, config.maxPlanBytes) || createHash('sha256').update(value).digest('hex') !== config.planSha256) failed()
      return value
    },
    skillProof: () => {
      const selected = config.skillRevalidation
      if (selected === undefined) failed()
      const bytes = native.readRecord(selected.proofPath, config.maxPlanBytes, maxPathBytes)
      if (!exact(bytes, config.maxPlanBytes) || createHash('sha256').update(bytes).digest('hex') !== selected.proofSha256) failed()
      const stat = new TextDecoder('utf-8', { fatal: true }).decode(readBounded('/proc/self/stat', config.maxMountInfoBytes, false))
      const end = stat.lastIndexOf(')'), startTicks = stat.slice(end + 1).trim().split(/\s+/)[19]
      if (end < 1 || !stat.startsWith(String(process.pid) + ' (') || startTicks === undefined || !/^[1-9][0-9]{0,19}$/.test(startTicks)) failed()
      return { bytes, process: { pid: process.pid, startTicks } }
    },
    view: () => ({ mountInfo: readBounded('/proc/self/mountinfo', config.maxMountInfoBytes, false),
      status: readBounded('/proc/self/status', config.maxMountInfoBytes, false) }),
  }
}

/**
 * Validate a private root command at the worker boundary.
 * @param raw Incoming structured clone.
 * @param maxPathBytes Existing path bound.
 * @returns Only a bounded versioned operation; invalid requests terminate the worker.
 */
export function storageRequest(raw: unknown, maxPathBytes: number): FdStorageRequest {
  if (!record(raw) || !['storage-probe', 'storage-record', 'storage-skill-proof', 'storage-view'].includes(String(raw.kind))
    || typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id)
    || !(raw.cancel instanceof SharedArrayBuffer) || raw.cancel.byteLength !== 4) failed()
  const base = { id: raw.id as FdStorageRequest['id'], cancel: raw.cancel }
  if (raw.kind === 'storage-record' || raw.kind === 'storage-skill-proof' || raw.kind === 'storage-view') return { ...base, kind: raw.kind }
  if (typeof raw.path !== 'string' || !raw.path.startsWith('/') || raw.path.includes('\0') || raw.path.includes('\\')
    || raw.path.length > maxPathBytes || Buffer.byteLength(raw.path) > maxPathBytes || posix.normalize(raw.path) !== raw.path) failed()
  return { ...base, kind: 'storage-probe', path: raw.path }
}
