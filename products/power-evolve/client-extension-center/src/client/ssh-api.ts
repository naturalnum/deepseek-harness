/** Browser SSH management. Only replacement credential envelopes go directly to Platform. */
import { approvalUrl } from './approval-api.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TICKET = /^[A-Za-z0-9_-]{32,256}$/u
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const DIRECTORY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

/** Metadata-only credential instructions from the fixed SSH management DTO. */
export type SshAuthenticationPlan =
  | { readonly kind: 'password'; readonly password: 'retain' | 'replace' }
  | { readonly kind: 'private_key'; readonly privateKey: 'retain' | 'replace'; readonly passphrase: 'retain' | 'replace' | 'clear' }

/** Complete configuration; secret values never belong in Host RPC. */
export interface SshConfigurationInput {
  readonly displayName: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly hostKeySha256: string
  /** Literal remote path; only null omits the override. */
  readonly workingDirectory: string | null
  readonly authentication: SshAuthenticationPlan
  readonly enabled: boolean
}

/** Write-only format two envelope, used solely by direct Platform upload. */
export interface SshCredentialUpload {
  readonly formatVersion: 2
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
}

/** Public metadata, including deletion identity retained for existing execution records. */
export interface PersonalSshConnection extends Omit<SshConfigurationInput, 'authentication'> {
  readonly connectionId: string
  readonly revision: number
  readonly credentialRevision: number
  readonly authentication: 'password' | 'private_key'
  readonly secretConfigured: boolean
  readonly passphraseConfigured: boolean
  readonly deletedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Owner-scoped live connections and deployment availability. */
export interface PersonalSshList {
  readonly available: boolean
  readonly items: readonly PersonalSshConnection[]
}

/** Browser-local creation input; credentials are excluded explicitly from Host requests. */
export interface SshCreateInput {
  readonly requestId: string
  readonly configuration: SshConfigurationInput
  readonly credentials: SshCredentialUpload
}

/** Browser-local update; absent credentials means metadata or an explicit clear only. */
export interface SshUpdateInput {
  readonly requestId: string
  readonly connectionId: string
  readonly baseRevision: number
  readonly configuration: SshConfigurationInput
  readonly credentials?: SshCredentialUpload
}

/** Compare-and-swap deletion or enablement identity. */
export interface SshDeleteInput {
  readonly connectionId: string
  readonly requestId: string
  readonly baseRevision: number
}

/** Enablement preserves credential bytes. */
export interface SshToggleInput extends SshDeleteInput {
  readonly enabled: boolean
}

/** Check only a persisted connection revision. */
export interface SshCheckInput {
  readonly requestId: string
  readonly connectionId: string
  readonly connectionRevision: number
}

/** Durable authentication check states; uncertain calls remain eligible for reconciliation. */
export type SshCheckState = 'accepted' | 'preparing' | 'ready' | 'dispatch-intent' | 'running'
  | 'succeeded' | 'failed' | 'uncertain' | 'cancelled'

/** Bounded owner-visible check result. */
export interface SshCheckCall {
  readonly callId: string
  readonly state: SshCheckState
  readonly result?: unknown
  readonly errorCode?: string
}

/** Browser operations. Retrying a write keeps its original request and immutable input. */
export interface PersonalSshPort {
  /** Read live public metadata.
   * @param signal - abort an obsolete read.
   * @returns availability and owner-visible records.
   */
  list(signal?: AbortSignal): Promise<PersonalSshList>
  /** Create through a ticket and direct upload; retries always verify the bytes again.
   * @param input - immutable creation and stable request identity.
   * @returns the created public record.
   */
  create(input: SshCreateInput): Promise<PersonalSshConnection>
  /** Replace metadata against a saved revision, uploading only replacement secret fields.
   * @param input - immutable edit and expected revision.
   * @returns the updated public record.
   */
  update(input: SshUpdateInput): Promise<PersonalSshConnection>
  /** Change enablement without replacing credentials.
   * @param input - stable request and expected revision.
   * @returns the updated public record.
   */
  toggle(input: SshToggleInput): Promise<PersonalSshConnection>
  /** Delete while retaining the connection identity for execution records.
   * @param input - stable request and expected revision.
   * @returns the public tombstone.
   */
  remove(input: SshDeleteInput): Promise<PersonalSshConnection>
  /** Authenticate the saved version without running a remote command.
   * @param input - stable request and saved revision.
   * @returns the durable authentication call.
   */
  check(input: SshCheckInput): Promise<SshCheckCall>
  /** Restore bounded call history after refresh.
   * @param signal - abort an obsolete poll.
   * @returns owner-visible call states.
   */
  callList(signal?: AbortSignal): Promise<readonly SshCheckCall[]>
  /** Read one accepted call's state.
   * @param callId - opaque durable call identity.
   * @param signal - abort an obsolete poll.
   * @returns the matching call.
   */
  callStatus(callId: string, signal?: AbortSignal): Promise<SshCheckCall>
  /** Request cancellation; the response may still describe an uncertain outcome.
   * @param callId - opaque durable call identity.
   * @returns the matching call's current state.
   */
  callCancel(callId: string): Promise<SshCheckCall>
}

/** Sanitized HTTP failure; callers may unlock a definitely rejected write. */
export class SshHttpError extends Error {
  constructor(readonly status: number) { super(`SSH request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const revision = (value: unknown): value is number => Number.isSafeInteger(value)
  && Number(value) > 0 && Number(value) <= 2_147_483_647
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value))
const CHECK_STATES = new Set<SshCheckState>([
  'accepted', 'preparing', 'ready', 'dispatch-intent', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled',
])

function checkCall(value: unknown): SshCheckCall {
  if (!record(value) || typeof value.callId !== 'string' || !UUID.test(value.callId)
    || !CHECK_STATES.has(value.state as SshCheckState)
    || (value.errorCode !== undefined && value.errorCode !== null && !bounded(value.errorCode, 100))) {
    throw new Error('Invalid SSH check response')
  }
  if (value.result !== undefined && new TextEncoder().encode(JSON.stringify(value.result)).byteLength > 8192) {
    throw new Error('Invalid SSH check result')
  }
  return { callId: value.callId, state: value.state as SshCheckState,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}) }
}

/** Strip only the optional base64 padding accepted by the original SSH form.
 * @param value - fingerprint entered by the user.
 * @returns canonical SHA-256 fingerprint text.
 */
export const normalizeSshFingerprint = (value: string): string => {
  const trimmed = value.trim()
  return /^SHA256:[A-Za-z0-9+/]{43}=$/u.test(trimmed) ? trimmed.slice(0, -1) : trimmed
}
/** Validate the original form's pinned host fingerprint.
 * @param value - entered fingerprint.
 * @returns whether its canonical value is accepted.
 */
export const validSshFingerprint = (value: string): boolean => FINGERPRINT.test(normalizeSshFingerprint(value))
const normalizeHost = (value: string): string => value.trim().replace(/^\[([^\]]+)\]$/u, '$1')
const label = (value: unknown, max: number): value is string => bounded(value, max) && !CONTROL.test(value)
const losslessUtf8 = (value: string): boolean =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
const validWorkingDirectory = (value: string | null): boolean => value === null
  || (bounded(value, 1024) && !DIRECTORY_CONTROL.test(value) && losslessUtf8(value))
const validUsername = (value: string): boolean => {
  const username = value.trim()
  return label(username, 100) && !/\s/u.test(username)
    && new TextEncoder().encode(username).byteLength <= 256 && losslessUtf8(username)
}

function validConfiguration(value: SshConfigurationInput): boolean {
  const auth = value.authentication
  const plan = auth.kind === 'password'
    ? exact(auth, ['kind', 'password']) && ['retain', 'replace'].includes(auth.password)
    : exact(auth, ['kind', 'privateKey', 'passphrase'])
      && ['retain', 'replace'].includes(auth.privateKey) && ['retain', 'replace', 'clear'].includes(auth.passphrase)
  return plan && label(value.displayName.trim(), 100) && label(normalizeHost(value.host), 253)
    && !/[\s/@?#]/u.test(normalizeHost(value.host))
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && validUsername(value.username)
    && validSshFingerprint(value.hostKeySha256) && typeof value.enabled === 'boolean'
    && validWorkingDirectory(value.workingDirectory)
}

function configuration(value: SshConfigurationInput): SshConfigurationInput {
  return { displayName: value.displayName.trim(), host: normalizeHost(value.host), port: value.port,
    username: value.username.trim(), hostKeySha256: normalizeSshFingerprint(value.hostKeySha256),
    workingDirectory: value.workingDirectory,
    authentication: value.authentication.kind === 'password'
      ? { kind: 'password', password: value.authentication.password }
      : { kind: 'private_key', privateKey: value.authentication.privateKey, passphrase: value.authentication.passphrase },
    enabled: value.enabled }
}

function replacementFields(plan: SshAuthenticationPlan): Array<'password' | 'privateKey' | 'passphrase'> {
  if (plan.kind === 'password') return plan.password === 'replace' ? ['password'] : []
  return [...(plan.privateKey === 'replace' ? ['privateKey' as const] : []),
    ...(plan.passphrase === 'replace' ? ['passphrase' as const] : [])]
}

function credentialBytes(fields: readonly ('password' | 'privateKey' | 'passphrase')[], envelope: SshCredentialUpload | undefined): Uint8Array<ArrayBuffer> {
  if (!envelope || !exact(envelope, ['formatVersion', ...fields])) {
    throw new Error('Invalid SSH credential fields')
  }
  const limits = { password: 4096, privateKey: 7168, passphrase: 1024 }
  for (const field of fields) {
    const value = envelope[field]
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error('Invalid SSH credential')
    const bytes = new TextEncoder().encode(value)
    const valid = bytes.length <= limits[field] && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === value
    bytes.fill(0)
    if (!valid) throw new Error('Invalid SSH credential')
  }
  // Fixed field budgets bound escaped JSON below Platform's 65536-byte limit.
  return new TextEncoder().encode(JSON.stringify(envelope))
}

function prepareCreate(input: SshCreateInput): Uint8Array<ArrayBuffer> {
  const auth = input.configuration.authentication
  if (!UUID.test(input.requestId) || !validConfiguration(input.configuration)
    || !(auth.kind === 'password' ? auth.password === 'replace' : auth.privateKey === 'replace' && auth.passphrase !== 'retain')) {
    throw new Error('Invalid SSH connection')
  }
  return credentialBytes(replacementFields(auth), input.credentials)
}

function prepareUpdate(input: SshUpdateInput): Uint8Array<ArrayBuffer> | undefined {
  if (!validIdentity(input) || !validConfiguration(input.configuration)) throw new Error('Invalid SSH update')
  const fields = replacementFields(input.configuration.authentication)
  if (fields.length === 0) {
    if (input.credentials !== undefined) throw new Error('Unexpected SSH credentials')
    return undefined
  }
  return credentialBytes(fields, input.credentials)
}

/** Validate a new connection and its exact replacement fields before reserving a ticket.
 * @param input - browser-local input including the write-only envelope.
 * @returns whether creation can be submitted.
 */
export function validSshCreate(input: SshCreateInput): boolean {
  try { const bytes = prepareCreate(input); bytes.fill(0); return true }
  catch (_cause) { return false } // Validation never reports secret-bearing input.
}

/** Validate an edit, with no envelope for retain/clear instructions.
 * @param input - frozen update and expected saved revision.
 * @returns whether its configuration and replacement fields are consistent.
 */
export function validSshUpdate(input: SshUpdateInput): boolean {
  try { const bytes = prepareUpdate(input); bytes?.fill(0); return true }
  catch (_cause) { return false } // Form validation only needs a boolean.
}

function validIdentity(input: SshDeleteInput): boolean {
  return UUID.test(input.requestId) && UUID.test(input.connectionId) && revision(input.baseRevision)
}

function connection(value: unknown): PersonalSshConnection {
  if (!record(value) || !exact(value, ['connectionId', 'revision', 'credentialRevision', 'displayName', 'host', 'port',
    'username', 'hostKeySha256', 'workingDirectory', 'authentication', 'secretConfigured', 'passphraseConfigured',
    'enabled', 'deletedAt', 'createdAt', 'updatedAt'])
    || typeof value.connectionId !== 'string' || !UUID.test(value.connectionId)
    || !label(value.displayName, 100) || !bounded(value.host, 253)
    || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
    || !label(value.username, 100) || typeof value.hostKeySha256 !== 'string' || !FINGERPRINT.test(value.hostKeySha256)
    || !(value.workingDirectory === null || bounded(value.workingDirectory, 1024))
    || (value.authentication !== 'password' && value.authentication !== 'private_key')
    || typeof value.secretConfigured !== 'boolean' || typeof value.passphraseConfigured !== 'boolean'
    || typeof value.enabled !== 'boolean' || !revision(value.revision) || !revision(value.credentialRevision)
    || !(value.deletedAt === null || timestamp(value.deletedAt)) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) {
    throw new Error('Invalid SSH connection response')
  }
  return { connectionId: value.connectionId, displayName: value.displayName, host: value.host, port: Number(value.port),
    username: value.username, hostKeySha256: value.hostKeySha256, workingDirectory: value.workingDirectory,
    authentication: value.authentication, secretConfigured: value.secretConfigured, passphraseConfigured: value.passphraseConfigured,
    enabled: value.enabled, revision: value.revision, credentialRevision: value.credentialRevision,
    deletedAt: value.deletedAt, createdAt: value.createdAt, updatedAt: value.updatedAt }
}

function writtenConnection(value: unknown, input: SshCreateInput | SshUpdateInput): PersonalSshConnection {
  const item = connection(value)
  const expected = configuration(input.configuration)
  if (item.deletedAt !== null || !item.secretConfigured || item.displayName !== expected.displayName
    || item.host !== expected.host || item.port !== expected.port || item.username !== expected.username
    || item.hostKeySha256 !== expected.hostKeySha256 || item.enabled !== expected.enabled
    || item.workingDirectory !== expected.workingDirectory || item.authentication !== expected.authentication.kind
    || (expected.authentication.kind === 'password' && item.passphraseConfigured)
    || (expected.authentication.kind === 'private_key' && expected.authentication.passphrase !== 'retain'
      && item.passphraseConfigured !== (expected.authentication.passphrase === 'replace'))
    || ('connectionId' in input && (item.connectionId !== input.connectionId || item.revision <= input.baseRevision))) {
    throw new Error('SSH write response mismatch')
  }
  return item
}

function receiptItem(value: unknown): unknown {
  if (!record(value) || !exact(value, ['item'])) throw new Error('Invalid SSH receipt response')
  return value.item
}

/** Fixed management RPC with direct, pinned credential upload and explicit lost-response recovery. */
export class PersonalSshHttpClient implements PersonalSshPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, body: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: body }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new SshHttpError(response.status)
    return response.json() as Promise<unknown>
  }

  async list(signal?: AbortSignal): Promise<PersonalSshList> {
    const value = await this.post('sshConnectionsList', {}, signal)
    if (!record(value) || !exact(value, ['available', 'items']) || typeof value.available !== 'boolean'
      || !Array.isArray(value.items) || value.items.length > 50) throw new Error('Invalid SSH list response')
    const items = value.items.map(connection)
    if (items.some(item => item.deletedAt !== null) || new Set(items.map(item => item.connectionId)).size !== items.length) {
      throw new Error('Invalid SSH list response')
    }
    return { available: value.available, items }
  }

  async create(input: SshCreateInput): Promise<PersonalSshConnection> {
    let bytes: Uint8Array<ArrayBuffer>
    try { bytes = prepareCreate(input) }
    catch (_cause) { throw new Error('Invalid SSH connection') } // Do not expose credential-bearing validation errors.
    return this.upload('create', input, bytes)
  }

  async update(input: SshUpdateInput): Promise<PersonalSshConnection> {
    let bytes: Uint8Array<ArrayBuffer> | undefined
    try { bytes = prepareUpdate(input) }
    catch (_cause) { throw new Error('Invalid SSH update') } // Preserve the sanitized browser operation error.
    if (bytes !== undefined) return this.upload('update', input, bytes)
    return writtenConnection(await this.post('sshConnectionsUpdate', {
      requestId: input.requestId, connectionId: input.connectionId, baseRevision: input.baseRevision,
      configuration: configuration(input.configuration),
    }), input)
  }

  private async recoverUpload(input: SshCreateInput | SshUpdateInput): Promise<PersonalSshConnection> {
    const item = receiptItem(await this.post('sshConnectionsReceipt', { requestId: input.requestId }))
    if (item === null) throw new Error('SSH upload outcome uncertain')
    return writtenConnection(item, input)
  }

  private async upload(purpose: 'create' | 'update', input: SshCreateInput | SshUpdateInput,
    bytes: Uint8Array<ArrayBuffer>): Promise<PersonalSshConnection> {
    try {
      const ticket = await this.post('sshConnectionsTicket', { purpose, requestId: input.requestId,
        configuration: configuration(input.configuration), sizeBytes: bytes.byteLength,
        ...('connectionId' in input ? { connectionId: input.connectionId, baseRevision: input.baseRevision } : {}) })
      if (!record(ticket) || !exact(ticket, ['state', 'requestId', 'ticket', 'uploadUrl', 'expiresAt'])
        || ticket.state !== 'pending' || ticket.requestId !== input.requestId
        || typeof ticket.ticket !== 'string' || !TICKET.test(ticket.ticket)
        || !bounded(ticket.uploadUrl, 2048) || !timestamp(ticket.expiresAt)) throw new Error('Invalid SSH upload ticket')
      const trusted = new URL(await approvalUrl(this.request))
      const destination = new URL(ticket.uploadUrl)
      if (destination.origin !== trusted.origin || destination.pathname !== '/ssh/upload'
        || destination.username || destination.password || destination.search || destination.hash) {
        throw new Error('Invalid SSH upload destination')
      }
      let response: Response
      try {
        response = await this.request(destination.href, {
          method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/octet-stream',
            accept: 'application/json' }, body: bytes,
        })
      } catch (_cause) { return await this.recoverUpload(input) } // Upload response was lost after dispatch.
      if (!response.ok) throw new SshHttpError(response.status)
      let body: string
      try { body = await response.text() }
      catch (_cause) { return await this.recoverUpload(input) } // Reading the successful upload response was interrupted.
      let uploaded: unknown
      try { uploaded = JSON.parse(body) }
      catch (_cause) { throw new Error('Invalid SSH upload response') } // A received invalid body is not a lost response.
      return writtenConnection(receiptItem(uploaded), input)
    } finally { bytes.fill(0) }
  }

  async toggle(input: SshToggleInput): Promise<PersonalSshConnection> {
    if (!validIdentity(input) || typeof input.enabled !== 'boolean') throw new Error('Invalid SSH toggle')
    const item = connection(await this.post('sshConnectionsToggle', { requestId: input.requestId,
      connectionId: input.connectionId, baseRevision: input.baseRevision, enabled: input.enabled }))
    if (item.connectionId !== input.connectionId || item.enabled !== input.enabled
      || item.deletedAt !== null || item.revision <= input.baseRevision) throw new Error('SSH toggle response mismatch')
    return item
  }

  async remove(input: SshDeleteInput): Promise<PersonalSshConnection> {
    if (!validIdentity(input)) throw new Error('Invalid SSH deletion')
    const item = connection(await this.post('sshConnectionsDelete', { requestId: input.requestId,
      connectionId: input.connectionId, baseRevision: input.baseRevision }))
    if (item.connectionId !== input.connectionId || item.deletedAt === null || item.enabled
      || item.revision <= input.baseRevision) throw new Error('SSH deletion response mismatch')
    return item
  }

  async check(input: SshCheckInput): Promise<SshCheckCall> {
    if (!UUID.test(input.requestId) || !UUID.test(input.connectionId) || !revision(input.connectionRevision)) {
      throw new Error('Invalid SSH check request')
    }
    return checkCall(await this.post('sshCheck', input))
  }

  async callList(signal?: AbortSignal): Promise<readonly SshCheckCall[]> {
    const value = await this.post('sshCallList', {}, signal)
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 100) throw new Error('Invalid SSH call list response')
    const calls = value.items.map(checkCall)
    if (new Set(calls.map(call => call.callId)).size !== calls.length) throw new Error('Invalid SSH call list response')
    return calls
  }

  async callStatus(callId: string, signal?: AbortSignal): Promise<SshCheckCall> {
    if (!UUID.test(callId)) throw new Error('Invalid SSH call ID')
    const call = checkCall(await this.post('sshCallStatus', { callId }, signal))
    if (call.callId !== callId) throw new Error('SSH call response mismatch')
    return call
  }

  async callCancel(callId: string): Promise<SshCheckCall> {
    if (!UUID.test(callId)) throw new Error('Invalid SSH call ID')
    const call = checkCall(await this.post('sshCallCancel', { callId }))
    if (call.callId !== callId) throw new Error('SSH call response mismatch')
    return call
  }
}
