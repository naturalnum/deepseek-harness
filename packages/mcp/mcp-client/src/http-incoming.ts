/** Optional HTTP byte admission before the official SDK's JSON/SSE decoders; no protocol parsing. */
import type { FetchLike } from '@modelcontextprotocol/client'

interface ResponseLease { close(reason?: unknown): Promise<boolean> }
/** Fetch and reader settlement owned by one original transport generation. */
export interface HttpIncomingOwner {
  fetch: FetchLike
  /** Stop pending requests and join their actual reader settlement.
   * @returns True only after all readers release their original locks.
   */
  close(): Promise<boolean>
}

function exceeded(): Error { return new Error('mcp-client: incoming HTTP response exceeds configured byte limit') }
function metadata(response: Response, source: Response): Response {
  for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(response, key, { value: source[key] })
  const clone = response.clone.bind(response)
  Object.defineProperty(response, 'clone', { value: () => metadata(clone(), source) })
  return response
}

/** Build an optional per-response decoded-byte gate over the existing fetch implementation.
 * @param maximum Positive finite maximum bytes per HTTP response, including cumulative SSE bytes.
 * @param fetcher Original fetch, preserving the Host's proxy/network implementation.
 * @returns Fetch plus actual request/reader settlement for the original connection supervisor.
 */
export function boundedHttpIncoming(maximum: number,
  fetcher: FetchLike = (input, init) => globalThis.fetch(input, init)): HttpIncomingOwner {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('mcp-client: positive incoming HTTP byte limit required')
  const requests = new Set<AbortController>(), pending = new Set<Promise<Response>>(), leases = new Set<ResponseLease>()
  let closing = false, stopping: Promise<boolean> | undefined
  const isClosing = (): boolean => closing
  const fetch: FetchLike = (input, init) => {
    const request = new AbortController()
    const signals = [request.signal, ...init?.signal === undefined || init.signal === null ? [] : [init.signal],
      ...input instanceof Request ? [input.signal] : []]
    requests.add(request)
    const work = (async (): Promise<Response> => {
      if (closing) throw new Error('mcp-client: incoming HTTP transport is closed')
      const original = await fetcher(input, { ...init, signal: AbortSignal.any(signals) })
      if (original.body === null) return original
      const reader = original.body.getReader()
      const terminal = reader.closed.then(() => {}, () => {})
      let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      let cleanup: Promise<boolean> | undefined, released = false, stoppingReader = false, bytes = 0
      const lease: ResponseLease = { close(reason) {
        return cleanup ??= (async () => {
          if (released) return true
          stoppingReader = true; request.abort(reason)
          // An already-errored fetch reader rejects cancel with its stored error.
          // Its terminal promise and pending read must still settle before lock release.
          try { await reader.cancel(reason) } catch (_error) { /* Terminal settlement below is the authority. */ }
          await terminal
          await reading?.then(() => {}, () => {})
          try { reader.releaseLock() } catch (_error) { return false }
          released = true; leases.delete(lease)
          return true
        })()
      } }
      leases.add(lease)
      const length = original.headers.get('content-length')
      const encoding = original.headers.get('content-encoding')
      if (isClosing() || (encoding === null || encoding === 'identity')
        && length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(maximum)) {
        await lease.close(exceeded()); throw exceeded()
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const read = reader.read(); reading = read
            let result: ReadableStreamReadResult<Uint8Array>
            try { result = await read } finally { if (reading === read) reading = undefined }
            if (stoppingReader) { controller.error(new Error('mcp-client: incoming HTTP transport closed')); return }
            if (result.done) {
              await terminal; reader.releaseLock(); released = true; leases.delete(lease); controller.close(); return
            }
            bytes += result.value.byteLength
            if (bytes > maximum) throw exceeded()
            controller.enqueue(result.value)
          } catch (error) {
            const confirmed = await lease.close(error)
            controller.error(confirmed ? error : new Error('mcp-client: incoming HTTP reader cleanup is unconfirmed'))
          }
        },
        async cancel(reason) {
          if (!await lease.close(reason)) throw new Error('mcp-client: incoming HTTP reader cleanup is unconfirmed')
        },
      }, { highWaterMark: 0 })
      return metadata(new Response(body, { status: original.status, statusText: original.statusText, headers: original.headers }), original)
    })()
    pending.add(work)
    void work.then(() => { pending.delete(work); requests.delete(request) }, () => { pending.delete(work); requests.delete(request) })
    return work
  }
  return { fetch, close() {
    return stopping ??= (async () => {
      closing = true
      for (const request of requests) request.abort(new Error('mcp-client: incoming HTTP transport closed'))
      await Promise.allSettled([...pending])
      const results = await Promise.allSettled([...leases].map(lease => lease.close()))
      return results.every(result => result.status === 'fulfilled' && result.value) && leases.size === 0
    })()
  } }
}
