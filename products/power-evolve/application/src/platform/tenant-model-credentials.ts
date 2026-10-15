/** Platform-only model keys, one-use browser intake, and cross-process native provider credential refresh. */
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { catalogProviderIds, type PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { modelCredentialReference, modelCredentialTicketRequest, modelCredentialReceipt, modelDiscoveryDraft,
  modelDiscovered, type ModelSettingsLimits } from '@power-evolve/contracts/model-settings'
import { userId as userIdSchema, PlatformError, type UserId } from '../contracts.ts'
import { assertActiveAccount, assertProductLoginAllowed, lockAccountAuthorities, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { mcpCanonicalJson, sealCredentialBytes } from './mcp-credentials.ts'

type NativeAuth = PiAiAdapterOptions['auth']
type NativeCredential = Awaited<ReturnType<NativeAuth['credentials']['read']>>
const credential = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), key: z.string().optional(), env: z.record(z.string(), z.string()).optional() }).strict(),
  z.object({ type: z.literal('oauth'), refresh: z.string(), access: z.string(), expires: z.number() }).catchall(z.json()),
]).transform((value): Exclude<NativeCredential, undefined> => value.type === 'api_key' ? { type: 'api_key',
  ...value.key === undefined ? {} : { key: value.key }, ...value.env === undefined ? {} : { env: value.env } } : value)
const sealedRow = z.object({ version_id: z.uuid(), sealed: z.instanceof(Buffer) })
const ticketRow = z.object({ reference: modelCredentialReference, size_bytes: z.number().int().positive(),
  consumed_at: z.date().nullable(), body_digest: z.string().nullable(), discovery: modelDiscoveryDraft.nullable(),
  result: modelCredentialReceipt.nullable() })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const keyBytes = z.string().min(1).regex(/^[\x21-\x7e]+$/u)

/** Native provider credentials never resolve from the Platform's ambient environment or filesystem. */
export class TenantModelCredentials {
  private readonly key: Buffer
  constructor(private readonly pool: Pool, encodedKey: string, private readonly limits: ModelSettingsLimits) {
    const key = Buffer.from(encodedKey.trim(), 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== encodedKey.trim()) throw new Error('Invalid tenant model credential key')
    this.key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'power-evolve-tenant-model-credentials-v1', 32))
  }
  private aad(userId: UserId, kind: 'reference' | 'record', name: string, version: string): Buffer {
    return Buffer.from(mcpCanonicalJson({ domain: 'tenant-model-v1', userId, kind, name, version }))
  }
  private seal(userId: UserId, kind: 'reference' | 'record', name: string, version: string, value: unknown): Buffer {
    const bytes = Buffer.from(mcpCanonicalJson(value))
    try { return sealCredentialBytes(this.key, this.aad(userId, kind, name, version), bytes) }
    finally { bytes.fill(0) }
  }
  private open(userId: UserId, kind: 'reference' | 'record', name: string, value: unknown): unknown {
    const row = sealedRow.parse(value)
    let clear: Buffer | undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.sealed.subarray(0, 12))
      decipher.setAAD(this.aad(userId, kind, name, row.version_id))
      decipher.setAuthTag(row.sealed.subarray(12, 28))
      clear = Buffer.concat([decipher.update(row.sealed.subarray(28)), decipher.final()])
      if (!Buffer.from(clear.toString('utf8')).equals(clear)) throw new Error('Invalid model credential encoding')
      return JSON.parse(clear.toString('utf8'))
    } catch (_invalidCredential) { throw new PlatformError(503, 'model_credential_unavailable') }
    finally { clear?.fill(0) }
  }
  /** Read public presence facts under the original account credential.
   * @param token Current Agent browser credential.
   * @param refs Credential names requested by the native Models page.
   * @returns Presence and writability only.
   */
  async describe(token: string, refs: readonly string[]) {
    const input = z.array(modelCredentialReference).max(this.limits.maxCredentialReferences + catalogProviderIds().length + 1).parse(refs)
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token)
      const rows = await client.query<{ reference: string }>('SELECT reference FROM pe_tenant_model_credentials WHERE user_id=$1 AND reference=ANY($2::text[])',
        [owner.userId, input])
      const configured = new Set(rows.rows.map(row => row.reference))
      return Object.fromEntries(input.map(ref => [ref, { configured: configured.has(ref), writable: true,
        ...configured.has(ref) ? { source: 'user' } : {} }]))
    })
  }
  /** Mint a bounded direct-upload ticket; no key is accepted by this metadata method.
   * @param token Current browser Agent credential.
   * @param value Original request identity, reference and byte count.
   * @param origin Configured trusted Platform public origin.
   * @returns A one-use intake bearer bound to this owner and request.
   */
  async ticket(token: string, value: unknown, origin: string) {
    const input = modelCredentialTicketRequest.parse(value)
    if (input.sizeBytes > this.limits.maxCredentialBytes) throw new PlatformError(413, 'model_credential_too_large')
    const destination = new URL('/model-credentials/upload', origin)
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
      throw new PlatformError(503, 'model_credential_origin_invalid')
    }
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token, { lock: 'update' })
      const prior = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_tenant_model_credential_tickets
        WHERE user_id=$1 AND request_id=$2 FOR UPDATE`, [owner.userId, input.requestId])).rows[0]
      if (prior) {
        const row = ticketRow.parse(prior)
        if (row.reference !== input.ref || row.size_bytes !== input.sizeBytes
          || mcpCanonicalJson(row.discovery) !== mcpCanonicalJson(input.discovery ?? null)) {
          throw new PlatformError(409, 'model_credential_request_conflict')
        }
      }
      const pending = (await client.query<{ count: string }>(`SELECT count(*) FROM pe_tenant_model_credential_tickets
        WHERE user_id=$1 AND request_id<>$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [owner.userId, input.requestId])).rows[0]
      if (!pending || Number(pending.count) >= this.limits.maxPendingTickets) throw new PlatformError(429, 'model_credential_ticket_limit')
      const ticket = Buffer.from(`${owner.userId}.${input.requestId}.${randomBytes(32).toString('base64url')}`).toString('base64url')
      const row = (await client.query<{ expires_at: Date }>(`INSERT INTO pe_tenant_model_credential_tickets
        (user_id,request_id,reference,size_bytes,token_digest,expires_at,discovery,credential_version)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond',$7::json,$8)
        ON CONFLICT(user_id,request_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,expires_at=EXCLUDED.expires_at,
          credential_version=EXCLUDED.credential_version
        RETURNING expires_at`, [owner.userId, input.requestId, input.ref, input.sizeBytes, digest(ticket),
        this.limits.ticketLifetimeMs, input.discovery === undefined ? null : JSON.stringify(input.discovery),
        owner.credentialVersion])).rows[0]
      if (!row) throw new PlatformError(503, 'model_credential_unavailable')
      return { requestId: input.requestId, ticket, uploadUrl: destination.href, expiresAt: row.expires_at.toISOString() }
    })
  }
  /** Reconcile only the original upload; no credential bytes or replacement action are returned.
   * @param token Current browser Agent credential.
   * @param requestId Original intake submission identity.
   * @returns Whether that original write committed.
   */
  async receipt(token: string, requestId: string) {
    const id = z.uuid().parse(requestId)
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token)
      const row = (await client.query<{ result: unknown }>(`SELECT result
        FROM pe_tenant_model_credential_tickets WHERE user_id=$1 AND request_id=$2`, [owner.userId, id])).rows[0]
      return row?.result == null ? { saved: false } : modelCredentialReceipt.parse(row.result)
    })
  }
  /** Accept key bytes directly at Platform and atomically encrypt the value with its original receipt.
   * @param ticket One-use intake bearer, never an Agent or Runtime token.
   * @param bytes Bounded UTF-8 API key; Host and runtime never handle this body.
   * @param discover Private native model-listing callback; a draft key is never stored as a credential.
   * @returns Original store outcome or native discovered models; discovery leaves saved false.
   */
  async upload(ticket: string, bytes: Uint8Array, discover?: (owner: UserId, draft: z.infer<typeof modelDiscoveryDraft>,
    key: string, client: PoolClient) => Promise<readonly LlmDiscoveredModel[]>): Promise<z.infer<typeof modelCredentialReceipt>> {
    if (bytes.byteLength > this.limits.maxCredentialBytes) throw new PlatformError(413, 'model_credential_too_large')
    const decoded = Buffer.from(ticket, 'base64url')
    const parts = decoded.toString('utf8').split('.'), owner = userIdSchema.safeParse(parts[0]), request = z.uuid().safeParse(parts[1])
    if (decoded.toString('base64url') !== ticket || parts.length !== 3 || !owner.success || !request.success || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? '')) {
      throw new PlatformError(401, 'invalid_model_credential_ticket')
    }
    const buffer = Buffer.from(bytes)
    try {
      const value = keyBytes.safeParse(buffer.toString('utf8'))
      if (!value.success || !Buffer.from(value.data).equals(buffer)) throw new PlatformError(400, 'model_credential_invalid')
      return await transaction(this.pool, async (client) => {
        const account = (await lockAccountAuthorities(client, [owner.data], 'update'))[0]
        if (!account) throw new PlatformError(401, 'invalid_model_credential_ticket')
        assertActiveAccount(account)
        assertProductLoginAllowed(account)
        const selected = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_tenant_model_credential_tickets
          WHERE user_id=$1 AND request_id=$2 AND token_digest=$3 AND expires_at>clock_timestamp() AND credential_version=$4 FOR UPDATE`,
        [owner.data, request.data, digest(ticket), account.credentialVersion])).rows[0]
        if (!selected) throw new PlatformError(401, 'invalid_model_credential_ticket')
        const row = ticketRow.parse(selected)
        const fingerprint = createHmac('sha256', this.key).update('key-upload\0').update(buffer).digest('hex')
        if (row.size_bytes !== bytes.byteLength) throw new PlatformError(400, 'model_credential_size_mismatch')
        if (row.consumed_at) {
          if (row.body_digest !== fingerprint) throw new PlatformError(409, 'model_credential_request_conflict')
          if (!row.result) throw new PlatformError(503, 'model_credential_unavailable')
          await client.query('UPDATE pe_tenant_model_credential_tickets SET token_digest=$3 WHERE user_id=$1 AND request_id=$2',
            [owner.data, request.data, digest(randomBytes(32).toString('base64url'))])
          return row.result
        }
        let result: z.infer<typeof modelCredentialReceipt>
        if (row.discovery !== null) {
          if (!discover) throw new PlatformError(503, 'model_discovery_unavailable')
          const models = z.array(modelDiscovered).parse(await discover(owner.data, row.discovery, value.data, client))
          result = { saved: false, models }
        } else {
          const count = (await client.query<{ count: string }>('SELECT count(*) FROM pe_tenant_model_credentials WHERE user_id=$1 AND reference<>$2',
            [owner.data, row.reference])).rows[0]
          if (!count || Number(count.count) >= this.limits.maxCredentialReferences) throw new PlatformError(429, 'model_credential_limit')
          const version = randomUUID(), sealed = this.seal(owner.data, 'reference', row.reference, version, value.data)
          await client.query(`INSERT INTO pe_tenant_model_credentials(user_id,reference,version_id,sealed,revision) VALUES($1,$2,$3,$4,1)
          ON CONFLICT(user_id,reference) DO UPDATE SET version_id=EXCLUDED.version_id,sealed=EXCLUDED.sealed,
          revision=pe_tenant_model_credentials.revision+1,updated_at=clock_timestamp()`, [owner.data, row.reference, version, sealed])
          result = { saved: true }
        }
        const consumed = await client.query(`UPDATE pe_tenant_model_credential_tickets SET consumed_at=clock_timestamp(),body_digest=$3,
          result=$4::json,token_digest=$5 WHERE user_id=$1 AND request_id=$2 AND expires_at>clock_timestamp() RETURNING request_id`,
        [owner.data, request.data, fingerprint, JSON.stringify(result), digest(randomBytes(32).toString('base64url'))])
        if (consumed.rowCount !== 1) throw new PlatformError(401, 'invalid_model_credential_ticket')
        return result
      })
    } finally { buffer.fill(0) }
  }
  /** Remove only the caller's named key, leaving other tenants and references intact.
   * @param token Current browser Agent credential.
   * @param ref Exact credential reference.
   */
  async unset(token: string, ref: string): Promise<void> {
    const reference = modelCredentialReference.parse(ref)
    await transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token, { lock: 'update' })
      await client.query('DELETE FROM pe_tenant_model_credentials WHERE user_id=$1 AND reference=$2', [owner.userId, reference])
    })
  }
  /** Private adapter-only lookup; the caller retains its current operation/account proof.
   * @param client Original authorized Platform transaction.
   * @param userId Server-derived account identity.
   * @param ref Provider-resolved credential reference.
   * @returns A private value that must never enter a public result or log.
   */
  async resolve(client: PoolClient, userId: UserId, ref: string): Promise<string | undefined> {
    const row = (await client.query<Record<string, unknown>>('SELECT version_id,sealed FROM pe_tenant_model_credentials WHERE user_id=$1 AND reference=$2 FOR SHARE',
      [userId, modelCredentialReference.parse(ref)])).rows[0]
    return row === undefined ? undefined : keyBytes.parse(this.open(userId, 'reference', ref, row))
  }
  /** Bind native Pi-AI refresh storage to one owner and exact current-operation verifier.
   * @param userId Original server-derived operation owner.
   * @param authorize Rechecks current account, operation and lease in each storage transaction.
   * @returns Native auth injectables with no ambient filesystem/environment fallback.
   */
  nativeAuth(userId: UserId, authorize: (client: PoolClient) => Promise<void>): NativeAuth {
    const read = async (client: PoolClient, provider: string): Promise<NativeCredential> => {
      const row = (await client.query<Record<string, unknown>>('SELECT version_id,sealed FROM pe_tenant_model_credential_records WHERE user_id=$1 AND provider=$2',
        [userId, provider])).rows[0]
      return row === undefined ? undefined : credential.parse(this.open(userId, 'record', provider, row))
    }
    const locked = async <T>(provider: string, operation: (client: PoolClient) => Promise<T>): Promise<T> =>
      transaction(this.pool, async (client) => {
        await authorize(client)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['tenant-model-record', userId, provider])])
        const result = await operation(client)
        await authorize(client)
        return result
      })
    return {
      authContext: {
        env: name => transaction(this.pool, async (client) => {
          await authorize(client)
          return modelCredentialReference.safeParse(name).success ? this.resolve(client, userId, name) : undefined
        }),
        fileExists: () => Promise.resolve(false),
      },
      credentials: {
        read: provider => locked(provider, client => read(client, provider)),
        list: () => transaction(this.pool, async (client) => {
          await authorize(client)
          const rows = await client.query<{ provider: string }>('SELECT provider FROM pe_tenant_model_credential_records WHERE user_id=$1', [userId])
          const values = await Promise.all(rows.rows.map(async (row) => {
            const value = await read(client, row.provider)
            if (!value) throw new PlatformError(503, 'model_credential_unavailable')
            return { providerId: row.provider, type: value.type }
          }))
          return values
        }),
        modify: (provider, update) => locked(provider, async (client) => {
          const current = await read(client, provider), next = await update(current)
          if (next === undefined) return current
          const value = credential.parse(JSON.parse(JSON.stringify(next))), version = randomUUID()
          if (Buffer.byteLength(mcpCanonicalJson(value)) > this.limits.maxCredentialBytes) throw new PlatformError(413, 'model_credential_too_large')
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['tenant-model-record-budget', userId])])
          const count = await client.query<{ count: string }>('SELECT count(*) FROM pe_tenant_model_credential_records WHERE user_id=$1 AND provider<>$2', [userId, provider])
          if (Number(count.rows[0]?.count) >= this.limits.maxCredentialReferences) throw new PlatformError(429, 'model_credential_limit')
          await client.query(`INSERT INTO pe_tenant_model_credential_records(user_id,provider,version_id,sealed,revision) VALUES($1,$2,$3,$4,1)
            ON CONFLICT(user_id,provider) DO UPDATE SET version_id=EXCLUDED.version_id,sealed=EXCLUDED.sealed,
            revision=pe_tenant_model_credential_records.revision+1,updated_at=clock_timestamp()`,
          [userId, provider, version, this.seal(userId, 'record', provider, version, value)])
          return value
        }),
        delete: provider => locked(provider, async (client) => {
          await client.query('DELETE FROM pe_tenant_model_credential_records WHERE user_id=$1 AND provider=$2', [userId, provider])
        }),
      },
    }
  }
}
