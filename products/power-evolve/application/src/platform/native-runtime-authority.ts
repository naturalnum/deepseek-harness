/** Revocable credentials bind one trusted native process to one account and pool generation. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { accountUserId, type UserId } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { requireActiveAccount, assertProductLoginAllowed } from './account-authority.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'

const binding = z.object({ credentialId: z.uuid(), userId: accountUserId, runtimeId: z.uuid(),
  generation: z.number().int().positive(), credentialVersion: z.number().int().positive(), expiresAt: z.number().int().positive() }).strict()
/** Tokenless identity of a current tenant runtime. */
export type NativeRuntimeIdentity = Readonly<z.infer<typeof binding>>

/** Revoke all derived operation access when its exact native process credential retires.
 * @param client Actual account and Session authorization transaction.
 * @param operation Original current operation, epoch and account.
 * @returns Nothing for a current native process or an explicit legacy worker; revoked native processes refuse.
 */
export async function assertNativeRuntimeGrant(client: PoolClient,
  operation: { operation_id: string; lease_epoch: number; user_id: string }): Promise<void> {
  const bound = await client.query(`SELECT 1 FROM pe_attempts a JOIN pe_runtime_credentials r ON r.runtime_id=a.worker_id
    WHERE a.operation_id=$1 AND a.epoch=$2`, [operation.operation_id, operation.lease_epoch])
  if (!bound.rowCount) return
  const current = await client.query(`SELECT 1 FROM pe_attempts a JOIN pe_runtime_credentials r ON r.runtime_id=a.worker_id
    JOIN pe_users u ON u.id=r.user_id WHERE a.operation_id=$1 AND a.epoch=$2 AND r.user_id=$3
      AND r.credential_version=u.credential_version AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()
      AND u.enabled AND u.deleted_at IS NULL AND NOT u.password_change_required FOR SHARE OF r`,
  [operation.operation_id, operation.lease_epoch, operation.user_id])
  if (current.rowCount !== 1) throw new PlatformError(401, 'unauthorized_runtime')
}

/** Native runtime credentials are separate from browser/account audiences and never grant shared worker admission. */
export class NativeRuntimeAuthority {
  constructor(private readonly pool: Pool) {}

  /** Issue one process credential after checking the current account under its update lock.
   * @param input Platform-selected owner, instance, monotonically increasing pool generation and elapsed lifetime.
   * @returns An opaque bearer for the owned private token file and its tokenless binding.
   */
  async issue(input: { userId: UserId; runtimeId: string; generation: number; lifetimeMs: number }): Promise<NativeRuntimeIdentity & { token: string }> {
    const parsed = z.object({ userId: accountUserId, runtimeId: z.uuid(), generation: z.number().int().positive(),
      lifetimeMs: z.number().int().positive().max(2_147_483_647) }).strict().parse(input)
    const credentialId = randomUUID(), token = randomBytes(32).toString('base64url')
    return transaction(this.pool, async client => {
      const account = await requireActiveAccount(client, parsed.userId, 'update')
      assertProductLoginAllowed(account)
      const previous = await client.query<{ generation: number }>(
        'SELECT generation FROM pe_runtime_credentials WHERE user_id=$1 ORDER BY generation DESC LIMIT 1', [parsed.userId])
      if (previous.rows[0] && previous.rows[0].generation >= parsed.generation) throw new PlatformError(409, 'runtime_generation_conflict')
      await client.query('UPDATE pe_runtime_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [parsed.userId])
      const result = await client.query<{ expires_at: Date }>(`INSERT INTO pe_runtime_credentials
        (id,digest,user_id,runtime_id,generation,credential_version,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::double precision*interval '1 millisecond') RETURNING expires_at`,
      [credentialId, digest(token), parsed.userId, parsed.runtimeId, parsed.generation, account.credentialVersion, parsed.lifetimeMs])
      const expiry = result.rows[0]
      if (!expiry) throw new PlatformError(503, 'runtime_credential_unavailable')
      return { ...binding.parse({ credentialId, userId: parsed.userId, runtimeId: parsed.runtimeId, generation: parsed.generation,
        credentialVersion: account.credentialVersion, expiresAt: expiry.expires_at.getTime() }), token }
    })
  }

  /** Authenticate a runtime bearer inside the caller's account/resource transaction.
   * @param client Transaction before Session or operation locks.
   * @param token Exact runtime bearer; browser and global worker tokens are refused.
   * @param expected Optional server-configured account and process instance.
   * @returns Current immutable binding after account rotation, revocation and expiry checks.
   */
  async authenticateInTransaction(client: PoolClient, token: string,
    expected?: { userId: UserId; runtimeId: string }): Promise<NativeRuntimeIdentity> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new PlatformError(401, 'unauthorized_runtime')
    const hashed = digest(token)
    const hint = await client.query<{ user_id: string }>(
      'SELECT user_id FROM pe_runtime_credentials WHERE digest=$1', [hashed])
    if (!hint.rows[0]) throw new PlatformError(401, 'unauthorized_runtime')
    const account = await requireActiveAccount(client, accountUserId.parse(hint.rows[0].user_id))
    assertProductLoginAllowed(account)
    const rows = await client.query<{ id: string; user_id: string; runtime_id: string; generation: number; credential_version: number; expires_at: Date }>(
      `SELECT id,user_id,runtime_id,generation,credential_version,expires_at FROM pe_runtime_credentials
       WHERE digest=$1 AND user_id=$2 AND credential_version=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
    [hashed, account.userId, account.credentialVersion])
    const row = rows.rows[0]
    if (!row || expected && (row.user_id !== expected.userId || row.runtime_id !== expected.runtimeId)) {
      throw new PlatformError(401, 'unauthorized_runtime')
    }
    return binding.parse({ credentialId: row.id, userId: row.user_id, runtimeId: row.runtime_id,
      generation: row.generation, credentialVersion: row.credential_version, expiresAt: row.expires_at.getTime() })
  }

  /** Recheck one runtime credential without exposing any secret.
   * @param token Runtime bearer.
   * @param expected Optional server-selected binding.
   * @returns Current tokenless runtime identity.
   */
  authenticate(token: string, expected?: { userId: UserId; runtimeId: string }): Promise<NativeRuntimeIdentity> {
    return transaction(this.pool, client => this.authenticateInTransaction(client, token, expected))
  }

  /** Revoke one exact process credential; replacement instances retain their own identity.
   * @param credentialId Platform-recorded original issuance.
   * @returns Completion after revocation is durable.
   */
  async revoke(credentialId: string): Promise<void> {
    const id = z.uuid().parse(credentialId)
    await this.pool.query('UPDATE pe_runtime_credentials SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL', [id])
  }
}
