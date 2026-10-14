/** Browser Agent credential exchange and cookie admission for product RPC. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { identity, settings, PlatformError } from '../contracts.ts'
import { bearer, readJson, sendJson } from '../http.ts'

const cookieName = 'pe_agent'
const cookiePaths = ['/native/api', '/api/powerEvolve', '/native/plugins'] as const
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)
const exchangeRequest = z.object({ token: tokenSchema }).strict()
const agentIdentity = identity.safeExtend({ settings })

/** Platform verification stays authoritative across Host replicas and restarts. */
export interface AgentVerifier {
  /** Call one platform endpoint with an Agent credential.
   * @param path - platform API path.
   * @param token - credential presented by the browser.
   * @param input - validated endpoint fields.
   * @returns bounded platform response.
   */
  call(path: string, token: string, input: unknown): Promise<unknown>
}

/** The external Host origin must be HTTPS, except for a local HTTP trial. */
function secureCookie(origin: string): boolean {
  const url = new URL(origin)
  if (url.origin !== origin || url.username || url.password) throw new Error('Invalid Host origin')
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
  throw new Error('Browser Agent cookies require HTTPS outside loopback')
}

function cookieHeaders(token: string, secure: boolean, clear = false): string[] {
  return cookiePaths.map(path => `${cookieName}=${token}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`)
}

function cookieToken(request: IncomingMessage, origin: string): string | undefined {
  const path = new URL(request.url ?? '/', origin).pathname
  if (!cookiePaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return undefined
  const [match, ...duplicates] = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${cookieName}=`))
  if (match === undefined) return undefined
  if (duplicates.length) throw new PlatformError(401, 'ambiguous_credential')
  const token = match.slice(cookieName.length + 1)
  if (!tokenSchema.safeParse(token).success) throw new PlatformError(401, 'unauthorized')
  return token
}

/** Authenticate browser RPC without retaining a process-local login session. */
export class BrowserAgentAuth {
  private readonly secure: boolean

  constructor(private readonly hostOrigin: string, private readonly platformOrigin: string,
    private readonly verifier: AgentVerifier, private readonly expectedUserId?: string,
    private readonly broker?: (token: string | undefined) => Promise<void>) {
    this.secure = secureCookie(hostOrigin)
    const platform = new URL(platformOrigin)
    if (platform.origin !== platformOrigin || platform.username || platform.password) throw new Error('Invalid platform origin')
  }

  /** Exchange an Agent token held only in login-page memory for an HttpOnly cookie.
   * @param request - platform-origin browser request.
   * @param response - Host response that receives scoped cookies.
   */
  async exchange(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.platformOrigin) throw new PlatformError(403, 'invalid_origin')
    if (request.method === 'OPTIONS') {
      if (request.headers['access-control-request-method'] !== 'POST'
        || request.headers['access-control-request-headers']?.toLowerCase() !== 'content-type') {
        throw new PlatformError(403, 'invalid_preflight')
      }
      response.writeHead(204, { 'access-control-allow-origin': this.platformOrigin,
        'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '600',
        'cache-control': 'no-store', vary: 'Origin' })
      response.end()
      return
    }
    if (request.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      throw new PlatformError(415, 'invalid_content_type')
    }
    const { token } = exchangeRequest.parse(await readJson(request, 4096))
    this.assertOwner(agentIdentity.parse(await this.verifier.call('/identity/me', token, {})))
    const replacement = z.object({ token: tokenSchema }).strict().parse(
      await this.verifier.call('/identity/exchange', token, {}),
    ).token
    response.setHeader('access-control-allow-origin', this.platformOrigin)
    response.setHeader('access-control-allow-credentials', 'true')
    response.setHeader('vary', 'Origin')
    response.setHeader('set-cookie', cookieHeaders(replacement, this.secure))
    sendJson(response, { ok: true })
  }

  /** Verify every RPC or stream request at the platform and return its current identity.
   * @param request - product RPC or native API request, including WebSocket upgrade.
   * @param safeGet - allow a same-origin GET navigation whose browser omits the Origin header.
   * @returns the current Agent credential and platform identity.
   */
  async authenticate(request: IncomingMessage, safeGet = false): Promise<{
    token: string
    fromCookie: boolean
    user: z.infer<typeof agentIdentity>
  }> {
    if (this.broker !== undefined) {
      const runtimeToken = request.headers['x-power-evolve-runner-token']
      await this.broker(typeof runtimeToken === 'string' ? runtimeToken : undefined)
      const raw = request.headers['x-power-evolve-browser-token']
      const token = tokenSchema.parse(typeof raw === 'string' ? raw : undefined)
      if (request.headers.origin !== undefined && request.headers.origin !== this.hostOrigin) throw new PlatformError(403, 'invalid_origin')
      return { token, fromCookie: false, user: this.assertOwner(agentIdentity.parse(await this.verifier.call('/identity/me', token, {}))) }
    }
    const cookie = cookieToken(request, this.hostOrigin)
    if (request.headers.authorization !== undefined) {
      if (cookie !== undefined) throw new PlatformError(401, 'ambiguous_credential')
      if (request.headers.origin !== undefined && request.headers.origin !== this.hostOrigin) {
        throw new PlatformError(403, 'invalid_origin')
      }
      const token = bearer(request)
      return { token, fromCookie: false, user: this.assertOwner(agentIdentity.parse(await this.verifier.call('/identity/me', token, {}))) }
    }
    const sameOriginNavigation = safeGet && request.method === 'GET' && request.headers.origin === undefined
      && (request.headers['sec-fetch-site'] === undefined
        || request.headers['sec-fetch-site'] === 'same-origin' || request.headers['sec-fetch-site'] === 'none')
    if (request.headers.origin !== this.hostOrigin && !sameOriginNavigation) throw new PlatformError(403, 'invalid_origin')
    if (!cookie) throw new PlatformError(401, 'unauthorized')
    return { token: cookie, fromCookie: true, user: this.assertOwner(agentIdentity.parse(await this.verifier.call('/identity/me', cookie, {}))) }
  }

  private assertOwner(user: z.infer<typeof agentIdentity>): z.infer<typeof agentIdentity> {
    if (this.expectedUserId !== undefined && user.userId !== this.expectedUserId) throw new PlatformError(401, 'unauthorized')
    return user
  }

  /** Clear a browser credential after the platform has revoked it.
   * @param response - Host response that removes both scoped cookies.
   */
  clear(response: ServerResponse): void { response.setHeader('set-cookie', cookieHeaders('', this.secure, true)) }
}
