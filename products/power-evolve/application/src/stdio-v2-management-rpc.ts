/** Native Cloud STDIO management over the original browser credential; metadata supplies budgets, never authority. */
import { z } from 'zod'
import { stdioActionRequestV2, stdioCheckRequestV2, stdioJsonV2, stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionSchemasV2, stdioManagementSchemasV2, stdioPublicConfigV2,
  type StdioActionDetailV2, type StdioActionListRequestV2, type StdioActionListV2, type StdioActionSummaryV2,
  type StdioCheckReceiptV2, type StdioConnectionListV2, type StdioCreateRequestV2, type StdioDeleteRequestV2,
  type StdioListRequestV2, type StdioManagementReceiptV2, type StdioMutationReceiptV2, type StdioPublicConfigV2,
  type StdioToggleRequestV2, type StdioUpdateRequestV2 } from '@power-evolve/contracts/stdio-management'
import { PlatformError } from './contracts.ts'
import type RuntimeScope from './host/scope.ts'

/** Flat native methods; dynamic request validation occurs after this peer's authenticated metadata read. */
export const stdioManagementRequestsV2 = {
  stdioV2Config: z.object({}).strict(),
  stdioV2ConnectionsList: z.unknown(), stdioV2ConnectionsCreate: z.unknown(),
  stdioV2ConnectionsUpdate: z.unknown(), stdioV2ConnectionsToggle: z.unknown(),
  stdioV2ConnectionsDelete: z.unknown(), stdioV2ConnectionsReceipt: z.unknown(),
  stdioV2ConnectionsCheck: z.unknown(), stdioV2ActionsList: z.unknown(),
  stdioV2ActionsDetail: z.unknown(), stdioV2ActionsCancel: z.unknown(),
}

/** Exact Platform management paths; no runtime, approval or executor endpoint is exposed. */
export const stdioManagementEndpointsV2 = {
  stdioV2Config: '/stdio-v2/config',
  stdioV2ConnectionsList: '/stdio-v2/connections/list', stdioV2ConnectionsCreate: '/stdio-v2/connections/create',
  stdioV2ConnectionsUpdate: '/stdio-v2/connections/update', stdioV2ConnectionsToggle: '/stdio-v2/connections/toggle',
  stdioV2ConnectionsDelete: '/stdio-v2/connections/delete', stdioV2ConnectionsReceipt: '/stdio-v2/connections/receipt',
  stdioV2ConnectionsCheck: '/stdio-v2/connections/check', stdioV2ActionsList: '/stdio-v2/actions/list',
  stdioV2ActionsDetail: '/stdio-v2/actions/detail', stdioV2ActionsCancel: '/stdio-v2/actions/cancel',
} as const

type Available = Extract<StdioPublicConfigV2, { available: true }>
type Schemas = { config: Available
  management: ReturnType<typeof stdioManagementSchemasV2>
  actions: ReturnType<typeof stdioActionSchemasV2> }
type Method = Exclude<keyof typeof stdioManagementEndpointsV2, 'stdioV2Config'>

/** Each operation reuses its peer bearer and fresh trusted validators; uncertain responses are never resubmitted. */
export class StdioManagementRpcV2 {
  constructor(private readonly runtime: Pick<RuntimeScope, 'call'>) {}

  private budget(config: Available, maxBytes: number) {
    return { maxDepth: config.limits.maxJsonDepth, maxNodes: config.limits.maxJsonNodes, maxBytes }
  }
  private reply<T>(config: Available, schema: z.ZodType<T>, value: unknown): T {
    if (!stdioJsonV2(this.budget(config, config.maxReplyBytes)).safeParse(value).success) {
      throw new PlatformError(413, 'stdio_v2_reply_limit')
    }
    const result = schema.safeParse(value)
    if (!result.success) throw new PlatformError(502, 'stdio_v2_response_invalid')
    return result.data
  }
  private mismatch(): never { throw new PlatformError(502, 'stdio_v2_response_mismatch') }
  private async invoke<T>(method: Method, token: string, input: unknown,
    validators: (schemas: Schemas) => { request: z.ZodType; response: z.ZodType<T> }): Promise<T> {
    const config = await this.config(token, {})
    if (!config.available) throw new PlatformError(503, 'stdio_v2_unavailable')
    const schemas = { config, management: stdioManagementSchemasV2(config.limits, config.management),
      actions: stdioActionSchemasV2(config.limits, config.maxReplyBytes, config.management.pageItems) }
    const { request, response } = validators(schemas)
    const parsed = request.parse(stdioJsonV2(this.budget(config, config.limits.maxInputBytes)).parse(input))
    return this.reply(config, response, await this.runtime.call(stdioManagementEndpointsV2[method], token, parsed))
  }
  private mutation(method: Method, token: string, input: unknown,
    selector: (schemas: Schemas) => z.ZodType): Promise<StdioMutationReceiptV2> {
    return this.invoke(method, token, input, schemas => ({ request: selector(schemas), response: schemas.management.mutationReceipt }))
  }

  /** Read public deployment budgets with the peer's current Agent credential.
   * @param token Original authenticated browser bearer, also rechecked by the Platform config operation.
   * @param input Empty strict request; a browser cannot supply budgets or an execution target.
   * @returns Public configuration; unavailable deployments return only formatVersion and available=false.
   */
  async config(token: string, input: Record<string, never>): Promise<StdioPublicConfigV2> {
    const parsed = stdioManagementRequestsV2.stdioV2Config.parse(input)
    const result = stdioPublicConfigV2.safeParse(await this.runtime.call(stdioManagementEndpointsV2.stdioV2Config, token, parsed))
    if (!result.success) throw new PlatformError(502, 'stdio_v2_config_invalid')
    return result.data.available ? this.reply(result.data, stdioPublicConfigV2, result.data) : result.data
  }

  /** Read one owner-scoped connection page without creating a process.
   * @param token Original Agent browser bearer.
   * @param input Original optional exclusive UUID cursor.
   * @returns Complete validated connections and the next cursor, without truncation.
   */
  list(token: string, input: StdioListRequestV2): Promise<StdioConnectionListV2> {
    return this.invoke('stdioV2ConnectionsList', token, input, s => ({ request: s.management.listRequest, response: s.management.list }))
  }
  /** Save a literal program configuration without approving or starting it.
   * @param token Original Agent browser bearer.
   * @param input Exact configuration and stable submission ID.
   * @returns Original create receipt; lost replies require receipt readback rather than a new request.
   */
  async create(token: string, input: StdioCreateRequestV2): Promise<StdioMutationReceiptV2> {
    const value = await this.mutation('stdioV2ConnectionsCreate', token, input, s => s.management.create)
    if (value.requestId !== input.requestId || value.purpose !== 'create') this.mismatch()
    return value
  }
  /** Replace the exact saved revision; the Platform retains original history and cancellation obligations.
   * @param token Original Agent browser bearer.
   * @param input Stable request and original expected revision.
   * @returns Original update receipt, never fabricated replacement connection metadata.
   */
  async update(token: string, input: StdioUpdateRequestV2): Promise<StdioMutationReceiptV2> {
    const value = await this.mutation('stdioV2ConnectionsUpdate', token, input, s => s.management.update)
    if (value.requestId !== input.requestId || value.purpose !== 'update' || value.connectionId !== input.connectionId) this.mismatch()
    return value
  }
  /** Change enabled state using the original saved revision and request ID.
   * @param token Original Agent browser bearer.
   * @param input Exact requested enabled state and optimistic revision.
   * @returns Original toggle receipt; the saved configuration revision does not change on toggle.
   */
  async toggle(token: string, input: StdioToggleRequestV2): Promise<StdioMutationReceiptV2> {
    const value = await this.mutation('stdioV2ConnectionsToggle', token, input, s => s.management.toggle)
    if (value.requestId !== input.requestId || value.purpose !== 'toggle' || value.connectionId !== input.connectionId
      || value.enabled !== input.enabled) this.mismatch()
    return value
  }
  /** Soft-delete a saved connection without claiming that its original writer has stopped.
   * @param token Original Agent browser bearer.
   * @param input Stable request and original connection revision.
   * @returns Original deletion receipt; historical actions remain owned and readable.
   */
  async remove(token: string, input: StdioDeleteRequestV2): Promise<StdioMutationReceiptV2> {
    const value = await this.mutation('stdioV2ConnectionsDelete', token, input, s => s.management.remove)
    if (value.requestId !== input.requestId || value.purpose !== 'delete' || value.connectionId !== input.connectionId || !value.deleted) this.mismatch()
    return value
  }
  /** Reconcile an uncertain submission by its original receipt ID, without resubmission.
   * @param token Original Agent browser bearer.
   * @param input Original request identity, with no replacement data.
   * @returns Formal management receipt; Platform 404 remains a refusal and never triggers a new ID.
   */
  async receipt(token: string, input: z.infer<typeof stdioReceiptRequestV2>): Promise<StdioManagementReceiptV2> {
    const value = await this.invoke('stdioV2ConnectionsReceipt', token, input,
      s => ({ request: stdioReceiptRequestV2, response: s.management.receipt }))
    if (value.requestId !== input.requestId) this.mismatch()
    return value
  }
  /** Admit discovery for one saved revision and explicitly selected existing Cloud Session.
   * @param token Original Agent browser bearer.
   * @param input Original saved revision, Session and stable check request.
   * @returns Durable action/execution receipt; metadata alone never grants permission to start the program.
   */
  async check(token: string, input: z.infer<typeof stdioCheckRequestV2>): Promise<StdioCheckReceiptV2> {
    const value = await this.invoke('stdioV2ConnectionsCheck', token, input,
      s => ({ request: stdioCheckRequestV2, response: s.management.checkReceipt }))
    if (value.requestId !== input.requestId || value.connectionId !== input.connectionId
      || value.revision !== input.expectedRevision) this.mismatch()
    return value
  }
  /** List bounded persisted Cloud action summaries under the current browser credential.
   * @param token Original Agent browser bearer.
   * @param input Exact page and optional existing owned Session.
   * @returns Logical states, not a new executor or process observation.
   */
  async actions(token: string, input: StdioActionListRequestV2): Promise<StdioActionListV2> {
    const value = await this.invoke('stdioV2ActionsList', token, input, s => ({ request: s.actions.listRequest, response: s.actions.list }))
    if (input.sessionId !== undefined && value.items.some(item => item.sessionId !== input.sessionId)) this.mismatch()
    return value
  }
  /** Read the original logical task and its formal immutable outcome or no-start disposition.
   * @param token Original Agent browser bearer.
   * @param input Exact original Cloud action selector.
   * @returns Full public details, retaining raw SDK fields while excluding capture and start permits.
   */
  async detail(token: string, input: z.infer<typeof stdioActionRequestV2>): Promise<StdioActionDetailV2> {
    const value = await this.invoke('stdioV2ActionsDetail', token, input, s => ({ request: stdioActionRequestV2, response: s.actions.detail }))
    if (value.actionId !== input.actionId) this.mismatch()
    return value
  }
  /** Request cancellation of the original action, leaving stop and result authority at the Platform.
   * @param token Original Agent browser bearer.
   * @param input Exact original Cloud action selector.
   * @returns Persisted summary; no writer release, root cancellation or terminal outcome is inferred.
   */
  async cancel(token: string, input: z.infer<typeof stdioActionRequestV2>): Promise<StdioActionSummaryV2> {
    const value = await this.invoke('stdioV2ActionsCancel', token, input, s => ({ request: stdioActionRequestV2, response: s.actions.summary }))
    if (value.actionId !== input.actionId) this.mismatch()
    return value
  }
}
