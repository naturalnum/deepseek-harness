/** One internal delivery, authenticated by the actual TLS connection; account admission remains with runtime. */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { TLSSocket } from 'node:tls'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId, InstanceId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { AuthAccessError } from './auth-error.ts'

/** Reserved for an authenticated node delivering directly to the selected owner. */
export const OWNER_HOP_HEADER = 'x-dsh-cloud-owner-hop'

/** Detached expectations only; no binding, lifetime, login or authority is reconstructed. */
export interface OwnerHop {
  readonly accountId: AccountId
  readonly recipientInstanceId: InstanceId
  readonly epoch: OwnerEpoch
  readonly recipeVersion: string
}

/**
 * Decode at most one internal marker after authenticating this actual connection.
 * @param request Original unconsumed Node request, including duplicate raw headers.
 * @param trustedPeerPins Root-selected SHA-256 certificate digests, in lowercase hexadecimal.
 * @param maxBytes Validated finite marker-byte limit, independently bounded by the HTTP header parser.
 * @param requestId Original ingress correlation identifier.
 * @returns One-hop expectations, or undefined for an ordinary public connection without the marker.
 * @throws AuthAccessError for a forged, malformed, duplicate or removable marker, or an internal connection without it.
 */
export function readOwnerHop(
  request: IncomingMessage, trustedPeerPins: ReadonlySet<string>, maxBytes: number,
  requestId: Branded<'pe-request-id'>,
): OwnerHop | undefined {
  const reject = (): never => { throw new AuthAccessError('cloud/forbidden', requestId) }
  let encoded: string | undefined
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase(), value = request.rawHeaders[index + 1]
    if (name === OWNER_HOP_HEADER) {
      if (encoded !== undefined || value === undefined || Buffer.byteLength(value, 'latin1') > maxBytes) reject()
      encoded = value
    }
    if (name === 'connection' && value?.split(',').some(part => part.trim().toLowerCase() === OWNER_HOP_HEADER)) reject()
  }

  const socket = request.socket
  let trusted = false
  if (socket instanceof TLSSocket && socket.authorized) {
    const certificate = socket.getPeerCertificate()
    if (Buffer.isBuffer(certificate.raw)) {
      trusted = trustedPeerPins.has(createHash('sha256').update(certificate.raw).digest('hex'))
    }
  }
  if (encoded === undefined) {
    if (trusted) reject()
    return undefined
  }
  if (!trusted || !/^[A-Za-z0-9_-]+$/.test(encoded)) reject()
  const decoded = Buffer.from(encoded, 'base64url')
  if (decoded.toString('base64url') !== encoded) reject()
  let input: unknown
  try { input = JSON.parse(decoded.toString('utf8')) }
  catch (_error) { return reject() }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) reject()
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 5 || value['version'] !== 1) reject()
  const field = (name: string): string => {
    const text = value[name]
    if (typeof text !== 'string' || text.length === 0 || /[\u0000-\u0020\u007f]/u.test(text)) return reject()
    return text
  }
  const accountId = field('accountId'), recipientInstanceId = field('recipientInstanceId')
  const epoch = field('epoch'), recipeVersion = field('recipeVersion')
  // A wire expectation must be canonical; only an exact match to the original persisted owner can admit it.
  if (!/^[1-9][0-9]{0,18}$/.test(epoch)) reject()
  return Object.freeze({ accountId: brandString<AccountId>(accountId),
    recipientInstanceId: brandString<InstanceId>(recipientInstanceId),
    epoch: brandString<OwnerEpoch>(epoch), recipeVersion })
}

/**
 * Encode an already decoded owner expectation for its fixed authenticated target.
 * @param hop Original owner metadata selected by trusted Host composition.
 * @param maxBytes Validated finite marker-byte limit.
 * @param requestId Original ingress correlation identifier.
 * @returns The bounded internal header value; callers must never forward an incoming marker again.
 * @throws AuthAccessError when the emitted marker exceeds its selected budget.
 */
export function encodeOwnerHop(hop: OwnerHop, maxBytes: number, requestId: Branded<'pe-request-id'>): string {
  const value = Buffer.from(JSON.stringify({ version: 1, accountId: hop.accountId,
    recipientInstanceId: hop.recipientInstanceId, epoch: hop.epoch, recipeVersion: hop.recipeVersion }), 'utf8').toString('base64url')
  if (Buffer.byteLength(value, 'latin1') > maxBytes) throw new AuthAccessError('cloud/capacity', requestId)
  return value
}
