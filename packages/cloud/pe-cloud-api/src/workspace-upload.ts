/** Exact workspace upload response; account admission stays with Access and publication stays with the original files owner. */
import { on } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceUploadSource, WorkspaceUploadResult } from '@deepseek-ai/dsh-pe-cloud-files/src/stage-bridge.ts'
import type { ResidentResult } from '@deepseek-ai/dsh-pe-cloud-files/src/work-queue.ts'
import { FdMutationFailure } from '@deepseek-ai/dsh-pe-cloud-files'
import { CloudApiError } from './errors.ts'

/** Structural subset of Access's borrowed binary response; it grants no independent login or account selection. */
export interface WorkspaceUploadBorrow {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
  assertCurrent(): void
}

/** Original account/Session selection, with a closure over the same files mutation owner and exact registered workspace. */
export interface WorkspaceUploadTarget {
  assertCurrent(): void
  publish(source: WorkspaceUploadSource, signal: AbortSignal): Promise<ResidentResult<readonly WorkspaceUploadResult[]>>
}

/** Actual source/worker/wire disposition returned to the original borrowed-response owner. */
export type WorkspaceUploadSettlement =
  | { readonly cleanup: 'confirmed'; readonly outcome: 'completed' | 'cancelled' | 'rejected' }
  | { readonly cleanup: 'unknown'; readonly cause: unknown }

type WorkspaceUploadConsumer = (borrow: WorkspaceUploadBorrow) => Promise<WorkspaceUploadSettlement>

function single(url: URL, field: string): string {
  const values = url.searchParams.getAll(field)
  if (values.length !== 1 || !values[0]) throw new Error(`One ${field} is required.`)
  return values[0]
}

async function closeResponse(response: ServerResponse): Promise<void> {
  if (response.writableFinished || response.closed) return
  await new Promise<void>((resolve) => {
    response.once('close', resolve)
    response.destroy()
  })
}

function send(response: ServerResponse, body: object, status: number, current: () => void): Promise<boolean> {
  current()
  if (response.destroyed) return closeResponse(response).then(() => false)
  const bytes = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const stop = (finished: boolean): void => {
      response.off('finish', finishedResponse); response.off('close', closed); response.off('error', failed)
      resolve(finished)
    }
    const finishedResponse = (): void => { stop(true) }
    const closed = (): void => { stop(response.writableFinished) }
    const failed = (error: Error): void => {
      response.off('finish', finishedResponse); response.off('close', closed); response.off('error', failed)
      reject(error)
    }
    response.once('finish', finishedResponse); response.once('close', closed); response.once('error', failed)
    try {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bytes),
        'cache-control': 'no-store', connection: 'close' })
      response.end(bytes)
    } catch (error) { failed(error instanceof Error ? error : new Error('Upload response failed.')) }
  })
}

/**
 * Create one Cloud workspace-file upload consumer, separate from Native conversation attachment receipts.
 * @param limits Explicit declared-file, source-chunk and path limits, bounded again by the existing staging owner.
 * @param select Original native Session/project policy; query paths and client digests never grant authority.
 * @returns Consumer joining source return, original worker settlement and actual HTTP finish/close. Access registers the exact route.
 */
export function createWorkspaceUploadConsumer(limits: {
  readonly maxFileBytes: number
  readonly maxSourceChunkBytes: number
  readonly maxPathBytes: number
}, select: (id: SessionId, signal: AbortSignal) => Promise<WorkspaceUploadTarget>): WorkspaceUploadConsumer {
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.maxSourceChunkBytes > limits.maxFileBytes) throw new RangeError('Invalid explicit workspace upload limits.')
  return async (borrow) => {
    const { request, response, signal } = borrow
    request.pause()
    let held: ResidentResult<readonly WorkspaceUploadResult[]> | undefined
    let attempted = false, finished = false
    const sourceState = { opened: false, closed: false }
    let rejectedStatus = 400
    let source: AsyncIterator<unknown[]> | undefined
    const current = (): void => { borrow.assertCurrent(); signal.throwIfAborted() }
    try {
      current()
      const url = new URL(request.url ?? '', 'http://cloud.invalid')
      if (request.method !== 'POST') { rejectedStatus = 405; throw new Error('POST is required.') }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/octet-stream') {
        rejectedStatus = 415; throw new Error('An octet-stream body is required.')
      }
      const sessionId = brandString<SessionId>(single(url, 'sessionId'))
      const name = single(url, 'name'), directory = single(url, 'directory')
      const sha256 = request.headers['x-content-sha256'], length = request.headers['content-length']
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
        || typeof length !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/u.test(length)
        || Buffer.byteLength(name) + Buffer.byteLength(directory) > limits.maxPathBytes) throw new Error('Invalid upload declaration.')
      const bytes = Number(length)
      if (!Number.isSafeInteger(bytes) || bytes > limits.maxFileBytes) {
        rejectedStatus = 413; throw new Error('Upload exceeds the declared file limit.')
      }
      const selected = await select(sessionId, signal)
      const check = (): void => { current(); selected.assertCurrent() }
      check()
      attempted = true
      held = await selected.publish({ claim: { sha256, bytes, name }, workspaceDirectory: directory,
        open: async function* (control) {
          sourceState.opened = true
          source = on(request, 'data', { signal: control, close: ['end'], highWaterMark: 1, lowWaterMark: 1 })
          request.resume()
          try {
            for (;;) {
              check()
              const part = await source.next()
              check()
              if (part.done === true) return
              const chunk: unknown = part.value[0]
              if (!(chunk instanceof Uint8Array) || chunk.byteLength > limits.maxSourceChunkBytes) {
                throw new Error('Upload source chunk exceeds its bound.')
              }
              const exact = new Uint8Array(chunk.byteLength)
              exact.set(chunk)
              yield exact
            }
          } finally { await source.return?.(); request.pause(); sourceState.closed = true }
        } }, signal)
      check()
      const [file] = held.value
      if (file === undefined || held.value.length !== 1) return { cleanup: 'unknown', cause: new Error('Missing publication receipt.') }
      finished = await send(response, { ok: true, value: { kind: file.kind, path: file.relativePath,
        sha256: file.claim.sha256, bytes: file.claim.bytes, outcome: file.outcome } }, 200, check)
      return { cleanup: 'confirmed', outcome: finished ? 'completed' : 'cancelled' }
    } catch (error) {
      if (source !== undefined) {
        try { await source.return?.(); request.pause(); sourceState.closed = true }
        catch (cause) { return { cleanup: 'unknown', cause } }
      }
      if (held !== undefined && (!sourceState.opened || sourceState.closed) && (signal.aborted || response.destroyed)) {
        await closeResponse(response)
        return { cleanup: 'confirmed', outcome: 'cancelled' }
      }
      if (sourceState.opened && !sourceState.closed || attempted && !(error instanceof FdMutationFailure && error.outcome === 'not-published')) {
        return { cleanup: 'unknown', cause: error }
      }
      if (signal.aborted || response.destroyed) {
        await closeResponse(response)
        return { cleanup: 'confirmed', outcome: 'cancelled' }
      }
      try {
        if (error instanceof CloudApiError && error.code === 'cloud/forbidden') rejectedStatus = 403
        finished = await send(response, { ok: false, error: { code: 'workspace/upload-rejected', outcome: 'not-published' } },
          rejectedStatus, current)
        return { cleanup: 'confirmed', outcome: finished ? 'rejected' : 'cancelled' }
      } catch (cause) { return { cleanup: 'unknown', cause } }
    } finally {
      // Closing an unread request before finish destroys its socket and can hide a complete rejection receipt.
      if (finished && !request.destroyed) request.destroy()
      if (held !== undefined && (!sourceState.opened || sourceState.closed) && (finished || response.destroyed)) held.release()
    }
  }
}
