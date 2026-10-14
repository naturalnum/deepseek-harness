/** Whole-request ownership for original native client assets and HMR streams. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { PlatformError } from './contracts.ts'
import { sendFailure } from './http.ts'

/** Admission and forwarding remain owned by the Host or Platform authority. */
export type NativeClientForward = (request: IncomingMessage, response: ServerResponse, target: string,
  method: 'GET' | 'HEAD', signal: AbortSignal) => Promise<void>

/** Install one original resource prefix and join every accepted authentication and transport on shutdown.
 * @param ctx Owning HTTP server lifetime.
 * @param prefix External resource prefix mapped to original /plugins.
 * @param forward Caller-owned authoritative admission and fixed-target forwarding.
 * @returns Cached explicit shutdown; callers join it before credential and database shutdown.
 */
export function installNativeClientHttp(ctx: Context, prefix: string, forward: NativeClientForward): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const live = new Map<ServerResponse, { request: IncomingMessage; controller: AbortController }>()
  let closing = false, closePromise: Promise<void> | undefined
  const isClosing = (): boolean => closing
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (request, response) => {
    const controller = new AbortController()
    const aborted = (): void => { controller.abort(new Error('Native client downstream closed')) }
    response.once('close', aborted)
    const responseClosed = response.closed ? Promise.resolve() : new Promise<void>((resolve) => { response.once('close', resolve) })
    const requestClosed = request.closed ? Promise.resolve() : new Promise<void>((resolve) => { request.once('close', resolve) })
    live.set(response, { request, controller })
    const work = (async () => {
      try {
        if (isClosing()) throw new PlatformError(503, 'native_runtime_closing')
        const method = request.method
        if (method !== 'GET' && method !== 'HEAD') throw new PlatformError(405, 'method_not_allowed')
        const original = new URL(request.url ?? '/', 'http://native')
        const target = `/plugins${original.pathname.slice(prefix.length)}${original.search}`
        await forward(request, response, target, method, controller.signal)
        if (!response.writableEnded && !response.destroyed) response.end()
      } catch (error) {
        if (!response.destroyed) {
          if (response.headersSent) response.destroy()
          else sendFailure(response, error)
        }
      } finally {
        await responseClosed
        if (!request.complete) request.destroy()
        await requestClosed
        response.off('close', aborted); live.delete(response)
      }
    })()
    pending.add(work)
    try { await work } finally { pending.delete(work) }
  } }))
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true
    for (const [response, value] of live) {
      value.controller.abort(new Error('Native client owner closing'))
      value.request.destroy(); response.destroy()
    }
    await Promise.all([...pending])
  })()
  ctx.effect(() => close)
  return close
}
