/** Trusted account lifecycle; every operation derives actor authority from a transaction-checked bearer. */
import { randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { storageRelativePath } from '@power-evolve/contracts/workspace-binding'
import { ACCOUNT_ERROR_CODES, ACCOUNT_MAX_MODELS_PER_USER, ACCOUNT_MAX_PAGE_ITEMS, ACCOUNT_PAGE_PATH,
  ACCOUNT_PASSWORD_MAX_BYTES, ACCOUNT_PASSWORD_MIN_BYTES, accountCapabilitiesValue, accountListRequest, accountListValue, accountLoginValue,
  accountMeValue, accountModelCatalogValue, accountMutationReceipt, accountMutationValue, accountReceiptValue,
  accountSecretMutationValue, accountUserId, accountValue,
  type AccountChangePasswordRequest, type AccountCreateRequest, type AccountMutationReceipt, type AccountRole,
  type AccountTargetMutationRequest, type AccountUpdateRequest, type AccountValue } from '../account-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'
import { assertAccountAdministrator, lockAccountAdministration, lockAccountAuthorities, requireBrowserAccount,
  type AccountAuthority } from './account-authority.ts'
import type { AccountManagementConfig } from './account-config.ts'
import { revokeAccountCredentials } from './account-credentials.ts'
import { transaction } from './database.ts'
import { digest, hashPassword, IdentityService, verifyPassword } from './identity.ts'
import { SafePosix } from './safe-posix.ts'

/** Invoked under the target user's exclusive lock; durable cancellation and grant fencing share the lifecycle transaction. */
export type AccountExecutionRevoker = (client: PoolClient, userId: UserId) => Promise<unknown>
/** Private deployment settings and execution coordinator; no browser request supplies these values. */
export interface AccountServiceOptions {
  readonly platformOrigin: string
  readonly workspaceRoot: string
  readonly management: AccountManagementConfig
  readonly revokeExecutions: AccountExecutionRevoker
}
type AccountRow = { userId: string; username: string; displayName: string; role: AccountRole; enabled: boolean;
  revision: number; passwordChangeRequired: boolean; deletedAt: Date | null; createdAt: Date; updatedAt: Date }
const columns = `id AS "userId",username,display_name AS "displayName",role,enabled,account_revision AS revision,
  password_change_required AS "passwordChangeRequired",deleted_at AS "deletedAt",created_at AS "createdAt",updated_at AS "updatedAt"`
const view = (row: AccountRow): AccountValue => accountValue.parse({ ...row,
  deletedAt: row.deletedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })
async function readAccount(client: PoolClient, userId: UserId): Promise<AccountValue> {
  const row = (await client.query<AccountRow>(`SELECT ${columns} FROM pe_users WHERE id=$1`, [userId])).rows[0]
  if (!row) throw new PlatformError(404, ACCOUNT_ERROR_CODES.notFound)
  return view(row)
}
type MutationKind = AccountMutationReceipt['kind']
const fingerprint = (metadata: readonly unknown[]) => digest(JSON.stringify(metadata))
const passwordInputs = (input: AccountChangePasswordRequest) => JSON.stringify([input.currentPassword, input.newPassword])

async function replay(client: PoolClient, actor: UserId, requestId: string, hashed: string,
  input?: AccountChangePasswordRequest): Promise<AccountMutationReceipt | null> {
  const row = (await client.query<{ request_digest: string; password_verifier: string | null; receipt: unknown }>(
    'SELECT request_digest,password_verifier,receipt FROM pe_account_mutations WHERE actor_user_id=$1 AND request_id=$2',
    [actor, requestId])).rows[0]
  if (!row) return null
  if (row.request_digest !== hashed || input && (!row.password_verifier || !await verifyPassword(passwordInputs(input), row.password_verifier))) {
    throw new PlatformError(409, ACCOUNT_ERROR_CODES.requestConflict)
  }
  return accountMutationReceipt.parse(row.receipt)
}

async function record(client: PoolClient, actor: UserId, requestId: string, kind: MutationKind,
  target: UserId, hashed: string, passwordVerifier: string | null = null): Promise<AccountMutationReceipt> {
  const receipt = accountMutationReceipt.parse({ requestId, kind, account: await readAccount(client, target),
    completedAt: (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!.time.toISOString() })
  await client.query(`INSERT INTO pe_account_mutations(actor_user_id,request_id,kind,target_user_id,request_digest,password_verifier,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor, requestId, kind, target, hashed, passwordVerifier, receipt])
  await client.query(`INSERT INTO pe_account_audit(id,actor_user_id,target_user_id,request_id,kind,metadata)
    VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), actor, target, requestId, kind,
    { revision: receipt.account.revision, enabled: receipt.account.enabled, role: receipt.account.role }])
  return receipt
}

async function protectAdministrator(client: PoolClient, previous: AccountAuthority, role: AccountRole, enabled: boolean): Promise<void> {
  if (previous.role !== 'ADMIN' || !previous.enabled || previous.deletedAt || previous.passwordChangeRequired || role === 'ADMIN' && enabled) return
  const others = await client.query(`SELECT 1 FROM pe_users WHERE id<>$1 AND role='ADMIN' AND enabled
    AND deleted_at IS NULL AND NOT password_change_required LIMIT 1`, [previous.userId])
  if (!others.rowCount) throw new PlatformError(409, ACCOUNT_ERROR_CODES.lastAdministrator)
}
function revisionMatches(target: AccountAuthority, expected: number): void {
  if (target.deletedAt) throw new PlatformError(404, ACCOUNT_ERROR_CODES.notFound)
  if (target.revision !== expected) throw new PlatformError(409, ACCOUNT_ERROR_CODES.revisionConflict)
}

/** Service methods require parsed DTO inputs; the route adapter owns untrusted JSON and origin validation. */
export class AccountService {
  /** Exact trusted browser origin enforced by the account route adapter. */
  readonly platformOrigin: string
  private readonly storage: SafePosix
  constructor(private readonly pool: Pool, private readonly identities: IdentityService,
    private readonly options: AccountServiceOptions) {
    const origin = new URL(options.platformOrigin)
    if (origin.origin !== options.platformOrigin || !['http:', 'https:'].includes(origin.protocol)
      || origin.username || origin.password || !isAbsolute(options.workspaceRoot)) throw new Error('Invalid account service configuration')
    this.platformOrigin = origin.origin
    this.storage = new SafePosix(resolve(options.workspaceRoot))
  }

  /**
   * Issue only an account-audience bearer; the Platform login admission guard runs before JSON is read.
   * @param username Exact legacy login name.
   * @param password Private password submitted directly to the Platform.
   * @returns Trusted-memory token, current account view and first-password restriction.
   */
  async login(username: string, password: string): Promise<z.infer<typeof accountLoginValue>> {
    const issued = await this.identities.login(username, password, 'account')
    return transaction(this.pool, async client => {
      const user = await requireBrowserAccount(client, issued.token, { audience: 'account', allowPasswordChangeRequired: true })
      const credential = (await client.query<{ expires_at: Date }>('SELECT expires_at FROM pe_credentials WHERE digest=$1', [digest(issued.token)])).rows[0]!
      return accountLoginValue.parse({ token: issued.token, user: await readAccount(client, user.userId),
        restricted: user.passwordChangeRequired, expiresAt: credential.expires_at.toISOString() })
    })
  }

  /**
   * Project only read-only account capability for the Host.
   * @param token Agent bearer.
   * @returns Capability and trusted URL without a management credential.
   */
  async capabilities(token: string): Promise<z.infer<typeof accountCapabilitiesValue>> {
    return transaction(this.pool, async client => {
      const user = await requireBrowserAccount(client, token)
      return accountCapabilitiesValue.parse({ userId: user.userId, username: user.username, displayName: user.displayName,
        role: user.role, canManage: user.role === 'ADMIN', accountUrl: new URL(ACCOUNT_PAGE_PATH, this.platformOrigin).href })
    })
  }

  /**
   * Read current own account status even during first-password change.
   * @param token Account bearer, including a restricted first-password token.
   * @returns Current own account and restriction.
   */
  async me(token: string): Promise<z.infer<typeof accountMeValue>> {
    return transaction(this.pool, async client => {
      const user = await requireBrowserAccount(client, token, { audience: 'account', allowPasswordChangeRequired: true })
      return accountMeValue.parse({ user: await readAccount(client, user.userId), restricted: user.passwordChangeRequired })
    })
  }

  /**
   * Revoke the presented trusted-account credential.
   * @param token Account bearer.
   * @returns Completion after the same transaction revokes this credential.
   */
  async logout(token: string): Promise<{ ok: true }> {
    return transaction(this.pool, async client => {
      await requireBrowserAccount(client, token, { audience: 'account', allowPasswordChangeRequired: true, credentialLock: 'update' })
      await client.query('DELETE FROM pe_credentials WHERE digest=$1', [digest(token)])
      return { ok: true }
    })
  }

  /**
   * Read the deployment model catalog for account creation.
   * @param token Unrestricted account administrator bearer.
   * @returns Deployment catalog, initial settings and bounded limits.
   */
  async models(token: string): Promise<z.infer<typeof accountModelCatalogValue>> {
    return transaction(this.pool, async client => {
      assertAccountAdministrator(await requireBrowserAccount(client, token, { audience: 'account' }))
      return accountModelCatalogValue.parse({ models: this.options.management.models, initialSettings: this.options.management.initialSettings,
        limits: { maxUsers: this.options.management.maxUsers,
        maxPageItems: ACCOUNT_MAX_PAGE_ITEMS, maxModelsPerUser: ACCOUNT_MAX_MODELS_PER_USER,
        passwordMinBytes: ACCOUNT_PASSWORD_MIN_BYTES, passwordMaxBytes: ACCOUNT_PASSWORD_MAX_BYTES } })
    })
  }

  /**
   * List live accounts using stable UUID pagination and literal substring search.
   * @param token Unrestricted account administrator bearer.
   * @param input Parsed list filters and bounded page size.
   * @returns Secret-free account page and the next UUID cursor.
   */
  async list(token: string, input: z.infer<typeof accountListRequest>): Promise<z.infer<typeof accountListValue>> {
    let cursor: string | null = null
    if (input.cursor) {
      const parsed = z.uuid().safeParse(input.cursor)
      if (!parsed.success) throw new PlatformError(400, 'invalid_request')
      cursor = parsed.data
    }
    if (input.query?.includes('\0')) throw new PlatformError(400, 'invalid_request')
    return transaction(this.pool, async client => {
      assertAccountAdministrator(await requireBrowserAccount(client, token, { audience: 'account' }))
      const rows = (await client.query<AccountRow>(`SELECT ${columns} FROM pe_users WHERE deleted_at IS NULL
        AND ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR strpos(lower(username),lower($2))>0 OR strpos(lower(display_name),lower($2))>0)
        AND ($3::text IS NULL OR role=$3) AND ($4::boolean IS NULL OR enabled=$4) ORDER BY id LIMIT $5`,
      [cursor, input.query ?? null, input.role ?? null, input.enabled ?? null, input.limit + 1])).rows
      return accountListValue.parse({ items: rows.slice(0, input.limit).map(view),
        nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.userId : null })
    })
  }

  private async administrator(client: PoolClient, token: string, targets: readonly UserId[] = []): Promise<AccountAuthority> {
    await lockAccountAdministration(client)
    // Lock existing participants together; missing targets are reported after the actor's receipt check.
    const participants = targets.length ? (await client.query<{ id: string }>(
      'SELECT id FROM pe_users WHERE id=ANY($1::uuid[])', [targets])).rows.map(row => accountUserId.parse(row.id)) : targets
    const actor = await requireBrowserAccount(client, token, { audience: 'account', lock: 'update', participants })
    assertAccountAdministrator(actor)
    return actor
  }

  /**
   * Create a new enabled identity with an independently generated temporary password and first-password restriction.
   * @param token Unrestricted account administrator bearer.
   * @param input Parsed username, settings, role and catalog-backed grants.
   * @returns Durable receipt and temporary password only on the first committed response.
   */
  async create(token: string, input: AccountCreateRequest): Promise<z.infer<typeof accountSecretMutationValue>> {
    const hashed = fingerprint(['create', input.username, input.displayName, input.role, input.settings.model, input.settings.maxTokens,
      [...input.models].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.maxTokens])])
    return transaction(this.pool, async client => {
      const actor = await this.administrator(client, token)
      const prior = await replay(client, actor.userId, input.requestId, hashed)
      if (prior) return accountSecretMutationValue.parse({ receipt: prior, replay: true, temporaryPassword: null })
      if ((await client.query('SELECT 1 FROM pe_users WHERE lower(username)=lower($1)', [input.username])).rowCount) {
        throw new PlatformError(409, ACCOUNT_ERROR_CODES.usernameConflict)
      }
      const count = (await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_users WHERE deleted_at IS NULL')).rows[0]!.count
      if (count >= this.options.management.maxUsers) throw new PlatformError(409, ACCOUNT_ERROR_CODES.limit)
      const models = input.models.map(request => {
        const model = this.options.management.models.find(item => item.id === request.id)
        if (!model || request.maxTokens > model.maxTokens) throw new PlatformError(403, ACCOUNT_ERROR_CODES.modelNotAuthorized)
        return { ...model, maxTokens: request.maxTokens }
      })
      const target = accountUserId.parse(randomUUID())
      const temporaryPassword = randomBytes(32).toString('base64url')
      await client.query(`INSERT INTO pe_users(id,username,display_name,role,password_hash,password_change_required,settings)
        VALUES($1,$2,$3,$4,$5,true,$6)`, [target, input.username, input.displayName, input.role,
        await hashPassword(temporaryPassword), { ...input.settings, revision: 1 }])
      for (const model of models) await client.query(`INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
        VALUES($1,$2,$3,$4,true)`, [target, model.id, model.label, model.maxTokens])
      return accountSecretMutationValue.parse({ receipt: await record(client, actor.userId, input.requestId, 'create', target, hashed),
        replay: false, temporaryPassword })
    })
  }

  /**
   * Update account metadata or enablement; disabling fences accepted grants through the execution coordinator.
   * @param token Unrestricted account administrator bearer.
   * @param input Parsed target, revision and changed fields.
   * @returns Stable metadata receipt; repeated request IDs do not repeat cancellation.
   */
  async update(token: string, input: AccountUpdateRequest): Promise<z.infer<typeof accountMutationValue>> {
    const hashed = fingerprint(['update', input.userId, input.expectedRevision, input.displayName ?? null, input.role ?? null, input.enabled ?? null])
    return transaction(this.pool, async client => {
      const actor = await this.administrator(client, token, [input.userId])
      const prior = await replay(client, actor.userId, input.requestId, hashed)
      if (prior) return { receipt: prior, replay: true }
      const target = (await lockAccountAuthorities(client, [input.userId], 'update'))[0]!
      revisionMatches(target, input.expectedRevision)
      const role = input.role ?? target.role
      const enabled = input.enabled ?? target.enabled
      await protectAdministrator(client, target, role, enabled)
      const rotating = enabled !== target.enabled
      await client.query(`UPDATE pe_users SET display_name=$2,role=$3,enabled=$4,account_revision=account_revision+1,
        credential_version=credential_version+$5,updated_at=clock_timestamp() WHERE id=$1`,
      [target.userId, input.displayName ?? target.displayName, role, enabled, rotating ? 1 : 0])
      if (rotating) await revokeAccountCredentials(client, target.userId)
      if (!enabled) await this.options.revokeExecutions(client, target.userId)
      return { receipt: await record(client, actor.userId, input.requestId, 'update', target.userId, hashed), replay: false }
    })
  }

  /**
   * Reset a password without revoking previously accepted task grants.
   * @param token Unrestricted account administrator bearer.
   * @param input Parsed target, expected revision and stable request ID.
   * @returns Receipt and a temporary password once; replay returns only the receipt.
   */
  async resetPassword(token: string, input: AccountTargetMutationRequest): Promise<z.infer<typeof accountSecretMutationValue>> {
    const hashed = fingerprint(['reset-password', input.userId, input.expectedRevision])
    return transaction(this.pool, async client => {
      const actor = await this.administrator(client, token, [input.userId])
      const prior = await replay(client, actor.userId, input.requestId, hashed)
      if (prior) return { receipt: prior, replay: true, temporaryPassword: null }
      const target = (await lockAccountAuthorities(client, [input.userId], 'update'))[0]!
      revisionMatches(target, input.expectedRevision)
      await protectAdministrator(client, target, target.role, false)
      const temporaryPassword = randomBytes(32).toString('base64url')
      await client.query(`UPDATE pe_users SET password_hash=$2,password_change_required=true,account_revision=account_revision+1,
        credential_version=credential_version+1,updated_at=clock_timestamp() WHERE id=$1`, [target.userId, await hashPassword(temporaryPassword)])
      await revokeAccountCredentials(client, target.userId)
      return { receipt: await record(client, actor.userId, input.requestId, 'reset-password', target.userId, hashed), replay: false, temporaryPassword }
    })
  }

  /**
   * Change the authenticated user's password; salted scrypt verifies password-bearing retries.
   * @param token Account bearer, including the first-password token.
   * @param input Parsed current and new passwords and stable request ID.
   * @returns Durable receipt after all browser audiences are revoked; accepted execution grants remain.
   */
  async changePassword(token: string, input: AccountChangePasswordRequest): Promise<z.infer<typeof accountMutationValue>> {
    const hashed = fingerprint(['change-password'])
    return transaction(this.pool, async client => {
      await lockAccountAdministration(client)
      const actor = await requireBrowserAccount(client, token, { audience: 'account', lock: 'update', allowPasswordChangeRequired: true })
      const prior = await replay(client, actor.userId, input.requestId, hashed, input)
      if (prior) return { receipt: prior, replay: true }
      const previous = (await client.query<{ password_hash: string }>('SELECT password_hash FROM pe_users WHERE id=$1', [actor.userId])).rows[0]!
      if (!await verifyPassword(input.currentPassword, previous.password_hash)) throw new PlatformError(403, ACCOUNT_ERROR_CODES.currentPasswordInvalid)
      if (await verifyPassword(input.newPassword, previous.password_hash)) throw new PlatformError(400, ACCOUNT_ERROR_CODES.passwordInvalid)
      const [passwordHash, verifier] = await Promise.all([hashPassword(input.newPassword), hashPassword(passwordInputs(input))])
      await client.query(`UPDATE pe_users SET password_hash=$2,password_change_required=false,account_revision=account_revision+1,
        credential_version=credential_version+1,updated_at=clock_timestamp() WHERE id=$1`, [actor.userId, passwordHash])
      await revokeAccountCredentials(client, actor.userId)
      return { receipt: await record(client, actor.userId, input.requestId, 'change-password', actor.userId, hashed, verifier), replay: false }
    })
  }

  /**
   * Look up only the authenticated actor's mutation receipt.
   * @param token Account bearer.
   * @param requestId Own mutation request ID.
   * @returns Own secret-free receipt, or null.
   */
  async receipt(token: string, requestId: string): Promise<z.infer<typeof accountReceiptValue>> {
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, token, { audience: 'account', allowPasswordChangeRequired: true })
      const row = (await client.query<{ receipt: unknown }>('SELECT receipt FROM pe_account_mutations WHERE actor_user_id=$1 AND request_id=$2',
        [actor.userId, requestId])).rows[0]
      return accountReceiptValue.parse({ receipt: row?.receipt ?? null })
    })
  }

  /**
   * Tombstone only an account without durable business data, storage intent or live/uncertain execution.
   * Every owned storage root is inspected; only empty default binding directories and their ancestors are exempt.
   * @param token Unrestricted account administrator bearer.
   * @param input Parsed target, expected revision and stable request ID.
   * @returns Stable deletion receipt; identity, audit and history rows remain intact.
   */
  async remove(token: string, input: AccountTargetMutationRequest): Promise<z.infer<typeof accountMutationValue>> {
    const hashed = fingerprint(['delete', input.userId, input.expectedRevision])
    return transaction(this.pool, async client => {
      const actor = await this.administrator(client, token, [input.userId])
      const prior = await replay(client, actor.userId, input.requestId, hashed)
      if (prior) return { receipt: prior, replay: true }
      const target = (await lockAccountAuthorities(client, [input.userId], 'update'))[0]!
      revisionMatches(target, input.expectedRevision)
      await protectAdministrator(client, target, target.role, false)
      await this.assertEmpty(client, target.userId)
      await client.query(`UPDATE pe_users SET enabled=false,deleted_at=clock_timestamp(),account_revision=account_revision+1,
        credential_version=credential_version+1,updated_at=clock_timestamp() WHERE id=$1`, [target.userId])
      await revokeAccountCredentials(client, target.userId)
      await this.options.revokeExecutions(client, target.userId)
      return { receipt: await record(client, actor.userId, input.requestId, 'delete', target.userId, hashed), replay: false }
    })
  }

  private async assertEmpty(client: PoolClient, userId: UserId): Promise<void> {
    const execution = (await client.query<{ active: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id WHERE s.user_id=$1 AND o.state IN ('queued','running'))
      OR EXISTS(SELECT 1 FROM pe_cloud_executions WHERE user_id=$1 AND state IN ('queued','starting','running','cancelling','uncertain'))
      OR EXISTS(SELECT 1 FROM pe_desktop_executions WHERE user_id=$1 AND state IN ('queued','running','cancelling','uncertain'))
      OR EXISTS(SELECT 1 FROM pe_connector_actions WHERE user_id=$1 AND state IN ('pending','approved','dispatching','uncertain'))
      OR EXISTS(SELECT 1 FROM pe_ssh_calls WHERE user_id=$1 AND (state IN ('accepted','preparing','ready','dispatch-intent','running') OR state='uncertain' AND NOT cleanup_complete))
      OR EXISTS(SELECT 1 FROM pe_stdio_mcp_calls WHERE user_id=$1 AND (state IN ('accepted','preparing','ready','dispatch-intent','running') OR state='uncertain' AND NOT cleanup_complete))
      OR EXISTS(SELECT 1 FROM pe_ssh_execute_actions WHERE user_id=$1 AND state IN ('pending','approved','dispatching','uncertain'))
      OR EXISTS(SELECT 1 FROM pe_mcp_actions WHERE user_id=$1 AND state IN ('pending','approved','preparing','dispatch-intent','uncertain'))
      OR EXISTS(SELECT 1 FROM pe_mcp_checks WHERE user_id=$1 AND state IN ('queued','running'))
      OR EXISTS(SELECT 1 FROM pe_office_preview_jobs WHERE user_id=$1
        AND (state IN ('queued','creating','running','stopping','blocked') OR parser_slot IS NOT NULL))
      OR EXISTS(SELECT 1 FROM pe_storage_directory_requests WHERE user_id=$1 AND state='accepted')
      OR EXISTS(SELECT 1 FROM pe_workspace_binding_requests WHERE user_id=$1 AND state IN ('accepted','stopping','blocked'))
      OR EXISTS(SELECT 1 FROM pe_workspaces WHERE user_id=$1 AND binding_state IN ('recovering','blocked'))
      OR EXISTS(SELECT 1 FROM pe_mount_slots WHERE user_id=$1 AND state<>'free')
      OR EXISTS(SELECT 1 FROM pe_sandbox_instances WHERE user_id=$1 AND state IN ('creating','ready','deleting','unknown')) AS active`, [userId])).rows[0]!
    if (execution.active) throw new PlatformError(409, ACCOUNT_ERROR_CODES.executionActive)
    const tables = ['pe_sessions', 'pe_file_mutations', 'pe_artifacts', 'pe_user_skills', 'pe_skill_package_versions',
      'pe_devices', 'pe_device_directories', 'pe_mcp_connections', 'pe_ssh_connections', 'pe_stdio_mcp_connections',
      'pe_mcp_remote_connections', 'pe_mcp_drafts', 'pe_mcp_checks', 'pe_connector_actions',
      'pe_storage_directory_requests', 'pe_workspace_binding_requests', 'pe_office_preview_jobs']
    const content = (await client.query<{ content: boolean }>(`SELECT ${tables.map(table => `EXISTS(SELECT 1 FROM ${table} WHERE user_id=$1)`).join(' OR ')}
      OR EXISTS(SELECT 1 FROM pe_workspaces WHERE user_id=$1 AND (NOT is_default OR create_request_id IS NOT NULL)) AS content`, [userId])).rows[0]!
    if (content.content) throw new PlatformError(409, ACCOUNT_ERROR_CODES.notEmpty)
    try { await this.storage.init() }
    catch (error) {
      if (error instanceof PlatformError) throw new PlatformError(409, ACCOUNT_ERROR_CODES.notEmpty)
      throw error
    }
    const roots = await client.query<{ root_key: string; root_relative_path: string | null }>(`SELECT s.root_key,b.root_relative_path
      FROM pe_storage_spaces s LEFT JOIN pe_workspace_bindings b ON b.space_id=s.id AND b.user_id=s.user_id
        AND EXISTS(SELECT 1 FROM pe_workspaces w WHERE w.id=b.workspace_id AND w.user_id=b.user_id AND w.is_default)
      WHERE s.user_id=$1
      UNION ALL SELECT w.id AS root_key,'' AS root_relative_path FROM pe_workspaces w
      WHERE w.user_id=$1 AND NOT EXISTS(SELECT 1 FROM pe_workspace_bindings b WHERE b.workspace_id=w.id AND b.user_id=w.user_id)
      ORDER BY root_key`, [userId])
    for (const storage of roots.rows) {
      const rootKey = z.uuid().parse(storage.root_key)
      const permittedPath = storage.root_relative_path === null ? '' : storageRelativePath.parse(storage.root_relative_path)
      let empty
      try { empty = await this.storage.isEmpty(rootKey, permittedPath === '' ? [] : permittedPath.split('/')) }
      catch (error) {
        if (error instanceof PlatformError) throw new PlatformError(409, ACCOUNT_ERROR_CODES.notEmpty)
        throw error
      }
      if (!empty) throw new PlatformError(409, ACCOUNT_ERROR_CODES.notEmpty)
    }
  }
}
