/** Account-authenticated carriers preserve the native RPC and stream protocols. */
import type { Context } from '@deepseek-ai/cordis'
import type { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { rejectRemoteStreamUpgrade } from '@deepseek-ai/dsh-api-gateway'
import { z } from 'zod'
import { installNativeClientHttp } from '../native-client-http.ts'
import { PlatformError } from '../contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../http.ts'
import type { IdentityService } from './identity.ts'
import type { KubernetesClient } from './kubernetes.ts'
import type { NativeRuntimePool, NativeRuntimePoolConfig } from './native-runtime-pool.ts'

const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1).max(128),
  method: z.string().min(1).max(120), payload: z.object({ args: z.unknown() }).strict() }).strict()

/** Install browser-account carriers and a non-overlapping process revocation reconciler.
 * @param ctx Trusted Platform lifetime.
 * @param pool Platform-owned tenant process pool.
 * @param kube Credentialed service proxy transport.
 * @param identities Current browser account authority.
 * @param config Validated pool deployment.
 * @param maxRequestBytes Original native RPC request budget.
 * @returns Idempotent joined shutdown, also registered with the Context lifetime.
 */
export function installNativeRuntimePoolRoutes(ctx: Context,
  pool: Pick<NativeRuntimePool, 'invoke' | 'streamTarget' | 'reconcile' | 'close' | 'clientResource'>,
  kube: Pick<KubernetesClient, 'proxyUpgrade'>,
  identities: Pick<IdentityService, 'authenticate'>, config: NativeRuntimePoolConfig, maxRequestBytes: number): () => Promise<void> {
  const streams = new Set<Duplex>(), pending = new Set<Promise<void>>()
  const requests = new Set<IncomingMessage>(), responses = new Set<ServerResponse>()
  let closing = false
  const isClosing = (): boolean => closing
  const origin = config.deployment.hostOrigin
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/native/runtime/invoke', handler: async (request, response) => {
    requests.add(request); responses.add(response)
    const requestClosed = transportClosed(request), responseClosed = transportClosed(response)
    const work = (async () => {
      try {
        if (isClosing()) throw new PlatformError(503, 'native_runtime_closing')
        if (request.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
        if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new PlatformError(403, 'invalid_origin')
        const token = bearer(request), user = await identities.authenticate(token)
        if (isClosing() || request.destroyed) throw new PlatformError(503, 'native_runtime_closing')
        const body = envelope.parse(await readJson(request, maxRequestBytes))
        if (isClosing() || response.destroyed) throw new PlatformError(503, 'native_runtime_closing')
        sendJson(response, await pool.invoke(user.userId, token, body))
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
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/native/runtime/mux', handler: async (request, socket, head) => {
    streams.add(socket)
    const closed = transportClosed(socket)
    const socketUnavailable = (): boolean => socket.destroyed
    const work = (async () => {
      try {
        if (isClosing()) throw new PlatformError(503, 'native_runtime_closing')
        if (request.headers.origin !== origin) throw new PlatformError(403, 'invalid_origin')
        const token = bearer(request), user = await identities.authenticate(token)
        if (isClosing() || socketUnavailable()) return
        const target = await pool.streamTarget(user.userId)
        if (isClosing() || socketUnavailable()) { socket.destroy(); return }
        await kube.proxyUpgrade(request, socket, head, target.path, target.token, token, origin, config.requestTimeoutMs)
      } catch (error) {
        if (!socket.destroyed) {
          socket.once('finish', () => { socket.destroy() })
          rejectRemoteStreamUpgrade(socket, error instanceof PlatformError && error.status === 401 ? 401
            : error instanceof PlatformError && error.status === 403 ? 403 : 503)
        }
      } finally { await closed; streams.delete(socket) }
    })()
    pending.add(work)
    try { await work } finally { pending.delete(work) }
  } }))
  const closeClients = installNativeClientHttp(ctx, '/native/runtime', async (request, response, target, method, signal) => {
    if (request.headers.origin !== origin) throw new PlatformError(403, 'invalid_origin')
    const token = bearer(request), user = await identities.authenticate(token)
    signal.throwIfAborted()
    await pool.clientResource(user.userId, token, target === '/document' ? '/native/runtime/document' : target, method, response, signal)
  }, { ...(config.clientMaxRequests === undefined ? {} : { maxRequests: config.clientMaxRequests }) }, '')
  let reconciliation: Promise<void> | undefined
  const timer = setInterval(() => {
    if (isClosing() || reconciliation) return
    reconciliation = pool.reconcile().catch((error: unknown) => {
      ctx.logger.warn('Native runtime reconciliation failed (%s)', error instanceof Error ? error.name : 'unknown')
    }).finally(() => { reconciliation = undefined })
  }, config.reconcileMs)
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true; clearInterval(timer)
    for (const request of requests) request.destroy()
    for (const response of responses) response.destroy()
    for (const socket of streams) socket.destroy()
    await Promise.allSettled([...pending, ...(reconciliation ? [reconciliation] : [])])
    await closeClients()
    await pool.close()
  })()
  ctx.effect(() => close)
  return close
}

function transportClosed(transport: Duplex | IncomingMessage | ServerResponse): Promise<void> {
  if (transport.closed) return Promise.resolve()
  return new Promise((resolve) => {
    const failed = (): void => { transport.destroy() }
    transport.on('error', failed)
    transport.once('close', () => { transport.off('error', failed); resolve() })
  })
}
