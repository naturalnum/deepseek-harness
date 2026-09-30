/** Platform-private MCP credential normalization, authenticated encryption and keyed replay identity. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { mcpConfigurationInput, mcpCredentialUpload, type McpConfigurationInput,
  type McpCredentialUpload, type McpResourceId } from '../mcp-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'

const blockedHeaders = new Set(['host', 'connection', 'content-length', 'content-type', 'accept',
  'accept-encoding', 'cookie', 'set-cookie', 'origin', 'referer', 'user-agent', 'upgrade', 'te',
  'trailer', 'transfer-encoding', 'keep-alive', 'expect', 'mcp-session-id', 'mcp-protocol-version',
  'last-event-id', 'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])

/** Explicit identity binds ciphertext to its purpose, owner and both immutable versions. */
export interface McpCredentialIdentity {
  kind: 'connection' | 'draft'; userId: UserId; resourceId: McpResourceId
  configurationRevision: number; credentialRevision: number
}

/** Stable JSON v1 sorts object keys and rejects non-JSON/deep inputs before digesting them.
 * @param value JSON-compatible input.
 * @returns Deterministic UTF-8 JSON text.
 */
export function mcpCanonicalJson(value: unknown): string {
  function canonical(item: unknown, depth: number): unknown {
    if (depth > 64) throw new PlatformError(400, 'mcp_json_depth')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(value => canonical(value, depth + 1))
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, value]) => [name, canonical(value, depth + 1)]))
    }
    throw new PlatformError(400, 'mcp_json_invalid')
  }
  return JSON.stringify(canonical(value, 0))
}

/** Transport-owned and browser security headers cannot be overridden by personal authentication.
 * @param name Header name supplied by the owner.
 * @returns A validated lower-case HTTP token.
 */
export function mcpHeaderName(name: string): string {
  const normalized = name.trim().toLowerCase()
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,200}$/u.test(normalized) || blockedHeaders.has(normalized)
    || /^(?:proxy-|sec-|x-forwarded-)/u.test(normalized)) throw new PlatformError(400, 'mcp_header_invalid')
  return normalized
}

/** Normalize metadata once; credential plans remain explicit and never include values.
 * @param value Untrusted complete metadata configuration.
 * @returns The canonical configuration used in request identity.
 */
export function normalizeMcpConfiguration(value: unknown): McpConfigurationInput {
  const input = mcpConfigurationInput.parse(value)
  let url: URL
  try { url = new URL(input.serverUrl) } catch { throw new PlatformError(400, 'mcp_url_invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || url.href.length > 2048 || /[\u0000-\u0020\u007f]/u.test(input.serverUrl)) {
    throw new PlatformError(400, 'mcp_url_invalid')
  }
  if (input.authentication.kind === 'headers') {
    const headers = input.authentication.headers.map(header => ({ ...header, name: mcpHeaderName(header.name) }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    if (new Set(headers.map(header => header.name)).size !== headers.length) {
      throw new PlatformError(400, 'mcp_header_duplicate')
    }
    return { ...input, serverUrl: url.href, displayName: input.displayName.normalize('NFC'),
      authentication: { kind: 'headers', headers } }
  }
  return { ...input, serverUrl: url.href, displayName: input.displayName.normalize('NFC') }
}

/** Validate direct secret input independently of Host metadata and enforce aggregate byte limits.
 * @param value Direct Platform JSON envelope.
 * @returns Canonical credential values, with no implicit preservation instruction.
 */
export function normalizeMcpUpload(value: unknown): McpCredentialUpload {
  const input = mcpCredentialUpload.parse(value)
  if (input.bearerToken !== undefined && (!input.bearerToken || Buffer.byteLength(input.bearerToken) > 8192
    || /[^\u0021-\u007e]/u.test(input.bearerToken))) throw new PlatformError(400, 'mcp_credential_invalid')
  const headers = input.headers?.map(header => {
    if (/[^\u0020-\u007e\u0080-\u00ff]/u.test(header.value) || Buffer.byteLength(header.value) > 8192) {
      throw new PlatformError(400, 'mcp_credential_invalid')
    }
    return { name: mcpHeaderName(header.name), value: header.value }
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  if (headers && new Set(headers.map(header => header.name)).size !== headers.length) {
    throw new PlatformError(400, 'mcp_header_duplicate')
  }
  const output = { formatVersion: 1 as const, ...(input.bearerToken === undefined ? {} : { bearerToken: input.bearerToken }),
    ...(headers === undefined ? {} : { headers }) }
  if (Buffer.byteLength(mcpCanonicalJson(output)) > 8192) throw new PlatformError(413, 'mcp_credential_too_large')
  return output
}

/** AES-GCM plus domain-separated HMAC; one backend key never leaves Platform memory. */
export class McpCredentialCipher {
  private readonly key: Buffer
  constructor(encodedKey: string) {
    const encoded = encodedKey.trim()
    const key = Buffer.from(encoded, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('Invalid MCP credential key')
    this.key = key
  }
  /** Backend-only digest prevents offline guesses of both supplied and retained low-entropy secrets. */
  fingerprint(domain: string, value: unknown): string {
    return createHmac('sha256', this.key).update(`power-evolve-mcp-v1\0${domain}\0`)
      .update(mcpCanonicalJson(value)).digest('hex')
  }
  private aad(identity: McpCredentialIdentity): Buffer {
    return Buffer.from(mcpCanonicalJson({ domain: 'power-evolve-mcp-credential-v1', ...identity }))
  }
  /** Seal only normalized version-one credentials. */
  seal(identity: McpCredentialIdentity, value: McpCredentialUpload): Buffer {
    const plaintext = Buffer.from(mcpCanonicalJson(value))
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
      cipher.setAAD(this.aad(identity))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    } finally { plaintext.fill(0) }
  }
  /** Reject wrong identity/key/ciphertext without leaking parser or cryptographic diagnostics. */
  open(identity: McpCredentialIdentity, sealed: Buffer): McpCredentialUpload {
    let plaintext: Buffer | undefined
    try {
      if (sealed.length < 29) throw new Error('Invalid ciphertext')
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12))
      decipher.setAAD(this.aad(identity)); decipher.setAuthTag(sealed.subarray(12, 28))
      plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
      const text = plaintext.toString('utf8')
      if (!Buffer.from(text).equals(plaintext)) throw new Error('Invalid UTF-8')
      return normalizeMcpUpload(JSON.parse(text))
    } catch { throw new PlatformError(503, 'mcp_credential_unavailable') }
    finally { plaintext?.fill(0) }
  }
}
