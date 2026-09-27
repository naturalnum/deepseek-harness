/** Password verification and opaque Agent credentials; provider credentials never enter this module. */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { identity, PlatformError, settings, type Identity } from '../contracts.ts'

const derive = promisify(scrypt)

/** Hash a credential for lookup without persisting its usable value. */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Create a password record with an independent random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `${salt}:${key.toString('hex')}`
}

/** Identity operations use PG as their authority and keep Agent and approval audiences separate. */
export class IdentityService {
  constructor(private readonly pool: Pool, private readonly tokenLifetimeMs: number) {}

  /** Authenticate a password and return one bounded, audience-specific token. */
  async login(username: string, password: string, audience: 'agent' | 'approval' = 'agent'): Promise<{ token: string; user: Identity }> {
    const result = await this.pool.query<{ id: string; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM pe_users WHERE username=$1', [username],
    )
    const row = result.rows[0]
    const [salt, expected] = (row?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
    const actual = await derive(password, salt!, 64) as Buffer
    if (!timingSafeEqual(actual, Buffer.from(expected!, 'hex')) || !row) throw new PlatformError(401, 'invalid_login')
    const token = randomBytes(32).toString('base64url')
    await this.pool.query(
      'INSERT INTO pe_credentials(digest,user_id,audience,expires_at) VALUES ($1,$2,$3,now()+$4::double precision*interval \'1 millisecond\')',
      [digest(token), row.id, audience, this.tokenLifetimeMs],
    )
    return { token, user: identity.parse({ userId: row.id, username: row.username }) }
  }

  /** Resolve an unexpired credential and its current user configuration. */
  async authenticate(token: string, audience: 'agent' | 'approval' = 'agent'): Promise<Identity & { settings: ReturnType<typeof settings.parse> }> {
    const result = await this.pool.query<{ id: string; username: string; settings: unknown }>(
      `SELECT u.id,u.username,u.settings FROM pe_credentials c JOIN pe_users u ON u.id=c.user_id
       WHERE c.digest=$1 AND c.audience=$2 AND c.expires_at>now()`, [digest(token), audience],
    )
    const row = result.rows[0]
    if (!row) throw new PlatformError(401, 'unauthorized')
    return { ...identity.parse({ userId: row.id, username: row.username }), settings: settings.parse(row.settings) }
  }

  /** Revoke only the presented credential.
   * @param token - authenticated credential to revoke.
   */
  async logout(token: string): Promise<void> { await this.pool.query('DELETE FROM pe_credentials WHERE digest=$1', [digest(token)]) }
}
