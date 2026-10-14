/** The shared Host forwards the original tenant client graph assets and HMR stream. */
import type { Context } from '@deepseek-ai/cordis'
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
 * @returns Cached joined carrier shutdown.
 */
export function installNativeClientRouting(ctx: Context, auth: BrowserAgentAuth, origin: string,
  platformUrl: string, maxBytes: number, timeoutMs: number): () => Promise<void> {
  return installNativeClientHttp(ctx, '/native/plugins', async (request, response, target, method, signal) => {
    const credential = await auth.authenticate(request, true)
    signal.throwIfAborted()
    if (request.headers.host !== new URL(origin).host) throw new PlatformError(403, 'invalid_host_authority')
    await proxyRuntimeHttp(response, new URL(`/native/runtime${target}`, platformUrl), {
      headers: { authorization: `Bearer ${credential.token}`, origin }, method,
      events: new URL(target, origin).pathname === '/plugins/events', signal,
      limits: { maxBytes, maxFrameBytes: maxBytes, handshakeMs: timeoutMs, lifetimeMs: 30_000 },
    })
  })
}
