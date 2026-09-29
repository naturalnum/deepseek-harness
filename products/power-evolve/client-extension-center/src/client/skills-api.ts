const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export interface PersonalSkill {
  readonly skillId: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  /** State revision, not an editable content version. */
  readonly revision: number
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

export interface SkillPort {
  list(signal?: AbortSignal): Promise<readonly PersonalSkill[]>
  read(skillId: string, signal?: AbortSignal): Promise<PersonalSkillDetail>
  install(input: InstallSkillInput): Promise<PersonalSkill>
  toggle(skillId: string, enabled: boolean): Promise<PersonalSkill>
}

export class SkillHttpError extends Error {
  constructor(readonly status: number) { super(`Skill request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

function parseSkill(value: unknown): PersonalSkill {
  if (!record(value) || !uuid(value.skillId) || !bounded(value.name, 80)
    || !bounded(value.description, 500) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new Error('Invalid skill response')
  }
  return { skillId: value.skillId, name: value.name, description: value.description,
    enabled: value.enabled, revision: Number(value.revision) }
}

export function validInstall(input: InstallSkillInput): boolean {
  return uuid(input.requestId) && bounded(input.name.trim(), 80)
    && bounded(input.description.trim(), 500) && bounded(input.instructions.trim(), 4096)
}

/** Product RPC, authenticated by the Host's same-origin browser cookie. */
export class SkillHttpClient implements SkillPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new SkillHttpError(response.status)
    return response.json() as Promise<unknown>
  }

  async list(signal?: AbortSignal): Promise<readonly PersonalSkill[]> {
    const result = await this.post('skillsList', {}, signal)
    if (!record(result) || !Array.isArray(result.items) || result.items.length > 8) {
      throw new Error('Invalid skill list response')
    }
    const items = result.items.map(parseSkill)
    if (new Set(items.map(item => item.skillId)).size !== items.length) throw new Error('Invalid skill list response')
    return items
  }

  async read(skillId: string, signal?: AbortSignal): Promise<PersonalSkillDetail> {
    if (!uuid(skillId)) throw new Error('Invalid skill ID')
    const result = await this.post('skillsRead', { skillId }, signal)
    const skill = parseSkill(result)
    if (!record(result) || skill.skillId !== skillId || !bounded(result.instructions, 4096)) {
      throw new Error('Invalid skill detail response')
    }
    return { ...skill, instructions: result.instructions }
  }

  async install(input: InstallSkillInput): Promise<PersonalSkill> {
    if (!validInstall(input)) throw new Error('Invalid skill installation')
    const result = parseSkill(await this.post('skillsInstall', input))
    if (result.skillId !== input.requestId) throw new Error('Skill installation response mismatch')
    return result
  }

  async toggle(skillId: string, enabled: boolean): Promise<PersonalSkill> {
    if (!uuid(skillId)) throw new Error('Invalid skill ID')
    const result = parseSkill(await this.post('skillsToggle', { skillId, enabled }))
    if (result.skillId !== skillId || result.enabled !== enabled) throw new Error('Skill toggle response mismatch')
    return result
  }
}
