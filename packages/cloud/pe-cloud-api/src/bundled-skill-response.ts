/** One Cloud-owned binary response, retained through the original Node finish/close; no Native bridge or protocol mux. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'
import type { SkillPackage } from '@deepseek-ai/dsh-skill'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ManagedSkillDownloadRequest, ManagedSkillId, ManagedSkillContentVersion } from './managed-skill-types.ts'

/** Files-owned finite residence; Root must share this original budget across all enabled account routes. */
export interface BundledSkillBinaryBudget {
  readonly limits: Readonly<{ maxArchiveBytes: number; chunkBytes: number; timeoutMs: number }>
  /** @param bytes Exact release length. @param consume Actual I/O and physical response settlement. @returns Actual retained result. */
  withArchive<T>(bytes: number, consume: (retainUnknown: (cause: unknown) => void) => Promise<T>): Promise<T>
}
/** Original account save owner and exact response-local account/Peer/Use guard. */
export interface BundledSkillResponseOwner {
  /**
   * @param request Exact current release.
   * @param consume Actual response.
   * @param check Original authority.
   * @param signal Original observer.
   * @returns Actual settlement inside the original read turn.
   */
  withBundledArchive<T>(request: ManagedSkillDownloadRequest, consume: (bundle: SkillPackage, name: string) => Promise<T>,
    check: () => void, signal: AbortSignal): Promise<T>
}

/**
 * Send only the exact complete release ZIP through an explicitly admitted original response.
 * @param owner Original account read-turn owner; it selects current release/version inside admission.
 * @param request Strictly decoded opaque selectors; no Host path is accepted.
 * @param response Original Cloud ingress response, still inside the original Peer/AccountUse operation.
 * @param method Exact selected GET or HEAD operation.
 * @param budget Files-owned readonly release allowance; legacy JSON/upload/storage quotas are untouched.
 * @param check Original account/Peer/Use, installed capability and exposure recheck.
 * @param observer Original request disconnect, account and installed-route lifetime.
 * @returns Physical finish/close settlement; a stream handoff never releases the read turn or bytes.
 */
export async function sendBundledSkillResponse(owner: BundledSkillResponseOwner, request: ManagedSkillDownloadRequest,
  response: ServerResponse, method: 'GET' | 'HEAD', budget: BundledSkillBinaryBudget, check: () => void, observer: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([observer, AbortSignal.timeout(budget.limits.timeoutMs)])
  const current = (): void => { signal.throwIfAborted(); check() }
  await owner.withBundledArchive(request, (bundle, name) => budget.withArchive(bundle.archive.bytes, async (retainUnknown) => {
    try {
      current()
      // HEAD validates the same source as GET, including complete hash, under the same bounded reservation.
      const bytes = await bundle.readArchive(signal)
      current()
      if (bytes.byteLength !== bundle.archive.bytes || createHash('sha256').update(bytes).digest('hex') !== bundle.archive.sha256) {
        throw new Error('The complete original release archive did not match its inventory.')
      }
      await send(response, method === 'HEAD' ? undefined : bytes, {
        'content-type': 'application/zip', 'content-length': String(bundle.archive.bytes),
        'content-disposition': `attachment; filename="${name}.skill"`,
        'x-content-sha256': bundle.archive.sha256, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      }, budget.limits.chunkBytes, signal, current)
    } catch (cause) {
      if (cause instanceof ConfigSaveOutcomeUnknown) {
        retainUnknown(cause)
        throw cause
      }
      try {
        if (!response.headersSent && !response.destroyed && !signal.aborted) {
          await send(response, undefined, { 'content-length': '0', 'cache-control': 'no-store' }, budget.limits.chunkBytes,
            signal, () => { signal.throwIfAborted() }, 403)
        } else if (!response.closed && !response.writableFinished) {
          response.destroy()
          await waitForClose(response)
        }
      } catch (cleanup) {
        const unknown = new ConfigSaveOutcomeUnknown({ cause: new AggregateError([cause, cleanup], 'Binary response cleanup is unconfirmed.') })
        retainUnknown(unknown); throw unknown
      }
      throw cause
    }
  }), current, signal)
}

async function send(response: ServerResponse, bytes: Uint8Array | undefined, headers: Record<string, string>,
  chunkBytes: number, signal: AbortSignal, check: () => void, status = 200): Promise<void> {
  const completed = Promise.withResolvers<void>()
  let finished = false
  const finish = (): void => { finished = true; completed.resolve() }
  const close = (): void => { if (!finished) completed.reject(new Error('The binary response closed before finish.')) }
  const error = (reason: Error): void => { completed.reject(reason) }
  const abort = (): void => {
    try { response.destroy(); completed.reject(signal.reason) }
    catch (cause) { completed.reject(new ConfigSaveOutcomeUnknown({ cause })) }
  }
  response.once('finish', finish); response.once('close', close); response.once('error', error)
  signal.addEventListener('abort', abort, { once: true })
  // Observe rejection while bounded writes are pending; the final join remains below.
  void completed.promise.catch(() => {})
  try {
    check()
    if (response.headersSent || response.destroyed || response.writableEnded) throw new Error('The original response is unavailable.')
    response.writeHead(status, headers)
    if (bytes !== undefined) for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      check()
      const written = new Promise<void>((resolve, reject) => {
        response.write(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)), (failure) => {
          if (failure != null) reject(failure); else resolve()
        })
      })
      await Promise.race([written, completed.promise])
    }
    check(); response.end()
    await completed.promise
  } catch (reason) {
    if (reason instanceof ConfigSaveOutcomeUnknown) throw reason
    try { if (!response.destroyed) response.destroy() }
    catch (cause) { throw new ConfigSaveOutcomeUnknown({ cause: new AggregateError([reason, cause], 'Binary response close is unconfirmed.') }) }
    // Physical close remains owned even when cancellation interrupted a pending write.
    await waitForClose(response)
    throw reason
  } finally {
    signal.removeEventListener('abort', abort)
    response.off('finish', finish); response.off('close', close); response.off('error', error)
  }
}


/** Only original ingress-owned request/response facts; the actual access contract also retains binding/context/Peer. */
export interface BundledSkillResponseBorrow {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
  /** Original same account/generation/Peer/Use and installed exposure check. */
  assertCurrent(): void
}
/** Confirmed refusal/cancellation never closes the whole Peer; unknown cleanup retains its original cause. */
export type BundledSkillResponseSettlement =
  | { readonly cleanup: 'confirmed'; readonly outcome: 'completed' | 'cancelled' | 'rejected' }
  | { readonly cleanup: 'unknown'; readonly cause: unknown }

/**
 * Consume an access-owned exact binary route with ordinary refusals and physical response settlement.
 * @param borrow Original access borrow; only access authenticates, selects the account and owns Peer/Use release.
 * @param owner Same account's original skill read-turn owner, selected by access/API object identity checks.
 * @param budget Shared files-owned finite release allowance, explicitly selected by Root.
 * @param maxRequestBytes Explicit original route URL bound.
 * @returns Confirmed completion/refusal/cancel, or original unknown cause; this registers no route or login owner.
 */
export async function consumeBundledSkillResponse(borrow: BundledSkillResponseBorrow, owner: BundledSkillResponseOwner,
  budget: BundledSkillBinaryBudget, maxRequestBytes: number): Promise<BundledSkillResponseSettlement> {
  const { request, response, signal } = borrow
  try {
    borrow.assertCurrent(); signal.throwIfAborted()
    const url = new URL(request.url ?? '', 'http://cloud.invalid')
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || Buffer.byteLength(request.url ?? '') > maxRequestBytes
      || url.pathname !== '/api/skills/release-archive' || !['GET', 'HEAD'].includes(request.method ?? '')
      || [...url.searchParams.keys()].some(key => key !== 'skillId' && key !== 'contentVersion')
      || url.searchParams.getAll('skillId').length !== 1 || url.searchParams.getAll('contentVersion').length !== 1) throw new Error('Invalid release selector.')
    const id = url.searchParams.get('skillId'), version = url.searchParams.get('contentVersion')
    if (id === null || version === null || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(version)) throw new Error('Invalid release identity.')
    const selector = { skillId: brandString<ManagedSkillId>(id), contentVersion: brandString<ManagedSkillContentVersion>(version) }
    await sendBundledSkillResponse(owner, selector,
      response, request.method === 'HEAD' ? 'HEAD' : 'GET', budget, () => { borrow.assertCurrent() }, signal)
    return { cleanup: 'confirmed', outcome: 'completed' }
  } catch (cause) {
    if (cause instanceof ConfigSaveOutcomeUnknown) return { cleanup: 'unknown', cause }
    try {
      if (!response.headersSent && !response.destroyed && !signal.aborted) {
        await send(response, undefined, { 'content-length': '0', 'cache-control': 'no-store' }, budget.limits.chunkBytes,
          signal, () => { signal.throwIfAborted() }, 403)
        return { cleanup: 'confirmed', outcome: 'rejected' }
      }
      if (!response.closed && !response.writableFinished) {
        response.destroy()
        await waitForClose(response)
      }
      return { cleanup: 'confirmed', outcome: response.statusCode === 403 && !signal.aborted ? 'rejected' : 'cancelled' }
    } catch (cleanup) { return { cleanup: 'unknown', cause: new AggregateError([cause, cleanup], 'Release response cleanup is unconfirmed.') } }
  }
}


async function waitForClose(response: ServerResponse): Promise<void> {
  if (!response.closed) await new Promise<void>((resolve) => { response.once('close', resolve) })
}
