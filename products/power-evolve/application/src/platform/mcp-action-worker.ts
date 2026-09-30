/** Lease-fenced remote calls; each durable dispatch intent can cause at most one transport POST. */
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformError } from '../contracts.ts'
import { mcpDiscoveredTool, mcpLeaseOwnerId, type McpPrivateSnapshot } from '../mcp-contracts.ts'
import type { McpActionLease } from '../mcp-action-contracts.ts'
import type { McpActionStore, McpActionPreparation } from './mcp-actions.ts'
import { mcpCatalogDigest } from './mcp-catalog.ts'
import { validateMcpBudgets } from './mcp-network.ts'
import { callMcp, McpDispatchRejected, McpTransportError,
  type McpNetworkPolicy, type McpTransportBudgets } from './mcp-transport.ts'

/** The store owns short, lease-fenced transactions and the unique durable continuation. */
export type McpActionWorkerStore = Pick<McpActionStore, 'claim' | 'renew' | 'preparation' | 'authorizeDispatch' | 'finish'>

/** Explicit deployment inputs; renewMs must be shorter than the store's lease lifetime. */
export interface McpActionWorkerOptions {
  ownerId: McpActionLease['ownerId']
  pollMs: number
  renewMs: number
  budgets: McpTransportBudgets
  networkPolicy: McpNetworkPolicy
  /** Resolve exact accepted connection versions in a short transaction, committed before returning.
   * @param preparation Private owner, routing metadata, and frozen arguments from the current lease.
   * @returns Endpoint and credentials; the worker must never log them.
   */
  snapshot: (preparation: McpActionPreparation) => Promise<McpPrivateSnapshot>
}

/** Only fixed categories escape the worker; private database or remote messages are never copied. */
export class McpActionWorkerError extends Error {
  constructor(readonly code: 'mcp_action_worker_running' | 'mcp_action_worker_config_invalid'
    | 'mcp_action_finish_uncertain') { super(code); this.name = 'McpActionWorkerError' }
}

const knownStoreCodes = new Set(['mcp_connection_revoked', 'mcp_dispatch_already_issued',
  'mcp_tool_duplicate', 'mcp_tool_collision'])

function leaseLost(error: unknown): boolean {
  return error instanceof PlatformError && error.code === 'mcp_action_lease_lost'
}

function failureCode(error: unknown, fallback: string): string {
  if (error instanceof McpTransportError) return `mcp_${error.code}`
  if (error instanceof PlatformError && knownStoreCodes.has(error.code)) return error.code
  return fallback
}

async function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  try { await delay(ms, undefined, { signal }); return !signal.aborted }
  catch (error) { if (signal.aborted) return false; throw error }
}

/** One action at a time; authorization and renewal settle before terminal persistence begins. */
export class McpActionWorker {
  private readonly options: Readonly<McpActionWorkerOptions>
  private active: Promise<void> | undefined
  private controller: AbortController | undefined

  constructor(private readonly store: McpActionWorkerStore, options: McpActionWorkerOptions) {
    if ([options.pollMs, options.renewMs].some(value => !Number.isSafeInteger(value) || value < 1
      || value > 2_147_483_647) || typeof options.snapshot !== 'function') {
      throw new McpActionWorkerError('mcp_action_worker_config_invalid')
    }
    mcpLeaseOwnerId.parse(options.ownerId)
    this.options = Object.freeze({ ...options, budgets: validateMcpBudgets(options.budgets) })
  }

  /** Poll until cancelled; unknown finish acknowledgements reject this run without another write.
   * @param signal Supervisor cancellation, combined with stop().
   * @returns Completion after owned snapshot, authorization, network, renewal, and finish work settles.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.active) throw new McpActionWorkerError('mcp_action_worker_running')
    const controller = new AbortController()
    this.controller = controller
    const combined = AbortSignal.any([signal, controller.signal])
    const active = Promise.resolve().then(() => this.loop(combined))
    this.active = active
    try { await active }
    finally { this.active = undefined; this.controller = undefined }
  }

  /** Cancel network work; an already-started database transaction must settle before stopping.
   * @returns Completion of the active run, including any unknown-finish rejection.
   */
  async stop(): Promise<void> {
    const active = this.active
    this.controller?.abort()
    await active
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let lease: McpActionLease | null
      try { lease = await this.store.claim(this.options.ownerId) }
      catch (_claimFailure) { if (!await wait(this.options.pollMs, signal)) return; continue }
      if (signal.aborted) return
      if (!lease) { if (!await wait(this.options.pollMs, signal)) return; continue }
      await this.call(lease, signal)
    }
  }

  private async call(lease: McpActionLease, supervisor: AbortSignal): Promise<void> {
    const lost = new AbortController(), renewalStop = new AbortController()
    const signal = AbortSignal.any([supervisor, lost.signal])
    const renewalSignal = AbortSignal.any([signal, renewalStop.signal])
    const renewal = (async () => {
      while (await wait(this.options.renewMs, renewalSignal)) {
        try { await this.store.renew(lease) }
        catch (_renewalFailure) { lost.abort(); return }
      }
    })()
    let authorization: Promise<boolean> | undefined
    let outcome: { result: unknown } | { errorCode: string } = { errorCode: 'mcp_action_interrupted' }
    let stage = 'mcp_action_preparation_failed'
    try {
      const preparation = await this.store.preparation(lease)
      if (signal.aborted) return
      stage = 'mcp_action_snapshot_failed'
      const snapshot = await this.options.snapshot(preparation)
      if (signal.aborted) return
      stage = 'mcp_action_call_failed'
      const result = await callMcp({ endpoint: snapshot.serverUrl, headers: snapshot.headers },
        { name: preparation.tool.raw.name, arguments: preparation.arguments }, {
          signal, budgets: this.options.budgets, networkPolicy: this.options.networkPolicy,
          onBeforeDispatch: async ({ catalog }, dispatchSignal) => {
            // Cancellation can race a COMMIT; only a confirmed false certifies rejection.
            if (signal.aborted || dispatchSignal.aborted) throw new Error('mcp_action_interrupted')
            const observedDigest = mcpCatalogDigest(catalog.tools.map(tool => mcpDiscoveredTool.parse(tool)))
            authorization = this.store.authorizeDispatch(lease, observedDigest)
            const allowed = await authorization
            if (allowed === false) { renewalStop.abort(); throw new McpDispatchRejected() }
            if (allowed !== true) throw new Error('mcp_action_authorization_uncertain')
          },
        })
      outcome = { result }
    } catch (error) {
      if (leaseLost(error)) lost.abort()
      outcome = { errorCode: failureCode(error, stage) }
    } finally {
      // Transport deadlines do not wait for caller-owned PG callbacks. This promise can still COMMIT.
      if (authorization) {
        try { await authorization }
        catch (_authorizationUncertain) { /* The transport outcome retains the fixed conservative category. */ }
      }
      renewalStop.abort()
      await renewal
      try {
        const receipt = await this.store.finish(lease, outcome)
        if (['pending', 'approved', 'preparing', 'dispatch-intent'].includes(receipt.state)) {
          throw new McpActionWorkerError('mcp_action_finish_uncertain')
        }
      } catch (error) {
        if (!leaseLost(error)) throw new McpActionWorkerError('mcp_action_finish_uncertain')
      }
    }
  }
}
