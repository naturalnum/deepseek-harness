/** Original-request recovery and stale-response fencing for the native generic STDIO card. */
import { stdioActionRequestV2, stdioCheckRequestV2, stdioExecutionRefV2, stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementSchemasV2, type StdioActionDetailV2, type StdioActionListV2, type StdioConnectionListV2,
  type StdioCreateRequestV2, type StdioDeleteRequestV2, type StdioManagementReceiptV2, type StdioPublicConfigV2,
  type StdioToggleRequestV2, type StdioUpdateRequestV2 } from '@power-evolve/contracts/stdio-management'
import { StdioV2HttpError, type StdioV2Check, type StdioV2Port } from './stdio-v2-api.ts'

/** One immutable user submission, retained after a lost response until its original receipt is read. */
export type StdioV2Submission = { readonly kind: 'create'; readonly input: StdioCreateRequestV2 }
  | { readonly kind: 'update'; readonly input: StdioUpdateRequestV2 }
  | { readonly kind: 'toggle'; readonly input: StdioToggleRequestV2 }
  | { readonly kind: 'delete'; readonly input: StdioDeleteRequestV2 }
  | { readonly kind: 'check'; readonly input: StdioV2Check }
/** Observable owner/Session-local view; unresolved submission never becomes an invented result. */
export interface StdioV2View {
  readonly sessionId: string
  readonly config: StdioPublicConfigV2 | undefined
  readonly connections: StdioConnectionListV2 | undefined
  readonly actions: StdioActionListV2 | undefined
  readonly detail: StdioActionDetailV2 | undefined
  readonly pending: StdioV2Submission | undefined
  readonly pendingCancel: string | undefined
  readonly receipt: StdioManagementReceiptV2 | undefined
  readonly busy: boolean
  readonly error: 'failed' | 'expired' | 'uncertain' | undefined
  readonly backendCode: string | undefined
}

/** Persistent card controller; navigation cancels reads while retaining original uncertain request IDs. */
export class StdioV2State {
  private view: StdioV2View = { sessionId: '', config: undefined, connections: undefined, actions: undefined,
    detail: undefined, pending: undefined, pendingCancel: undefined, receipt: undefined, busy: false,
    error: undefined, backendCode: undefined }
  private listeners = new Set<() => void>()
  private request: AbortController | undefined
  private epoch = 0
  private context = ''
  private pendingBySession = new Map<string, StdioV2Submission>()
  private cancelBySession = new Map<string, string>()
  constructor(private readonly port: StdioV2Port) {}
  /** Read one stable snapshot for useSyncExternalStore. @returns Current owner-local fields. */
  getSnapshot = (): StdioV2View => this.view
  /** Observe view changes. @param listener Renderer notification. @returns Listener disposer. */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<StdioV2View>): void {
    this.view = { ...this.view, ...patch }; this.listeners.forEach((listener) => { listener() })
  }
  /** Select only an explicitly chosen existing Session; old owner responses cannot populate its view.
   * @param sessionId Explicit selection, or empty.
   * @param ownedIds Existing native Session IDs.
   */
  select(sessionId: string, ownedIds: readonly string[]): void {
    const selected = ownedIds.includes(sessionId) ? sessionId : ''
    const context = `${selected}:${[...ownedIds].sort().join(',')}`
    if (context === this.context) return
    this.context = context; this.stop()
    const pending = ownedIds.map(id => this.pendingBySession.get(id)).find(value => value !== undefined)
    this.update({ sessionId: selected, connections: undefined, actions: undefined, detail: undefined,
      receipt: undefined, pending, pendingCancel: this.cancelBySession.get(selected), error: pending ? 'uncertain' : undefined, backendCode: undefined })
  }
  /** Stop owned requests when the card closes; uncertain submissions remain available for original receipt recovery. */
  stop(): void { this.epoch++; this.request?.abort(); this.request = undefined; this.update({ busy: false }) }
  private async run(operation: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
    if (this.view.busy) return
    const epoch = ++this.epoch, controller = new AbortController()
    this.request = controller; this.update({ busy: true, error: undefined, backendCode: undefined })
    const current = () => epoch === this.epoch && !controller.signal.aborted
    try { await operation(controller.signal, current) }
    catch (cause) { if (current()) this.update({ error: cause instanceof StdioV2HttpError && cause.status === 401 ? 'expired'
      : this.view.pending || this.view.pendingCancel ? 'uncertain' : 'failed', backendCode: cause instanceof StdioV2HttpError ? cause.code : undefined }) }
    finally { if (current()) { this.request = undefined; this.update({ busy: false }) } }
  }
  /** Read availability and one complete page for the selected Session; does not Check or create it.
   * @param after Explicit connection cursor.
   * @param offset Explicit action offset.
   * @returns Fresh observed availability, or undefined when the request failed, was cancelled or another request was busy.
   */
  async load(after?: StdioConnectionListV2['next'], offset = 0): Promise<boolean | undefined> {
    let availability: boolean | undefined
    let currentRead = () => false
    await this.run(async (signal, current) => {
      currentRead = current
      const config = await this.port.config(signal)
      if (!current()) return
      availability = config.available
      this.update({ config })
      const sessionId = this.view.sessionId
      if (!config.available || !sessionId) { this.update({ connections: undefined, actions: undefined, detail: undefined }); return }
      const session = stdioCheckRequestV2.shape.sessionId.parse(sessionId)
      const connections = await this.port.list(after ? { after } : {}, signal)
      if (!current()) return
      const actions = await this.port.actions({ sessionId: session, offset, limit: config.management.pageItems }, signal)
      if (current()) {
        const cancelling = actions.items.find(item => item.actionId === this.view.pendingCancel)
        if (cancelling && (cancelling.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(cancelling.state))) {
          this.cancelBySession.delete(sessionId); this.update({ pendingCancel: undefined })
        }
        this.update({ connections, actions, detail: undefined, error: this.view.pending || this.view.pendingCancel ? 'uncertain' : undefined })
      }
    })
    return currentRead() ? availability : undefined
  }
  /** Submit one user-approved metadata mutation, keeping its original full input if the reply is lost.
   * @param submission Exact parsed request with a stable request ID.
   */
  async submit(submission: StdioV2Submission): Promise<void> {
    if (this.view.pending || !this.view.sessionId || !this.view.config?.available || this.view.busy) return
    const sessionId = this.view.sessionId, original = structuredClone(submission)
    this.pendingBySession.set(sessionId, original); this.update({ pending: original, receipt: undefined })
    await this.run(async (signal, current) => {
      let receipt: StdioManagementReceiptV2
      try {
        switch (original.kind) {
          case 'create': receipt = await this.port.create(original.input, signal); break
          case 'update': receipt = await this.port.update(original.input, signal); break
          case 'toggle': receipt = await this.port.toggle(original.input, signal); break
          case 'delete': receipt = await this.port.remove(original.input, signal); break
          case 'check': receipt = await this.port.check(original.input, signal); break
        }
      } catch (cause) {
        if (current() && cause instanceof StdioV2HttpError && cause.status >= 400 && cause.status < 500) {
          this.pendingBySession.delete(sessionId); this.update({ pending: undefined })
        }
        throw cause
      }
      if (current()) this.accept(original, receipt)
    })
  }
  private accept(original: StdioV2Submission, receipt: StdioManagementReceiptV2): void {
    if (receipt.requestId !== original.input.requestId || receipt.purpose !== original.kind
      || original.kind !== 'create' && receipt.connectionId !== original.input.connectionId
      || original.kind === 'check' && (receipt.purpose !== 'check' || receipt.revision !== original.input.expectedRevision
        || !stdioExecutionRefV2.options[0].safeParse(receipt.executionRef).success)
      || original.kind === 'toggle' && (receipt.purpose !== 'toggle' || receipt.enabled !== original.input.enabled)) {
      throw new Error('Original STDIO receipt changed')
    }
    if (original.kind !== 'check' && (receipt.purpose === 'check'
      || receipt.revision !== (original.kind === 'create' ? 1 : original.input.expectedRevision + Number(original.kind === 'update'))
      || receipt.deleted !== (original.kind === 'delete') || original.kind !== 'toggle' && receipt.enabled)) {
      throw new Error('Original STDIO mutation receipt changed')
    }
    for (const [id, pending] of this.pendingBySession) {
      if (pending.input.requestId !== original.input.requestId) continue
      this.pendingBySession.delete(id)
    }
    this.update({ pending: undefined, receipt, error: undefined })
  }
  /** Recover only the original receipt; missing receipts do not generate an ID or replay a POST. */
  async reconcile(): Promise<void> {
    const original = this.view.pending
    if (!original) return
    await this.run(async (signal, current) => {
      const receipt = await this.port.receipt(stdioReceiptRequestV2.parse({ requestId: original.input.requestId }), signal)
      if (current()) this.accept(original, receipt)
    })
  }
  /** Read full persisted action data, ignoring any result from an obsolete Session selection.
   * @param actionId Selected summary ID from this page.
   */
  async detail(actionId: string): Promise<void> {
    const row = this.view.actions?.items.find(item => item.actionId === actionId)
    if (!row) return
    await this.run(async (signal, current) => {
      const detail = await this.port.detail(stdioActionRequestV2.parse({ actionId }), signal)
      if (detail.sessionId !== row.sessionId || detail.connectionId !== row.connectionId || detail.taskDigest !== row.taskDigest
        || detail.executionRef.executionId !== row.executionRef.executionId) throw new Error('Selected STDIO action changed')
      if (current()) this.update({ detail })
    })
  }
  /** Request cancellation of the selected original action; readers must still observe its actual lifecycle.
   * @param actionId Selected owned summary ID; no result or stopped-writer assertion is sent.
   */
  async cancel(actionId: string): Promise<void> {
    const page = this.view.actions
    const row = page?.items.find(item => item.actionId === actionId)
    if (!page || !row || this.view.pendingCancel === actionId || this.view.busy) return
    const sessionId = this.view.sessionId
    this.cancelBySession.set(sessionId, actionId); this.update({ pendingCancel: actionId })
    await this.run(async (signal, current) => {
      let result
      try { result = await this.port.cancel(stdioActionRequestV2.parse({ actionId }), signal) }
      catch (cause) {
        if (current() && cause instanceof StdioV2HttpError && cause.status >= 400 && cause.status < 500) {
          this.cancelBySession.delete(sessionId); this.update({ pendingCancel: undefined })
        }
        throw cause
      }
      if (result.sessionId !== row.sessionId || result.taskDigest !== row.taskDigest
        || result.executionRef.executionId !== row.executionRef.executionId) throw new Error('Cancelled STDIO action changed')
      if (current()) { this.cancelBySession.delete(sessionId); this.update({ pendingCancel: undefined,
        actions: { ...page, items: page.items.map(item => item.actionId === actionId ? result : item) }, detail: undefined })
      }
    })
  }
}

/** Parse form fields as literal program/argv/cwd, preserving empty arguments and their original order.
 * @param fields Original form text, without shell assembly.
 * @param config Trusted available public budgets.
 * @returns Complete validated saved configuration.
 */
export function stdioV2Configuration(fields: { name: string; program: string; argv: string; cwd: string },
  config: Extract<StdioPublicConfigV2, { available: true }>): StdioCreateRequestV2['configuration'] {
  const argv: unknown = JSON.parse(fields.argv)
  return stdioManagementSchemasV2(config.limits, config.management).configuration.parse({ name: fields.name,
    invocation: { program: fields.program, argv, cwd: fields.cwd } })
}
