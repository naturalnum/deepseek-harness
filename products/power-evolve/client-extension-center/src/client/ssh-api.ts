import { approvalUrl } from './plugins-api.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TICKET = /^[A-Za-z0-9_-]{32,256}$/u
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u

export interface PersonalSshConnection {
  readonly connectionId: string
  readonly displayName: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly hostKeySha256: string
  readonly enabled: boolean
  readonly revision: number
  readonly credentialRevision: number
}

export interface PersonalSshList {
  readonly available: boolean
  readonly items: readonly PersonalSshConnection[]
}

export interface SshCreateInput {
  readonly requestId: string
  readonly displayName: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly hostKeySha256: string
  readonly password: string
  readonly enabled: boolean
}

export interface SshToggleInput {
  readonly connectionId: string
  readonly requestId: string
  readonly baseRevision: number
  readonly enabled: boolean
}

export interface SshCheckInput {
  readonly requestId: string
  readonly connectionId: string
  readonly connectionRevision: number
}

export type SshCheckState = 'accepted' | 'preparing' | 'ready' | 'dispatch-intent' | 'running'
  | 'succeeded' | 'failed' | 'uncertain' | 'cancelled'

export interface SshCheckCall {
  readonly callId: string
  readonly state: SshCheckState
  readonly result?: unknown
  readonly errorCode?: string
}

export interface PersonalSshPort {
  list(signal?: AbortSignal): Promise<PersonalSshList>
  createPassword(input: SshCreateInput): Promise<PersonalSshConnection>
  toggle(input: SshToggleInput): Promise<PersonalSshConnection>
  check(input: SshCheckInput): Promise<SshCheckCall>
  callList(signal?: AbortSignal): Promise<readonly SshCheckCall[]>
  callStatus(callId: string, signal?: AbortSignal): Promise<SshCheckCall>
  callCancel(callId: string): Promise<SshCheckCall>
}

export class SshHttpError extends Error {
  constructor(readonly status: number) { super(`SSH request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
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
export const normalizeSshFingerprint = (value: string): string => {
  const trimmed = value.trim()
  return /^SHA256:[A-Za-z0-9+/]{43}=$/u.test(trimmed) ? trimmed.slice(0, -1) : trimmed
}
export const validSshFingerprint = (value: string): boolean => FINGERPRINT.test(normalizeSshFingerprint(value))
const normalizeHost = (value: string): string => value.trim().replace(/^\[([^\]]+)\]$/u, '$1')

function connection(value: unknown): PersonalSshConnection {
  if (!record(value) || typeof value.connectionId !== 'string' || !UUID.test(value.connectionId)
    || !bounded(value.displayName, 100) || !bounded(value.host, 253)
    || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
    || !bounded(value.username, 100) || !bounded(value.hostKeySha256, 51)
    || !validSshFingerprint(value.hostKeySha256) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !Number.isSafeInteger(value.credentialRevision) || Number(value.credentialRevision) < 1) {
    throw new Error('Invalid SSH connection response')
  }
  return { connectionId: value.connectionId, displayName: value.displayName, host: value.host,
    port: Number(value.port), username: value.username, hostKeySha256: normalizeSshFingerprint(value.hostKeySha256),
    enabled: value.enabled, revision: Number(value.revision), credentialRevision: Number(value.credentialRevision) }
}

function createdConnection(value: unknown, input: SshCreateInput): PersonalSshConnection {
  const item = connection(value)
  if (item.displayName !== input.displayName.trim() || item.host !== normalizeHost(input.host)
    || item.port !== input.port || item.username !== input.username.trim()
    || item.hostKeySha256 !== normalizeSshFingerprint(input.hostKeySha256)
    || item.enabled !== input.enabled) throw new Error('SSH creation response mismatch')
  return item
}

function validHost(value: string): boolean {
  if (!bounded(value, 253) || /[\s/@?#]/u.test(value)) return false
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.startsWith('[') } catch { return false }
  }
  if (/^[\d.]+$/u.test(value)) return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)
    && value.split('.').every(part => Number(part) <= 255)
  return value.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(label))
}

export function validSshCreate(input: SshCreateInput): boolean {
  return UUID.test(input.requestId) && bounded(input.displayName.trim(), 100) && validHost(normalizeHost(input.host))
    && Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535
    && bounded(input.username.trim(), 100) && !/\s/u.test(input.username)
    && validSshFingerprint(input.hostKeySha256) && typeof input.enabled === 'boolean'
    && new TextEncoder().encode(input.password).byteLength > 0
    && new TextEncoder().encode(input.password).byteLength <= 8192
}

/** The Host sees metadata and byte count; credential bytes go only to the trusted Platform. */
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
    const value = await this.post('sshList', {}, signal)
    if (!record(value) || typeof value.available !== 'boolean' || !Array.isArray(value.items)
      || value.items.length > 50) throw new Error('Invalid SSH list response')
    const items = value.items.map(connection)
    if (new Set(items.map(item => item.connectionId)).size !== items.length) throw new Error('Invalid SSH list response')
    return { available: value.available, items }
  }

  async createPassword(input: SshCreateInput): Promise<PersonalSshConnection> {
    if (!validSshCreate(input)) throw new Error('Invalid SSH connection')
    const bytes = new TextEncoder().encode(input.password)
    try {
      const metadata = { requestId: input.requestId, displayName: input.displayName.trim(), host: normalizeHost(input.host),
        port: input.port, username: input.username.trim(), hostKeySha256: normalizeSshFingerprint(input.hostKeySha256),
        credentialKind: 'password', sizeBytes: bytes.byteLength, enabled: input.enabled }
      const ticket = await this.post('sshCreateTicket', metadata)
      if (!record(ticket)) throw new Error('Invalid SSH upload ticket')
      if (ticket.state === 'ready') return createdConnection(ticket.item, input)
      if (ticket.state !== 'pending' || !bounded(ticket.ticket, 256) || !TICKET.test(ticket.ticket)
        || !bounded(ticket.uploadUrl, 2048) || !bounded(ticket.expiresAt, 64)) {
        throw new Error('Invalid SSH upload ticket')
      }
      const trusted = new URL(await approvalUrl(this.request))
      const destination = new URL(ticket.uploadUrl)
      if (destination.origin !== trusted.origin || destination.pathname !== '/ssh/upload'
        || destination.username || destination.password || destination.search || destination.hash) {
        throw new Error('Invalid SSH upload destination')
      }
      const response = await this.request(destination.href, {
        method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/octet-stream',
          accept: 'application/json' }, body: bytes,
      })
      if (!response.ok) throw new SshHttpError(response.status)
      const uploaded: unknown = await response.json()
      if (!record(uploaded)) throw new Error('Invalid SSH upload response')
      return createdConnection(uploaded.item, input)
    } finally { bytes.fill(0) }
  }

  async toggle(input: SshToggleInput): Promise<PersonalSshConnection> {
    if (!UUID.test(input.connectionId) || !UUID.test(input.requestId)
      || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1
      || typeof input.enabled !== 'boolean') throw new Error('Invalid SSH toggle')
    const item = connection(await this.post('sshToggle', input))
    if (item.connectionId !== input.connectionId || item.enabled !== input.enabled
      || item.revision < input.baseRevision) throw new Error('SSH toggle response mismatch')
    return item
  }

  async check(input: SshCheckInput): Promise<SshCheckCall> {
    if (!UUID.test(input.requestId) || !UUID.test(input.connectionId)
      || !Number.isSafeInteger(input.connectionRevision) || input.connectionRevision < 1) {
      throw new Error('Invalid SSH check request')
    }
    return checkCall(await this.post('sshCheck', input))
  }

  async callList(signal?: AbortSignal): Promise<readonly SshCheckCall[]> {
    const value = await this.post('sshCallList', {}, signal)
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 100) {
      throw new Error('Invalid SSH call list response')
    }
    const calls = value.items.map(checkCall)
    if (new Set(calls.map(call => call.callId)).size !== calls.length) {
      throw new Error('Invalid SSH call list response')
    }
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
