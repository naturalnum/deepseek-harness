/** Lossless native model chunks over one operation-authorized, cancellable NDJSON response. */
import { addAbortListener } from 'node:events'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { nativeModelRequest, nativeModelStreamChunk, type NativeModelPreparationId } from '../model-runtime-contracts.ts'

interface Limits { platformUrl: string; maxResponseBytes: number; streamIdleTimeoutMs: number }

async function* responseChunks(config: Limits, token: string, options: GenerateOptions, signal: AbortSignal,
  activity: () => void, preparationId: NativeModelPreparationId): AsyncGenerator<StreamChunk> {
  const { signal: _callerSignal, ...input } = options
  const request = nativeModelRequest.parse({ ...input, preparationId })
  const response = await fetch(new URL('/runtime/models/stream', config.platformUrl), { method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError('Platform model request refused', 'TRANSPORT', { status: response.status })
  }
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || response.body === null) {
    await response.body?.cancel()
    throw new LlmError('Platform model response is not native NDJSON', 'TRANSPORT')
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let cancelPromise: Promise<void> | undefined
  const cancel = (): Promise<void> => cancelPromise ??= reader.cancel().catch((_closedResponse: unknown) => {
    // An aborted fetch can already have closed its reader; releaseLock still runs after cancellation settles.
  })
  const listener = addAbortListener(signal, () => { void cancel() })
  let pending = '', bytes = 0, finished = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      activity()
      bytes += part.value.byteLength
      if (bytes > config.maxResponseBytes) throw new LlmError('Platform model response exceeds its byte limit', 'TRANSPORT')
      pending += decoder.decode(part.value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        if (finished) throw new LlmError('Platform model emitted data after finish', 'STREAM_CLOSED')
        const chunk = nativeModelStreamChunk.parse(JSON.parse(line))
        finished = chunk.type === 'finish'
        yield chunk
      }
    }
    pending += decoder.decode()
    if (pending.length || !finished) throw new LlmError('Platform model response ended before a complete finish', 'STREAM_CLOSED')
  } finally {
    listener[Symbol.dispose]()
    await cancel()
    reader.releaseLock()
  }
}

/** Transport original GenerateOptions and native chunks without provider serialization or replay conversion.
 * @param config Fixed Platform endpoint and validated response/idle budgets.
 * @param token Exact current operation bearer.
 * @param options Original native request and caller cancellation.
 * @param preparationId Exact owner-bound one-use preparation returned with the native metadata.
 * @returns Native chunks, including opaque provider replay envelopes.
 */
export async function* streamNativeModel(config: Limits, token: string, options: GenerateOptions,
  preparationId: NativeModelPreparationId): AsyncGenerator<StreamChunk> {
  const consumer = new AbortController()
  const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
  using watchdog = idleWatchdog(signal, config.streamIdleTimeoutMs, 'NATIVE_MODEL_IDLE')
  const iterator = responseChunks(config, token, options, watchdog.signal, () => { watchdog.pulse() }, preparationId)
  try {
    for (;;) {
      const item = await watchdog.next(iterator)
      if (item.done) return
      yield item.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, 'NATIVE_MODEL_IDLE') !== undefined) throw new LlmError('Platform model stream idle timeout', 'TIMEOUT', { cause: error })
    if (options.signal?.aborted) throw new LlmError('Platform model request aborted', 'ABORTED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError('Platform native model transport failed', 'TRANSPORT', { cause: error })
  } finally {
    consumer.abort()
    await iterator.return(undefined)
  }
}
