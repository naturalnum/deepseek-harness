/** Bounded views over one original operation; no allocation, process set or cleanup ownership. */
import type { SubprocessHandle, SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import type { CommandDirectStatus } from './command-operation.ts'
import { ExecutionStateError } from './errors.ts'

/** Root's same operation provides private cleanup even after its public handle is revoked. */
export interface ServiceRangeOwner {
  readonly whenEmpty: Promise<void>
  directStatus(): CommandDirectStatus
  requestStop(): void
}

/** Original registration guard and the already-reserved tail read limit. */
export interface ServiceProjectionPolicy {
  readonly maxLogReadBytes: number
  assertCurrent(): void
}

async function observe(actual: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const cancelled = Promise.withResolvers<boolean>()
  const abort = (): void => { cancelled.resolve(false) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([actual.then(() => true), cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

/**
 * Project exactly one original public handle and that same operation's actual range/I/O latch.
 * @param process Original handle, captured before public revocation.
 * @param owner Private callbacks from that same operation, never reconstructed from exit facts.
 * @param policy Original registration check and finite output reservation.
 * @returns Observation views only; direct failure and confirmed physical range exit remain independent facts.
 */
export function projectServiceRange(process: SubprocessHandle, owner: ServiceRangeOwner, policy: ServiceProjectionPolicy): Readonly<{
  status(): CommandDirectStatus & { range: 'pending' | 'empty' }
  log(stream: 'stdout' | 'stderr', fromByte: number): SubprocessOutputRead
  stop(signal: AbortSignal): Promise<boolean>
}> {
  policy.assertCurrent()
  if (!Number.isSafeInteger(policy.maxLogReadBytes) || policy.maxLogReadBytes < 1) {
    throw new ExecutionStateError('cloud/invalid-config', 'A finite service log limit is required.')
  }
  const stdout = process.collected.stdout, stderr = process.collected.stderr
  if (stdout === undefined || stderr === undefined) throw new ExecutionStateError('cloud/execution-unavailable', 'Service logs are unavailable.')
  let range: 'pending' | 'empty' = 'pending'
  void owner.whenEmpty.then(() => { range = 'empty' })
  return Object.freeze({
    status() {
      policy.assertCurrent()
      return { ...owner.directStatus(), range }
    },
    log(stream: 'stdout' | 'stderr', fromByte: number): SubprocessOutputRead {
      policy.assertCurrent()
      if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
        throw new ExecutionStateError('cloud/invalid-config', 'A log stream and finite byte offset are required.')
      }
      const result = (stream === 'stdout' ? stdout : stderr).readFrom(fromByte)
      if (Buffer.byteLength(result.text) > policy.maxLogReadBytes || result.spillPath !== undefined) {
        throw new ExecutionStateError('cloud/capacity', 'The service log exceeds its read limit.')
      }
      return result
    },
    stop(signal: AbortSignal): Promise<boolean> {
      policy.assertCurrent()
      owner.requestStop()
      return observe(owner.whenEmpty, signal)
    },
  })
}
