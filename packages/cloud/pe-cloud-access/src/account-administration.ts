/** Account administration over the pinned authentication provider and its existing PostgreSQL database. */
import type { Auth } from 'better-auth'
import { createHmac } from 'node:crypto'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Pool } from 'pg'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { AuthAccessError } from './auth-error.ts'

/** Explicit deployment bounds; initialization is separate from ordinary management requests. */
export interface AccountAdministrationConfig {
  readonly maxAccounts: number
  readonly maxPageSize: number
  readonly initialAdministratorIds: string[]
}

/** Exactly the two platform roles; neither role grants another account's project data. */
export type AccountRole = 'admin' | 'user'

/** Sanitized authentication metadata; credentials and other accounts' data are excluded. */
export interface ManagedAccount {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: AccountRole
  readonly enabled: boolean
}

type ManagedAuth = Auth
type RequestId = Branded<'pe-request-id'>

/** Same authentication invocation owns whole-account hook scope and its structured failures. */
interface AccountAuthInvocation {
  reserve(accountId: AccountId): void
  revoke<T>(accountId: AccountId, operation: () => Promise<T>): Promise<T>
  failure(): 'cloud/capacity' | 'cloud/account-unavailable' | undefined
}

/** Accepted browser operations; actor identity always comes from the actual request Cookie. */
export type AccountAdministrationRequest =
  | { readonly op: 'list'; readonly search: string; readonly offset: number; readonly limit: number }
  | {
    readonly op: 'create'
    readonly email: string
    readonly displayName: string
    readonly password: string
    readonly role: AccountRole
    readonly templateId: string
    readonly requestId: string
  }
  | { readonly op: 'prepare'; readonly id: string; readonly templateId: string; readonly requestId: string }
  | { readonly op: 'rename'; readonly id: string; readonly displayName: string }
  | { readonly op: 'role'; readonly id: string; readonly role: AccountRole }
  | { readonly op: 'enabled'; readonly id: string; readonly enabled: boolean }
  | { readonly op: 'password'; readonly id: string; readonly password: string }

/** Extract only one supported role; old accounts with no role remain ordinary users.
 * @param user Original verified library user.
 * @returns Effective platform role.
 */
export function accountRole(user: object): AccountRole {
  return Reflect.get(user, 'role') === 'admin' ? 'admin' : 'user'
}

/** Strictly decode the management JSON before any database or authentication mutation.
 * @param input Untrusted parsed JSON.
 * @param config Explicit finite deployment limits.
 * @param requestId Original request correlation.
 * @returns Validated account operation.
 */
export function parseAccountAdministration(
  input: unknown, config: AccountAdministrationConfig, requestId: RequestId,
): AccountAdministrationRequest {
  const fail = (): never => { throw new AuthAccessError('cloud/forbidden', requestId) }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail()
  const read = (key: string): unknown => Reflect.get(input, key)
  const text = (key: string, maximum: number): string => {
    const value = read(key)
    if (typeof value !== 'string' || value.length > maximum || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) return fail()
    return value
  }
  const role = (): AccountRole => { const value = read('role'); return value === 'admin' || value === 'user' ? value : fail() }
  const fields = (names: readonly string[]): void => { if (Object.keys(input).some(key => !names.includes(key))) fail() }
  const password = (): string => { const value = text('password', 128); if (value.length < 12) return fail(); return value }
  switch (read('op')) {
    case 'list': {
      fields(['op', 'search', 'offset', 'limit'])
      const search = read('search'), offset = read('offset'), limit = read('limit') ?? config.maxPageSize
      if (typeof search !== 'string' || search.length > 200 || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
        || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > config.maxPageSize) return fail()
      return { op: 'list', search, offset, limit }
    }
    case 'create': fields(['op', 'email', 'displayName', 'password', 'role', 'templateId', 'requestId']); return {
      op: 'create', email: text('email', 254), displayName: text('displayName', 200), password: password(), role: role(), templateId: text('templateId', 64), requestId: text('requestId', 128),
    }
    case 'prepare': fields(['op', 'id', 'templateId', 'requestId']); return {
      op: 'prepare', id: text('id', 200), templateId: text('templateId', 64), requestId: text('requestId', 128),
    }
    case 'rename': fields(['op', 'id', 'displayName']); return { op: 'rename', id: text('id', 200), displayName: text('displayName', 200) }
    case 'role': fields(['op', 'id', 'role']); return { op: 'role', id: text('id', 200), role: role() }
    case 'enabled': {
      fields(['op', 'id', 'enabled']); const enabled = read('enabled')
      if (typeof enabled !== 'boolean') return fail()
      return { op: 'enabled', id: text('id', 200), enabled }
    }
    case 'password': fields(['op', 'id', 'password']); return { op: 'password', id: text('id', 200), password: password() }
    default: return fail()
  }
}

/** Trusted Root resource operations; authentication and physical runtime readiness remain separate owners. */
export interface AccountResourceLifecycle {
  templates(): Promise<readonly Readonly<{ id: string; available: number }>[]>
  states(ids: readonly AccountId[]): Promise<readonly Readonly<{ accountId: AccountId; phase: string }>[]>
  prepare(accountId: AccountId, templateId: string, operationId: string): Promise<void>
  disable(accountId: AccountId, operationId: string): Promise<'disabled' | 'stop-unknown'>
}

/** Finite management operations sharing the original provider, Cookie and PostgreSQL lock. */
export class AccountAdministrator {
  private tail: Promise<void> = Promise.resolve()
  private resources: AccountResourceLifecycle | undefined
  constructor(private readonly auth: ManagedAuth, private readonly database: Pool, readonly config: AccountAdministrationConfig,
    private readonly authInvocation: AccountAuthInvocation) {}

  /** Bind the original Root's physical resource coordinator exactly once.
   * @param resources Original trusted runtime callbacks, never Loader JSON or a browser object.
   */
  installResources(resources: AccountResourceLifecycle): void {
    if (this.resources !== undefined) throw new Error('Account resource lifecycle is already installed')
    this.resources = resources
  }

  private async invoke(headers: Headers, endpoint: string, body: object, requestId: RequestId, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, unknown>> {
    const base = this.auth.options.baseURL
    if (typeof base !== 'string') throw new AuthAccessError('cloud/account-unavailable', requestId)
    const target = new URL('/cloud/auth/admin/' + endpoint, base), copied = new Headers(headers)
    copied.set('content-type', 'application/json')
    copied.delete('content-length')
    if (method === 'GET') for (const [key, value] of Object.entries(body)) target.searchParams.set(key, String(value))
    const response = await this.auth.handler(new Request(target, { method, headers: copied,
      ...method === 'POST' ? { body: JSON.stringify(body) } : {} }))
    const value: unknown = await response.json()
    const failure = this.authInvocation.failure()
    if (failure !== undefined) throw new AuthAccessError(failure, requestId)
    if (!response.ok) throw new AuthAccessError(response.status === 401 ? 'cloud/unauthenticated'
      : response.status < 500 ? 'cloud/forbidden' : 'cloud/account-unavailable', requestId)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AuthAccessError('cloud/account-unavailable', requestId)
    return Object.fromEntries(Object.entries(value))
  }

  /** Seed explicitly named existing accounts only when no active administrator exists.
   * @param current Original startup admission check.
   * @returns Initialization settlement; it neither registers public routes nor creates accounts.
   */
  async initialize(current: () => void): Promise<void> {
    if (this.config.initialAdministratorIds.length === 0) return
    const client = await this.database.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(1346715981, 1)')
      current()
      const count = await client.query<{ count: string }>('SELECT count(*) FROM "user" WHERE role = $1 AND coalesce(banned, false) = false', ['admin'])
      if (count.rows[0]?.count === '0') {
        const seeded = await client.query('UPDATE "user" SET role = $1 WHERE id = ANY($2::text[]) AND coalesce(banned, false) = false RETURNING id', ['admin', this.config.initialAdministratorIds])
        if (seeded.rowCount !== this.config.initialAdministratorIds.length) throw new Error('Configured initial administrator is unavailable')
      }
      current(); await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  /** Execute one supported operation after re-reading the actor's authoritative login.
   * @param headers Captured trusted headers from the original browser request, never omitted.
   * @param request Parsed management operation.
   * @param requestId Original correlation.
   * @param current Original operation admission, checked before each mutation and after awaits.
   * @returns Sanitized outcome; account creation does not claim storage readiness.
   */
  execute(headers: Headers, request: AccountAdministrationRequest, requestId: RequestId, current: () => void): Promise<object> {
    // The outer authentication owner bounds all queued operations. Only one local operation may hold a lock connection.
    const actual = this.tail.then(() => this.executeSerial(headers, request, requestId, current))
    this.tail = actual.then(() => {}, () => {})
    return actual
  }

  private async executeSerial(
    headers: Headers, request: AccountAdministrationRequest, requestId: RequestId, current: () => void,
  ): Promise<object> {
    current()
    const client = await this.database.connect()
    try {
      await client.query('BEGIN')
      // The same transaction lock serializes every application administration mutation across hosts.
      await client.query('SELECT pg_advisory_xact_lock(1346715981, 1)')
      current()
      const login = await this.auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
      current()
      if (login === null) throw new AuthAccessError('cloud/unauthenticated', requestId)
      if (accountRole(login.user) !== 'admin' || Reflect.get(login.user, 'banned') === true) throw new AuthAccessError('cloud/forbidden', requestId)
      if (request.op === 'list') {
        const result = await this.invoke(headers, 'list-users', { limit: request.limit, offset: request.offset,
          searchField: 'email', searchValue: request.search, searchOperator: 'contains' }, requestId, 'GET')
        current()
        if (!Array.isArray(result['users']) || typeof result['total'] !== 'number') throw new AuthAccessError('cloud/account-unavailable', requestId)
        const accounts = result['users'].map((user: unknown): ManagedAccount => {
          if (user === null || typeof user !== 'object') throw new AuthAccessError('cloud/account-unavailable', requestId)
          const id: unknown = Reflect.get(user, 'id'), email: unknown = Reflect.get(user, 'email'), name: unknown = Reflect.get(user, 'name')
          if (typeof id !== 'string' || typeof email !== 'string' || typeof name !== 'string') throw new AuthAccessError('cloud/account-unavailable', requestId)
          return { id, email, displayName: name, role: accountRole(user), enabled: Reflect.get(user, 'banned') !== true }
        })
        const resourceStates = await this.resources?.states(accounts.map(row => row.id as AccountId)) ?? []
        const templates = await this.resources?.templates() ?? []
        current()
        return { accounts: accounts.map(row => ({ ...row, resourceState: resourceStates.find(state => state.accountId === row.id)?.phase
          ?? (row.enabled && templates.length === 0 ? 'legacy' : 'not-provisioned') })), total: result['total'], offset: request.offset, limit: request.limit, templates }
      }
      if (request.op === 'create') {
        const secret = this.auth.options.secret
        if (typeof secret !== 'string') throw new AuthAccessError('cloud/account-unavailable', requestId)
        const hash = createHmac('sha256', secret).update(JSON.stringify(request)).digest('hex')
        const prior = await client.query<{ id: string; cloudCreationHash: string; banned: boolean; banReason: string | null }>(
          'SELECT id, "cloudCreationHash", banned, "banReason" FROM "user" WHERE "cloudCreationId" = $1', [request.requestId])
        let id = prior.rows[0]?.id
        if (id !== undefined && prior.rows[0]?.cloudCreationHash !== hash) throw new AuthAccessError('cloud/forbidden', requestId)
        if (id !== undefined && (prior.rows[0]?.banned !== true || prior.rows[0].banReason !== 'resources-not-provisioned')) {
          return { id, resourceState: prior.rows[0]?.banned ? 'disabled' : 'ready' }
        }
        if (id === undefined) {
          const count = await client.query<{ count: string }>('SELECT count(*) FROM "user"')
          if (Number(count.rows[0]?.count) >= this.config.maxAccounts) throw new AuthAccessError('cloud/capacity', requestId)
          current()
          const result = await this.invoke(headers, 'create-user', { email: request.email, name: request.displayName,
            password: request.password, role: request.role, data: { banned: true, banReason: 'resources-not-provisioned',
              cloudCreationId: request.requestId, cloudCreationHash: hash } }, requestId)
          current()
          const user = result['user']
          if (user === null || typeof user !== 'object') throw new AuthAccessError('cloud/account-unavailable', requestId)
          const createdId: unknown = Reflect.get(user, 'id')
          if (typeof createdId !== 'string') throw new AuthAccessError('cloud/account-unavailable', requestId)
          id = createdId
        }
        if (this.resources === undefined) return { id, resourceState: 'not-provisioned' }
        try {
          await this.resources.prepare(id as AccountId, request.templateId, request.requestId)
          current()
          await this.invoke(headers, 'unban-user', { userId: id }, requestId)
          current()
          return { id, resourceState: 'ready' }
        } catch (_resourceFailure) {
          current()
          return { id, resourceState: 'failed' }
        }
      }
      if (request.op === 'prepare') {
        if (this.resources === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
        const target = await this.invoke(headers, 'get-user', { id: request.id }, requestId, 'GET')
        current()
        if (target['id'] !== request.id) throw new AuthAccessError('cloud/forbidden', requestId)
        await this.resources.prepare(request.id as AccountId, request.templateId, request.requestId)
        current()
        await this.invoke(headers, 'unban-user', { userId: request.id }, requestId)
        current()
        return { id: request.id, resourceState: 'ready' }
      }
      if (request.op === 'role' && request.role !== 'admin' || request.op === 'enabled' && !request.enabled) {
        const target = await client.query<{ role: string; banned: boolean }>('SELECT role, banned FROM "user" WHERE id = $1', [request.id])
        if (target.rows[0]?.role === 'admin' && !target.rows[0].banned) {
          const count = await client.query<{ count: string }>('SELECT count(*) FROM "user" WHERE role = $1 AND coalesce(banned, false) = false', ['admin'])
          if (Number(count.rows[0]?.count) <= 1) throw new AuthAccessError('cloud/last-administrator', requestId)
        }
      }
      current()
      switch (request.op) {
        case 'rename': await this.invoke(headers, 'update-user', { userId: request.id, data: { name: request.displayName } }, requestId); break
        case 'role': await this.invoke(headers, 'set-role', { userId: request.id, role: request.role }, requestId); break
        case 'enabled': {
          const resources = this.resources
          if (resources === undefined) throw new AuthAccessError('cloud/account-unavailable', requestId)
          const target = await this.invoke(headers, 'get-user', { id: request.id }, requestId, 'GET')
          current()
          if (target['id'] !== request.id) throw new AuthAccessError('cloud/forbidden', requestId)
          if (request.enabled) {
            await resources.prepare(request.id as AccountId, '', requestId)
            current()
            await this.invoke(headers, 'unban-user', { userId: request.id }, requestId)
          } else {
            let banFailure: { readonly cause: unknown } | undefined
            try {
              await this.authInvocation.revoke(request.id as AccountId,
                () => this.invoke(headers, 'ban-user', { userId: request.id }, requestId))
            } catch (cause) {
              const actual = await client.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id = $1', [request.id])
              if (actual.rows[0]?.banned !== true) throw cause
              banFailure = { cause }
            }
            // Once the identity is banned, actual drain remains owned even if its login or browser retires.
            let status: 'disabled' | 'stop-unknown'
            try { status = await resources.disable(request.id as AccountId, requestId) }
            catch (cause) { throw new AuthAccessError('cloud/account-stop-unconfirmed', requestId, { cause }) }
            if (status !== 'disabled') throw new AuthAccessError('cloud/account-stop-unconfirmed', requestId)
            if (banFailure !== undefined) throw banFailure.cause
            current()
          }
          break
        }
        case 'password':
          this.authInvocation.reserve(request.id as AccountId)
          await this.authInvocation.revoke(request.id as AccountId, async () => {
            await this.invoke(headers, 'set-user-password', { userId: request.id, newPassword: request.password }, requestId)
            await this.invoke(headers, 'revoke-user-sessions', { userId: request.id }, requestId)
          })
          break
      }
      current()
      return { updated: true }
    } finally {
      try { await client.query('ROLLBACK') } finally { client.release() }
    }
  }
}
