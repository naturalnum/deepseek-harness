/** Private Root-only adoption of inherited fd4. This opens no FIFO path, socket endpoint or process. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { isMainThread } from 'node:worker_threads'

/** Protected Root composition input only; never an account option, model field or filesystem target. */
export interface ExportKeeperLiveInput {
  readonly runId: string
  readonly manifestSha256: string
  readonly nonce: string
  readonly device: string
  readonly inode: string
  /** Original protected complete-manifest/retained-owner guard; no account or model input participates. */
  readonly assertManifestCurrent: () => void
}
/** Permanent loss of the original keeper observation; no mounted-export or share-release proof is implied. */
export interface ExportKeeperLoss {
  readonly reason: 'eof' | 'read-error' | 'identity-changed' | 'invalid-frame' | 'observer-closed' | 'bad-input' | 'duplicate' | 'adoption-unknown' | 'manifest-unavailable'
}
/** Losing observation closes admission; it never proves that a mounted export or an active share was released. */
export interface ExportKeeperLive {
  /** Original complete manifest, optional first READY consumption and actual original kernel writer; rejects on loss. */
  readonly ready: Promise<void>
  /** Permanent first loss. Does not invoke mount/share cleanup. */
  readonly lost: Promise<ExportKeeperLoss>
  readonly signal: AbortSignal
  /** Nonblocking original-inode/kernel-writer sample before and after awaited SDK preparation/create. */
  assertAvailable(): void
  /**
   * Resolves only after this owner confirms direct FD close or its own Socket emits close.
   * Bad input/duplicate/unconfirmed identity never closes FD4 and stays pending.
   * Unconfirmed Socket handoff never directly closes FD4 and stays pending without its close event.
   * An unknown close also stays pending; actual original Root process exit is the external final fence.
   * No share release is implied. Do not await this as a prerequisite for that process exit.
   */
  closeObserver(): Promise<void>
}

const adoptionSlot = Symbol.for('dsh.root.export-keeper.fd4.adoption.v1')

/**
 * Adopt inherited readonly fd4 once in the Root main thread; no path, PID or launcher input is accepted.
 * @param input Original protected complete-manifest identity and retained-owner guard.
 * @returns Original readiness/loss signal and admission/observer-close operations; no share release is implied.
 */
export function adoptExportKeeperLive(input: ExportKeeperLiveInput): ExportKeeperLive {
  // Reserve before any FS/Socket action or input getter. Never reset, including on failed adoption.
  const duplicate = Object.hasOwn(process, adoptionSlot)
  if (isMainThread && !duplicate) Object.defineProperty(process, adoptionSlot, { value: true })
  const fd = 4, frame = Buffer.alloc(128), readBuffer = Buffer.alloc(128), probe = Buffer.alloc(1)
  let pipe: Socket | undefined, owned = false, wrapping = false, phase: 'pending' | 'lost' | 'live' = 'pending',
    terminal: ExportKeeperLoss | undefined, adoptionFailure: ExportKeeperLoss['reason'] = 'bad-input'
  const controller = new AbortController()
  const ready = Promise.withResolvers<void>(), lost = Promise.withResolvers<ExportKeeperLoss>(), closed = Promise.withResolvers<void>()
  void ready.promise.catch(() => {})
  const fail = (reason: ExportKeeperLoss['reason']): void => {
    if (terminal) return
    terminal = Object.freeze({ reason }); phase = 'lost'
    controller.abort(terminal); lost.resolve(terminal)
    ready.reject(Object.assign(new Error('Root export keeper is unavailable'), { code: 'ROOT_EXPORT_UNAVAILABLE', reason }))
    if (pipe) pipe.destroy()
    else if (owned && !wrapping) {
      try { original(); flags(); closeSync(fd); closed.resolve() } catch { /* Unknown ownership/closure requires original process exit. */ }
    }
  }
  const original = (): void => {
    const s = fstatSync(fd, { bigint: true })
    if (!s.isFIFO() || s.uid !== 0n || s.gid !== 0n || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o600n
      || String(s.dev) !== input.device || String(s.ino) !== input.inode) throw Error('Original FIFO identity changed')
  }
  const flags = (): void => {
    const infoFd = openSync('/proc/self/fdinfo/4', 'r')
    try {
      const bytes = Buffer.alloc(4096), n = readSync(infoFd, bytes, 0, bytes.length, null)
      if (n === bytes.length) throw Error('FD facts exceeded their bound')
      const text = bytes.toString('utf8', 0, n), match = /^flags:\s+([0-7]+)$/m.exec(text)
      if (!match) throw Error('FD flags unavailable')
      const value = BigInt('0o' + (match[1] as string))
      if ((value & 3n) !== 0n || !(value & 0o4000n) || !(value & 0o2000000n)
        || !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(text)) throw Error('Readonly nonblocking cloexec reader lease required')
    } finally { closeSync(infoFd) }
  }
  const writerPresent = (): boolean => {
    original()
    try {
      const n = readSync(fd, probe, 0, 1, null)
      fail(n === 0 ? 'eof' : 'invalid-frame')
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EAGAIN' || (error as NodeJS.ErrnoException | undefined)?.code === 'EWOULDBLOCK') return true
      fail('read-error'); return false
    }
  }
  try {
    if (!isMainThread) throw Error('Root main-thread adoption only')
    if (duplicate) { adoptionFailure = 'duplicate'; throw Error('Root keeper adoption already reserved') }
    if ((input as ExportKeeperLiveInput | null) === null || typeof input !== 'object') throw Error('Invalid private adoption input')
    input = Object.freeze({ runId: input.runId, manifestSha256: input.manifestSha256, nonce: input.nonce,
      device: input.device, inode: input.inode, assertManifestCurrent: input.assertManifestCurrent })
    if (process.platform !== 'linux' || (process.getuid as NonNullable<typeof process.getuid>)() !== 2000 || (process.getgid as NonNullable<typeof process.getgid>)() !== 2000
      || !/^[a-f0-9]{32}$/.test(input.runId) || !/^[a-f0-9]{64}$/.test(input.nonce)
      || !/^[a-f0-9]{64}$/.test(input.manifestSha256) || !/^[0-9]{1,20}$/.test(input.device)
      || !/^[0-9]{1,20}$/.test(input.inode) || typeof input.assertManifestCurrent !== 'function') throw Error('Invalid private adoption input')
    adoptionFailure = 'adoption-unknown'
    input.assertManifestCurrent()
    original(); flags(); original(); owned = true
    const expected = Buffer.alloc(128)
    expected.write('EKL1', 0, 'ascii'); expected[4] = 1
    Buffer.from(input.runId, 'hex').copy(expected, 8)
    Buffer.from(input.manifestSha256, 'hex').copy(expected, 24)
    Buffer.from(input.nonce, 'hex').copy(expected, 56)
    let filled = 0
    while (filled < frame.length) {
      let n
      try { n = readSync(fd, frame, filled, frame.length - filled, null) } catch (error) {
        if (((error as NodeJS.ErrnoException | undefined)?.code === 'EAGAIN' || (error as NodeJS.ErrnoException | undefined)?.code === 'EWOULDBLOCK') && filled === 0) break
        throw Error('Incomplete or unreadable initial frame')
      }
      if (n === 0) throw Error('Original writer is closed')
      filled += n
    }
    if (filled !== 0 && (filled !== frame.length || !timingSafeEqual(frame, expected))) throw Error('Invalid initial frame')
    if (!writerPresent()) throw Error('Original writer is closed')
    wrapping = true
    pipe = new Socket({ fd, readable: true, writable: false, allowHalfOpen: false,
      // @ts-expect-error The reviewed callback intentionally retains both unused parameters for exact runtime AST equality.
      // eslint-disable-next-line no-unused-vars -- Keep the reviewed callback bindings; do not change runtime AST.
      onread: { buffer: readBuffer, callback(n, buffer) {
        if (!terminal) fail('invalid-frame')
        return false
      } } })
    // eslint-disable-next-line typescript/no-confusing-void-expression -- Preserve the reviewed listener expression and return.
    pipe.once('end', () => fail('eof'))
    // eslint-disable-next-line typescript/no-confusing-void-expression -- Preserve the reviewed listener expression and return.
    pipe.on('error', () => fail('read-error'))
    pipe.once('close', () => { fail('observer-closed'); closed.resolve() })
    pipe.resume()
    input.assertManifestCurrent()
    if (!writerPresent()) throw Error('Original writer is closed')
    phase = 'live'; ready.resolve()
  } catch { fail(adoptionFailure) }
  return Object.freeze({
    ready: ready.promise, lost: lost.promise, signal: controller.signal,
    assertAvailable() {
      if (phase !== 'live' || terminal) throw Object.assign(new Error('Root export keeper is unavailable'), { code: 'ROOT_EXPORT_UNAVAILABLE' })
      try { input.assertManifestCurrent() } catch { fail('manifest-unavailable') }
      if (terminal as ExportKeeperLoss | undefined) throw Object.assign(new Error('Root export keeper is unavailable'), { code: 'ROOT_EXPORT_UNAVAILABLE' })
      try { if (writerPresent()) return } catch { fail('identity-changed') }
      throw Object.assign(new Error('Root export keeper is unavailable'), { code: 'ROOT_EXPORT_UNAVAILABLE' })
    },
    // A nonowner/unknown adoption stays pending; only confirmed direct close or this Socket's close resolves.
    closeObserver() { fail('observer-closed'); return closed.promise },
  })
}
