/** Kernel exclusion for one Device private root; the stable lock inode is never unlinked. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** Stable owner-only file retained across release, restart, and process death. */
export const DEVICE_PROCESS_LOCK_FILENAME = 'device-process.lock'

/** Safe failure categories; native loading and unexpected syscall failures remain their original errors. */
export type DeviceProcessLockErrorCode = 'device_process_already_owned'
  | 'device_process_lock_path_changed' | 'device_process_lock_released' | 'device_process_lock_unsupported'

/** A rejected ownership attempt or a changed path; no process identity or timeout can replace the lock. */
export class DeviceProcessLockError extends Error {
  /** Stable rejection category; the message contains no private root. */
  readonly code: DeviceProcessLockErrorCode

  /** @param code Stable rejection category, without private paths. */
  constructor(code: DeviceProcessLockErrorCode) {
    super(code)
    this.name = 'DeviceProcessLockError'
    this.code = code
  }
}

function changed(): DeviceProcessLockError {
  return new DeviceProcessLockError('device_process_lock_path_changed')
}

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function directories(path: string, mayBeMissing: boolean): Promise<void> {
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split('/')) {
    current = join(current, part)
    const entry = await lstat(current).catch((error: unknown) => {
      if (mayBeMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!entry) return
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw changed()
  }
}

function ownerOnly(entry: BigIntStats, directory: boolean): void {
  if ((directory ? !entry.isDirectory() : !entry.isFile()) || entry.uid !== BigInt(process.getuid!())
    || (!directory && entry.nlink !== 1n)) throw changed()
}

/**
 * Holds one nonblocking macOS/Linux flock until release or process death. Call assertOwned before
 * using the guarded journal: a same-user path replacement invalidates ownership, even though the
 * old inode remains locked. Cooperating owners must retain the stable file; this is not an OS-user
 * isolation mechanism or proof that a Device's Docker containers have stopped.
 */
export class DeviceProcessLock {
  private releasePromise: Promise<void> | undefined
  private readonly root: string
  private readonly rootHandle: FileHandle
  private readonly handle: FileHandle
  private readonly rootIdentity: BigIntStats
  private readonly lockIdentity: BigIntStats

  private constructor(root: string, rootHandle: FileHandle, handle: FileHandle,
    rootIdentity: BigIntStats, lockIdentity: BigIntStats) {
    this.root = root
    this.rootHandle = rootHandle
    this.handle = handle
    this.rootIdentity = rootIdentity
    this.lockIdentity = lockIdentity
  }

  /**
   * Acquire kernel ownership without waiting for a competing process. Creates an owner-only private
   * root and stable regular lock file, refuses symlinks/hard links, and checks both inodes after flock.
   * Existing lock bytes are preserved. A replaced inode rejects rather than being retried.
   * @param privateRoot Absolute Device private root, with no symbolic-link path components.
   * @returns Held lock; the caller must release it after all guarded work reaches quiescence.
   */
  static async acquire(privateRoot: string): Promise<DeviceProcessLock> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new DeviceProcessLockError('device_process_lock_unsupported')
    }
    if (!isAbsolute(privateRoot) || resolve(privateRoot) === parse(privateRoot).root) throw changed()
    const root = resolve(privateRoot)
    await directories(root, true)
    await mkdir(root, { recursive: true, mode: 0o700 })
    let rootHandle: FileHandle | undefined, handle: FileHandle | undefined
    try {
      rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const rootIdentity = await rootHandle.stat({ bigint: true })
      ownerOnly(rootIdentity, true)
      await rootHandle.chmod(0o700)
      handle = await open(join(root, DEVICE_PROCESS_LOCK_FILENAME),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      const lockIdentity = await handle.stat({ bigint: true })
      ownerOnly(lockIdentity, false)
      try { await tryLockExclusive(handle.fd) }
      catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          throw new DeviceProcessLockError('device_process_already_owned')
        }
        throw error
      }
      await handle.chmod(0o600)
      const lock = new DeviceProcessLock(root, rootHandle, handle, rootIdentity, lockIdentity)
      await lock.assertOwned()
      return lock
    } catch (error: unknown) {
      await Promise.allSettled([handle?.close(), rootHandle?.close()])
      if (['ELOOP', 'ENOTDIR', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw changed()
      throw error
    }
  }

  /**
   * Refuse root/lock replacement, links, ownership changes, or broadened permissions while held.
   * @returns Completion after comparing current paths with the retained root and lock descriptors.
   */
  async assertOwned(): Promise<void> {
    if (this.releasePromise) throw new DeviceProcessLockError('device_process_lock_released')
    try {
      await directories(this.root, false)
      const [root, lock, heldRoot, heldLock] = await Promise.all([
        lstat(this.root, { bigint: true }), lstat(join(this.root, DEVICE_PROCESS_LOCK_FILENAME), { bigint: true }),
        this.rootHandle.stat({ bigint: true }), this.handle.stat({ bigint: true }),
      ])
      ownerOnly(root, true); ownerOnly(lock, false)
      if (!same(root, this.rootIdentity) || !same(lock, this.lockIdentity)
        || !same(root, heldRoot) || !same(lock, heldLock)
        || (root.mode & 0o777n) !== 0o700n || (lock.mode & 0o777n) !== 0o600n) throw changed()
    } catch (error: unknown) {
      if (['ELOOP', 'ENOTDIR', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw changed()
      throw error
    }
  }

  /**
   * Descriptor for a trusted child to inherit through its explicit stdio mapping. The child keeps
   * the same open-file flock after this process closes its descriptor; call assertOwned before spawn.
   * @returns Held kernel-lock descriptor; released locks cannot supply it.
   */
  get fd(): number {
    if (this.releasePromise) throw new DeviceProcessLockError('device_process_lock_released')
    return this.handle.fd
  }

  /**
   * Close both retained descriptors, await completion, and keep the stable lock file. Concurrent and
   * repeated calls join the same completion, including a close failure; no PID or expiry is involved.
   * @returns Completion of descriptor closure, which releases the kernel lock.
   */
  release(): Promise<void> {
    this.releasePromise ??= Promise.allSettled([this.handle.close(), this.rootHandle.close()]).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason
    })
    return this.releasePromise
  }
}
