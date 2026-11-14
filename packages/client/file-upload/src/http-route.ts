/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { FileUploadIntakeUnconfirmedError, type FileUploads } from './index.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadValue, ImageUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue | ImageUploadValue | FileAttachmentRef }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Handle one authenticated raw-byte upload. A `mediaType` query parameter
 * stages the body as a prompt image; without it the body is stored verbatim.
 * File requests may select a workspace directory or workspace-only publication through the same protected file hook.
 * The response waits for actual body-reader closure; failed cancellation remains unknown even after lock release.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(service: FileUploads, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return rejectBeforeIntake(request.body, new Response(null, { status: 405, headers: { allow: 'POST' } }))
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return rejectBeforeIntake(request.body, new Response('content type must be application/octet-stream', { status: 415 }))
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return rejectBeforeIntake(request.body, new Response('sessionId is required', { status: 400 }))
  }
  const name = url.searchParams.get('name') ?? undefined
  const imageMediaType = url.searchParams.get('mediaType') ?? undefined
  const workspaceDirectory = url.searchParams.get('directory') ?? undefined
  const workspaceOnly = url.searchParams.get('workspaceOnly') === 'true'
  if (imageMediaType !== undefined && (workspaceOnly || workspaceDirectory !== undefined)) {
    return rejectBeforeIntake(request.body, new Response('Image uploads do not publish workspace files.', { status: 400 }))
  }
  const body = requestBodyChunks(request.body)
  const upload = {
    sessionId: brandString<SessionId>(sessionId),
    data: body,
    signal: request.signal,
    ...(name === undefined ? {} : { name }),
  }
  let result: FileUploadHttpResult
  try {
    let value: FileUploadValue | ImageUploadValue | FileAttachmentRef | undefined
    let uploadError: unknown
    let uploadFailed = false
    try {
      value = imageMediaType !== undefined
        ? await service.uploadImageStream({ ...upload, mediaType: imageMediaType })
        : workspaceOnly
          ? await service.uploadWorkspaceStream({ ...upload, workspaceDirectory: workspaceDirectory ?? '.' })
          : await service.uploadStream({ ...upload, ...workspaceDirectory === undefined ? {} : { workspaceDirectory } })
    } catch (error) { uploadFailed = true; uploadError = error }
    try { await body.return() }
    catch (cleanupError) {
      const cause = uploadFailed ? new AggregateError([uploadError, cleanupError], 'Upload and request cleanup failed.') : cleanupError
      throw new FileUploadIntakeUnconfirmedError({ cause })
    }
    if (uploadFailed) throw uploadError
    if (value === undefined) throw new FileUploadIntakeUnconfirmedError()
    result = { ok: true, value }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: error instanceof FileUploadIntakeUnconfirmedError
        ? unconfirmedResult()
        : failure !== undefined
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

/** Fixed public error; private storage and request cleanup causes remain with their original owners. */
function unconfirmedResult() {
  return { code: 'gateway/internal', message: 'File upload intake settlement is unconfirmed.',
    details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } }
}

/** Close a rejected body through its original reader without draining more bytes. */
async function rejectBeforeIntake(body: ReadableStream<Uint8Array> | null, response: Response): Promise<Response> {
  try { await requestBodyChunks(body).return(); return response }
  catch {
    return new Response(JSON.stringify({ ok: false, error: unconfirmedResult() }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

/** Lazy original request reader; return joins cancel, terminal state and an already-started read before releasing its lock. */
function requestBodyChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterableIterator<Uint8Array> & { return(): Promise<IteratorResult<Uint8Array>> } {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  let ending: Promise<IteratorResult<Uint8Array>> | undefined
  let terminal: Promise<void> | undefined
  let terminalFailure: { readonly reason: unknown } | undefined
  let unconfirmed: FileUploadIntakeUnconfirmedError | undefined
  let ended = false
  const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined })
  const acquire = (): ReadableStreamDefaultReader<Uint8Array> => {
    if (reader !== undefined) return reader
    if (body === null) throw new Error('The upload request has no body reader.')
    reader = body.getReader()
    terminal = reader.closed.then(() => {}, (reason: unknown) => { terminalFailure = { reason } })
    return reader
  }
  const release = (prior?: { readonly cause: unknown }): void => {
    try { reader?.releaseLock(); reader = undefined }
    catch (error) {
      const cause = prior === undefined ? error : new AggregateError([prior.cause, error], 'Upload reader cleanup failed.')
      throw unconfirmed ??= new FileUploadIntakeUnconfirmedError({ cause })
    }
  }
  const pendingReturn = (): Promise<IteratorResult<Uint8Array>> | undefined => ending
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (unconfirmed !== undefined) throw unconfirmed
      if (ending !== undefined) { await ending; return done() }
      if (ended || body === null) return done()
      if (reading !== undefined) throw unconfirmed ??= new FileUploadIntakeUnconfirmedError()
      const active = reading = acquire().read()
      try {
        const chunk = await active
        const closing = pendingReturn()
        if (closing !== undefined) { await closing; return done() }
        if (chunk.done) { ended = true; await terminal; release(); return done() }
        return { done: false, value: chunk.value }
      } catch (error) {
        const closing = pendingReturn()
        if (closing !== undefined) await closing
        else { ended = true; await terminal; release() }
        throw error
      } finally {
        if (reading === active) reading = undefined
      }
    },
    return() {
      if (ending !== undefined) return ending
      if (unconfirmed !== undefined) return Promise.reject(unconfirmed)
      if (ended || body === null) { ended = true; return Promise.resolve(done()) }
      ended = true
      const active = reading
      const settled = Promise.withResolvers<IteratorResult<Uint8Array>>()
      ending = settled.promise
      // Publish the one cached close before invoking the original source's cancel callback.
      void (async () => {
        const source = acquire()
        let cancellationFailure: { readonly cause: unknown } | undefined
        try { await source.cancel() }
        catch (cause: unknown) {
          await terminal
          // An errored stream rejects cancel with its stored error without invoking the source;
          // a readable stream can close reader.closed before its actual cancel Promise rejects.
          if (terminalFailure === undefined || terminalFailure.reason !== cause) cancellationFailure = { cause }
        }
        await terminal
        if (active !== undefined) await active.catch(() => undefined)
        release(cancellationFailure)
        if (cancellationFailure !== undefined) throw new FileUploadIntakeUnconfirmedError(cancellationFailure)
        return done()
      })().then(settled.resolve, (cause: unknown) => {
        unconfirmed ??= cause instanceof FileUploadIntakeUnconfirmedError ? cause : new FileUploadIntakeUnconfirmedError({ cause })
        settled.reject(unconfirmed)
      })
      return ending
    },
  }
}
