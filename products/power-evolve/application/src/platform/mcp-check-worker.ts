/** Lease-fenced remote MCP discovery; network and model-schema validation happen outside PG transactions. */
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformError } from '../contracts.ts'
import { mcpDiscoveredTool, mcpLeaseOwnerId, type McpCheck, type McpCheckLease,
  type McpDiscoveredTool, type McpPrivateSnapshot } from '../mcp-contracts.ts'
import { compileMcpModelTool, McpToolAdmissionError, type McpToolAdmissionLimits } from '../mcp-model-tools.ts'
import { mcpCatalogTools } from './mcp-catalog.ts'
import { mcpCanonicalJson } from './mcp-credentials.ts'
import { validateMcpBudgets } from './mcp-network.ts'
import { discoverMcp, McpTransportError, type McpNetworkPolicy,
  type McpTransportBudgets } from './mcp-transport.ts'

/** Structural port matches McpConnectionService; no service implementation or pool is owned here. */
export interface McpCheckWorkerStore {
  /** Claim only a new lease epoch; the transaction must finish before this promise resolves.
   * @param ownerId Configured worker UUID.
   * @returns The next leased check, or null when none can be claimed.
   */
  claimCheck(ownerId: McpCheckLease['ownerId']): Promise<McpCheckLease | null>
  /** Renew one live lease; throw mcp_check_lease_lost when cancelled, expired, terminal, or superseded.
   * @param lease Current owner and epoch.
   * @returns Completion of the renewal transaction.
   */
  renewCheck(lease: McpCheckLease): Promise<void>
  /** Read only the leased immutable credentials and endpoint; commit before resolving.
   * @param lease Current owner and epoch.
   * @returns Private discovery material which must never be logged.
   */
  checkSnapshot(lease: McpCheckLease): Promise<McpPrivateSnapshot>
  /** Finish atomically; stale leases reject, and 413/mcp_catalog_limit certifies a precommit refusal.
   * @param lease Current owner and epoch.
   * @param outcome Entire validated raw directory or a fixed redacted error code.
   * @returns Durable terminal metadata. A rejected promise may have lost its commit acknowledgement.
   */
  finishCheck(lease: McpCheckLease,
    outcome: { tools: readonly McpDiscoveredTool[] } | { errorCode: string }): Promise<McpCheck>
}

/** Required deployment inputs; renewMs must be shorter than the store's configured lease lifetime. */
export interface McpCheckWorkerOptions {
  ownerId: McpCheckLease['ownerId']
  pollMs: number
  renewMs: number
  budgets: McpTransportBudgets
  networkPolicy: McpNetworkPolicy
  toolLimits: McpToolAdmissionLimits
  /** Protocol dependency, injectable for fixtures; production uses discoverMcp.
   * @param target Private snapshot endpoint and headers.
   * @param options Operation abort signal, budgets and operator policy.
   * @returns Complete raw discovery, never a partial or filtered directory.
   */
  discover?: typeof discoverMcp
}

/** Only fixed messages escape worker failures; no database, endpoint, credential, or tool text is copied. */
export class McpCheckWorkerError extends Error {
  constructor(readonly code: 'mcp_check_worker_running' | 'mcp_check_worker_config_invalid'
    | 'mcp_check_finish_uncertain') { super(code); this.name = 'McpCheckWorkerError' }
}

const admissionCodes = new Set(['mcp_tool_size_limit', 'mcp_tool_name_conflict', 'mcp_tasks_unsupported',
  'mcp_schema_unsupported', 'mcp_description_size_limit'])
const storeCodes = new Set(['mcp_check_stale', 'mcp_connection_not_found', 'revision_conflict',
  'mcp_catalog_limit', 'mcp_tool_duplicate', 'mcp_tool_collision'])

function leaseLost(error: unknown): boolean {
  return error instanceof PlatformError && error.code === 'mcp_check_lease_lost'
}

function failureCode(error: unknown, fallback: string): string {
  if (error instanceof McpToolAdmissionError && admissionCodes.has(error.code)) return error.code
  if (error instanceof McpTransportError) return `mcp_${error.code}`
  if (error instanceof PlatformError && storeCodes.has(error.code)) return error.code
  return fallback
}

async function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  try { await delay(ms, undefined, { signal }); return !signal.aborted }
  catch (error) {
    if (signal.aborted) return false
    throw error
  }
}

/** One instance processes one leased check at a time and stops renewing before any terminal write. */
export class McpCheckWorker {
  private readonly options: Readonly<McpCheckWorkerOptions>
  private readonly discover: typeof discoverMcp
  private active: Promise<void> | undefined
  private controller: AbortController | undefined

  constructor(private readonly store: McpCheckWorkerStore, options: McpCheckWorkerOptions) {
    if ([options.pollMs, options.renewMs, options.toolLimits.maxToolBytes,
      options.toolLimits.maxDescriptionBytes].some(value => !Number.isSafeInteger(value) || value < 1)
      || options.pollMs > 2_147_483_647 || options.renewMs > 2_147_483_647) {
      throw new McpCheckWorkerError('mcp_check_worker_config_invalid')
    }
    mcpLeaseOwnerId.parse(options.ownerId)
    this.options = Object.freeze({ ...options, budgets: validateMcpBudgets(options.budgets),
      toolLimits: Object.freeze({ ...options.toolLimits }) })
    this.discover = options.discover ?? discoverMcp
  }

  /** Poll until cancellation; unknown terminal commits reject instead of reusing the former epoch.
   * @param signal Supervisor cancellation. In-flight store methods must settle before this returns.
   * @returns Completion after every owned renewal, discovery, and terminal write has settled.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.active) throw new McpCheckWorkerError('mcp_check_worker_running')
    const controller = new AbortController()
    this.controller = controller
    const combined = AbortSignal.any([signal, controller.signal])
    const active = Promise.resolve().then(() => this.loop(combined))
    this.active = active
    try { await active }
    finally { this.active = undefined; this.controller = undefined }
  }

  /** Abort network work and wait for all store and renewal operations, including an already-started finish.
   * @returns Completion after every operation owned by the active run has settled.
   */
  async stop(): Promise<void> {
    const active = this.active
    this.controller?.abort()
    await active
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let lease: McpCheckLease | null
      try { lease = await this.store.claimCheck(this.options.ownerId) }
      catch (_pollFailure) {
        if (!await wait(this.options.pollMs, signal)) return
        continue
      }
      if (signal.aborted) return
      if (!lease) {
        if (!await wait(this.options.pollMs, signal)) return
        continue
      }
      await this.check(lease, signal)
    }
  }

  private async check(lease: McpCheckLease, supervisor: AbortSignal): Promise<void> {
    const lost = new AbortController(), renewalStop = new AbortController()
    const signal = AbortSignal.any([supervisor, lost.signal])
    const renewalSignal = AbortSignal.any([supervisor, renewalStop.signal])
    const renewal = (async () => {
      while (await wait(this.options.renewMs, renewalSignal)) {
        try { await this.store.renewCheck(lease) }
        catch (_renewalFailure) { lost.abort(); return }
      }
    })()
    let outcome: { tools: readonly McpDiscoveredTool[] } | { errorCode: string } | undefined
    try {
      let snapshot: McpPrivateSnapshot
      try { snapshot = await this.store.checkSnapshot(lease) }
      catch (error) {
        if (leaseLost(error)) lost.abort()
        else outcome = { errorCode: failureCode(error, 'mcp_check_snapshot_failed') }
        return
      }
      if (signal.aborted) return
      try {
        const raw = await this.discover({ endpoint: snapshot.serverUrl, headers: snapshot.headers },
          { signal, budgets: this.options.budgets, networkPolicy: this.options.networkPolicy })
        if (signal.aborted) return
        const tools = raw.tools.map(tool => mcpDiscoveredTool.parse(tool))
        const mapped = mcpCatalogTools(snapshot.resourceId, tools)
        if (tools.length > this.options.budgets.maxTools
          || Buffer.byteLength(mcpCanonicalJson(mapped)) > this.options.budgets.maxCatalogBytes) {
          outcome = { errorCode: 'mcp_catalog_limit' }
        } else {
          for (const tool of mapped) compileMcpModelTool(tool, this.options.toolLimits)
          outcome = { tools }
        }
      } catch (error) { outcome = { errorCode: failureCode(error, 'mcp_check_discovery_failed') } }
    } finally {
      renewalStop.abort()
      await renewal
      if (!signal.aborted && outcome) await this.finish(lease, outcome)
    }
  }

  private async finish(lease: McpCheckLease, outcome: { tools: readonly McpDiscoveredTool[] } | { errorCode: string }): Promise<void> {
    try {
      const finished = await this.store.finishCheck(lease, outcome)
      if (finished.state === 'queued' || finished.state === 'running') throw new McpCheckWorkerError('mcp_check_finish_uncertain')
    } catch (error) {
      if (leaseLost(error)) return
      if ('tools' in outcome && error instanceof PlatformError && error.status === 413
        && error.code === 'mcp_catalog_limit') {
        await this.finish(lease, { errorCode: 'mcp_catalog_limit' })
        return
      }
      throw new McpCheckWorkerError('mcp_check_finish_uncertain')
    }
  }
}
