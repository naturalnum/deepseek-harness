/** Optional account HTTP MCP connections; the official client owns transport, discovery, execution and reconnection. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { AccountMcpConnectionStore, McpConnectionInput, McpConnectionRecord, McpConnectionId } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'

/** Explicit native HTTP admission and reconnect policy selected by deployment. */
export interface McpConnectionRuntimePolicy {
  readonly maxInstructionBytes: number
  readonly maxIncomingResponseBytes: number
  readonly listMaxPages: number
  readonly reconnect: Readonly<{ enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }>
}
/** Probe reports only observations from this one authenticated HTTP handshake. */
export type McpConnectionTest = Readonly<{ reachable: true; tools: readonly string[] }>
  | Readonly<{ reachable: false; failure: 'connection-failed' }>

/** Native supervisor could not confirm release; the original host must retain this operation. */
export class McpConnectionCleanupError extends ConfigSaveOutcomeUnknown {
  constructor() { super({ cause: new Error('cloud/mcp-close-unconfirmed') }) }
}

/** Account-owned optional native-client assembly; it never edits Loader entries or installs packages. */
export class AccountMcpConnections {
  private readonly mounted = new Map<McpConnectionId, Fiber>()
  private readonly namespaces = new Map<McpConnectionId, string>()
  private readonly clients = new Map<McpConnectionId, McpClient.McpClientLifecycle>()
  private readonly probes = new Set<McpClient.McpClientLifecycle>()
  private stopping: Promise<void> | undefined
  private restoration: Promise<void> | undefined

  /**
   * @param ctx Original account plugin scope with the existing native tool registry.
   * @param store Original account-private metadata and credential owner.
   * @param policy Explicit deployment reconnect and instruction budgets.
   * @param current Account generation and business check for public operations.
   * @param toolCurrent Original account/session/Agent authorization repeated before and after calls.
   */
  constructor(private readonly ctx: Context, private readonly store: AccountMcpConnectionStore,
    private readonly policy: McpConnectionRuntimePolicy, private readonly current: () => void,
    toolCurrent: (exec: Pick<ToolRunContext, 'agent' | 'signal'>) => void) {
    ctx.on('tools/execute', async (exec, next) => {
      if (![...this.namespaces.values()].some(name => exec.name.startsWith(`mcp__${name}__`))) return next()
      this.check(); toolCurrent(exec)
      const result = await next()
      this.check(); toolCurrent(exec)
      return result
    })
    ctx.effect(() => () => this.close(), 'pe-cloud-api: close optional native MCP clients')
  }

  /** Restore enabled definitions after the account's private providers are installed.
   * @returns Actual initial client connection/discovery settlement; unavailable external servers retain native reconnect behavior.
   */
  restore(): Promise<void> {
    this.check()
    return this.restoration ??= (async () => {
      for (const row of this.store.list()) await this.apply(row)
    })()
  }

  /** Observe only the saved connection's original native registrations, including definitions retained while disconnected.
   * @param id Original account-local saved connection identifier.
   * @returns Current owned registration count; an unmounted connection owns none.
   */
  toolCount(id: McpConnectionId): number {
    this.check()
    return this.clients.get(id)?.registeredTools().length ?? 0
  }

  /** Replace only the selected account connection after its durable definition has committed.
   * @param row Persisted account-local definition.
   * @returns Actual old-client disposal and new-client initial discovery settlement.
   */
  async apply(row: McpConnectionRecord): Promise<void> {
    this.check()
    await this.detach(row.id)
    this.check()
    if (!row.enabled) return
    await this.store.withHeaders(row.id, async (headers) => {
      this.check()
      const config = this.config(row, headers, false)
      const fiber = this.ctx.plugin({ name: `cloud-mcp-${row.id}`, inject: ['tools'],
        apply: async (scope: Context): Promise<void> => {
          await McpClient.apply(scope, config, lifecycle => this.clients.set(row.id, lifecycle))
        } })
      this.mounted.set(row.id, fiber); this.namespaces.set(row.id, row.serverName)
      await fiber
      this.check()
    })
  }

  /** Remove the live registration before deleting its persistent definition.
   * @param id Account-local connection identifier.
   * @returns Actual official client teardown, including pending transport work.
   */
  async detach(id: McpConnectionId): Promise<void> {
    this.check()
    const fiber = this.mounted.get(id)
    if (fiber === undefined) return
    const confirmed = await this.clients.get(id)?.close()
    await fiber.dispose()
    while (fiber.inertia !== undefined) await fiber.inertia
    if (confirmed !== true) throw new McpConnectionCleanupError()
    this.mounted.delete(id); this.namespaces.delete(id)
    this.clients.delete(id)
  }

  /** Probe without publishing tools to the account or any model.
   * @param input Validated complete HTTP input, including transient headers for this test.
   * @param signal Original request observer lifetime.
   * @returns Sanitized observation; errors never echo URL headers, token values or remote response bodies.
   */
  async test(input: McpConnectionInput, signal: AbortSignal): Promise<McpConnectionTest> {
    this.check(); signal.throwIfAborted()
    const probe = createScope(this.ctx, {})
    let lifecycle: McpClient.McpClientLifecycle | undefined
    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => disposal ??= probe.dispose()
    const close = (): Promise<boolean> => lifecycle?.close() ?? Promise.resolve(true)
    // Observe the cancellation-triggered promise immediately, then await its real outcome in finally.
    const cancel = (): void => {
      // Ask the original supervisor to stop before waiting on the parent scope's child startup.
      void close().then(() => {}, () => {})
      void dispose().then(() => {}, () => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const observation = { connected: false }
      await probe.ctx.plugin({ name: 'cloud-mcp-probe', inject: ['tools'], apply: async (owner: Context) => {
        // A refused transient handshake is an observation, not a failed required Loader entry.
        try {
          await McpClient.apply(owner, this.config(input, { ...input.headers }, true), (observed) => {
            lifecycle = observed; this.probes.add(observed)
          })
          observation.connected = true
        } catch (_error) { /* Return a sanitized observation after the same native lifecycle is joined. */ }
      } })
      this.check(); signal.throwIfAborted()
      if (!observation.connected) return { reachable: false, failure: 'connection-failed' }
      if (lifecycle === undefined) throw new Error('cloud/mcp-probe-lifecycle-unavailable')
      return { reachable: true, tools: lifecycle.registeredTools() }
    } catch (_error) {
      this.check(); signal.throwIfAborted()
      return { reachable: false, failure: 'connection-failed' }
    } finally {
      signal.removeEventListener('abort', cancel)
      const confirmed = await close()
      await dispose()
      if (lifecycle !== undefined) {
        if (!confirmed) throw new McpConnectionCleanupError()
        this.probes.delete(lifecycle)
      }
    }
  }

  /** Close all retained native clients; repeated calls join the same teardown.
   * @returns Actual client disposal, without declaring unknown work released.
   */
  close(): Promise<void> {
    return this.stopping ??= (async () => {
      const results = await Promise.allSettled([...this.mounted.entries()].map(async ([id, fiber]) => {
        const confirmed = await this.clients.get(id)?.close()
        await fiber.dispose()
        while (fiber.inertia !== undefined) await fiber.inertia
        if (confirmed !== true) throw new McpConnectionCleanupError()
      }))
      const probes = await Promise.allSettled([...this.probes].map(lifecycle => lifecycle.close()))
      if (results.some(result => result.status === 'rejected')
        || probes.some(result => result.status === 'rejected' || !result.value)) throw new McpConnectionCleanupError()
      this.mounted.clear(); this.namespaces.clear(); this.clients.clear(); this.probes.clear()
    })()
  }

  private check(): void {
    if (this.stopping !== undefined) throw new Error('cloud/mcp-connections-closed')
    this.ctx.fiber.assertActive(); this.current()
  }
  private config(row: McpConnectionInput, headers: Record<string, string>, strict: boolean): McpClient.Config {
    return McpClient.Config({ transport: 'streamable-http', serverName: row.serverName, url: row.url, headers,
      toolCallTimeoutMs: row.toolCallTimeoutMs, failOnStartupError: strict,
      maxInstructionBytes: this.policy.maxInstructionBytes,
      maxIncomingResponseBytes: this.policy.maxIncomingResponseBytes, listMaxPages: this.policy.listMaxPages,
      reconnect: strict ? { ...this.policy.reconnect, enabled: false } : this.policy.reconnect })
  }
}
