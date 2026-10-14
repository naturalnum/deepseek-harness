/** The execution carrier retains original operation credentials through cleanup and joined HTTP shutdown. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { PlatformError } from '../contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../http.ts'
import type { NativeExecutionRoutes } from './native-execution-routes.ts'

/** Install original-world HTTP dispatch without substituting Browser or Runtime authentication.
 * @param ctx Platform route lifetime.
 * @param routes Original operation and exact cleanup authority.
 * @param maxRequestBytes Complete execution request budget.
 * @returns Cached shutdown after accepted requests and their original transports settle.
 */
export function installNativeExecutionHttp(ctx: Context, routes: Pick<NativeExecutionRoutes, 'route'>,
  maxRequestBytes: number): () => Promise<void> {
  const requests = new Set<IncomingMessage>(), responses = new Set<ServerResponse>(), pending = new Set<Promise<void>>()
  let closing = false, closed: Promise<void> | undefined
  const isClosing = (): boolean => closing
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/runtime/native-world', handler: async (request, response) => {
    requests.add(request); responses.add(response)
    const requestClosed = transportClosed(request), responseClosed = transportClosed(response)
    const work = (async () => {
      try {
        if (isClosing()) throw new PlatformError(503, 'native_execution_closing')
        if (request.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
        const token = bearer(request), path = new URL(request.url ?? '/', 'http://localhost').pathname
        const input = await readJson(request, maxRequestBytes)
        if (isClosing() || response.destroyed) throw new PlatformError(503, 'native_execution_closing')
        sendJson(response, await routes.route(path, token, input))
      } catch (error) { if (!response.destroyed) sendFailure(response, error) }
      finally {
        await responseClosed
        if (!request.complete) request.destroy()
        await requestClosed
        requests.delete(request); responses.delete(response)
      }
    })()
    pending.add(work)
    try { await work } finally { pending.delete(work) }
  } }))
  const close = (): Promise<void> => closed ??= (async () => {
    closing = true
    for (const request of requests) request.destroy()
    for (const response of responses) response.destroy()
    await Promise.allSettled([...pending])
  })()
  ctx.effect(() => close)
  return close
}

function transportClosed(transport: IncomingMessage | ServerResponse): Promise<void> {
  if (transport.closed) return Promise.resolve()
  return new Promise((resolve) => {
    const failed = (): void => { transport.destroy() }
    transport.on('error', failed)
    transport.once('close', () => { transport.off('error', failed); resolve() })
  })
}
