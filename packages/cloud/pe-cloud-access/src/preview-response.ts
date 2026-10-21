/** Bounded text responses retained through original execution and ingress settlement. */
import type { ApplicationReadLimits, ApplicationReadResponse, RegisteredApplicationService } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { ExposureManifest } from '@deepseek-ai/dsh-pe-cloud-api/types'
import { forwardAuthorizedPreview, type ExistingPreviewAdmission, type ExecutionPreviewPort,
  type PreviewPolicy } from './preview-access.ts'

/** One upstream response whose original transport retains read, cancellation and release responsibility. */
export type OwnedPreviewResponse = ApplicationReadResponse
/** Original registered service capability with bounded upstream response consumption. */
export interface ResponsePreviewService extends RegisteredApplicationService {
  readonly manifest: ExposureManifest
}
/** Original execution owner borrows the registered service through complete response consumption. */
export interface ResponseExecutionPreviewPort {
  /**
   * @param binding Original admitted account graph binding.
   * @param selector Expected service identity, checked by the original owner.
   * @param manifest Original immutable exposure manifest.
   * @param signal Original request cancellation observer.
   * @param consume Consumer retained through response read, close and downstream settlement.
   * @returns Actual request settlement; unknown cleanup remains retained by its original owner.
   */
  withRegisteredService: (binding: Parameters<ExecutionPreviewPort['withRegisteredService']>[0],
    selector: Parameters<ExecutionPreviewPort['withRegisteredService']>[1],
    manifest: Parameters<ExecutionPreviewPort['withRegisteredService']>[2], signal: AbortSignal,
    consume: (service: ResponsePreviewService) => Promise<void>) => Promise<void>
}
/** Bounded text-only browser response with fixed platform-controlled headers. */
export interface InertPreviewReply {
  readonly status: 200
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}
/** Original ingress response owner, including actual downstream write and close settlement. */
export interface OriginalIngressSink {
  /**
   * @param reply Bounded text and fixed platform-controlled headers.
   * @param signal Original response cancellation observer.
   * @param assertCurrent Recheck original admission immediately before committing headers or body.
   * @returns Actual ServerResponse finish or close settlement.
   */
  send(reply: InertPreviewReply, signal: AbortSignal, assertCurrent: () => void): Promise<void>
  /**
   * Failure retains the original ingress cleanupUnknown state.
   * @param reason Reason to cancel only this response.
   * @returns Actual pending writes and response close settlement.
   */
  close(reason: unknown): Promise<void>
}
/** Explicit byte, pull and header limits reserved by the original request owner. */
export interface ResponseLimits extends ApplicationReadLimits {
  readonly mode: 'inert-text-v1'
}
/** Refusal or unknown cleanup retained by the original ingress and execution owners. */
export class PreviewResponseError extends Error {
  /**
   * @param code Stable handling classification.
   * @param cause Private original failure; omission records no underlying failure.
   */
  constructor(readonly code: 'cloud/forbidden' | 'cloud/capacity' | 'cloud/stop-unconfirmed', cause?: unknown) {
    super('Service preview response refused.', { cause })
  }
}
function need(ok: unknown, code: PreviewResponseError['code'] = 'cloud/forbidden'): asserts ok {
  if (!ok) throw new PreviewResponseError(code)
}
function validate(limits: Omit<ResponseLimits, 'mode'> & { readonly mode: unknown }): void {
  need(limits.mode === 'inert-text-v1')
  for (const name of ['maxBodyBytes', 'maxChunkBytes', 'maxChunks', 'maxHeaderCount', 'maxHeaderBytes'] as const) {
    need(Number.isSafeInteger(limits[name]) && limits[name] > 0 && limits[name] <= 1048576, 'cloud/capacity')
  }
  need(limits.maxChunkBytes <= limits.maxBodyBytes + 1 && limits.maxHeaderCount <= 128, 'cloud/capacity')
}
function metadata(response: OwnedPreviewResponse, limits: ResponseLimits): number | undefined {
  // Only complete successful application responses can be published as text.
  need(response.status === 200)
  const rows = response.headers
  need(Array.isArray(rows) && rows.length <= limits.maxHeaderCount, 'cloud/capacity')
  let bytes = 0, length: number | undefined, encodingSeen = false, transferSeen = false
  for (const row of rows) {
    need(Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string')
    const name: string = row[0], value: string = row[1]
    need(name.length <= limits.maxHeaderBytes && value.length <= limits.maxHeaderBytes, 'cloud/capacity')
    need(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && /^[\x20-\x7e]*$/.test(value))
    bytes += name.length + value.length + 4
    need(bytes <= limits.maxHeaderBytes, 'cloud/capacity')
    switch (name.toLowerCase()) {
      case 'content-length':
        need(length === undefined && /^(?:0|[1-9][0-9]{0,15})$/.test(value))
        length = Number(value)
        need(Number.isSafeInteger(length) && length <= limits.maxBodyBytes, 'cloud/capacity')
        break
      case 'content-encoding':
        need(!encodingSeen && value.toLowerCase() === 'identity'); encodingSeen = true
        break
      case 'transfer-encoding':
        need(!transferSeen && value.toLowerCase() === 'chunked'); transferSeen = true
    }
  }
  need(!transferSeen || length === undefined)
  return length
}
type Outcome = { ok: true } | { ok: false; error: unknown }
function observe(promise: Promise<void>): Promise<Outcome> {
  return promise.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }))
}
/**
 * The original owner retains the resource and its known or unknown state.
 * @param close Original idempotent close operation.
 * @returns Request-local start and actual-settlement joins for the same close operation.
 */
function closing(close: (reason?: unknown) => Promise<void>): {
  start: (reason?: unknown) => void
  join: () => Promise<void>
} {
  let actual: Promise<Outcome> | undefined
  return {
    start(reason) {
      if (actual !== undefined) return
      try { actual = observe(close(reason)) } catch (error) { actual = Promise.resolve({ ok: false, error }) }
    },
    async join() {
      need(actual !== undefined)
      const result = await actual
      if (!result.ok) throw new PreviewResponseError('cloud/stop-unconfirmed', result.error)
    },
  }
}
async function collect(response: OwnedPreviewResponse, method: 'GET' | 'HEAD', limits: ResponseLimits,
  signal: AbortSignal, current: () => void): Promise<InertPreviewReply> {
  const close = closing(reason => response.close(reason))
  const abort = (): void => { close.start(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  let failure: { error: unknown } | undefined, declared: number | undefined, total = 0
  // Original request/execution owners must reserve maxBodyBytes+1 + maxChunkBytes before this allocation.
  let buffer: Uint8Array | undefined
  try {
    current(); signal.throwIfAborted(); declared = metadata(response, limits)
    const cap = declared === undefined ? limits.maxBodyBytes : Math.min(declared, limits.maxBodyBytes)
    buffer = new Uint8Array(method === 'HEAD' ? 0 : cap + 1)
    for (let pulls = 0; ; pulls++) {
      current(); signal.throwIfAborted(); need(pulls < limits.maxChunks, 'cloud/capacity')
      const allowance = method === 'HEAD' ? 1 : Math.min(limits.maxChunkBytes, cap - total + 1)
      const chunk = await response.read(allowance)
      current(); signal.throwIfAborted()
      if (chunk === null) break
      need(chunk instanceof Uint8Array && chunk.byteLength > 0 && chunk.byteLength <= allowance, 'cloud/capacity')
      need(method !== 'HEAD' && total + chunk.byteLength <= cap, 'cloud/capacity')
      buffer.set(chunk, total); total += chunk.byteLength
    }
    need(method === 'HEAD' || declared === undefined || declared === total)
  } catch (error) { failure = { error } }
  finally {
    close.start(failure?.error)
    try { await close.join() } catch (error) {
      failure = { error: failure === undefined ? error : new PreviewResponseError('cloud/stop-unconfirmed',
        new AggregateError([failure.error, error], 'Original failure and unknown response close.')) }
    }
    signal.removeEventListener('abort', abort)
  }
  if (failure !== undefined) throw failure.error
  current(); signal.throwIfAborted(); need(buffer !== undefined)
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store, max-age=0', pragma: 'no-cache', expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
    'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer',
  }
  if (method === 'GET' || declared !== undefined) headers['content-length'] = String(method === 'GET' ? total : declared)
  // No upstream header is copied: Set-Cookie/Location/Refresh/CORS/cache/ETag/reporting headers all disappear.
  return Object.freeze({ status: 200, headers: Object.freeze(headers), body: buffer.subarray(0, total) })
}
async function transfer(reply: InertPreviewReply, sink: OriginalIngressSink,
  signal: AbortSignal, current: () => void): Promise<void> {
  const close = closing(reason => sink.close(reason))
  const abort = (): void => { close.start(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  let failure: { error: unknown } | undefined
  try { current(); signal.throwIfAborted(); await sink.send(reply, signal, current); current(); signal.throwIfAborted() }
  catch (error) { failure = { error }; close.start(error) }
  finally {
    if (failure !== undefined || signal.aborted) {
      close.start(failure?.error ?? signal.reason)
      try { await close.join() } catch (error) {
        failure = { error: failure === undefined ? error : new PreviewResponseError('cloud/stop-unconfirmed',
          new AggregateError([failure.error, error], 'Original failure and unknown ingress close.')) }
      }
    }
    signal.removeEventListener('abort', abort)
  }
  if (failure !== undefined) throw failure.error
}
/**
 * Deliver bounded text while the original account use and service reservation remain held.
 * @param input Untrusted HTTP selection, path and headers.
 * @param admission Original authenticated account operation.
 * @param policy Fixed audited route, isolated origin and request limits.
 * @param limits Approved response limits reserved before reading.
 * @param execution Original registered-service and response owner.
 * @param sink Original ingress response owner.
 * @returns Actual upstream close and downstream write settlement; unknown cleanup rejects without releasing responsibility.
 */
export async function forwardInertPreview(input: unknown, admission: ExistingPreviewAdmission,
  policy: PreviewPolicy, limits: ResponseLimits, execution: ResponseExecutionPreviewPort, sink: OriginalIngressSink): Promise<void> {
  validate(limits)
  await forwardAuthorizedPreview(input, admission, policy, {
    withRegisteredService(binding, selector, manifest, signal, consume) {
      return execution.withRegisteredService(binding, selector, manifest, signal, service => consume({
        scope: service.scope, manifest: service.manifest, port: service.port, lifetime: service.lifetime,
        assertCurrent: () => { service.assertCurrent() },
        async forward(request, serviceSignal) {
          const current = (): void => {
            serviceSignal.throwIfAborted(); admission.assertCurrent(); admission.use.assertCurrent(); service.assertCurrent()
            need(admission.api.binding === binding && policy.manifest.recipeVersion === binding.recipeVersion
              && service.manifest === policy.manifest && service.scope.accountId === binding.accountId
              && service.scope.epoch === binding.epoch && service.scope.sessionId === selector.sessionId
              && service.scope.allocationId === selector.allocationId && service.scope.serviceId === selector.serviceId
              && policy.allowedServicePorts.includes(service.port))
            const row = admission.api.requireFetch(request.method, policy.routePath)
            need(row.method === request.method && row.path === policy.routePath && row.handlerId === policy.handlerId
              && row.guard === 'account-session')
          }
          current()
          await service.withResponse(request, limits, serviceSignal, async (response) => {
            const reply = await collect(response, request.method, limits, serviceSignal, current)
            current(); await transfer(reply, sink, serviceSignal, current)
          })
        },
      }))
    },
  })
}
