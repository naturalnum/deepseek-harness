/** The shared Host forwards the original tenant client graph assets and HMR stream. */
import type { Context } from '@deepseek-ai/cordis'
import { nativeUiCsp, serveNativeUi } from '../ui.ts'
import { PlatformError } from '../contracts.ts'
import { installNativeClientHttp } from '../native-client-http.ts'
import { proxyRuntimeHttp } from '../runtime-http-proxy.ts'
import type { BrowserAgentAuth } from './browser-auth.ts'

/** Preserve original browser cookie admission and raw client bytes at a fixed Platform origin.
 * @param ctx Shared Host server lifetime.
 * @param auth Existing browser account authority.
 * @param origin Exact public Host origin.
 * @param platformUrl Fixed private Platform origin.
 * @param maxBytes Whole asset and HMR frame budget.
 * @param timeoutMs Upstream admission deadline.
 * @param clientLimits Validated Host client request count and streaming lifetime.
 * @returns Cached joined carrier shutdown.
 */
export function installNativeClientRouting(ctx: Context, auth: BrowserAgentAuth, origin: string,
  platformUrl: string, maxBytes: number, timeoutMs: number,
  clientLimits: { maxRequests: number; lifetimeMs: number; platformOrigin?: string }): () => Promise<void> {
  return installNativeClientHttp(ctx, '/native', async (request, response, target, method, signal) => {
    const resource = new URL(target || '/', origin)
    const credential = await auth.authenticate(request, true, !resource.pathname.startsWith('/plugins/'))
    signal.throwIfAborted()
    if (request.headers.host !== new URL(origin).host) throw new PlatformError(403, 'invalid_host_authority')
    const document = resource.pathname === '/' || resource.pathname === '/index.html'
    if (document && resource.search) throw new PlatformError(400, 'invalid_native_document')
    if (!document && !['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg'].includes(resource.pathname) && !['/plugins/', '/boot/', '/assets/'].some(prefix => resource.pathname.startsWith(prefix))) {
      throw new PlatformError(404, 'not_found')
    }
    if (document) response.setHeader('content-security-policy', nativeUiCsp(clientLimits.platformOrigin))
    if (document) {
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('referrer-policy', 'no-referrer')
    }
    if (resource.pathname.startsWith('/assets/') || ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg'].includes(resource.pathname)) {
      await serveNativeUi(new URL(request.url ?? '/', origin), response, clientLimits.platformOrigin)
      return
    }
    await proxyRuntimeHttp(response, new URL(document ? '/native/runtime/document' : `/native/runtime${target}`, platformUrl), {
      headers: { authorization: `Bearer ${credential.token}`, origin }, method,
      events: resource.pathname === '/plugins/events', signal,
      limits: { maxBytes, maxFrameBytes: maxBytes, handshakeMs: timeoutMs, lifetimeMs: clientLimits.lifetimeMs },
    })
  }, { maxRequests: clientLimits.maxRequests }, '')
}
