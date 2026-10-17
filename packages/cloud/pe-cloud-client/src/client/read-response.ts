/** Bounded response consumption shared by bootstrap and cloud error classification. */
import { ClientFailure } from './errors.ts'

/**
 * Read at most the declared byte budget, cancelling the reader on overflow or failure.
 * @param response - owned response; this function consumes its body once.
 * @param maxBytes - validated finite retained-byte limit.
 * @param signal - owning operation's cancellation signal.
 * @returns exact bytes, without parsing native envelopes.
 */
export async function readResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let cancelled: Promise<void> | undefined
  const cancel = (): void => {
    cancelled ??= reader.cancel(signal.reason)
    // The operation awaits this same promise before settling.
    void cancelled.catch((_error: unknown) => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      if (item.value.byteLength === 0) continue
      if (item.value.byteLength > maxBytes - size) throw new ClientFailure('response-too-large')
      chunks.push(item.value)
      size += item.value.byteLength
    }
  } catch (error) {
    try {
      await (cancelled ?? reader.cancel(error))
    } catch (cleanupError) {
      throw new ClientFailure('close-unconfirmed', new AggregateError([error, cleanupError]))
    }
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
