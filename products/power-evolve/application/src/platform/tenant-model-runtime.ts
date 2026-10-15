/** Native adapter execution with the existing operation, tool-catalog and Platform egress authority. */
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { adapterFailureChunk, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolHistoryProjection } from '@deepseek-ai/dsh-session'
import { stdioJsonV2 } from '@power-evolve/contracts/stdio-mcp'
import { bearer, readJson } from '../http.ts'
import { PlatformError, settings, userId } from '../contracts.ts'
import { nativeModelRequest, nativeModelResolve, nativeModelStreamChunk, nativeModelPreparationId,
  type NativePreparedModel } from '../model-runtime-contracts.ts'
import { assertModelToolDeclarations, McpToolAdmissionError, modelMessageTool } from '../mcp-model-tools.ts'
import { mcpOperationTools } from '../mcp-operation-contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { transaction } from './database.ts'
import { requireModelGrant } from './account-settings.ts'
import { readNativeModelTools } from './native-tool-catalog.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeRuntimeAuthority } from './native-runtime-authority.ts'
import { tenantModelSnapshot, type TenantModelSettings, type TenantModelAttachments } from './tenant-model-settings.ts'
import type { ModelProxyConfig } from './model.ts'

/** Existing model lifetime and byte budgets; attachments are resolved only for the original operation. */
export interface TenantModelRuntimeOptions extends Pick<ModelProxyConfig, 'timeoutMs' | 'maxRequestBytes' | 'maxResponseBytes' | 'stdioV2Admission'> {
  readonly maxHistoryEvents: number
  readonly maxHistoryBytes: number
  readonly preparation: { readonly maxPending: number; readonly lifetimeMs: number }
  readonly attachments: (token: string, signal: AbortSignal, authorize: () => Promise<void>) =>
    TenantModelAttachments & { dispose: () => Promise<void> }
}

/** The Host transports native options/chunks; all provider conversion remains in the maintained adapters. */
export class TenantModelRuntime {
  constructor(private readonly tasks: TaskStore, private readonly models: TenantModelSettings,
    private readonly authority: NativeRuntimeAuthority, private readonly options: TenantModelRuntimeOptions) {}

  /** Resolve public model capabilities for a current tenant runtime.
   * @param token Original tenant-runtime bearer.
   * @param value Native provider and model identities.
   * @returns Native resolved metadata, without configuration or credentials.
   */
  resolve(token: string, value: unknown) {
    const input = nativeModelResolve.parse(value)
    return transaction(this.tasks.pool, async (client) => {
      const owner = await this.authority.authenticateInTransaction(client, token)
      await requireModelGrant(client, owner.userId, input.model, 1, input.provider)
      const { adapter } = await this.models.adapter(client, owner.userId, input.provider, async (connection) => {
        await this.authority.authenticateInTransaction(connection, token)
      })
      return adapter.resolveModel(input.provider, input.model)
    })
  }

  /** Bind native capabilities and image pricing to the original private configuration generation.
   * @param token Original tenant-runtime bearer.
   * @param value Native provider and model identities.
   * @returns Public native metadata and an owner-bound one-use configuration identity.
   */
  prepare(token: string, value: unknown): Promise<NativePreparedModel> {
    const input = nativeModelResolve.parse(value)
    return transaction(this.tasks.pool, async (client) => {
      const owner = await this.authority.authenticateInTransaction(client, token, undefined, 'update')
      await requireModelGrant(client, owner.userId, input.model, 1, input.provider)
      await client.query(`DELETE FROM pe_tenant_model_preparations WHERE user_id=$1
        AND (expires_at<=clock_timestamp() OR consumed_at IS NOT NULL)`, [owner.userId])
      const pending = (await client.query<{ count: string }>('SELECT count(*) FROM pe_tenant_model_preparations WHERE user_id=$1', [owner.userId])).rows[0]
      if (!pending || Number(pending.count) >= this.options.preparation.maxPending) throw new PlatformError(429, 'model_preparation_limit')
      const configuration = await this.models.snapshot(client, owner.userId)
      const { adapter } = await this.models.adapter(client, owner.userId, input.provider, async (connection) => {
        await this.authority.authenticateInTransaction(connection, token)
      }, undefined, configuration)
      const native = await adapter.prepareCall(input.provider, input.model)
      const preparationId = nativeModelPreparationId.parse(randomUUID())
      await client.query(`INSERT INTO pe_tenant_model_preparations(id,user_id,provider,model_id,configuration,credential_version,expires_at)
        SELECT $1,$2,$3,$4,$5::json,credential_version,clock_timestamp()+$6*interval '1 millisecond' FROM pe_users WHERE id=$2`,
      [preparationId, owner.userId, input.provider, input.model, JSON.stringify(configuration), this.options.preparation.lifetimeMs])
      return { preparationId, model: native.model,
        imagePricing: await this.models.imagePricing(client, owner.userId, input.provider, input.model, configuration) }
    })
  }

  /** Return only model catalog facts needed by the native synchronous image pricing helper.
   * @param token Original tenant-runtime bearer.
   * @param value Native route and model identities.
   * @returns Pricing kind and public catalog entry; no endpoint or authentication fields.
   */
  imagePricing(token: string, value: unknown) {
    const input = nativeModelResolve.parse(value)
    return transaction(this.tasks.pool, async (client) => {
      const owner = await this.authority.authenticateInTransaction(client, token)
      await requireModelGrant(client, owner.userId, input.model, 1, input.provider)
      return this.models.imagePricing(client, owner.userId, input.provider, input.model)
    })
  }

  private async admit(client: PoolClient, token: string, body: z.infer<typeof nativeModelRequest>) {
    const owner = await this.tasks.executionAuthorized(client, token), selected = settings.parse(owner.settings)
    if (body.sessionId !== owner.id || body.provider !== (selected.provider ?? 'power-evolve') || body.model !== selected.model
      || body.maxTokens === undefined || body.maxTokens > selected.maxTokens
      || (body.reasoningEffort ?? 'off') !== (selected.reasoningEffort ?? 'off')) throw new PlatformError(403, 'model_not_authorized')
    await requireModelGrant(client, owner.user_id, selected.model, selected.maxTokens, selected.provider, selected.reasoningEffort)
    const row = (await client.query<{ remote_mcp_selection: unknown; stdio_v2_selection: unknown; workspace_id: string }>(
      `SELECT o.remote_mcp_selection,o.stdio_v2_selection,s.workspace_id FROM pe_operations o
       JOIN pe_sessions s ON s.id=o.session_id WHERE o.id=$1 AND s.id=$2 AND s.user_id=$3`,
      [owner.operation_id, owner.id, owner.user_id])).rows[0]
    if (!row) throw new PlatformError(409, 'lease_lost')
    const remote = mcpOperationTools.parse(row.remote_mcp_selection).map(tool => tool.model)
    const stdio = this.options.stdioV2Admission ? this.options.stdioV2Admission.selection.restore(row.stdio_v2_selection,
      [...this.options.stdioV2Admission.reservedNames, ...remote.map(tool => tool.name)]) : []
    if (!this.options.stdioV2Admission && !z.array(z.never()).safeParse(row.stdio_v2_selection).success) {
      throw new PlatformError(409, 'stdio_v2_admission_unavailable')
    }
    if (stdio.some(group => group.scopeBinding.userId !== owner.user_id || group.scopeBinding.workspaceId !== row.workspace_id)) {
      throw new PlatformError(409, 'stdio_v2_origin_changed')
    }
    const admitted = [...remote, ...stdio.flatMap(group => group.tools.map(tool => tool.model))]
    const tools = (body.tools ?? []).map(tool => modelMessageTool.parse({ name: tool.name,
      description: tool.description, input_schema: tool.parameters, ...tool.deferLoading ? { defer_loading: true } : {} }))
    try { assertModelToolDeclarations(tools, admitted, await readNativeModelTools(client, owner, admitted)) }
    catch (error) {
      if (error instanceof McpToolAdmissionError) throw new PlatformError(403, error.code)
      throw error
    }
    if (body.toolHistory !== undefined) {
      const totals = (await client.query<{ count: string; bytes: string }>(`SELECT count(*)::text AS count,
        COALESCE(sum(octet_length(event::text)),0)::text AS bytes FROM pe_events WHERE session_id=$1
        AND event->>'type' IN ('request/header','developer/message')`, [owner.id])).rows[0]
      if (!totals || Number(totals.count) > this.options.maxHistoryEvents || Number(totals.bytes) > this.options.maxHistoryBytes) {
        throw new PlatformError(413, 'history_limit')
      }
      const events = await client.query<{ event: unknown }>(`SELECT event FROM pe_events WHERE session_id=$1
        AND event->>'type' IN ('request/header','developer/message') ORDER BY seq`, [owner.id])
      const projection = new ToolHistoryProjection()
      for (const event of parseEvents(headerSchema.parse(owner.header), events.rows.map(row => row.event))) projection.apply(event)
      if (!isDeepStrictEqual(body.toolHistory, projection.snapshot())) throw new PlatformError(403, 'model_tool_history_not_authorized')
    }
    const prepared = (await client.query<{ configuration: unknown }>(`SELECT p.configuration FROM pe_tenant_model_preparations p
      JOIN pe_users u ON u.id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND p.provider=$3 AND p.model_id=$4
        AND p.credential_version=u.credential_version AND p.expires_at>clock_timestamp() AND p.consumed_at IS NULL FOR UPDATE OF p`,
    [body.preparationId, owner.user_id, body.provider, body.model])).rows[0]
    if (!prepared) throw new PlatformError(409, 'model_preparation_unavailable')
    const snapshot = tenantModelSnapshot.parse(prepared.configuration)
    await client.query(`UPDATE pe_tenant_model_preparations
      SET consumed_at=clock_timestamp(),operation_id=$2,configuration='[]'::json WHERE id=$1`,
    [body.preparationId, owner.operation_id])
    return { owner, snapshot }
  }

  /** Execute the maintained adapter using the original claimed operation; no provider key crosses this stream.
   * @param token Original fenced operation bearer.
   * @param value Native GenerateOptions JSON with cancellation supplied by HTTP.
   * @param signal Request disconnect and deployment deadline.
   * @returns The adapter's original native chunks and successful replay envelopes.
   */
  async *stream(token: string, value: unknown, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const body = nativeModelRequest.parse(stdioJsonV2({ maxBytes: this.options.maxRequestBytes,
      maxDepth: this.options.maxRequestBytes, maxNodes: this.options.maxRequestBytes }).parse(value))
    const { owner: original, snapshot } = await transaction(this.tasks.pool, client => this.admit(client, token, body))
    const authorize = async (client: PoolClient): Promise<void> => {
      signal.throwIfAborted()
      const current = await this.tasks.executionAuthorized(client, token)
      if (current.id !== original.id || current.user_id !== original.user_id || current.operation_id !== original.operation_id
        || current.lease_epoch !== original.lease_epoch) throw new PlatformError(409, 'lease_lost')
      await requireModelGrant(client, original.user_id, body.model, body.maxTokens ?? 1, body.provider, body.reasoningEffort)
    }
    const services = this.options.attachments(token, signal, () => transaction(this.tasks.pool, authorize))
    try {
      const { adapter, filterReplay } = await transaction(this.tasks.pool, async (client) => {
        await authorize(client)
        return this.models.adapter(client, userId.parse(original.user_id), body.provider, authorize, services, snapshot)
      })
      const { preparationId: _preparationId, ...native } = body
      for await (const value of adapter.stream(filterReplay({ ...native, signal }))) {
        await transaction(this.tasks.pool, authorize)
        const chunk = nativeModelStreamChunk.parse(value)
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          yield { type: 'finish', reason: { kind: chunk.reason.kind,
            failure: { ...chunk.reason.failure, message: 'Model request failed.' } } }
        } else yield chunk
      }
    } catch (error) {
      if (error instanceof PlatformError) throw error
      const chunk = adapterFailureChunk(error, signal)
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        yield { type: 'finish', reason: { kind: chunk.reason.kind, failure: { ...chunk.reason.failure, message: 'Model request failed.' } } }
      }
    } finally { await services.dispose() }
  }

  /** Write native NDJSON with existing model limits, backpressure and disconnect cancellation.
   * @param request Current operation HTTP request.
   * @param response Host stream response.
   */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = await readJson(request, this.options.maxRequestBytes), token = bearer(request)
    const abort = new AbortController(), close = () => { abort.abort() }
    response.once('close', close)
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.options.timeoutMs)])
    let bytes = 0
    try {
      for await (const chunk of this.stream(token, input, signal)) {
        const line = JSON.stringify(chunk) + '\n'
        bytes += Buffer.byteLength(line)
        if (bytes > this.options.maxResponseBytes) throw new PlatformError(502, 'model_output_limit')
        if (!response.headersSent) response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
        if (!response.write(line)) await once(response, 'drain', { signal })
      }
      response.end()
    } finally { response.off('close', close); abort.abort() }
  }
}
