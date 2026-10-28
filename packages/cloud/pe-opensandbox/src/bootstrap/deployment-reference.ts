/** Root-owned readonly file leases bind deployment selection and policy, never server liveness. */
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { BootstrapFailure } from './bootstrap.ts'

/** Explicit protected Root file and exact approved bytes; no environment/default lookup. */
export interface RootDeploymentReference {
  readonly path: string
  readonly sha256: string
}
function need(value: boolean): asserts value { if (!value) throw new BootstrapFailure('binding') }
function bounded(fd: number, maximum: number): Buffer {
  const bytes = Buffer.alloc(maximum + 1)
  let size = 0
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, size)
    if (!count) break
    size += count
  }
  need(size <= maximum)
  return bytes.subarray(0, size)
}
function proc(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bounded(fd, maximum)) }
  finally { closeSync(fd) }
}
function parents(path: string): void {
  let current = '/'
  const root = lstatSync(current, { bigint: true })
  need(root.isDirectory() && root.uid === 0n && (root.mode & 0o022n) === 0n)
  for (const part of posix.dirname(path).split('/').filter(Boolean)) {
    current = posix.join(current, part)
    const info = lstatSync(current, { bigint: true })
    need(info.isDirectory() && info.uid === 0n && (info.mode & 0o022n) === 0n)
  }
}
function readonlyMount(path: string, fd: number): void {
  const match = /^mnt_id:\s+([1-9]\d{0,19})$/m.exec(proc(`/proc/self/fdinfo/${fd}`, 4096))
  need(match?.[1] !== undefined)
  const rows = proc('/proc/self/mountinfo', 1048576).split('\n').filter(Boolean)
  need(rows.length > 0 && rows.length <= 8192)
  let selected: { id: string; path: string; readonly: boolean } | undefined
  for (const line of rows) {
    const sides = line.split(' - '), fields = sides[0]?.split(' ')
    need(sides.length === 2 && fields !== undefined && fields.length >= 6)
    const id = fields[0], encoded = fields[4], flags = fields[5]
    need(id !== undefined && encoded !== undefined && flags !== undefined && /^[1-9]\d{0,19}$/.test(id))
    const mount = encoded.replace(/\\(040|011|012|134)/g, (_all, code: string) => String.fromCharCode(parseInt(code, 8)))
    if ((path === mount || path.startsWith(mount === '/' ? '/' : mount + '/'))
      && (selected === undefined || mount.length > selected.path.length)) {
      const options = flags.split(',')
      selected = { id, path: mount, readonly: options.includes('ro') && !options.includes('rw') }
    }
  }
  need(selected !== undefined && selected.readonly && selected.id === match[1])
}
function identity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

/** A retained original file selection. Revocation denies use; it does not attest server/keeper/process survival. */
export class RootDeploymentLease {
  private fd: number | undefined
  private readonly initial: BigIntStats
  private readonly originalBytes: Buffer
  private closeFailure?: BootstrapFailure
  /**
   * Open one protected readonly deployment file, keeping its original descriptor until actual Root cleanup.
   * @param reference Original explicit Root path/SHA.
   * @param maximum Hard byte bound: configuration/export at most128KiB, existing files plan at most256KiB.
   * @param kind Protected configuration, legacy export manifest or the existing files storage plan.
   */
  constructor(private readonly reference: RootDeploymentReference, private readonly maximum: number,
    kind: 'configuration' | 'export-manifest' | 'storage-plan') {
    need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= (kind === 'storage-plan' ? 262144 : 131072)
      && reference.path.startsWith('/') && posix.normalize(reference.path) === reference.path && reference.path !== '/'
      && reference.path.length <= 4096 && Buffer.byteLength(reference.path) <= 4096 && !/[\0\\]/.test(reference.path)
      && /^[a-f0-9]{64}$/.test(reference.sha256))
    parents(reference.path)
    this.fd = openSync(reference.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      this.initial = fstatSync(this.fd, { bigint: true })
      const permissions = kind === 'storage-plan' ? (this.initial.mode & 0o022n) === 0n
        : this.initial.gid === (kind === 'configuration' ? 2000n : 0n)
          && (this.initial.mode & 0o7777n) === (kind === 'configuration' ? 0o440n : 0o444n)
      need(this.initial.isFile() && this.initial.uid === 0n && this.initial.nlink === 1n && permissions
        && this.initial.size > 0n && this.initial.size <= BigInt(maximum))
      this.originalBytes = bounded(this.fd, maximum)
      this.assertCurrent()
    } catch (cause) {
      try { this.close() }
      catch (closeCause) { throw new BootstrapFailure('wire-unknown', { kind: 'root-file-close-unknown', cause, closeCause, lease: this }) }
      throw cause
    }
  }
  /** Recheck exact descriptor/path bytes, readonly mount and protected ancestors; never contact the selected server. */
  assertCurrent(): void {
    need(this.fd !== undefined && this.closeFailure === undefined)
    parents(this.reference.path)
    const before = fstatSync(this.fd, { bigint: true }), current = lstatSync(this.reference.path, { bigint: true })
    need(current.isFile() && identity(this.initial, before) && identity(before, current))
    readonlyMount(this.reference.path, this.fd)
    const bytes = bounded(this.fd, this.maximum), after = fstatSync(this.fd, { bigint: true })
    need(identity(before, after) && bytes.length === Number(before.size)
      && createHash('sha256').update(bytes).digest('hex') === this.reference.sha256)
  }
  /**
   * Read the original protected bytes after checking the current selection.
   * @returns A separate byte copy retained only within the Root assembly.
   */
  bytes(): Buffer { this.assertCurrent(); return Buffer.from(this.originalBytes) }
  /**
   * Decode the exact protected file bytes as JSON without granting deployment or keeper authority.
   * @returns Parsed fields for the closed deployment-input parser.
   */
  value(): unknown {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.bytes()))
    return value
  }
  /** Close only after original SDK/coordinator/share settlement; a close uncertainty is sticky and never retried. */
  close(): void {
    if (this.closeFailure !== undefined) throw this.closeFailure
    const fd = this.fd
    if (fd === undefined) return
    this.fd = undefined
    try { closeSync(fd) }
    catch (cause) { this.closeFailure = new BootstrapFailure('wire-unknown', cause); throw this.closeFailure }
  }
}

/**
 * Retain the immutable Root configuration selection under the original non-root CLI's0440 read access.
 * @param reference Explicit Root path/SHA; Root apply rejects account graphs/closed mode before this call.
 * @returns Original retained selection/policy lease; Root must keep it through actual cleanup.
 */
export function readRootDeploymentReference(reference: RootDeploymentReference): RootDeploymentLease {
  return new RootDeploymentLease(reference, 16384, 'configuration')
}
