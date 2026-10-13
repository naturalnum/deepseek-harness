/** Same-origin native RPC for generic STDIO metadata; browser credentials remain in HttpOnly cookies. */
import { stdioActionRequestV2, stdioCheckRequestV2, stdioJsonV2, stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionSchemasV2, stdioManagementSchemasV2, stdioPublicConfigV2,
  type StdioPublicConfigV2, type StdioActionDetailV2, type StdioActionListRequestV2, type StdioActionListV2,
  type StdioActionSummaryV2, type StdioCheckReceiptV2, type StdioConnectionListV2, type StdioCreateRequestV2,
  type StdioDeleteRequestV2, type StdioListRequestV2, type StdioManagementReceiptV2,
  type StdioMutationReceiptV2, type StdioToggleRequestV2, type StdioUpdateRequestV2 } from '@power-evolve/contracts/stdio-management'

/** Explicit saved revision and owned Session; the native page only checks Cloud targets. */
export type StdioV2Check = ReturnType<typeof stdioCheckRequestV2.parse>
/** Generic native management operations, separate from the legacy fixed whoami connection. */
export interface StdioV2Port {
  config(signal?: AbortSignal): Promise<StdioPublicConfigV2>
  list(input: StdioListRequestV2, signal?: AbortSignal): Promise<StdioConnectionListV2>
  create(input: StdioCreateRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2>
  update(input: StdioUpdateRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2>
  toggle(input: StdioToggleRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2>
  remove(input: StdioDeleteRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2>
  receipt(input: ReturnType<typeof stdioReceiptRequestV2.parse>, signal?: AbortSignal): Promise<StdioManagementReceiptV2>
  check(input: StdioV2Check, signal?: AbortSignal): Promise<StdioCheckReceiptV2>
  actions(input: StdioActionListRequestV2, signal?: AbortSignal): Promise<StdioActionListV2>
  detail(input: ReturnType<typeof stdioActionRequestV2.parse>, signal?: AbortSignal): Promise<StdioActionDetailV2>
  cancel(input: ReturnType<typeof stdioActionRequestV2.parse>, signal?: AbortSignal): Promise<StdioActionSummaryV2>
}

/** HTTP refusal; failed or lost replies never cause an automatic mutation retry. */
export class StdioV2HttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`STDIO v2 request failed: ${status}`) }
}
type Available = Extract<StdioPublicConfigV2, { available: true }>
type Parser<T> = { parse(input: unknown): T }

/** Validate each native request and complete reply using authenticated public deployment budgets. */
export class StdioV2HttpClient implements StdioV2Port {
  private available: Available | undefined
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  private async post(method: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${method}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }),
      ...(signal === undefined ? {} : { signal }) })
    if (!response.ok) {
      let code: string | undefined
      try {
        const error: unknown = await response.json()
        if (typeof error === 'object' && error !== null && 'error' in error
          && typeof error.error === 'string' && /^[a-z][a-z0-9_]{0,127}$/u.test(error.error)) code = error.error
      } catch (_nonJsonFailure) { /* A proxy may return no JSON; preserve its HTTP status without inventing a service code. */ }
      throw new StdioV2HttpError(response.status, code)
    }
    return response.json() as Promise<unknown>
  }
  private schemas() {
    const c = this.available
    if (!c) throw new StdioV2HttpError(503)
    return { management: stdioManagementSchemasV2(c.limits, c.management),
      actions: stdioActionSchemasV2(c.limits, c.maxReplyBytes, c.management.pageItems),
      input: stdioJsonV2({ maxDepth: c.limits.maxJsonDepth, maxNodes: c.limits.maxJsonNodes, maxBytes: c.limits.maxInputBytes }),
      output: stdioJsonV2({ maxDepth: c.limits.maxJsonDepth, maxNodes: c.limits.maxJsonNodes, maxBytes: c.maxReplyBytes }) }
  }
  private async invoke<I extends object, O>(method: string, input: I, request: Parser<I>, reply: Parser<O>,
    signal?: AbortSignal): Promise<O> {
    const s = this.schemas(), parsed = request.parse(s.input.parse(input))
    return reply.parse(s.output.parse(await this.post(method, parsed, signal)))
  }
  /** Read availability before using generic methods; false keeps the existing fixed STDIO page.
   * @param signal Caller lifetime. @returns Strict public configuration with no private execution credentials.
   */
  async config(signal?: AbortSignal): Promise<StdioPublicConfigV2> {
    const result = stdioPublicConfigV2.parse(await this.post('stdioV2Config', {}, signal))
    if (!signal?.aborted) this.available = result.available ? result : undefined
    return result
  }
  /** Read one complete connection page.
   * @param input Original cursor. @param signal Caller lifetime. @returns Parsed owner-scoped page.
   */
  async list(input: StdioListRequestV2, signal?: AbortSignal): Promise<StdioConnectionListV2> {
    const s = this.schemas(), result = await this.invoke('stdioV2ConnectionsList', input, s.management.listRequest, s.management.list, signal)
    if (new Set(result.items.map(i => i.connectionId)).size !== result.items.length
      || result.items.some(i => input.after !== undefined && i.connectionId <= input.after)
      || result.next !== null && result.next !== result.items.at(-1)?.connectionId) throw new Error('STDIO connection page mismatch')
    return result
  }
  /** Save a disabled literal invocation once.
   * @param input Stable request and full configuration. @param signal Caller lifetime. @returns Original receipt.
   */
  async create(input: StdioCreateRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ConnectionsCreate', input, s.management.create, s.management.mutationReceipt, signal)
    if (r.requestId !== input.requestId || r.purpose !== 'create' || r.revision !== 1 || r.enabled || r.deleted) this.mismatch()
    return r
  }
  /** Replace the exact saved revision without discovering or enabling it.
   * @param input Original optimistic revision. @param signal Caller lifetime. @returns Original update receipt.
   */
  async update(input: StdioUpdateRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ConnectionsUpdate', input, s.management.update, s.management.mutationReceipt, signal)
    if (r.requestId !== input.requestId || r.purpose !== 'update' || r.connectionId !== input.connectionId
      || r.revision !== input.expectedRevision + 1 || r.enabled || r.deleted) this.mismatch()
    return r
  }
  /** Toggle the saved revision; enabling requires the Platform's successful catalog.
   * @param input Exact requested state. @param signal Caller lifetime. @returns Original toggle receipt.
   */
  async toggle(input: StdioToggleRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ConnectionsToggle', input, s.management.toggle, s.management.mutationReceipt, signal)
    if (r.requestId !== input.requestId || r.purpose !== 'toggle' || r.connectionId !== input.connectionId
      || r.revision !== input.expectedRevision || r.enabled !== input.enabled || r.deleted) this.mismatch()
    return r
  }
  /** Tombstone one connection; retained writers still require independent cleanup.
   * @param input Stable delete request. @param signal Caller lifetime. @returns Original deletion receipt.
   */
  async remove(input: StdioDeleteRequestV2, signal?: AbortSignal): Promise<StdioMutationReceiptV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ConnectionsDelete', input, s.management.remove, s.management.mutationReceipt, signal)
    if (r.requestId !== input.requestId || r.purpose !== 'delete' || r.connectionId !== input.connectionId
      || r.revision !== input.expectedRevision || r.enabled || !r.deleted) this.mismatch()
    return r
  }
  /** Query the original receipt after a lost response, without sending the mutation again.
   * @param input Original request ID. @param signal Caller lifetime. @returns Complete original receipt; 404 remains unresolved.
   */
  async receipt(input: ReturnType<typeof stdioReceiptRequestV2.parse>, signal?: AbortSignal): Promise<StdioManagementReceiptV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ConnectionsReceipt', input, stdioReceiptRequestV2, s.management.receipt, signal)
    if (r.requestId !== input.requestId) this.mismatch()
    return r
  }
  /** Check one explicit existing Session with a fixed Cloud target.
   * @param input Original revision and Session. @param signal Caller lifetime. @returns Acceptance, never approval or a result.
   */
  async check(input: StdioV2Check, signal?: AbortSignal): Promise<StdioCheckReceiptV2> {
    const s = this.schemas()
    const r = await this.invoke('stdioV2ConnectionsCheck', input, stdioCheckRequestV2, s.management.checkReceipt, signal)
    if (r.requestId !== input.requestId || r.connectionId !== input.connectionId || r.revision !== input.expectedRevision) this.mismatch()
    return r
  }
  /** Read a bounded page of persisted actions for the selected Session.
   * @param input Explicit offset and page limit. @param signal Caller lifetime. @returns Complete page with no outcome truncation.
   */
  async actions(input: StdioActionListRequestV2, signal?: AbortSignal): Promise<StdioActionListV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ActionsList', input, s.actions.listRequest, s.actions.list, signal)
    if (r.items.length > input.limit || new Set(r.items.map(i => i.actionId)).size !== r.items.length
      || r.items.some(i => input.sessionId !== undefined && i.sessionId !== input.sessionId)
      || r.nextOffset !== null && r.nextOffset !== input.offset + input.limit) this.mismatch()
    return r
  }
  /** Read the complete original task and outcome for one owned action.
   * @param input Original action ID. @param signal Caller lifetime. @returns Full parsed historical detail.
   */
  async detail(input: ReturnType<typeof stdioActionRequestV2.parse>, signal?: AbortSignal): Promise<StdioActionDetailV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ActionsDetail', input, stdioActionRequestV2, s.actions.detail, signal)
    if (r.actionId !== input.actionId) this.mismatch()
    return r
  }
  /** Request cancellation; the reply does not assert that the SDK or writer stopped.
   * @param input Original action ID. @param signal Caller lifetime. @returns Persisted logical cancellation summary.
   */
  async cancel(input: ReturnType<typeof stdioActionRequestV2.parse>, signal?: AbortSignal): Promise<StdioActionSummaryV2> {
    const s = this.schemas(), r = await this.invoke('stdioV2ActionsCancel', input, stdioActionRequestV2, s.actions.summary, signal)
    if (r.actionId !== input.actionId) this.mismatch()
    return r
  }
  private mismatch(): never { throw new Error('STDIO v2 receipt mismatch') }
}
