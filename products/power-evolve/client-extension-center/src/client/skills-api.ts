import { skillImportFileIssue } from './skill-import.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const TICKET = /^[A-Za-z0-9_-]{32,256}$/u
const BUILTIN_ID = /^builtin\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u

export interface PersonalSkill {
  readonly skillId: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  /** State revision, independent of the package version. */
  readonly revision: number
  readonly kind: 'text' | 'package'
  readonly version: string | null
  /** SHA-256 of the installed SKILL.md instructions. */
  readonly digest: string
  /** SHA-256 of the uploaded ZIP, when kind is package. */
  readonly packageDigest: string | null
  readonly manifestDigest: string | null
  readonly observedState: 'ready' | 'revoked'
}

export interface PersonalSkillDetail extends PersonalSkill {
  readonly instructions: string
}

export interface InstallSkillInput {
  readonly requestId: string
  readonly name: string
  readonly description: string
  readonly instructions: string
}

export interface BuiltinSkill {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly description: string
  readonly category: string
  readonly publisher: string
  readonly version: string
  readonly manifestDigest: string
  readonly archiveDigest: string
  readonly archiveSize: number
  readonly installedSkillId: string | null
}

export interface InstallBuiltinSkillInput {
  readonly requestId: string
  readonly catalogId: string
  readonly version: string
}

export interface SkillPort {
  list(signal?: AbortSignal): Promise<readonly PersonalSkill[]>
  catalog(signal?: AbortSignal): Promise<readonly BuiltinSkill[]>
  read(skillId: string, signal?: AbortSignal): Promise<PersonalSkillDetail>
  install(input: InstallSkillInput): Promise<PersonalSkill>
  installBuiltin(input: InstallBuiltinSkillInput, signal?: AbortSignal): Promise<PersonalSkill>
  importPackage(file: File, requestId: string, signal?: AbortSignal): Promise<PersonalSkill>
  toggle(skillId: string, enabled: boolean): Promise<PersonalSkill>
  revoke(skillId: string): Promise<PersonalSkill>
}

export class SkillHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`Skill request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const sha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)

function parseSkill(value: unknown): PersonalSkill {
  if (!record(value) || !uuid(value.skillId) || !bounded(value.name, 80)
    || !bounded(value.description, 500) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !sha256(value.digest) || (value.observedState !== 'ready' && value.observedState !== 'revoked')
    || (value.observedState === 'revoked' && value.enabled)) {
    throw new Error('Invalid skill response')
  }
  if (value.kind === 'text') {
    if (value.version !== null || value.packageDigest !== null || value.manifestDigest !== null) {
      throw new Error('Invalid text skill response')
    }
  } else if (value.kind === 'package') {
    if (!bounded(value.version, 128) || !sha256(value.packageDigest) || !sha256(value.manifestDigest)) {
      throw new Error('Invalid package skill response')
    }
  } else throw new Error('Invalid skill kind')
  return { skillId: value.skillId, name: value.name, description: value.description,
    enabled: value.enabled, revision: Number(value.revision), kind: value.kind,
    version: value.version, digest: value.digest, packageDigest: value.packageDigest,
    manifestDigest: value.manifestDigest, observedState: value.observedState }
}

function parseBuiltin(value: unknown): BuiltinSkill {
  if (!record(value) || typeof value.id !== 'string' || !BUILTIN_ID.test(value.id)
    || !bounded(value.name, 200) || !bounded(value.summary, 500)
    || !bounded(value.description, 10_000) || !bounded(value.category, 100)
    || !bounded(value.publisher, 200) || typeof value.version !== 'string' || !VERSION.test(value.version)
    || typeof value.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.manifestDigest)
    || !sha256(value.archiveDigest) || !Number.isSafeInteger(value.archiveSize)
    || Number(value.archiveSize) < 1 || Number(value.archiveSize) > 1024 * 1024
    || (value.installedSkillId !== null && !uuid(value.installedSkillId))) {
    throw new Error('Invalid builtin skill response')
  }
  return { id: value.id, name: value.name, summary: value.summary,
    description: value.description, category: value.category, publisher: value.publisher,
    version: value.version, manifestDigest: value.manifestDigest,
    archiveDigest: value.archiveDigest, archiveSize: Number(value.archiveSize),
    installedSkillId: value.installedSkillId }
}

export function validInstall(input: InstallSkillInput): boolean {
  return uuid(input.requestId) && bounded(input.name.trim(), 80)
    && bounded(input.description.trim(), 500) && bounded(input.instructions.trim(), 4096)
}

async function failure(response: Response): Promise<SkillHttpError> {
  let code: string | undefined
  try {
    const value: unknown = await response.json()
    if (record(value) && bounded(value.error, 80)) code = value.error
  } catch (_error: unknown) { /* The status remains available when a response body is missing. */ }
  return new SkillHttpError(response.status, code)
}

function uploadUrl(value: unknown): string {
  if (!bounded(value, 2048)) throw new Error('Invalid upload URL')
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.pathname !== '/skills/upload' || url.search || url.hash) {
    throw new Error('Invalid upload URL')
  }
  return url.href
}

/** Product RPC uses the Host cookie; the ZIP goes directly to the Platform with only a scoped ticket. */
export class SkillHttpClient implements SkillPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw await failure(response)
    return response.json() as Promise<unknown>
  }

  async list(signal?: AbortSignal): Promise<readonly PersonalSkill[]> {
    const result = await this.post('skillsList', {}, signal)
    if (!record(result) || !Array.isArray(result.items) || result.items.length > 256) {
      throw new Error('Invalid skill list response')
    }
    const items = result.items.map(parseSkill)
    if (new Set(items.map(item => item.skillId)).size !== items.length) throw new Error('Invalid skill list response')
    return items
  }

  async catalog(signal?: AbortSignal): Promise<readonly BuiltinSkill[]> {
    const result = await this.post('skillsCatalog', {}, signal)
    if (!record(result) || !Array.isArray(result.items) || result.items.length !== 9) {
      throw new Error('Invalid builtin skill catalog response')
    }
    const items = result.items.map(parseBuiltin)
    if (new Set(items.map(item => item.id)).size !== items.length
      || new Set(items.map(item => item.installedSkillId).filter(id => id !== null)).size
        !== items.filter(item => item.installedSkillId !== null).length) {
      throw new Error('Invalid builtin skill catalog response')
    }
    return items
  }

  async read(skillId: string, signal?: AbortSignal): Promise<PersonalSkillDetail> {
    if (!uuid(skillId)) throw new Error('Invalid skill ID')
    const result = await this.post('skillsRead', { skillId }, signal)
    const skill = parseSkill(result)
    if (!record(result) || skill.skillId !== skillId
      || !bounded(result.instructions, skill.kind === 'package' ? 256 * 1024 : 4096)) {
      throw new Error('Invalid skill detail response')
    }
    return { ...skill, instructions: result.instructions }
  }

  async install(input: InstallSkillInput): Promise<PersonalSkill> {
    if (!validInstall(input)) throw new Error('Invalid skill installation')
    const result = parseSkill(await this.post('skillsInstall', input))
    if (result.skillId !== input.requestId || result.kind !== 'text') throw new Error('Skill installation response mismatch')
    return result
  }

  async installBuiltin(input: InstallBuiltinSkillInput, signal?: AbortSignal): Promise<PersonalSkill> {
    if (!uuid(input.requestId) || !BUILTIN_ID.test(input.catalogId) || !VERSION.test(input.version)) {
      throw new Error('Invalid builtin skill installation')
    }
    const result = parseSkill(await this.post('skillsInstallBuiltin', input, signal))
    if (result.kind !== 'package' || result.version !== input.version || result.observedState !== 'ready') {
      throw new Error('Builtin skill installation response mismatch')
    }
    return result
  }

  async importPackage(file: File, requestId: string, signal?: AbortSignal): Promise<PersonalSkill> {
    if (!uuid(requestId) || skillImportFileIssue(file) !== undefined) throw new Error('Invalid skill package')
    const bytes = await file.arrayBuffer()
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const digest = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ticket = await this.post('skillsUploadTicket', { requestId, sizeBytes: file.size, sha256: digest }, signal)
    if (!record(ticket)) throw new Error('Invalid upload ticket response')
    if (ticket.state === 'ready') {
      const item = parseSkill(ticket.item)
      if (item.kind !== 'package' || item.packageDigest !== digest) throw new Error('Skill upload response mismatch')
      return item
    }
    if (ticket.state !== 'pending' || !bounded(ticket.ticket, 256) || !TICKET.test(ticket.ticket)
      || !bounded(ticket.expiresAt, 64)) throw new Error('Invalid upload ticket response')
    const destination = uploadUrl(ticket.uploadUrl)
    const response = await this.request(destination, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/zip', accept: 'application/json' },
      body: file, ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw await failure(response)
    const item = parseSkill(await response.json())
    if (item.kind !== 'package' || item.packageDigest !== digest) throw new Error('Skill upload response mismatch')
    return item
  }

  async toggle(skillId: string, enabled: boolean): Promise<PersonalSkill> {
    if (!uuid(skillId)) throw new Error('Invalid skill ID')
    const result = parseSkill(await this.post('skillsToggle', { skillId, enabled }))
    if (result.skillId !== skillId || result.enabled !== enabled) throw new Error('Skill toggle response mismatch')
    return result
  }

  async revoke(skillId: string): Promise<PersonalSkill> {
    if (!uuid(skillId)) throw new Error('Invalid skill ID')
    const result = parseSkill(await this.post('skillsRevoke', { skillId }))
    if (result.skillId !== skillId || result.observedState !== 'revoked') throw new Error('Skill revoke response mismatch')
    return result
  }
}
