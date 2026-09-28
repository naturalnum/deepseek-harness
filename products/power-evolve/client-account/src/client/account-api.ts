const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export interface AccountSettings {
  readonly model: string
  readonly maxTokens: number
  readonly revision: number
}

export interface CurrentAccount {
  readonly userId: string
  readonly username: string
  readonly settings: AccountSettings
}

export interface AuthorizedModel {
  readonly id: string
  readonly label: string
  readonly maxTokens: number
}

export interface SettingsUpdateRequest {
  readonly requestId: string
  readonly expectedRevision: number
  readonly model: string
  readonly maxTokens: number
}

export class AccountHttpError extends Error {
  constructor(readonly status: number) { super(`Account request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const modelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100
const tokenLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 8192
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1

function parseSettings(value: unknown): AccountSettings {
  if (!record(value) || !modelId(value.model) || !tokenLimit(value.maxTokens) || !revision(value.revision)) {
    throw new Error('Invalid account settings response')
  }
  return { model: value.model, maxTokens: value.maxTokens, revision: value.revision }
}

function parseAccount(value: unknown): CurrentAccount {
  if (!record(value) || typeof value.userId !== 'string' || !UUID.test(value.userId)
    || typeof value.username !== 'string' || !value.username || value.username.length > 80) {
    throw new Error('Invalid account response')
  }
  return { userId: value.userId, username: value.username, settings: parseSettings(value.settings) }
}

function parseModels(value: unknown): AuthorizedModel[] {
  if (!record(value) || !Array.isArray(value.models)) throw new Error('Invalid model list response')
  const ids = new Set<string>()
  return value.models.map((candidate: unknown) => {
    if (!record(candidate) || !modelId(candidate.id) || typeof candidate.label !== 'string'
      || !candidate.label || candidate.label.length > 200 || !positiveInteger(candidate.maxTokens)
      || ids.has(candidate.id)) throw new Error('Invalid model list response')
    ids.add(candidate.id)
    return { id: candidate.id, label: candidate.label, maxTokens: candidate.maxTokens }
  })
}

export class AccountHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new AccountHttpError(response.status)
    return response.json()
  }

  async me(signal?: AbortSignal): Promise<CurrentAccount> {
    return parseAccount(await this.post('me', {}, signal))
  }

  async modelsList(signal?: AbortSignal): Promise<readonly AuthorizedModel[]> {
    return parseModels(await this.post('modelsList', {}, signal))
  }

  async settingsUpdate(input: SettingsUpdateRequest): Promise<AccountSettings> {
    if (!UUID.test(input.requestId) || !revision(input.expectedRevision) || !modelId(input.model)
      || !tokenLimit(input.maxTokens)) throw new Error('Invalid settings update request')
    return parseSettings(await this.post('settingsUpdate', input))
  }

  async logout(): Promise<void> {
    const result = await this.post('logout', {})
    if (!record(result) || result.ok !== true) throw new Error('Invalid logout response')
  }

  async loginUrl(): Promise<string> {
    const response = await this.request('/config', { credentials: 'same-origin' })
    if (!response.ok) throw new AccountHttpError(response.status)
    const result: unknown = await response.json()
    if (!record(result) || typeof result.loginUrl !== 'string') throw new Error('Invalid login destination')
    const url = new URL(result.loginUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid login destination')
    }
    return url.toString()
  }
}
