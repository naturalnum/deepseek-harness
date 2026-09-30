/** Host product RPCs expose personal settings and trusted account navigation. */
import { accountCapabilitiesValue } from '@power-evolve/contracts/account'
import { accountDestination, type AccountNavigation } from './navigation.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Per-user model settings with a revision for conditional changes. */
export interface AccountSettings {
  readonly model: string
  readonly maxTokens: number
  readonly revision: number
}

/** Minimal personal identity exposed by authenticated product RPCs. */
export interface CurrentAccount {
  readonly userId: string
  readonly username: string
  readonly settings: AccountSettings
}

/** Model label and token ceiling authorized for this user. */
export interface AuthorizedModel {
  readonly id: string
  readonly label: string
  readonly maxTokens: number
}

/** Stable personal-settings gesture addressed to the shown revision. */
export interface SettingsUpdateRequest {
  readonly requestId: string
  readonly expectedRevision: number
  readonly model: string
  readonly maxTokens: number
}

/** Product RPC refusal carrying only its HTTP status. */
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

/** Same-origin native client that never handles an account-audience bearer. */
export class AccountHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly onIdentityExpired?: () => void) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new AccountHttpError(response.status)
    return response.json()
  }

  /** Read the signed-in product user's personal identity and settings; report only an un-aborted HTTP 401 as login expiry.
   * @param signal - read lifetime.
   * @returns permitted personal metadata.
   */
  async me(signal?: AbortSignal): Promise<CurrentAccount> {
    try { return parseAccount(await this.post('me', {}, signal)) }
    catch (error) {
      if (!signal?.aborted && error instanceof AccountHttpError && error.status === 401) this.onIdentityExpired?.()
      throw error
    }
  }

  /** Read only the native launcher's display and navigation capabilities.
   * @param signal - launcher lifetime.
   * @returns a trusted entry address without an account bearer.
   */
  async navigation(signal: AbortSignal): Promise<AccountNavigation> {
    const [value, loginUrl] = await Promise.all([this.post('accountCapabilities', {}, signal), this.loginUrl(signal)])
    const capability = accountCapabilitiesValue.parse(value)
    const url = new URL(accountDestination(capability.accountUrl, 'password'))
    if (url.origin !== new URL(loginUrl).origin) throw new Error('Unexpected account origin')
    signal.throwIfAborted()
    return { displayName: capability.displayName, canManage: capability.canManage, accountUrl: capability.accountUrl }
  }

  /** Read the user's authorized model choices.
   * @param signal - read lifetime.
   * @returns model labels and allowed ceilings.
   */
  async modelsList(signal?: AbortSignal): Promise<readonly AuthorizedModel[]> {
    return parseModels(await this.post('modelsList', {}, signal))
  }

  /** Save one validated personal-settings gesture.
   * @param input - immutable request ID, shown revision and desired settings.
   * @returns the authoritative saved settings.
   */
  async settingsUpdate(input: SettingsUpdateRequest): Promise<AccountSettings> {
    if (!UUID.test(input.requestId) || !revision(input.expectedRevision) || !modelId(input.model)
      || !tokenLimit(input.maxTokens)) throw new Error('Invalid settings update request')
    return parseSettings(await this.post('settingsUpdate', input))
  }

  /** Revoke the current product login through its Host RPC. */
  async logout(): Promise<void> {
    const result = await this.post('logout', {})
    if (!record(result) || result.ok !== true) throw new Error('Invalid logout response')
  }

  /** Read the configured trusted Platform login destination.
   * @param signal - navigation read lifetime.
   * @returns an HTTP(S) URL without embedded credentials.
   */
  async loginUrl(signal?: AbortSignal): Promise<string> {
    const response = await this.request('/config', { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) })
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
