/** Password verification and opaque Agent credentials; provider credentials never enter this module. */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { identity, PlatformError, settings, type Identity } from '../contracts.ts'
import { accountUserId, type AccountAudience } from '../account-contracts.ts'
import { assertProductLoginAllowed, lockAccountAuthorities, requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'

const derive = promisify(scrypt)

/**
 * Hash an opaque credential or public metadata, never a password, for database lookup.
 * @param value Opaque random bearer or secret-free metadata serialization.
 * @returns Hex SHA-256 lookup digest.
 */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

/**
 * Create a password record with an independent random salt.
 * @param password Private password or private password input tuple.
 * @returns Salted scrypt record suitable for expensive verification.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `${salt}:${key.toString('hex')}`
}

/**
 * Verify a salted password record; invalid records still perform the same expensive derivation.
 * @param password Private submitted password or password input tuple.
 * @param record Stored salted scrypt record; never an ordinary digest.
 * @returns Whether the derivation matches a valid record.
 */
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const valid = /^[a-f0-9]{32}:[a-f0-9]{128}$/u.test(record)
  const [salt, expected] = (valid ? record : `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
  const actual = await derive(password, salt!, 64) as Buffer
  return timingSafeEqual(actual, Buffer.from(expected!, 'hex')) && valid
}

/** Identity operations use PG as their authority and keep Agent and approval audiences separate. */
export class IdentityService {
  constructor(private readonly pool: Pool, private readonly tokenLifetimeMs: number) {}

  /**
   * Authenticate the exact login name and recheck the verified hash under the user lock before issuing a token.
   * @param username Stored case-sensitive login name.
   * @param password Private login password; legacy passwords retain their prior login behavior.
   * @param audience Requested Agent, approval or trusted-account audience.
   * @returns Opaque bearer and the stable two-field Identity DTO.
   */
  async login(username: string, password: string, audience: AccountAudience = 'agent'): Promise<{ token: string; user: Identity }> {
    const result = await this.pool.query<{ id: string; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM pe_users WHERE username=$1', [username],
    )
    const row = result.rows[0]
    if (!await verifyPassword(password, row?.password_hash ?? '') || !row) throw new PlatformError(401, 'invalid_login')
    const token = randomBytes(32).toString('base64url')
    return transaction(this.pool, async client => {
      const authority = await requireActiveAccount(client, accountUserId.parse(row.id))
      const current = await client.query<{ password_hash: string }>('SELECT password_hash FROM pe_users WHERE id=$1', [row.id])
      if (current.rows[0]?.password_hash !== row.password_hash) throw new PlatformError(401, 'invalid_login')
      if (audience !== 'account') assertProductLoginAllowed(authority)
      await client.query(
        `INSERT INTO pe_credentials(digest,user_id,audience,credential_version,expires_at)
         VALUES($1,$2,$3,$4,clock_timestamp()+$5::double precision*interval '1 millisecond')`,
        [digest(token), row.id, audience, authority.credentialVersion, this.tokenLifetimeMs])
      return { token, user: identity.parse({ userId: row.id, username: row.username }) }
    })
  }

  /**
   * Resolve an unexpired current-version credential under the account lock.
   * @param token Raw opaque browser bearer.
   * @param audience Expected credential audience; account status may remain restricted to first-password change.
   * @returns Stable identity and current user settings; revoked or disabled credentials fail.
   */
  async authenticate(token: string, audience: AccountAudience = 'agent'): Promise<Identity & { settings: ReturnType<typeof settings.parse> }> {
    try {
      return await transaction(this.pool, async client => {
        const row = await requireBrowserAccount(client, token, { audience, allowPasswordChangeRequired: audience === 'account' })
        const current = await client.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [row.userId])
        return { ...identity.parse({ userId: row.userId, username: row.username }), settings: settings.parse(current.rows[0]!.settings) }
      })
    } catch (error) {
      if (error instanceof PlatformError && error.status === 401) throw new PlatformError(401, 'unauthorized')
      throw error
    }
  }

  /** Replace one Agent credential without extending its original lifetime.
   * @param token - Agent credential consumed by this request.
   * @returns the replacement Agent credential.
   */
  async exchange(token: string): Promise<string> {
    const replacement = randomBytes(32).toString('base64url')
    try {
      return await transaction(this.pool, async client => {
        const user = await requireBrowserAccount(client, token, { audience: 'agent', credentialLock: 'update' })
        const consumed = await client.query<{ expires_at: Date }>(
          'DELETE FROM pe_credentials WHERE digest=$1 AND user_id=$2 RETURNING expires_at', [digest(token), user.userId])
        if (!consumed.rows[0]) throw new PlatformError(401, 'unauthorized')
        await client.query(`INSERT INTO pe_credentials(digest,user_id,audience,credential_version,expires_at)
          VALUES($1,$2,'agent',$3,$4)`, [digest(replacement), user.userId, user.credentialVersion, consumed.rows[0].expires_at])
        return replacement
      })
    } catch (error) {
      if (error instanceof PlatformError && error.status === 401) throw new PlatformError(401, 'unauthorized')
      throw error
    }
  }

  /** Revoke only the presented credential.
   * @param token - authenticated credential to revoke.
   */
  async logout(token: string): Promise<void> {
    await transaction(this.pool, async client => {
      const hint = await client.query<{ user_id: string }>('SELECT user_id FROM pe_credentials WHERE digest=$1', [digest(token)])
      if (!hint.rows[0]) return
      await lockAccountAuthorities(client, [accountUserId.parse(hint.rows[0].user_id)])
      await client.query('DELETE FROM pe_credentials WHERE digest=$1', [digest(token)])
    })
  }
}
