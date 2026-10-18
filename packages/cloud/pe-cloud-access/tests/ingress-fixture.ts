/** Memory Node carriers and explicit test budgets; no listener, database schema or account-ready fixture. */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { AccessConfig } from '../src/types.ts'
import type { AuthIngressConfig, AuthRootConfig } from '../src/root-config.ts'

/** In-process byte sink for real Node HTTP responses and upgrade rejections. */
export class MemorySocket extends Socket {
  readonly output: Buffer[] = []
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output.push(Buffer.from(chunk))
    callback()
  }
  override _writev(chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>, callback: (error?: Error | null) => void): void {
    for (const { chunk } of chunks) this.output.push(Buffer.from(chunk))
    callback()
  }
}

/**
 * Construct original Node request/response objects without listening on a port.
 * @param path Request target.
 * @param method HTTP method.
 * @param extra Original additional header pairs, preserving duplicates.
 * @returns The real carrier and captured wire bytes.
 */
export function carrier(path: string, method = 'GET', extra: readonly string[] = []): {
  request: IncomingMessage
  response: ServerResponse
  socket: MemorySocket
} {
  const socket = new MemorySocket()
  const request = new IncomingMessage(socket)
  request.url = path
  request.method = method
  request.httpVersionMajor = 1
  request.httpVersionMinor = 1
  request.httpVersion = '1.1'
  request.rawHeaders = ['Host', '127.0.0.1:4100', ...extra]
  request.headers = { host: '127.0.0.1:4100' }
  for (let index = 0; index < extra.length; index += 2) {
    const key = extra[index]?.toLowerCase()
    if (key !== undefined) request.headers[key] = extra[index + 1] ?? ''
  }
  const response = new ServerResponse(request)
  response.assignSocket(socket)
  return { request, response, socket }
}

/** @returns Explicit fixed-origin test input; it grants no identity or readiness. */
export function accessConfig(): AccessConfig {
  return {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'INGRESS_TEST_AUTH',
    sessionRecheckMs: 50, authCheckTimeoutMs: 500, maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerWaiters: 8, maxPeerWaitersPerAccount: 4, maxPeerCarriers: 8, maxPeerCarriersPerAccount: 4,
    maxPeerCarriersPerLogin: 2, peerCloseTimeoutMs: 100, maxAuthOperations: 4,
    maxTrackedLogins: 8, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 4,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}

/** @returns Finite ingress capacities; every production admission prerequisite remains absent. */
export function ingressConfig(): AuthIngressConfig {
  return {
    maxOperations: 4, maxOperationsPerAccount: 2, requestTimeoutMs: 500,
    maxAuthRequestBodyBytes: 1024, maxRequestBodyBytes: 4096, maxBootstrapResponseBytes: 4096, maxGenerationBindings: 4,
    maxFrameBytes: 1024, maxLogicalStreams: 8, maxLogicalStreamsPerAccount: 4, maxLogicalStreamsPerPeer: 2,
  }
}

/** @returns Root resource input pointed only at deliberately unavailable port 1. */
export function rootConfig(): AuthRootConfig {
  return {
    ...accessConfig(), ingress: ingressConfig(),
    database: { host: '127.0.0.1', port: 1, user: 'ingress_test', database: 'unavailable', passwordRef: 'INGRESS_TEST_DB_PASSWORD', ssl: false },
    pool: {
      maxConnections: 1, connectionTimeoutMs: 30, statementTimeoutMs: 500, lockTimeoutMs: 50,
      idleTimeoutMs: 100, idleTransactionTimeoutMs: 500, maxLifetimeSeconds: 10,
    },
    startupTimeoutMs: 2000, secretResolveTimeoutMs: 100, maxSecretOperations: 2, maxSecretBytes: 128,
  }
}
