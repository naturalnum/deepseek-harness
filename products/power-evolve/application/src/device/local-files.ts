/** Descriptor-relative local transfers; children retain the caller's flock through actual exit. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_IPC_BYTES = 4 * 1024 * 1024
const MAX_ACTIVE = 8
const CODES = ['invalid_path', 'invalid_file_data', 'file_not_found', 'file_too_large', 'file_exists',
  'directory_identity_changed', 'local_files_lock_required', 'local_files_unavailable',
  'local_files_timeout', 'local_files_closed', 'local_files_busy'] as const

/** Decimal POSIX root identity, serialized without Number precision loss. */
export type DeviceDirectoryIdentity = { readonly dev: string; readonly ino: string }

/** Stable refusal categories; neither error messages nor logs expose private paths or bytes. */
export type LocalDeviceFilesErrorCode = typeof CODES[number]

/** A helper refusal or an owned-process lifecycle failure. */
export class LocalDeviceFilesError extends Error {
  /** Safe category for local authorization and transfer responses. */
  readonly code: LocalDeviceFilesErrorCode

  /** @param code Safe refusal category. */
  constructor(code: LocalDeviceFilesErrorCode) {
    super(code)
    this.name = 'LocalDeviceFilesError'
    this.code = code
  }
}

interface Request {
  op: 'inspect' | 'read' | 'create'; root: string; relative: string
  identity?: DeviceDirectoryIdentity; base64?: string
}
interface Active { child: ChildProcess; closed: Promise<void> }

function unavailable(): LocalDeviceFilesError { return new LocalDeviceFilesError('local_files_unavailable') }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function code(value: unknown): value is LocalDeviceFilesErrorCode {
  return typeof value === 'string' && CODES.some(item => item === value)
}
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) }

async function helper(): Promise<string> {
  // Source launches use adjacent assets; emitted modules use src or packaged .src.
  for (const candidate of ['./local-files.py', '../../src/device/local-files.py', '../../.src/device/local-files.py']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
      throw unavailable()
    })
    if (info?.isFile()) return path
  }
  throw unavailable()
}

/**
 * Runs bounded, one-shot POSIX helpers with a scrubbed environment. Read/create require a shared
 * regular flock descriptor; the caller must retain its own descriptor until these operations finish.
 * Root identity is checked on the opened root, and file traversal never follows symbolic links.
 */
export class LocalDeviceFiles {
  private readonly pythonExecutable: string
  private readonly timeoutMs: number
  private readonly active = new Set<Active>()
  private closePromise: Promise<void> | undefined

  /**
   * @param options Explicit Python executable and positive deadline before the helper is killed.
   */
  constructor(options: { pythonExecutable: string; timeoutMs: number }) {
    if (!options.pythonExecutable || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw unavailable()
    this.pythonExecutable = options.pythonExecutable
    this.timeoutMs = options.timeoutMs
  }

  /**
   * Inspect the authorized root and verify an existing relative directory without creating it.
   * @param root Absolute local directory with no symbolic-link components.
   * @param relativeDirectory Existing relative directory; the protocol constant `.` means the root.
   * @returns Decimal dev/ino identity of the authorized root, not its selected child.
   */
  async inspect(root: string, relativeDirectory: string = '.'): Promise<DeviceDirectoryIdentity> {
    const value = await this.call({ op: 'inspect', root, relative: relativeDirectory })
    if (!record(value) || !decimal(value.dev) || !decimal(value.ino)) throw unavailable()
    return { dev: value.dev, ino: value.ino }
  }

  /**
   * Read one regular file, refusing links, nonregular entries and bytes beyond 2 MiB.
   * @param root Previously authorized absolute local root.
   * @param identity Root identity recorded during explicit authorization.
   * @param relative Canonical relative file path beneath the root.
   * @param lockFd Caller-owned shared flock descriptor inherited by the helper as FD 3.
   * @returns Canonical base64 bytes, their SHA-256 digest, and byte length.
   */
  async read(root: string, identity: DeviceDirectoryIdentity, relative: string, lockFd: number): Promise<{ base64: string; sha256: string; size: number }> {
    const value = await this.call({ op: 'read', root, identity, relative }, lockFd)
    if (!record(value) || typeof value.base64 !== 'string' || typeof value.sha256 !== 'string'
      || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_BYTES) throw unavailable()
    const bytes = Buffer.from(value.base64, 'base64')
    if (bytes.length !== value.size || bytes.toString('base64') !== value.base64
      || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw unavailable()
    return { base64: value.base64, sha256: value.sha256, size: value.size }
  }

  /**
   * Create one owner-only file using a random exclusive temporary, fsync and create-only link.
   * Existing files, directories and symbolic links are never overwritten; missing parents reject.
   * An interrupted response can leave a committed destination; callers must inspect, never replay.
   * @param root Previously authorized absolute local root.
   * @param identity Root identity recorded during explicit authorization.
   * @param relative Canonical destination path beneath the root.
   * @param base64 Canonical base64 bytes, limited to 2 MiB.
   * @param lockFd Caller-owned shared flock descriptor inherited by the helper as FD 3.
   */
  async create(root: string, identity: DeviceDirectoryIdentity, relative: string, base64: string, lockFd: number): Promise<void> {
    const value = await this.call({ op: 'create', root, identity, relative, base64 }, lockFd)
    if (!record(value) || Object.keys(value).length !== 0) throw unavailable()
  }

  /**
   * Refuse new operations, kill only owned helper processes, and await their real close events.
   * Repeated calls join the same completion; the caller's original lock descriptor is never closed.
   * @returns Completion after all helpers have exited and released their inherited descriptors.
   */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      for (const entry of this.active) entry.child.kill('SIGKILL')
      await Promise.all([...this.active].map(entry => entry.closed))
    })()
    return this.closePromise
  }

  private async call(request: Request, lockFd?: number): Promise<unknown> {
    if (this.closePromise) throw new LocalDeviceFilesError('local_files_closed')
    if (lockFd !== undefined && (!Number.isSafeInteger(lockFd) || lockFd < 0)) throw new LocalDeviceFilesError('local_files_lock_required')
    const payload = JSON.stringify(request)
    if (Buffer.byteLength(payload) > MAX_IPC_BYTES) throw new LocalDeviceFilesError('invalid_file_data')
    const path = await helper()
    // Asset lookup yields; shutdown must not race a new spawn or miss its close promise.
    if (this.closePromise) throw new LocalDeviceFilesError('local_files_closed')
    if (this.active.size >= MAX_ACTIVE) throw new LocalDeviceFilesError('local_files_busy')
    const output = await new Promise<Buffer>((resolveResult, rejectResult) => {
      let child: ChildProcess
      try {
        child = spawn(this.pythonExecutable, ['-I', '-B', path], { shell: false, windowsHide: true, cwd: '/',
          env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C' },
          stdio: lockFd === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', lockFd] })
      } catch (_spawnFailure) { rejectResult(unavailable()); return }
      let timedOut = false, tooLarge = false, processError = false, total = 0
      const chunks: Buffer[] = []
      let resolveClosed!: () => void
      const entry = { child, closed: new Promise<void>(resolve => { resolveClosed = resolve }) }
      this.active.add(entry)
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, this.timeoutMs)
      child.stdout!.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_IPC_BYTES) { tooLarge = true; child.kill('SIGKILL') }
        else chunks.push(chunk)
      })
      child.stderr!.on('data', () => { /* Drain without retaining paths, file contents or credentials. */ })
      child.stdin!.on('error', () => { /* Actual process close determines the operation outcome. */ })
      child.once('error', () => { processError = true; child.kill('SIGKILL') })
      child.once('close', exitCode => {
        clearTimeout(timer)
        this.active.delete(entry)
        resolveClosed()
        if (this.closePromise) rejectResult(new LocalDeviceFilesError('local_files_closed'))
        else if (timedOut) rejectResult(new LocalDeviceFilesError('local_files_timeout'))
        else if (exitCode !== 0 || tooLarge || processError) rejectResult(unavailable())
        else resolveResult(Buffer.concat(chunks, total))
      })
      child.stdin!.end(payload)
    })
    let response: unknown
    try { response = JSON.parse(output.toString('utf8')) }
    catch (_invalidJson) { throw unavailable() }
    if (!record(response)) throw unavailable()
    if (response.ok === false && code(response.code)) throw new LocalDeviceFilesError(response.code)
    if (response.ok !== true || !('value' in response)) throw unavailable()
    return response.value
  }
}
