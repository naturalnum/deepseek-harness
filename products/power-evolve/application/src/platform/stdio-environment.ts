/** Platform-only encrypted STDIO environments; Host receives names and immutable references only. */
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioEnvironmentOptions, stdioEnvironmentReceiptRequest, stdioEnvironmentTicketRequest,
  stdioEnvironmentUpload, type StdioEnvironmentOptions } from '@power-evolve/contracts/stdio-environment'
import { stdioEnvironmentRef, type StdioEnvironmentRef } from '@power-evolve/contracts/mcp-metadata'
import { stdioSavedConfigurationV2 } from '@power-evolve/contracts/stdio-management'
import { stdioDispatchV2, type StdioDispatchV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2, type StdioActionLeaseV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { accountUserId } from '../account-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'
import { assertActiveAccount, lockAccountAuthorities, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { mcpCanonicalJson, sealCredentialBytes } from './mcp-credentials.ts'
import { assertStdioActionLeaseV2 } from './stdio-v2-leases.ts'

const uuid = z.uuid()
const versionRow = z.object({ id: uuid, user_id: accountUserId, keys: stdioEnvironmentRef.shape.keys,
  sealed: z.instanceof(Buffer), connection_id: uuid.nullable(), configuration_revision: z.number().int().positive().nullable(),
  expires_at: z.date() })
const ticketRow = z.object({ user_id: accountUserId, request_id: uuid, request: stdioEnvironmentTicketRequest,
  request_digest: z.string(), expires_at: z.date(), consumed_at: z.date().nullable(), body_digest: z.string().nullable(),
  version_id: uuid.nullable() })
const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Bind an uploaded version in the same transaction as its first immutable configuration.
 * @param client Original connection mutation transaction after inserting its configuration.
 * @param userId Authenticated owner from the current Agent credential.
 * @param connectionId Original connection receiving this new revision.
 * @param revision Newly inserted configuration revision.
 * @param reference Complete masked environment reference, absent for historical configurations.
 * @returns Completion only after exact owner, names, freshness and single binding are proved.
 */
export async function bindStdioEnvironment(client: PoolClient, userId: UserId, connectionId: string,
  revision: number, reference: StdioEnvironmentRef | undefined): Promise<void> {
  if (!reference) return
  const value = stdioEnvironmentRef.parse(reference)
  const selected = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_stdio_v2_environment_versions
    WHERE id=$1 AND user_id=$2 FOR UPDATE`, [value.credentialVersion, userId])).rows[0]
  if (!selected) throw new PlatformError(404, 'stdio_environment_not_found')
  const row = versionRow.parse(selected)
  if (!isDeepStrictEqual(row.keys, value.keys) || row.connection_id !== null) {
    throw new PlatformError(409, 'stdio_environment_binding_conflict')
  }
  const changed = await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_environment_versions SET connection_id=$3,configuration_revision=$4
    WHERE id=$1 AND user_id=$2 AND connection_id IS NULL AND expires_at>clock_timestamp() RETURNING id`,
  [row.id, userId, connectionId, revision])
  if (changed.rowCount !== 1) throw new PlatformError(409, 'stdio_environment_expired')
}

/** Private worker callback input is the original complete dispatch, never a browser-supplied worker credential. */
export interface StdioEnvironmentWorkerInput {
  readonly lease: StdioActionLeaseV2
  readonly dispatch: StdioDispatchV2
}

/** Private intake and worker capability; callers must keep this service inside the Platform process. */
export class StdioEnvironmentService {
  private readonly options: StdioEnvironmentOptions
  private readonly key: Buffer
  constructor(private readonly pool: Pool, approvalKey: Uint8Array, private readonly limits: StdioLimitsV2,
    options: StdioEnvironmentOptions) {
    if (approvalKey.byteLength !== 32) throw new TypeError('stdio_environment_key_invalid')
    this.options = stdioEnvironmentOptions.parse(options)
    this.key = Buffer.from(hkdfSync('sha256', approvalKey, Buffer.alloc(0), 'power-evolve-stdio-environment-v1', 32))
  }
  private fingerprint(domain: string, value: unknown): string {
    return createHmac('sha256', this.key).update(domain + '\0').update(mcpCanonicalJson(value)).digest('hex')
  }
  private aad(userId: UserId, id: string): Buffer {
    return Buffer.from(mcpCanonicalJson({ kind: 'stdio-environment-v1', userId, id }))
  }
  private seal(userId: UserId, id: string, values: z.infer<typeof stdioEnvironmentUpload>): Buffer {
    const plaintext = Buffer.from(mcpCanonicalJson(values))
    try { return sealCredentialBytes(this.key, this.aad(userId, id), plaintext) }
    finally { plaintext.fill(0) }
  }
  private open(row: z.infer<typeof versionRow>): z.infer<typeof stdioEnvironmentUpload> {
    let plaintext: Buffer | undefined
    try {
      if (row.sealed.length < 29) throw new Error('Invalid encrypted environment')
      const cipher = createDecipheriv('aes-256-gcm', this.key, row.sealed.subarray(0, 12))
      cipher.setAAD(this.aad(row.user_id, row.id)); cipher.setAuthTag(row.sealed.subarray(12, 28))
      plaintext = Buffer.concat([cipher.update(row.sealed.subarray(28)), cipher.final()])
      if (!Buffer.from(plaintext.toString('utf8')).equals(plaintext)) throw new Error('Invalid UTF-8')
      return stdioEnvironmentUpload.parse(JSON.parse(plaintext.toString('utf8')))
    } catch (_invalidCiphertext) { throw new PlatformError(503, 'stdio_environment_unavailable') }
    finally { plaintext?.fill(0) }
  }
  private async source(client: PoolClient, userId: UserId, request: z.infer<typeof stdioEnvironmentTicketRequest>) {
    if (!request.source) return undefined
    const source = request.source
    const found = await client.query<Record<string, unknown>>(`SELECT v.* FROM pe_stdio_v2_connections c
      JOIN pe_stdio_v2_configurations f ON f.connection_id=c.id AND f.user_id=c.user_id AND f.revision=c.revision
      JOIN pe_stdio_v2_environment_versions v ON v.connection_id=c.id AND v.user_id=c.user_id AND v.configuration_revision=c.revision
      WHERE c.id=$1 AND c.user_id=$2 AND c.revision=$3 AND c.deleted_at IS NULL AND v.id=$4 FOR UPDATE OF c,v`,
    [source.connectionId, userId, source.expectedRevision, source.credentialVersion])
    if (!found.rows[0]) throw new PlatformError(409, 'stdio_environment_source_changed')
    return versionRow.parse(found.rows[0])
  }
  /** Issue a one-use direct upload capability; reissuing the same metadata invalidates its earlier token.
   * @param token Current Agent browser credential, rechecked transactionally.
   * @param value Names, retain/replace plan and exact byte count, without secret values.
   * @param platformOrigin Validated operator Platform origin.
   * @returns Private direct-upload capability and expiry; no worker or execution authority.
   */
  async issueTicket(token: string, value: unknown, platformOrigin: string) {
    const input = stdioEnvironmentTicketRequest.parse(value)
    if (input.sizeBytes > this.options.maxUploadBytes) throw new PlatformError(413, 'stdio_environment_too_large')
    const origin = new URL(platformOrigin)
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new PlatformError(400, 'stdio_environment_origin_invalid')
    }
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const digest = this.fingerprint('request', { userId, input })
      const previousRow = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_environment_tickets WHERE user_id=$1 AND request_id=$2 FOR UPDATE',
        [userId, input.requestId])).rows[0]
      const previous = previousRow ? ticketRow.parse(previousRow) : undefined
      if (previous && previous.request_digest !== digest) throw new PlatformError(409, 'stdio_environment_request_conflict')
      if (!previous?.version_id) await this.source(client, userId, input)
      const capacity = (await client.query<{ count: string }>(`SELECT count(*) AS count FROM pe_stdio_v2_environment_tickets
        WHERE user_id=$1 AND request_id<>$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [userId, input.requestId])).rows[0]
      if (!capacity || Number(capacity.count) >= this.options.maxPendingTickets) throw new PlatformError(429, 'stdio_environment_ticket_limit')
      const ticket = randomBytes(32).toString('base64url')
      const row = (await client.query<{ expires_at: Date }>(`INSERT INTO pe_stdio_v2_environment_tickets
        (user_id,request_id,request,request_digest,token_digest,expires_at)
        VALUES($1,$2,$3::json,$4,$5,clock_timestamp()+$6::double precision*interval '1 millisecond')
        ON CONFLICT(user_id,request_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,
          expires_at=EXCLUDED.expires_at,consumed_at=NULL RETURNING expires_at`,
      [userId, input.requestId, JSON.stringify(input), digest, tokenDigest(ticket), this.options.ticketLifetimeMs])).rows[0]
      if (!row) throw new PlatformError(503, 'stdio_environment_unavailable')
      return { requestId: input.requestId, ticket, uploadUrl: new URL('/stdio-environment/upload', origin).href,
        expiresAt: row.expires_at.toISOString() }
    })
  }
  /** Read only the original masked upload outcome; this does not retry or dispatch a server.
   * @param token Current owner Agent credential.
   * @param value Original upload request identity.
   * @returns The immutable environment reference, or null until an upload committed.
   */
  async receipt(token: string, value: unknown): Promise<{ environment: StdioEnvironmentRef | null }> {
    const input = stdioEnvironmentReceiptRequest.parse(value)
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent' })
      const row = (await client.query<Record<string, unknown>>(`SELECT v.id,v.keys FROM pe_stdio_v2_environment_tickets t
        JOIN pe_stdio_v2_environment_versions v ON v.id=t.version_id AND v.user_id=t.user_id
        WHERE t.user_id=$1 AND t.request_id=$2`, [userId, input.requestId])).rows[0]
      return { environment: row ? stdioEnvironmentRef.parse({ credentialVersion: row.id, keys: row.keys }) : null }
    })
  }
  /** Consume direct Platform bytes exactly once; identical fresh-ticket replay returns the original masked version.
   * @param ticket Unexpired one-use upload capability.
   * @param bytes Complete bounded UTF-8 body from the Platform's owned HTTP carrier.
   * @returns The immutable reference after ciphertext and receipt commit; raw values never enter the receipt.
   */
  async upload(ticket: string, bytes: Uint8Array): Promise<{ environment: StdioEnvironmentRef }> {
    if (bytes.byteLength > this.options.maxUploadBytes) throw new PlatformError(413, 'stdio_environment_too_large')
    const digest = tokenDigest(ticket)
    const hint = (await this.pool.query<Record<string, unknown>>('SELECT user_id FROM pe_stdio_v2_environment_tickets WHERE token_digest=$1', [digest])).rows[0]
    if (!hint) throw new PlatformError(401, 'invalid_stdio_environment_ticket')
    const buffer = Buffer.from(bytes)
    try {
      if (!Buffer.from(buffer.toString('utf8')).equals(buffer)) throw new PlatformError(400, 'stdio_environment_invalid')
      let value: z.infer<typeof stdioEnvironmentUpload>
      try { value = stdioEnvironmentUpload.parse(JSON.parse(buffer.toString('utf8'))) }
      catch (_invalidEnvelope) { throw new PlatformError(400, 'stdio_environment_invalid') }
      const bodyDigest = this.fingerprint('body', value)
      return await transaction(this.pool, async (client) => {
        const userId = accountUserId.parse(hint.user_id)
        const account = (await lockAccountAuthorities(client, [userId], 'update'))[0]
        if (!account) throw new PlatformError(401, 'invalid_stdio_environment_ticket')
        assertActiveAccount(account)
        const found = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_stdio_v2_environment_tickets
          WHERE token_digest=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
        [digest, userId])).rows[0]
        if (!found) throw new PlatformError(401, 'invalid_stdio_environment_ticket')
        const row = ticketRow.parse(found), input = row.request
        if (bytes.byteLength !== input.sizeBytes) throw new PlatformError(400, 'stdio_environment_size_mismatch')
        if (row.request_digest !== this.fingerprint('request', { userId, input })) throw new PlatformError(409, 'stdio_environment_record_invalid')
        const replaces = input.keys.filter(item => item.action === 'replace').map(item => item.name).sort()
        if (!isDeepStrictEqual(replaces, value.values.map(item => item.name).sort())) throw new PlatformError(400, 'stdio_environment_plan_mismatch')
        let environment: StdioEnvironmentRef
        if (row.version_id !== null) {
          if (row.body_digest !== bodyDigest) throw new PlatformError(409, 'stdio_environment_request_conflict')
          const original = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_environment_versions WHERE id=$1 AND user_id=$2',
            [row.version_id, userId])).rows[0]
          if (!original) throw new PlatformError(503, 'stdio_environment_unavailable')
          const version = versionRow.parse(original)
          environment = stdioEnvironmentRef.parse({ credentialVersion: version.id, keys: version.keys })
        } else {
          const source = await this.source(client, userId, input)
          const retained = new Map(source ? this.open(source).values.map(item => [item.name, item.value]) : [])
          const supplied = new Map(value.values.map(item => [item.name, item.value]))
          const values = input.keys.map((item) => {
            const secret = (item.action === 'replace' ? supplied : retained).get(item.name)
            if (secret === undefined) throw new PlatformError(400, 'stdio_environment_value_required')
            return { name: item.name, value: secret }
          }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
          const capacity = (await client.query<{ count: string }>(
            'SELECT count(*) AS count FROM pe_stdio_v2_environment_versions WHERE user_id=$1', [userId])).rows[0]
          if (!capacity || Number(capacity.count) >= this.options.maxVersionsPerUser) throw new PlatformError(429, 'stdio_environment_version_limit')
          const id = randomUUID(), keys = values.map(item => item.name)
          await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_environment_versions(id,user_id,keys,sealed,expires_at)
            VALUES($1,$2,$3::json,$4,clock_timestamp()+$5::double precision*interval '1 millisecond')`,
          [id, userId, JSON.stringify(keys), this.seal(userId, id, { formatVersion: 1, values }), this.options.ticketLifetimeMs])
          environment = stdioEnvironmentRef.parse({ credentialVersion: id, keys })
          await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_environment_tickets SET version_id=$3,body_digest=$4
            WHERE user_id=$1 AND request_id=$2`, [userId, row.request_id, id, bodyDigest])
        }
        const consumed = await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_environment_tickets SET consumed_at=clock_timestamp()
          WHERE token_digest=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING request_id`, [digest, userId])
        if (consumed.rowCount !== 1) throw new PlatformError(401, 'invalid_stdio_environment_ticket')
        return { environment }
      })
    } finally { buffer.fill(0) }
  }

  /** Deliver values once to the Platform's original post-permit worker, never to a Host or browser endpoint.
   * @param input Current worker lease and the exact committed dispatch returned by the once authorization.
   * @param signal Original worker lifetime; an abort cannot publish values to a replacement execution.
   * @returns In-memory environment overrides after original account, task, permit, lease and version checks commit.
   */
  async readForWorker(input: StdioEnvironmentWorkerInput, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
    signal.throwIfAborted()
    const lease = stdioActionLeaseV2.parse(input.lease), dispatch = stdioDispatchV2(this.limits).parse(input.dispatch)
    if (dispatch.task.actionId !== lease.actionId) {
      throw new PlatformError(409, 'stdio_environment_identity_changed')
    }
    const hint = (await this.pool.query<Record<string, unknown>>('SELECT user_id FROM pe_stdio_v2_actions WHERE id=$1', [lease.actionId])).rows[0]
    if (!hint) throw new PlatformError(404, 'stdio_v2_action_not_found')
    return transaction(this.pool, async (client) => {
      const userId = accountUserId.parse(hint.user_id)
      const account = (await lockAccountAuthorities(client, [userId], 'update'))[0]
      if (!account) throw new PlatformError(409, 'stdio_environment_authority_lost')
      assertActiveAccount(account)
      const task = dispatch.task
      const session = await client.query<Record<string, unknown>>('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [task.sessionId, userId])
      const connection = await client.query<Record<string, unknown>>(`SELECT id FROM pe_stdio_v2_connections
        WHERE id=$1 AND user_id=$2 AND revision=$3 AND deleted_at IS NULL AND ($4::text='discover' OR enabled) FOR UPDATE`,
      [task.connectionId, userId, task.configRevision, task.phase])
      const action = await client.query<Record<string, unknown>>(`SELECT id FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 AND session_id=$3
        AND connection_id=$4 AND config_revision=$5 AND config_digest=$6 AND task_digest=$7 AND execution_id=$8
        AND execution_target='cloud' AND NOT cancel_requested AND state IN ('dispatch-intent','running') FOR UPDATE`,
      [lease.actionId, userId, task.sessionId, task.connectionId, task.configRevision, task.configDigest,
        dispatch.taskDigest, dispatch.executionRef.executionId])
      const execution = await client.query<Record<string, unknown>>(`SELECT id FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 AND session_id=$3
        AND execution_kind='stdio_v2' AND stdio_action_id=$4 AND execution_target='cloud' AND NOT cancel_requested
        AND lease_owner=$5 AND lease_until>clock_timestamp() AND state IN ('queued','starting','running') FOR UPDATE`,
      [dispatch.executionRef.executionId, userId, task.sessionId, lease.actionId, lease.workerId])
      if ([session, connection, action, execution].some(result => result.rowCount !== 1)) throw new PlatformError(409, 'stdio_environment_authority_lost')
      await assertStdioActionLeaseV2(client, lease)
      const permit = (await client.query<Record<string, unknown>>(`SELECT permit FROM pe_stdio_v2_start_permits WHERE action_id=$1 AND permit_id=$2
        AND execution_id=$3 AND decision='once' AND expires_at>clock_timestamp()`,
      [lease.actionId, dispatch.permit.permitId, dispatch.executionRef.executionId])).rows[0]
      const storedDispatch = (await client.query<Record<string, unknown>>('SELECT dispatch,dispatch_digest FROM pe_stdio_v2_dispatches WHERE action_id=$1', [lease.actionId])).rows[0]
      const budget = { maxDepth: this.limits.maxJsonDepth, maxNodes: this.limits.maxJsonNodes, maxBytes: this.limits.maxInputBytes }
      if (!permit || !isDeepStrictEqual(permit.permit, dispatch.permit) || !storedDispatch
        || !isDeepStrictEqual(storedDispatch.dispatch, dispatch)
        || storedDispatch.dispatch_digest !== stdioSha256V2('dispatch', dispatch, budget)) {
        throw new PlatformError(409, 'stdio_environment_permit_changed')
      }
      const config = (await client.query<Record<string, unknown>>(`SELECT configuration,config_digest FROM pe_stdio_v2_configurations
        WHERE connection_id=$1 AND user_id=$2 AND revision=$3`, [task.connectionId, userId, task.configRevision])).rows[0]
      if (!config) throw new PlatformError(409, 'stdio_environment_configuration_changed')
      const configuration = stdioSavedConfigurationV2.parse(config.configuration)
      if (config.config_digest !== task.configDigest || stdioSha256V2('configuration', configuration, budget) !== task.configDigest
        || !isDeepStrictEqual(configuration.invocation, task.invocation)) throw new PlatformError(409, 'stdio_environment_configuration_changed')
      const reference = configuration.environment
      if (!reference) { signal.throwIfAborted(); return {} }
      const selected = (await client.query<Record<string, unknown>>(`SELECT * FROM pe_stdio_v2_environment_versions WHERE id=$1 AND user_id=$2
        AND connection_id=$3 AND configuration_revision=$4`, [reference.credentialVersion, userId, task.connectionId, task.configRevision])).rows[0]
      if (!selected) throw new PlatformError(409, 'stdio_environment_binding_changed')
      const version = versionRow.parse(selected)
      if (!isDeepStrictEqual(version.keys, reference.keys)) throw new PlatformError(409, 'stdio_environment_binding_changed')
      const values = this.open(version)
      if (!isDeepStrictEqual(values.values.map(item => item.name), reference.keys)) throw new PlatformError(409, 'stdio_environment_binding_changed')
      await assertStdioActionLeaseV2(client, lease)
      signal.throwIfAborted()
      const delivered = await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_environment_deliveries
        (action_id,user_id,version_id,permit_id,worker_id,lease_epoch,execution_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(action_id) DO NOTHING RETURNING action_id`, [lease.actionId, userId, reference.credentialVersion,
        dispatch.permit.permitId, lease.workerId, lease.leaseEpoch, dispatch.executionRef.executionId])
      if (delivered.rowCount !== 1) throw new PlatformError(409, 'stdio_environment_already_delivered')
      await assertStdioActionLeaseV2(client, lease)
      signal.throwIfAborted()
      return Object.freeze(Object.fromEntries(values.values.map(item => [item.name, item.value])))
    })
  }
}
