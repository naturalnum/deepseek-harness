/** Account-audience requests run only on the trusted Platform origin. */
import { ACCOUNT_ERROR_CODES, ACCOUNT_ROUTES, ACCOUNT_PASSWORD_MIN_BYTES, ACCOUNT_PASSWORD_MAX_BYTES,
  accountLoginRequest, accountLoginValue, accountMeValue, accountModelCatalogValue, accountListRequest,
  accountListValue, accountCreateRequest, accountUpdateRequest, accountTargetMutationRequest,
  accountSecretMutationValue, accountMutationValue, accountReceiptRequest, accountReceiptValue,
  accountChangePasswordRequest, accountLogoutValue, type AccountValue, type AccountMutationReceipt,
} from '@power-evolve/contracts/account'
import type { TrustedAccountPageClient, TrustedAccountSessionView } from './AccountPage.tsx'
import type { PasswordChangeIntent } from './PasswordChange.tsx'
import { AccountActionError, type AccountMutationIntent, type AccountMutationResult, type ManagedAccountView } from './view.ts'

// The protocol's bounded account pages fit inside this independent parser limit.
const MAX_JSON_BYTES = 512 * 1024
interface Parser<T> { parse: (value: unknown) => T }

function input<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown, problem: 'invalidAccount' | 'passwordRejected' = 'invalidAccount'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AccountActionError(problem)
  return parsed.data
}

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing account response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_JSON_BYTES) throw new Error('Account response exceeds limit')
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

function actionFailure(status: number, value: unknown): Error {
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' ? value.code : ''
  if (code === ACCOUNT_ERROR_CODES.revisionConflict || code === ACCOUNT_ERROR_CODES.requestConflict) return new AccountActionError('revisionConflict')
  if (code === ACCOUNT_ERROR_CODES.lastAdministrator) return new AccountActionError('lastAdmin')
  if (code === ACCOUNT_ERROR_CODES.notEmpty || code === ACCOUNT_ERROR_CODES.executionActive) return new AccountActionError('accountNotEmpty')
  if (code === ACCOUNT_ERROR_CODES.currentPasswordInvalid || code === ACCOUNT_ERROR_CODES.passwordInvalid) return new AccountActionError('passwordRejected')
  if (code === ACCOUNT_ERROR_CODES.modelNotAuthorized || code === ACCOUNT_ERROR_CODES.usernameConflict
    || code === ACCOUNT_ERROR_CODES.limit || status === 400 || status === 404 || status === 409 || status === 429) return new AccountActionError('invalidAccount')
  if (status === 401 || status === 403) return new AccountActionError('permissionLost')
  return new Error('Account result is unconfirmed')
}

function view(account: AccountValue): ManagedAccountView {
  return { userId: account.userId, username: account.username, displayName: account.displayName,
    role: account.role === 'ADMIN' ? 'admin' : 'user', enabled: account.enabled, revision: account.revision,
    passwordChangeRequired: account.passwordChangeRequired, createdAt: account.createdAt }
}

function result(value: { receipt: AccountMutationReceipt; temporaryPassword?: string | null }, requestId: string,
  kind: AccountMutationReceipt['kind'], userId?: string): AccountMutationResult {
  if (value.receipt.requestId !== requestId || value.receipt.kind !== kind
    || userId !== undefined && value.receipt.account.userId !== userId) throw new Error('Account receipt mismatch')
  return { account: view(value.receipt.account), ...(value.temporaryPassword ? { temporaryPassword: value.temporaryPassword } : {}) }
}

/** Holds an account bearer in memory and never exchanges it through the Host. */
export class TrustedAccountHttpClient implements TrustedAccountPageClient {
  private token: string | undefined
  private userId: string | undefined
  private readonly origin: string
  constructor(platformOrigin: string, private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {
    const url = new URL(platformOrigin)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/`) throw new Error('Invalid account origin')
    this.origin = url.origin
  }
  private async post<T>(route: string, input: object, parser: Parser<T>, signal: AbortSignal, authenticated = true): Promise<T> {
    if (authenticated && !this.token) throw new AccountActionError('permissionLost')
    const response = await this.request(new URL(route, this.origin), {
      method: 'POST', credentials: 'omit', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json',
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(input),
    })
    let value: unknown
    try { value = await json(response) }
    catch (error) {
      if (response.status === 401 || response.status === 403) { this.forget(); throw new AccountActionError('permissionLost') }
      throw error
    }
    signal.throwIfAborted()
    if (!response.ok) {
      const failure = actionFailure(response.status, value)
      if (failure instanceof AccountActionError && failure.problem === 'permissionLost') this.forget()
      throw failure
    }
    return parser.parse(value)
  }

  /** Read personal state and the administrator's permitted model catalog.
   * @param signal - page lifetime.
   * @returns display data without the bearer.
   */
  state = async (signal: AbortSignal): Promise<TrustedAccountSessionView> => {
    const personal = await this.post(ACCOUNT_ROUTES.me, {}, accountMeValue, signal)
    if (personal.user.userId !== this.userId) throw new Error('Account identity mismatch')
    const restricted = personal.restricted || personal.user.passwordChangeRequired
    const canManage = !restricted && personal.user.role === 'ADMIN'
    const catalog = canManage ? await this.post(ACCOUNT_ROUTES.models, {}, accountModelCatalogValue, signal) : undefined
    const response = await this.request(new URL('/config', this.origin), { credentials: 'omit', redirect: 'error', signal })
    if (!response.ok) throw new Error('Product navigation unavailable')
    const config = await json(response)
    if (typeof config !== 'object' || config === null || !('hostUrl' in config) || typeof config.hostUrl !== 'string') throw new Error('Invalid product navigation')
    const host = new URL(config.hostUrl)
    if (!['http:', 'https:'].includes(host.protocol) || host.username || host.password) throw new Error('Invalid product origin')
    signal.throwIfAborted()
    return { account: { ...view(personal.user), passwordChangeRequired: restricted }, canManage,
      models: catalog?.models ?? [], ...(catalog ? { initialSettings: catalog.initialSettings } : {}), minPasswordBytes: ACCOUNT_PASSWORD_MIN_BYTES,
      maxPasswordBytes: ACCOUNT_PASSWORD_MAX_BYTES, productLoginUrl: host.href }
  }

  /** Sign in directly on the Platform; an aborted response retains no credential.
   * @param username - stored login name.
   * @param password - trusted form password.
   * @param signal - login lifetime.
   * @returns personal state after login.
   */
  login = async (username: string, password: string, signal: AbortSignal): Promise<TrustedAccountSessionView> => {
    this.forget()
    const value = await this.post(ACCOUNT_ROUTES.login, input(accountLoginRequest, { username, password }, 'passwordRejected'), accountLoginValue, signal, false)
    signal.throwIfAborted(); this.token = value.token; this.userId = value.user.userId
    try { return await this.state(signal) }
    catch (error) { this.forget(); throw error }
  }

  /** Revoke the account bearer before forgetting it locally.
   * @param signal - logout lifetime.
   */
  logout = async (signal: AbortSignal): Promise<void> => {
    await this.post(ACCOUNT_ROUTES.logout, {}, accountLogoutValue, signal); this.forget()
  }

  /** Drop the local bearer without writing it to browser storage. */
  forget = (): void => { this.token = undefined; this.userId = undefined }

  /** Load one bounded management page.
   * @param cursor - next-page cursor.
   * @param signal - read lifetime.
   * @returns permitted records.
   */
  list: TrustedAccountPageClient['list'] = async (cursor, signal) => {
    const page = await this.post(ACCOUNT_ROUTES.list, input(accountListRequest, { limit: 30,
      ...(cursor === undefined ? {} : { cursor }) }), accountListValue, signal)
    return { items: page.items.map(view), nextCursor: page.nextCursor }
  }

  /** Send the immutable gesture using its retained ID and shown revision.
   * @param intent - component-owned gesture.
   * @param signal - gesture lifetime.
   * @returns receipt data and a first-response temporary password, when supplied.
   */
  mutate = async (intent: AccountMutationIntent, signal: AbortSignal): Promise<AccountMutationResult> => {
    if (intent.kind === 'create') {
      const draft = intent.draft
      const value = await this.post(ACCOUNT_ROUTES.create, input(accountCreateRequest, { requestId: intent.requestId,
        username: draft.username, displayName: draft.displayName, role: draft.role === 'admin' ? 'ADMIN' : 'USER',
        settings: { model: draft.model, maxTokens: draft.maxTokens }, models: draft.modelGrants }), accountSecretMutationValue, signal)
      return result(value, intent.requestId, 'create')
    }
    const target = { requestId: intent.requestId, userId: intent.account.userId, expectedRevision: intent.account.revision }
    if (intent.kind === 'update') {
      const value = await this.post(ACCOUNT_ROUTES.update, input(accountUpdateRequest, { ...target, displayName: intent.displayName,
        role: intent.role === 'admin' ? 'ADMIN' : 'USER', enabled: intent.enabled }), accountMutationValue, signal)
      return result(value, intent.requestId, 'update', intent.account.userId)
    }
    if (intent.kind === 'reset') {
      const value = await this.post(ACCOUNT_ROUTES.resetPassword, input(accountTargetMutationRequest, target), accountSecretMutationValue, signal)
      return result(value, intent.requestId, 'reset-password', intent.account.userId)
    }
    const value = await this.post(ACCOUNT_ROUTES.remove, input(accountTargetMutationRequest, target), accountMutationValue, signal)
    return result(value, intent.requestId, 'delete', intent.account.userId)
  }

  /** Query metadata for an ambiguous gesture without retrieving its password.
   * @param intent - original gesture, including its ID and target.
   * @param signal - lookup lifetime.
   * @returns receipt display data, or null when absent.
   */
  lookup = async (intent: AccountMutationIntent, signal: AbortSignal): Promise<AccountMutationResult | null> => {
    const value = await this.post(ACCOUNT_ROUTES.receipt, input(accountReceiptRequest, { requestId: intent.requestId }), accountReceiptValue, signal)
    if (value.receipt === null) return null
    const kind = intent.kind === 'reset' ? 'reset-password' : intent.kind === 'remove' ? 'delete' : intent.kind
    return result({ receipt: value.receipt }, intent.requestId, kind, intent.kind === 'create' ? undefined : intent.account.userId)
  }

  /** Change the personal password and discard the bearer on confirmed success.
   * @param intent - password gesture held only in component memory.
   * @param signal - change lifetime.
   */
  changePassword = async (intent: PasswordChangeIntent, signal: AbortSignal): Promise<void> => {
    const userId = this.userId
    if (!userId) throw new AccountActionError('permissionLost')
    const value = await this.post(ACCOUNT_ROUTES.changePassword, input(accountChangePasswordRequest, intent, 'passwordRejected'), accountMutationValue, signal)
    result(value, intent.requestId, 'change-password', userId); this.forget()
  }
}
