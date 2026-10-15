/** Owner-scoped STDIO v2 configuration management; cancellation never releases an executor's writer. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioCatalogV2, stdioCheckRequestV2, stdioDigestV2, stdioExecutorImageV2, stdioJsonV2,
  stdioLimitsV2, stdioReceiptRequestV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementLimitsV2, stdioManagementSchemasV2, type StdioConfigurationV2,
  type StdioConnectionListV2, type StdioCreateRequestV2, type StdioDeleteRequestV2,
  type StdioListRequestV2, type StdioManagementLimitsV2, type StdioManagementReceiptV2,
  type StdioMutationReceiptV2, type StdioToggleRequestV2, type StdioUpdateRequestV2 } from '@power-evolve/contracts/stdio-management'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { PlatformError, type UserId } from '../contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { bindStdioEnvironment } from './stdio-environment.ts'
import { transaction } from './database.ts'

type Mutation = { purpose: 'create'; input: StdioCreateRequestV2 }
  | { purpose: 'update'; input: StdioUpdateRequestV2 }
  | { purpose: 'toggle'; input: StdioToggleRequestV2 }
  | { purpose: 'delete'; input: StdioDeleteRequestV2 }
type RequestRow = { purpose: unknown; request: unknown; request_digest: unknown; receipt: unknown }
type ConnectionRow = { id: unknown
  revision: unknown
  enabled: unknown
  configuration: unknown
  config_digest: unknown
  current_catalog_id: unknown
  catalog_digest: unknown
  created_at: unknown
  updated_at: unknown }
const rowState = z.object({ revision: z.number().int().positive().max(2_147_483_647), enabled: z.boolean() })
const purposeValue = z.enum(['create', 'update', 'toggle', 'delete', 'check'])
const columns = `c.id,c.revision,c.enabled,c.current_catalog_id,c.created_at,c.updated_at,
  f.configuration,f.config_digest,k.catalog_digest`
const joins = `LEFT JOIN pe_stdio_v2_configurations f ON f.connection_id=c.id AND f.user_id=c.user_id AND f.revision=c.revision
  LEFT JOIN pe_stdio_v2_catalogs k ON k.id=c.current_catalog_id AND k.user_id=c.user_id
    AND k.connection_id=c.id AND k.config_revision=c.revision AND k.config_digest=f.config_digest`

/** Every method derives its owner from an agent bearer rechecked under the account's update lock. */
export class StdioConnectionServiceV2 {
  private readonly limits: StdioLimitsV2
  private readonly management: StdioManagementLimitsV2
  private readonly schemas: ReturnType<typeof stdioManagementSchemasV2>

  constructor(private readonly pool: Pool, limits: StdioLimitsV2, management: StdioManagementLimitsV2) {
    this.limits = stdioLimitsV2.parse(limits)
    this.management = stdioManagementLimitsV2.parse(management)
    this.schemas = stdioManagementSchemasV2(this.limits, this.management)
  }

  private get jsonLimits() {
    return { maxDepth: this.limits.maxJsonDepth, maxNodes: this.limits.maxJsonNodes, maxBytes: this.limits.maxInputBytes }
  }

  private stored<T>(parse: () => T): T {
    try { return parse() }
    catch (_invalidRecord) { throw new PlatformError(409, 'stdio_v2_record_invalid') }
  }

  private request(row: RequestRow): StdioManagementReceiptV2 {
    return this.stored(() => {
      const purpose = purposeValue.parse(row.purpose)
      const input = purpose === 'create' ? this.schemas.create.parse(row.request)
        : purpose === 'update' ? this.schemas.update.parse(row.request)
          : purpose === 'toggle' ? this.schemas.toggle.parse(row.request)
            : purpose === 'delete' ? this.schemas.remove.parse(row.request) : stdioCheckRequestV2.parse(row.request)
      if (stdioDigestV2.parse(row.request_digest) !== stdioSha256V2('management', { purpose, input }, this.jsonLimits)) {
        throw new Error('Stored request digest mismatch')
      }
      const receipt = this.schemas.receipt.parse(stdioJsonV2(this.jsonLimits).parse(row.receipt))
      if (receipt.purpose !== purpose || receipt.requestId !== input.requestId
        || 'connectionId' in input && receipt.connectionId !== input.connectionId
        || receipt.revision !== (purpose === 'create' ? 1 : 'expectedRevision' in input
          ? input.expectedRevision + (purpose === 'update' ? 1 : 0) : 0)
        || receipt.purpose !== 'check' && (receipt.deleted !== (purpose === 'delete')
          || receipt.enabled !== (purpose === 'toggle' && 'enabled' in input && input.enabled))) {
        throw new Error('Stored receipt binding mismatch')
      }
      return receipt
    })
  }

  private async requestRow(client: PoolClient, userId: UserId, requestId: string): Promise<RequestRow | undefined> {
    return (await client.query<RequestRow>(`SELECT purpose,request,request_digest,receipt
      FROM pe_stdio_v2_management_requests WHERE user_id=$1 AND request_id=$2`, [userId, requestId])).rows[0]
  }

  private configuration(row: ConnectionRow): StdioConfigurationV2 {
    return this.stored(() => {
      const configuration = this.schemas.configuration.parse(row.configuration)
      if (stdioDigestV2.parse(row.config_digest) !== stdioSha256V2('configuration', configuration, this.jsonLimits)) {
        throw new Error('Stored configuration digest mismatch')
      }
      return configuration
    })
  }

  private view(row: ConnectionRow) {
    return this.stored(() => {
      const configuration = this.configuration(row)
      const catalogId = this.schemas.connection.shape.catalogId.parse(row.current_catalog_id)
      const catalogDigest = this.schemas.connection.shape.catalogDigest.parse(row.catalog_digest)
      if ((catalogId === null) !== (catalogDigest === null)) throw new Error('Stored catalog binding mismatch')
      return this.schemas.connection.parse({ connectionId: row.id, revision: row.revision, enabled: row.enabled, configuration,
        catalogId, catalogDigest, createdAt: z.date().parse(row.created_at).toISOString(),
        updatedAt: z.date().parse(row.updated_at).toISOString() })
    })
  }

  private async current(client: PoolClient, userId: UserId, connectionId: string, expectedRevision: number): Promise<ConnectionRow> {
    const row = (await client.query<ConnectionRow>(`SELECT ${columns} FROM pe_stdio_v2_connections c ${joins}
      WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL FOR UPDATE OF c`, [connectionId, userId])).rows[0]
    if (!row) throw new PlatformError(404, 'stdio_v2_connection_not_found')
    const state = this.stored(() => rowState.parse(row))
    this.view(row)
    if (state.revision !== expectedRevision) throw new PlatformError(409, 'stdio_v2_revision_conflict')
    return row
  }

  private async writeConfiguration(client: PoolClient, userId: UserId, connectionId: string, revision: number,
    configuration: StdioConfigurationV2): Promise<void> {
    await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_configurations(connection_id,user_id,revision,configuration,config_digest)
      VALUES($1,$2,$3,$4::json,$5)`, [connectionId, userId, revision, JSON.stringify(configuration),
      stdioSha256V2('configuration', configuration, this.jsonLimits)])
    await bindStdioEnvironment(client, userId, connectionId, revision, configuration.environment)
  }

  private async cancel(client: PoolClient, userId: UserId, connectionId: string, callsOnly = false): Promise<void> {
    await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_actions SET cancel_requested=true,updated_at=clock_timestamp()
      WHERE user_id=$1 AND connection_id=$2 AND (NOT $3::boolean OR phase='call')
        AND state IN ('queued','preparing','pending','approved','dispatch-intent','running','stopping','blocked')`,
    [userId, connectionId, callsOnly])
  }

  private async catalog(client: PoolClient, userId: UserId, row: ConnectionRow): Promise<void> {
    if (!row.current_catalog_id) throw new PlatformError(409, 'stdio_v2_catalog_required')
    const found = (await client.query<{ raw_catalog: unknown
      image_expectation: unknown
      catalog_digest: unknown
      result: unknown
      result_digest: unknown }>(`SELECT k.raw_catalog,k.image_expectation,k.catalog_digest,r.result,r.result_digest
      FROM pe_stdio_v2_catalogs k JOIN pe_stdio_v2_actions a ON a.id=k.action_id AND a.user_id=k.user_id
        AND a.connection_id=k.connection_id AND a.config_revision=k.config_revision AND a.config_digest=k.config_digest
        AND a.session_id=k.session_id AND a.phase=k.phase
      JOIN pe_stdio_v2_results r ON r.action_id=a.id
      WHERE k.id=$1 AND k.user_id=$2 AND k.connection_id=$3 AND k.config_revision=$4 AND k.config_digest=$5
        AND a.phase='discover' AND a.state='succeeded' AND NOT a.cancel_requested`,
    [row.current_catalog_id, userId, row.id, row.revision, row.config_digest])).rows[0]
    if (!found) throw new PlatformError(409, 'stdio_v2_catalog_required')
    this.stored(() => {
      const raw = stdioCatalogV2(this.limits).parse(found.raw_catalog)
      stdioExecutorImageV2.parse(found.image_expectation)
      if (stdioDigestV2.parse(found.catalog_digest) !== stdioCatalogFingerprintV2(raw, this.limits)
        || stdioDigestV2.parse(found.result_digest) !== stdioSha256V2('result', found.result, this.jsonLimits)) {
        throw new Error('Stored catalog or result digest mismatch')
      }
    })
  }

  private async mutate(token: string, proposed: Mutation): Promise<StdioMutationReceiptV2> {
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const mutation: Mutation = proposed.purpose === 'create' ? { purpose: 'create', input: this.schemas.create.parse(proposed.input) }
        : proposed.purpose === 'update' ? { purpose: 'update', input: this.schemas.update.parse(proposed.input) }
          : proposed.purpose === 'toggle' ? { purpose: 'toggle', input: this.schemas.toggle.parse(proposed.input) }
            : { purpose: 'delete', input: this.schemas.remove.parse(proposed.input) }
      const { purpose, input } = mutation
      const hashed = stdioSha256V2('management', { purpose, input }, this.jsonLimits)
      const prior = await this.requestRow(client, userId, input.requestId)
      if (prior) {
        const receipt = this.request(prior)
        if (prior.purpose !== purpose || prior.request_digest !== hashed) throw new PlatformError(409, 'stdio_v2_request_conflict')
        return this.schemas.mutationReceipt.parse(receipt)
      }
      let receipt: StdioMutationReceiptV2
      if (mutation.purpose === 'create') {
        const capacity = (await client.query<{ full: boolean }>(`SELECT count(*) >= $2::bigint AS full
          FROM pe_stdio_v2_connections WHERE user_id=$1 AND deleted_at IS NULL`, [userId, this.management.maxConnections])).rows[0]
        if (this.stored(() => z.boolean().parse(capacity?.full))) throw new PlatformError(409, 'stdio_v2_connection_limit')
        const connectionId = this.schemas.connection.shape.connectionId.parse(randomUUID())
        await client.query<Record<string, unknown>>('INSERT INTO pe_stdio_v2_connections(id,user_id,revision,enabled) VALUES($1,$2,1,false)', [connectionId, userId])
        await this.writeConfiguration(client, userId, connectionId, 1, mutation.input.configuration)
        receipt = this.schemas.mutationReceipt.parse({ requestId: input.requestId,
          purpose, connectionId, revision: 1, enabled: false, deleted: false })
      } else {
        const row = await this.current(client, userId, mutation.input.connectionId, mutation.input.expectedRevision)
        const state = this.stored(() => rowState.parse(row))
        let revision = state.revision, enabled = state.enabled
        if (mutation.purpose === 'update') {
          if (revision === 2_147_483_647) throw new PlatformError(409, 'stdio_v2_revision_conflict')
          revision++; enabled = false
          await this.writeConfiguration(client, userId, mutation.input.connectionId, revision, mutation.input.configuration)
          await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_connections SET revision=$3,enabled=false,current_catalog_id=NULL,updated_at=clock_timestamp()
            WHERE id=$1 AND user_id=$2`, [row.id, userId, revision])
          await this.cancel(client, userId, mutation.input.connectionId)
        } else if (mutation.purpose === 'toggle') {
          enabled = mutation.input.enabled
          if (enabled) await this.catalog(client, userId, row)
          await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_connections SET enabled=$3,updated_at=clock_timestamp()
            WHERE id=$1 AND user_id=$2`, [row.id, userId, enabled])
          if (!enabled) await this.cancel(client, userId, mutation.input.connectionId, true)
        } else {
          enabled = false
          await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_connections SET deleted_at=clock_timestamp(),enabled=false,current_catalog_id=NULL,
            updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2`, [row.id, userId])
          await this.cancel(client, userId, mutation.input.connectionId)
        }
        receipt = this.schemas.mutationReceipt.parse({ requestId: input.requestId, purpose,
          connectionId: mutation.input.connectionId, revision, enabled, deleted: mutation.purpose === 'delete' })
      }
      await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
        VALUES($1,$2,$3,$4::json,$5,$6::json)`, [userId, input.requestId, purpose, JSON.stringify(input), hashed, JSON.stringify(receipt)])
      return receipt
    })
  }

  /** Create a disabled revision-one connection without starting discovery.
   * @param token Current agent bearer.
   * @param input Complete literal configuration and immutable request ID.
   * @returns Original mutation receipt, including on an exact retry.
   */
  async create(token: string, input: StdioCreateRequestV2): Promise<StdioMutationReceiptV2> {
    return this.mutate(token, { purpose: 'create', input })
  }

  /** Replace configuration while retaining historical revisions and requesting writer cancellation.
   * @param token Current agent bearer.
   * @param input Original request identity, expected revision and full replacement configuration.
   * @returns Disabled new revision or the original retry receipt.
   */
  async update(token: string, input: StdioUpdateRequestV2): Promise<StdioMutationReceiptV2> {
    return this.mutate(token, { purpose: 'update', input })
  }

  /** Change enabled state; enabling requires a successful immutable catalog for the current revision.
   * @param token Current agent bearer.
   * @param input Request identity, expected revision and requested enabled state.
   * @returns Original toggle receipt without changing configuration revision.
   */
  async toggle(token: string, input: StdioToggleRequestV2): Promise<StdioMutationReceiptV2> {
    return this.mutate(token, { purpose: 'toggle', input })
  }

  /** Soft-delete a connection and request cancellation without releasing any writer.
   * @param token Current agent bearer.
   * @param input Immutable request identity and expected current revision.
   * @returns Original deletion receipt; all configuration and execution history remains.
   */
  async remove(token: string, input: StdioDeleteRequestV2): Promise<StdioMutationReceiptV2> {
    return this.mutate(token, { purpose: 'delete', input })
  }

  /** List owned live connections in UUID order under the configured page limit.
   * @param token Current agent bearer.
   * @param input Optional exclusive UUID cursor.
   * @returns Validated configurations and the last returned UUID when another page exists.
   */
  async list(token: string, input: StdioListRequestV2): Promise<StdioConnectionListV2> {
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const parsed = this.schemas.listRequest.parse(input)
      const rows = (await client.query<ConnectionRow>(`SELECT ${columns} FROM pe_stdio_v2_connections c ${joins}
        WHERE c.user_id=$1 AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR c.id>$2) ORDER BY c.id LIMIT $3::bigint+1`,
      [userId, parsed.after ?? null, this.management.pageItems])).rows
      const items = rows.slice(0, this.management.pageItems).map(row => this.view(row))
      let next: string | null = null
      if (rows.length > this.management.pageItems) {
        const tail = items.at(-1)
        if (!tail) throw new PlatformError(409, 'stdio_v2_record_invalid')
        next = tail.connectionId
      }
      return this.schemas.list.parse({ items, next })
    })
  }

  /** Recover an owned mutation or discovery receipt without creating another action.
   * @param token Current agent bearer, rechecked even when the original request previously succeeded.
   * @param input The original management request ID.
   * @returns Original parsed receipt after its complete request digest and binding are checked.
   */
  async receipt(token: string, input: z.infer<typeof stdioReceiptRequestV2>): Promise<StdioManagementReceiptV2> {
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const parsed = stdioReceiptRequestV2.parse(input)
      const row = await this.requestRow(client, userId, parsed.requestId)
      if (!row) throw new PlatformError(404, 'stdio_v2_request_not_found')
      const receipt = this.request(row)
      if (receipt.requestId !== parsed.requestId) throw new PlatformError(409, 'stdio_v2_record_invalid')
      return receipt
    })
  }
}
