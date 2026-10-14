/** The shared Host transports native streams to the Platform-selected tenant process. */
import type { Context } from '@deepseek-ai/cordis'
import type { Duplex } from 'node:stream'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { rejectRemoteStreamUpgrade } from '@deepseek-ai/dsh-api-gateway'
import { PlatformError } from '../contracts.ts'
import { proxyRuntimeUpgrade } from '../runtime-upgrade-proxy.ts'
import type { BrowserAgentAuth } from './browser-auth.ts'

/** Install the complete native mux carrier without giving the shared Host Kubernetes credentials.
 * @param ctx Shared Host lifetime and Web server.
 * @param auth Browser Agent verification service.
 * @param origin Configured public Host origin.
 * @param platformUrl Fixed internal Platform origin.
 * @param timeoutMs Upstream handshake deadline.
 */
export function installNativeRuntimeRoutingUpgrade(ctx: Context, auth: BrowserAgentAuth,
  origin: string, platformUrl: string, timeoutMs: number): void {
  const sockets = new Set<Duplex>(), pending = new Set<Promise<void>>()
  let closing = false
  const isClosing = (): boolean => closing
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/native/api/remote.mux', handler: async (request, socket, head) => {
    sockets.add(socket)
    const closed = socket.closed ? Promise.resolve() : new Promise<void>((resolve) => {
      const failed = (): void => { socket.destroy() }
      socket.on('error', failed)
      socket.once('close', () => { socket.off('error', failed); resolve() })
    })
    const work = (async () => {
      try {
        if (isClosing()) throw new PlatformError(503, 'native_runtime_closing')
        const credential = await auth.authenticate(request)
        if (request.headers.host !== new URL(origin).host || isClosing()) throw new PlatformError(403, 'invalid_host_authority')
        if (socket.destroyed) return
        await proxyRuntimeUpgrade(request, socket, head, new URL('/native/runtime/mux', platformUrl),
          { headers: { authorization: `Bearer ${credential.token}`, origin } }, timeoutMs)
      } catch (error) {
        if (!socket.destroyed) {
          socket.once('finish', () => { socket.destroy() })
          rejectRemoteStreamUpgrade(socket, error instanceof PlatformError && error.status === 401 ? 401
            : error instanceof PlatformError && error.status === 403 ? 403 : 503)
        }
      } finally { await closed; sockets.delete(socket) }
    })()
    pending.add(work)
    try { await work } finally { pending.delete(work) }
  } }))
  ctx.effect(() => async () => {
    closing = true
    for (const socket of sockets) socket.destroy()
    await Promise.allSettled([...pending])
  })
}
