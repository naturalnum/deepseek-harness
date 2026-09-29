/** Bounded, explicit wire format for one SSH connector call. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { isIP } from 'node:net'

export type SshCredential =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'private_key'; readonly privateKey: string; readonly passphrase?: string }

export interface Destination {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly hostKeySha256?: string
}

export type CallInput = {
  readonly callId: string
  readonly instanceId: string
  readonly digest: string
  readonly destination: Destination
  readonly timeoutMs: number
  readonly maxOutputBytes: number
} & ({ readonly kind: 'ssh.inspect' } | {
  readonly kind: 'ssh.authenticate'
  readonly credential: SshCredential
} | {
  readonly kind: 'ssh.execute'
  readonly credential: SshCredential
  readonly command: string
})

export type UnsignedCallInput = CallInput extends infer Member
  ? Member extends CallInput ? Omit<Member, 'digest'> : never : never

export type CallResult =
  | { readonly kind: 'ssh.inspect'; readonly hostKeySha256: string; readonly serverBanner: string | null }
  | { readonly kind: 'ssh.authenticate'; readonly serverBanner: string | null }
  | { readonly kind: 'ssh.execute'; readonly exitCode: number | null; readonly signal: string | null;
      readonly stdout: string; readonly stderr: string }

export class CallValidationError extends Error {
  constructor(readonly code: string) { super(code) }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const fingerprint = /^SHA256:[A-Za-z0-9+/]{43}$/u
const hexDigest = /^[0-9a-f]{64}$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}
function text(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes && !value.includes('\0')
}
function bounded(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum
}

/** Normalize an exact operator-approved host:port; no wildcards or CIDR ranges. */
export function destinationKey(host: string, port: number): string {
  if (!text(host, 512) || /\s|[/?#@]/u.test(host) || !bounded(port, 65_535)) {
    throw new CallValidationError('invalid_destination')
  }
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const ascii = (isIP(unwrapped) ? unwrapped : domainToASCII(unwrapped)).toLowerCase()
  if (!ascii || ascii.length > 253 || /[^a-z0-9.:-]/u.test(ascii)) {
    throw new CallValidationError('invalid_destination')
  }
  return ascii.includes(':') ? `[${ascii}]:${port}` : `${ascii}:${port}`
}

/** Parse the deployment-owned destination allowlist; empty input denies every target. */
export function parseAllowlist(raw: string): ReadonlySet<string> {
  if (!raw.trim()) return new Set()
  const entries = raw.split(',').map(value => value.trim())
  if (entries.length > 128 || entries.some(value => !value)) throw new CallValidationError('invalid_allowlist')
  return new Set(entries.map(value => {
    if (value.startsWith('[')) {
      const split = value.indexOf(']:')
      if (split < 0) throw new CallValidationError('invalid_allowlist')
      return destinationKey(value.slice(1, split), Number(value.slice(split + 2)))
    }
    const split = value.lastIndexOf(':')
    if (split < 1 || value.indexOf(':') !== split) throw new CallValidationError('invalid_allowlist')
    return destinationKey(value.slice(0, split), Number(value.slice(split + 1)))
  }))
}

/** Strictly parse a request before reserving its stable call ID. */
export function parseCallInput(value: unknown): CallInput {
  if (!record(value) || typeof value.kind !== 'string') throw new CallValidationError('invalid_call')
  const common = ['callId', 'instanceId', 'digest', 'destination', 'timeoutMs', 'maxOutputBytes', 'kind']
  const fields = value.kind === 'ssh.inspect' ? common
    : value.kind === 'ssh.authenticate' ? [...common, 'credential']
      : value.kind === 'ssh.execute' ? [...common, 'credential', 'command'] : []
  if (!fields.length || !exact(value, fields) || typeof value.callId !== 'string' || !uuid.test(value.callId)
    || typeof value.instanceId !== 'string' || !uuid.test(value.instanceId)
    || typeof value.digest !== 'string' || !hexDigest.test(value.digest)
    || !bounded(value.timeoutMs, 60_000) || !bounded(value.maxOutputBytes, 131_072)
    || !record(value.destination)) throw new CallValidationError('invalid_call')
  const destination = value.destination
  const expectedFields = value.kind === 'ssh.inspect' ? ['host', 'port', 'username']
    : ['host', 'port', 'username', 'hostKeySha256']
  if (!exact(destination, expectedFields) || !text(destination.host, 512)
    || !bounded(destination.port, 65_535) || !text(destination.username, 256)
    || /[\r\n\x00-\x1f\x7f]/u.test(destination.username)
    || value.kind !== 'ssh.inspect' && (typeof destination.hostKeySha256 !== 'string'
      || !fingerprint.test(destination.hostKeySha256))) throw new CallValidationError('invalid_call')
  destinationKey(destination.host, destination.port)
  if (value.kind === 'ssh.inspect') return value as CallInput
  const credential = value.credential
  if (!record(credential) || typeof credential.kind !== 'string') throw new CallValidationError('invalid_call')
  if (credential.kind === 'password') {
    if (!exact(credential, ['kind', 'password']) || !text(credential.password, 4096)) {
      throw new CallValidationError('invalid_call')
    }
  } else if (credential.kind === 'private_key') {
    if (!exact(credential, credential.passphrase === undefined ? ['kind', 'privateKey']
      : ['kind', 'privateKey', 'passphrase']) || !text(credential.privateKey, 7168)
      || credential.passphrase !== undefined && !text(credential.passphrase, 1024)) {
      throw new CallValidationError('invalid_call')
    }
  } else throw new CallValidationError('invalid_call')
  if (value.kind === 'ssh.execute' && (!text(value.command, 16_384)
    || /\0/u.test(value.command))) throw new CallValidationError('invalid_call')
  return value as CallInput
}

/** Canonical HMAC includes credentials without publishing an offline password hash. */
export function requestDigest(input: UnsignedCallInput, token: string): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]))
    return value
  }
  return createHmac('sha256', token).update(JSON.stringify(canonical(input))).digest('hex')
}

/** Authenticate the payload as well as the call ID; digest never returns raw secret text. */
export function validCallDigest(input: CallInput, token: string): boolean {
  const { digest, ...body } = input
  const expected = Buffer.from(requestDigest(body, token), 'hex')
  const actual = Buffer.from(digest, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
