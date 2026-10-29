/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { FileUploadIntakeUnconfirmedError, type FileUploads } from './index.ts'
import type { FileUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Handle one authenticated raw-byte upload.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(service: FileUploads, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const name = url.searchParams.get('name') ?? undefined
  let result: FileUploadHttpResult
  const body = requestBodyChunks(request.body)
  try {
    let value: FileUploadValue
    try {
      value = await service.uploadStream({
        sessionId: brandString<SessionId>(sessionId),
        data: body,
        signal: request.signal,
        ...(name === undefined ? {} : { name }),
      })
    } finally { await body.return() }
    result = { ok: true, value }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function requestBodyChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterableIterator<Uint8Array> & { return(): Promise<IteratorResult<Uint8Array>> } {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  let ending: Promise<IteratorResult<Uint8Array>> | undefined
  let unconfirmed: FileUploadIntakeUnconfirmedError | undefined
  let ended = false
  const pendingReturn = (): Promise<IteratorResult<Uint8Array>> | undefined => ending
  const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined })
  const release = () => {
    try { reader?.releaseLock(); reader = undefined }
    catch { throw unconfirmed ??= new FileUploadIntakeUnconfirmedError() }
  }
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (unconfirmed !== undefined) throw unconfirmed
      if (ending !== undefined) { await ending; return done() }
      if (ended || body === null) return done()
      if (reading !== undefined) throw unconfirmed ??= new FileUploadIntakeUnconfirmedError()
      reader ??= body.getReader()
      const active = reading = reader.read()
      try {
        const chunk = await active
        const closing = pendingReturn()
        if (closing !== undefined) { await closing; return done() }
        if (chunk.done) { ended = true; release(); return done() }
        return { done: false, value: chunk.value }
      } catch (error) {
        const closing = pendingReturn()
        if (closing !== undefined) await closing
        else { ended = true; release() }
        throw error
      } finally {
        if (reading === active) reading = undefined
      }
    },
    return() {
      if (unconfirmed !== undefined) return Promise.reject(unconfirmed)
      if (ending !== undefined) return ending
      if (ended || body === null) { ended = true; return Promise.resolve(done()) }
      ended = true
      const active = reading
      ending = (async () => {
        try {
          reader ??= body.getReader()
          await reader.cancel()
          if (active !== undefined) await active
          release()
          return done()
        } catch { throw unconfirmed ??= new FileUploadIntakeUnconfirmedError() }
      })()
      return ending
    },
  }
}
