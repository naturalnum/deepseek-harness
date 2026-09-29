/** Personal SSH metadata and direct, encrypted credential intake. Execution uses a separate Runner. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { Pool } from 'pg'
import { z } from 'zod'
import { sshCreateTicketRequest, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'

const TICKET_LIFETIME_MS = 5 * 60_000
const MAX_CONNECTIONS = 8
const MAX_PENDING = 8
type Request = z.infer<typeof sshCreateTicketRequest>
type Connection = {
  id: string; user_id: string; install_request_id: string; install_digest: string;
  display_name: string; host: string; port: number; username: string; host_key_sha256: string;
  credential_kind: 'password'; credential_revision: number; encrypted_credential: Buffer;
  enabled: boolean; revision: number
}
type Intent = {
  request_id: string; user_id: string; request_digest: string; config: unknown;
  size_bytes: number; secret_digest: string | null; token_digest: string;
  expires_at: Date; consumed_at: Date | null; result: { item: ReturnType<SshConnectionService['present']> } | null
}

const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
const fingerprint = (value: unknown) => typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(value)

function validHost(host: string): boolean {
  if (isIP(host) === 4) return true
  if (isIP(host) !== 0 || host.length > 253 || !host.includes('.')) return false
  return host.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(part))
}

function parseAllowlist(raw: string): ReadonlySet<string> {
  if (!raw.trim()) return new Set()
  const entries = raw.split(',').map(value => value.trim().toLowerCase())
  if (entries.length > 32 || entries.some(value => {
    const match = /^([^:]+):(\d{1,5})$/u.exec(value)
    return !match || !validHost(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 65_535
  })) throw new Error('Invalid SSH destination allowlist')
  return new Set(entries)
}

/** The optional key and allowlist must be configured together; neither is exposed to Host. */
export class SshConnectionService {
  private readonly key: Buffer | null
  private readonly allowed: ReadonlySet<string>

  constructor(private readonly pool: Pool, keyText: string, allowlist: string) {
    this.allowed = parseAllowlist(allowlist)
    const encoded = keyText.trim()
    if (!encoded && this.allowed.size === 0) { this.key = null; return }
    const parsed = Buffer.from(encoded, 'base64url')
    if (parsed.length !== 32 || parsed.toString('base64url') !== encoded || this.allowed.size === 0) {
      throw new Error('SSH credential key and destination allowlist must both be configured')
    }
    this.key = parsed
  }

  get available(): boolean { return this.key !== null }

  private requireAvailable(): Buffer {
    if (!this.key) throw new PlatformError(503, 'ssh_unavailable')
    return this.key
  }

  private checkDestination(host: string, port: number): void {
    if (!validHost(host) || !this.allowed.has(`${host}:${port}`)) {
      throw new PlatformError(403, 'ssh_destination_denied')
    }
  }

  private present(row: Connection) {
    return { connectionId: row.id, displayName: row.display_name, host: row.host, port: row.port,
      username: row.username, hostKeySha256: row.host_key_sha256,
      enabled: row.enabled, revision: row.revision, credentialRevision: row.credential_revision }
  }

  async list(user: Identity) {
    const rows = await this.pool.query<Connection>(
      'SELECT * FROM pe_ssh_connections WHERE user_id=$1 ORDER BY created_at DESC,id', [user.userId])
    return { available: this.available, items: rows.rows.map(row => this.present(row)) }
  }

  /** Platform-only lookup. Never expose this result through a Host or browser route. */
  async credentialForCall(user: Pick<Identity, 'userId'>, connectionId: string, revision: number) {
    const key = this.requireAvailable()
    const found = await this.pool.query<Connection>(
      `SELECT * FROM pe_ssh_connections WHERE id=$1 AND user_id=$2 AND revision=$3
       AND enabled=true`, [connectionId, user.userId, revision])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
    this.checkDestination(row.host, row.port)
    if (row.credential_kind !== 'password' || row.encrypted_credential.length < 29) {
      throw new PlatformError(503, 'ssh_credential_unavailable')
    }
    const sealed = row.encrypted_credential
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
    decipher.setAAD(Buffer.from(['power-evolve-ssh-v1', row.user_id, row.install_request_id,
      String(row.credential_revision)].join('\0')))
    decipher.setAuthTag(sealed.subarray(12, 28))
    let plain: Buffer | undefined
    try {
      plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
      if (!plain.length || !Buffer.from(plain.toString('utf8'), 'utf8').equals(plain)) {
        throw new PlatformError(503, 'ssh_credential_unavailable')
      }
      return { host: row.host, port: row.port, username: row.username,
        hostKeySha256: row.host_key_sha256, credentialRevision: row.credential_revision,
        credential: { kind: 'password' as const, password: plain.toString('utf8') } }
    } catch (_error) { throw new PlatformError(503, 'ssh_credential_unavailable') }
    finally { plain?.fill(0) }
  }

  /** Reserve a fixed-size secret upload while Host sees only its size and metadata. */
  async issueTicket(user: Identity, input: Request, platformOrigin: string) {
    this.requireAvailable()
    const host = input.host.toLowerCase()
    this.checkDestination(host, input.port)
    if (!fingerprint(input.hostKeySha256) || /\s/u.test(input.username)
      || /[\u0000-\u001f\u007f]/u.test(input.displayName + input.username)) {
      throw new PlatformError(400, 'invalid_ssh_connection')
    }
    const config = { ...input, host }
    const requestDigest = hash(JSON.stringify(config))
    return transaction(this.pool, async client => {
      const owner = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      if (!owner.rowCount) throw new PlatformError(401, 'unauthorized')
      const installed = await client.query<Connection>(
        'SELECT * FROM pe_ssh_connections WHERE install_request_id=$1', [input.requestId])
      if (installed.rows[0]) {
        const row = installed.rows[0]
        if (row.user_id !== user.userId || row.install_digest !== requestDigest) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return { state: 'ready' as const, item: this.present(row) }
      }
      const prior = await client.query<Intent>(
        'SELECT * FROM pe_ssh_upload_intents WHERE request_id=$1', [input.requestId])
      if (prior.rows[0] && (prior.rows[0].user_id !== user.userId
        || prior.rows[0].request_digest !== requestDigest)) throw new PlatformError(409, 'request_id_conflict')
      if (!prior.rows[0]) {
        const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM pe_ssh_connections WHERE user_id=$1', [user.userId])
        if (Number(count.rows[0]!.n) >= MAX_CONNECTIONS) throw new PlatformError(413, 'ssh_connection_limit')
        const pending = await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM pe_ssh_upload_intents WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>now()',
          [user.userId])
        if (Number(pending.rows[0]!.n) >= MAX_PENDING) throw new PlatformError(429, 'ssh_upload_limit')
      }
      const ticket = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + TICKET_LIFETIME_MS)
      const issued = await client.query(
        `INSERT INTO pe_ssh_upload_intents(request_id,user_id,request_digest,config,size_bytes,token_digest,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(request_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,expires_at=EXCLUDED.expires_at
         WHERE pe_ssh_upload_intents.user_id=EXCLUDED.user_id
           AND pe_ssh_upload_intents.request_digest=EXCLUDED.request_digest
           AND pe_ssh_upload_intents.consumed_at IS NULL RETURNING request_id`,
        [input.requestId, user.userId, requestDigest, config, input.sizeBytes, hash(ticket), expiresAt])
      if (!issued.rowCount) throw new PlatformError(409, 'request_id_conflict')
      return { state: 'pending' as const, ticket, uploadUrl: new URL('/ssh/upload', platformOrigin).href,
        expiresAt: expiresAt.toISOString() }
    })
  }

  /** Consume the exact credential bytes and save AES-256-GCM ciphertext bound to owner and version. */
  async upload(ticket: string, body: IncomingMessage) {
    const key = this.requireAvailable()
    const tokenDigest = hash(ticket)
    const found = await this.pool.query<Intent>(
      'SELECT * FROM pe_ssh_upload_intents WHERE token_digest=$1', [tokenDigest])
    const intent = found.rows[0]
    if (!intent || intent.expires_at.getTime() < Date.now()) throw new PlatformError(401, 'invalid_ssh_ticket')
    const chunks: Buffer[] = []
    let plain: Buffer | undefined
    try {
      let size = 0
      for await (const value of body) {
        const chunk = Buffer.from(value as Buffer)
        chunks.push(chunk)
        size += chunk.length
        if (size > 8192 || size > intent.size_bytes) throw new PlatformError(413, 'ssh_credential_too_large')
      }
      plain = Buffer.concat(chunks)
      if (plain.length !== intent.size_bytes || !Buffer.from(plain.toString('utf8'), 'utf8').equals(plain)) {
        throw new PlatformError(400, 'ssh_credential_mismatch')
      }
      // A keyed digest prevents an offline password guess from a DB-only snapshot.
      const secretDigest = createHmac('sha256', key).update(plain).digest('hex')
      const config = sshCreateTicketRequest.parse(intent.config)
      this.checkDestination(config.host, config.port)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(['power-evolve-ssh-v1', intent.user_id, intent.request_id, '1'].join('\0')))
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
      return transaction(this.pool, async client => {
        await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [intent.user_id])
        const current = await client.query<Intent>(
          'SELECT * FROM pe_ssh_upload_intents WHERE request_id=$1 FOR UPDATE', [intent.request_id])
        const row = current.rows[0]
        if (!row || row.token_digest !== tokenDigest || row.expires_at.getTime() < Date.now()) {
          throw new PlatformError(401, 'invalid_ssh_ticket')
        }
        if (row.consumed_at) {
          if (row.secret_digest !== secretDigest) throw new PlatformError(409, 'ssh_credential_conflict')
          if (!row.result) throw new PlatformError(503, 'ssh_upload_unavailable')
          return row.result
        }
        const created = await client.query<Connection>(
          `INSERT INTO pe_ssh_connections(id,user_id,install_request_id,install_digest,display_name,host,port,
           username,host_key_sha256,credential_kind,encrypted_credential,enabled)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'password',$10,$11) RETURNING *`,
          [intent.request_id, intent.user_id, intent.request_id, intent.request_digest,
            config.displayName, config.host, config.port, config.username, config.hostKeySha256,
            sealed, config.enabled])
        const result = { item: this.present(created.rows[0]!) }
        await client.query('UPDATE pe_ssh_upload_intents SET consumed_at=now(),secret_digest=$2,result=$3 WHERE request_id=$1',
          [intent.request_id, secretDigest, result])
        return result
      })
    } finally {
      plain?.fill(0)
      for (const chunk of chunks) chunk.fill(0)
    }
  }

  /** Revisioned enablement is scoped to the verified user and stable request ID. */
  async toggle(user: Identity, connectionId: string, requestId: string, baseRevision: number, enabled: boolean) {
    if (enabled) this.requireAvailable()
    const requestDigest = hash(JSON.stringify({ connectionId, baseRevision, enabled }))
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const prior = await client.query<{ request_digest: string; result: ReturnType<SshConnectionService['present']> }>(
        'SELECT request_digest,result FROM pe_ssh_updates WHERE user_id=$1 AND request_id=$2', [user.userId, requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== requestDigest) throw new PlatformError(409, 'request_id_conflict')
        return prior.rows[0].result
      }
      const current = await client.query<Connection>(
        'SELECT * FROM pe_ssh_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [connectionId, user.userId])
      const row = current.rows[0]
      if (!row) throw new PlatformError(404, 'ssh_connection_not_found')
      if (row.revision !== baseRevision) throw new PlatformError(409, 'revision_conflict')
      this.checkDestination(row.host, row.port)
      const updated = await client.query<Connection>(
        'UPDATE pe_ssh_connections SET enabled=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *',
        [connectionId, user.userId, enabled])
      const result = this.present(updated.rows[0]!)
      await client.query('INSERT INTO pe_ssh_updates(user_id,request_id,connection_id,request_digest,result) VALUES($1,$2,$3,$4,$5)',
        [user.userId, requestId, connectionId, requestDigest, result])
      return result
    })
  }
}
