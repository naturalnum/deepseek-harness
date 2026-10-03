/** Read-only Host transport. Approval credentials and confirmation routes never enter this client. */
import {
  executionResolutionsListRequest, executionResolutionsList, executionResolutionInspectRequest,
  executionResolutionInspection, executionResolutionStatusRequest, executionResolutionStatus,
  type ExecutionResolutionsList, type ExecutionResolutionInspection, type ExecutionResolutionStatus,
} from '@power-evolve/contracts/execution-resolution'

/** HTTP failures keep their status; product copy belongs to the locale dictionary. */
export class ExecutionResolutionHttpError extends Error {
  /** @param status - HTTP response status, including a revoked or expired account. */
  constructor(readonly status: number) { super(`Execution resolution read failed: ${status}`) }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new Error('Missing execution resolution response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  const abort = () => { void reader.cancel().catch(() => { /* No consumer remains after cancellation. */ }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      length += result.value.byteLength
      if (length > 2 * 1024 * 1024) throw new Error('Execution resolution response exceeds its byte limit')
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => { /* The bounded read has finished. */ })
    reader.releaseLock()
  }
}

/** Only the configured independent Platform approval page may be linked.
 * @param value - Host /config response's approvalUrl.
 * @param hostOrigin - current native client origin.
 * @returns a fixed approval-page URL without user-supplied executable schemes.
 */
export function trustedApprovalUrl(value: unknown, hostOrigin: string): string {
  if (typeof value !== 'string') throw new Error('Missing trusted approval URL')
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)
    || url.origin === hostOrigin || url.username || url.password || url.pathname !== '/approval'
    || url.search || url.hash) throw new Error('Invalid trusted approval URL')
  return url.href
}

/** Validated owner-scoped reads for existing executions and durable receipts. */
export class ExecutionResolutionClient {
  /** @param request - fetch transport; substitutes are used by keyless tests. */
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(key: string, request: object, signal: AbortSignal): Promise<unknown> {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const response = await this.request(`/api/powerEvolve/${key}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }), signal: lifetime,
    })
    if (!response.ok) throw new ExecutionResolutionHttpError(response.status)
    return boundedJson(response, lifetime)
  }

  /** @param sessionId - original Session filter, absent only for an owner-wide view.
   * @param signal - visible view's request lifetime.
   * @returns a bounded validated list matching the requested Session.
   */
  async list(sessionId: string | undefined, signal: AbortSignal): Promise<ExecutionResolutionsList> {
    const request = executionResolutionsListRequest.parse(sessionId === undefined ? {} : { sessionId })
    const result = executionResolutionsList.parse(await this.post('executionResolutionsList', request, signal))
    if (request.sessionId !== undefined && result.items.some(item => item.sessionId !== request.sessionId)
      || new Set(result.items.map(item => item.executionId)).size !== result.items.length) {
      throw new Error('Mismatched execution resolution list')
    }
    return result
  }

  /** @param executionId - exact original execution selected in the view.
   * @param signal - visible view's lifetime.
   * @returns current identity and read-only blocking reason for that execution.
   */
  async inspect(executionId: string, signal: AbortSignal): Promise<ExecutionResolutionInspection> {
    const request = executionResolutionInspectRequest.parse({ executionId })
    const result = executionResolutionInspection.parse(await this.post('executionResolutionInspect', request, signal))
    if (result.item.executionId !== request.executionId) throw new Error('Mismatched execution inspection')
    return result
  }

  /** @param requestId - existing receipt identity; this method never submits an intent.
   * @param signal - visible view's lifetime.
   * @returns a matching receipt, or an explicitly missing request.
   */
  async status(requestId: string, signal: AbortSignal): Promise<ExecutionResolutionStatus> {
    const request = executionResolutionStatusRequest.parse({ requestId })
    const result = executionResolutionStatus.parse(await this.post('executionResolutionStatus', request, signal))
    if (result.receipt !== null && result.receipt.requestId !== request.requestId) throw new Error('Mismatched execution receipt')
    return result
  }

  /** @param signal - visible view's lifetime.
   * @param hostOrigin - native client origin.
   * @returns the independent approval URL supplied by Host deployment configuration.
   */
  async approvalUrl(signal: AbortSignal, hostOrigin: string): Promise<string> {
    const response = await this.request('/config', { credentials: 'same-origin', redirect: 'error', signal })
    if (!response.ok) throw new ExecutionResolutionHttpError(response.status)
    const value = await boundedJson(response, signal)
    if (typeof value !== 'object' || value === null || !('approvalUrl' in value)) throw new Error('Missing approval configuration')
    return trustedApprovalUrl(value.approvalUrl, hostOrigin)
  }
}
