/** Transactional account authority. Cleanup, observation and stop proofs do not require an active account. */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { ACCOUNT_ERROR_CODES, accountAudience, accountBearerToken, accountRole, accountUserId, type AccountAudience } from '../account-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'

/** This namespace is distinct from schema, execution capacity and Skill advisory locks. */
export const ACCOUNT_ADMINISTRATION_LOCK_ID = 72819535
/** Update mode uses NO KEY UPDATE so result observation can retain foreign-key references during lifecycle work. */
export type AccountLockMode = 'share' | 'update'
const authority = z.object({
  userId: accountUserId, username: z.string().min(1).max(80), displayName: z.string().min(1).max(200), role: accountRole,
  enabled: z.boolean(), revision: z.number().int().positive(), credentialVersion: z.number().int().positive(),
  passwordChangeRequired: z.boolean(), deletedAt: z.date().nullable(),
}).strict()
export type AccountAuthority = Readonly<z.infer<typeof authority>>
export interface BrowserAccountOptions {
  readonly audience?: AccountAudience
  readonly lock?: AccountLockMode
  /** Only account status, own-password change, logout and own receipt lookup may allow this. */
  readonly allowPasswordChangeRequired?: boolean
}

/**
 * Call inside BEGIN, before user/resource locks, for bootstrap and lifecycle mutations.
 * Lock order: administration advisory lock -> users sorted by UUID -> credential -> Session/operation
 * -> action/call/connection. Execution admission starts with the user lock and does not take this advisory lock.
 * @param client The caller's transaction client.
 * @returns Resolves after the administration lock is held until transaction end.
 */
export async function lockAccountAdministration(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_ADMINISTRATION_LOCK_ID])
}

/**
 * Lock every participant before any resource lock; missing identities fail without an authority result.
 * @param client The caller's transaction client.
 * @param userIds Participants whose rows must be locked together, in UUID order.
 * @param mode Shared admission lock or exclusive lifecycle lock.
 * @returns Current database authorities ordered by UUID.
 */
export async function lockAccountAuthorities(client: PoolClient, userIds: readonly UserId[],
  mode: AccountLockMode = 'share'): Promise<readonly AccountAuthority[]> {
  const ids = [...new Set(userIds.map(id => id.toLowerCase()))].sort()
  const clause = mode === 'update' ? 'FOR NO KEY UPDATE' : 'FOR SHARE'
  if (!ids.length) return []
  const result = await client.query(`SELECT id AS "userId",username,display_name AS "displayName",role,
    enabled,account_revision AS revision,credential_version AS "credentialVersion",
    password_change_required AS "passwordChangeRequired",deleted_at AS "deletedAt"
    FROM pe_users WHERE id=ANY($1::uuid[]) ORDER BY id ${clause}`, [ids])
  if (result.rows.length !== ids.length) throw new PlatformError(404, ACCOUNT_ERROR_CODES.notFound)
  return result.rows.map(row => authority.parse(row))
}

/**
 * Reject deleted or disabled identities; password rotation does not invalidate a task grant.
 * @param row Authority read under a user row lock.
 * @returns Returns when execution admission remains allowed.
 */
export function assertActiveAccount(row: AccountAuthority): void {
  if (row.deletedAt) throw new PlatformError(401, ACCOUNT_ERROR_CODES.deleted)
  if (!row.enabled) throw new PlatformError(401, ACCOUNT_ERROR_CODES.disabled)
}
/**
 * Product login and new browser work require completion of the first-password change.
 * @param row Authority read under a user row lock.
 * @returns Returns when product login remains allowed.
 */
export function assertProductLoginAllowed(row: AccountAuthority): void {
  assertActiveAccount(row)
  if (row.passwordChangeRequired) throw new PlatformError(403, ACCOUNT_ERROR_CODES.passwordChangeRequired)
}
/**
 * Caller must independently authenticate the account audience; role comes from the locked row.
 * @param row Authority read under a user row lock.
 * @returns Returns when the current identity is an unrestricted administrator.
 */
export function assertAccountAdministrator(row: AccountAuthority): void {
  assertProductLoginAllowed(row)
  if (row.role !== 'ADMIN') throw new PlatformError(403, ACCOUNT_ERROR_CODES.forbidden)
}

/**
 * Acquire the user lock before Session/action/call/connection locks inside the execution transaction.
 * @param client The caller's transaction client.
 * @param userId Identity admitted to an execution grant.
 * @param mode Shared admission lock or exclusive lifecycle lock.
 * @returns Enabled, nondeleted authority; credential rotation and forced change do not revoke existing grants.
 */
export async function requireActiveAccount(client: PoolClient, userId: UserId,
  mode: AccountLockMode = 'share'): Promise<AccountAuthority> {
  const row = (await lockAccountAuthorities(client, [userId], mode))[0]!
  assertActiveAccount(row)
  return row
}

/**
 * Recheck a browser bearer inside the acceptance transaction. Identity DTOs stay unchanged.
 * The initial credential lookup is a hint only. User authority is locked first, then the credential is
 * rechecked and locked against its current version/expiry; concurrent password rotation or logout cannot
 * pass this check and commit a new acceptance afterwards. No password enters this token digest.
 * @param client The caller's transaction client, before any resource lock.
 * @param token Raw admission bearer, never a stale two-field Identity snapshot.
 * @param options Credential audience, user lock mode and limited account-page access.
 * @returns Current enabled authority with a valid, locked credential for the requested audience.
 */
export async function requireBrowserAccount(client: PoolClient, token: string,
  options: BrowserAccountOptions = {}): Promise<AccountAuthority> {
  if (!accountBearerToken.safeParse(token).success) throw new PlatformError(401, ACCOUNT_ERROR_CODES.unauthorized)
  const audience = accountAudience.parse(options.audience ?? 'agent')
  if (options.allowPasswordChangeRequired && audience !== 'account') throw new Error('Restricted account access requires account audience')
  const hashed = createHash('sha256').update(token).digest('hex')
  const hint = await client.query<{ user_id: string }>(
    'SELECT user_id FROM pe_credentials WHERE digest=$1 AND audience=$2 AND expires_at>clock_timestamp()', [hashed, audience])
  if (!hint.rows[0]) throw new PlatformError(401, ACCOUNT_ERROR_CODES.unauthorized)
  const row = await requireActiveAccount(client, accountUserId.parse(hint.rows[0].user_id), options.lock ?? 'share')
  const credential = await client.query(`SELECT digest FROM pe_credentials
    WHERE digest=$1 AND user_id=$2 AND audience=$3 AND credential_version=$4
      AND expires_at>clock_timestamp() FOR SHARE`, [hashed, row.userId, audience, row.credentialVersion])
  if (!credential.rowCount) throw new PlatformError(401, ACCOUNT_ERROR_CODES.unauthorized)
  if (!options.allowPasswordChangeRequired) assertProductLoginAllowed(row)
  return row
}
