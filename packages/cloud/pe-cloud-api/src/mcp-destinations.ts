/** Root-selected MCP endpoints and the account-owned outbound transport. */
import { BlockList, isIP } from 'node:net'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { createPinnedHttpTransport, createPinnedLookup, isPublicIpAddress, resolvePublicAddresses } from '@deepseek-ai/dsh-web-fetch-http'
import { CloudApiError } from './errors.ts'

const platformAddresses = new BlockList()
// Azure presents this platform-only virtual address in public IP space.
platformAddresses.addAddress('168.63.129.16')

function outsideCloudPlatform(address: string): boolean {
  return !platformAddresses.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

function unbracket(host: string): string { return host.startsWith('[') ? host.slice(1, -1) : host }

/** Normalize an HTTP endpoint that may be selected by the Root policy.
 * @param input - complete URL from the Root, saved record or native transport.
 * @returns canonical endpoint, or undefined for inadmissible input.
 */
export function publicMcpEndpoint(input: string): string | undefined {
  const url = URL.parse(input)
  if (url === null || !/^https?:\/\//i.test(input) || /[\u0000-\u0020\u007f#]/u.test(input)
    || url.username || url.password) return undefined
  const host = unbracket(url.hostname).replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || isIP(host) !== 0 && (!isPublicIpAddress(host) || !outsideCloudPlatform(host))) return undefined
  return url.href
}

// Undici accepts an async byte iterator for a streaming request body.
async function* requestBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally { reader.releaseLock() }
}

function forbidden(): CloudApiError {
  return new CloudApiError('cloud/mcp-destination-forbidden', 'This MCP address is not allowed.')
}

/** One admission owner for connection definitions and every native HTTP request. */
export class McpDestinations {
  private readonly allowed: ReadonlySet<string>
  private transport: ReturnType<typeof createPinnedHttpTransport> | undefined
  private closing: Promise<void> | undefined

  /** @param endpoints - canonical endpoints selected by the original Root catalog.
   * @param lifetime - original account generation, also bounding pending DNS observations.
   */
  constructor(endpoints: readonly string[], private readonly lifetime: AbortSignal) {
    this.allowed = new Set(endpoints)
  }

  /** Check the endpoint against the account’s Root selection.
   * @param input - account-local connection definition.
   * @returns whether the current Root selection permits the exact endpoint.
   */
  allows(input: string): boolean {
    const endpoint = publicMcpEndpoint(input)
    return endpoint !== undefined && this.allowed.has(endpoint)
  }

  /** Reject an endpoint that is outside the Root selection.
   * @param input - endpoint for a test, save, enable or outbound request.
   */
  assertAllowed(input: string): void {
    if (!this.allows(input)) throw forbidden()
  }

  private async addresses(host: string, signal: AbortSignal) {
    try {
      const addresses = await resolvePublicAddresses(host, signal, undefined, outsideCloudPlatform)
      signal.throwIfAborted()
      return addresses
    } catch (_error) {
      signal.throwIfAborted()
      throw forbidden()
    }
  }

  private directTransport(): ReturnType<typeof createPinnedHttpTransport> {
    return this.transport ??= createPinnedHttpTransport((host, options, callback) => {
      void this.addresses(host, this.lifetime).then(
        addresses => createPinnedLookup(addresses)(host, options, callback),
        () => callback(forbidden(), options.all === true ? [] : '', 0),
      )
    })
  }

  /** Apply Root policy before handing any request or private headers to the carrier. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    this.assertAllowed(url.href)
    const signal = AbortSignal.any([this.lifetime, ...init?.signal ? [init.signal] : [],
      ...input instanceof Request ? [input.signal] : []])
    signal.throwIfAborted()
    // Literal IPv6 destinations bypass DNS lookup in Node, but may use a NAT64 route.
    if (isIP(unbracket(url.hostname)) === 6) await this.addresses(url.hostname, signal)
    if (this.closing !== undefined || proxyRouteFor(url).proxied) throw forbidden()
    const transport = await this.directTransport()
    signal.throwIfAborted()
    if (this.closing !== undefined || proxyRouteFor(url).proxied) throw forbidden()
    const request = new Request(input instanceof Request ? input : url, init)
    const response = await transport.request(url, { method: request.method, headers: [...request.headers],
      body: request.body === null ? null : requestBytes(request.body), signal })
    const source: NodeReadableStream<Uint8Array> | null = response.body
    const reader = source?.getReader()
    const body = reader === undefined ? null : new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (!chunk.done) { controller.enqueue(chunk.value); return }
          reader.releaseLock()
          controller.close()
        } catch (error) {
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } finally { reader.releaseLock() }
      },
    }, { highWaterMark: 0 })
    const webResponse = new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] })
    Object.defineProperties(webResponse, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    })
    return webResponse
  }

  /** Close the account’s owned HTTP carrier.
   * @returns Actual dispatcher closure after the original clients and readers settle.
   */
  close(): Promise<void> {
    return this.closing ??= this.transport?.then(transport => transport.close()) ?? Promise.resolve()
  }
}
