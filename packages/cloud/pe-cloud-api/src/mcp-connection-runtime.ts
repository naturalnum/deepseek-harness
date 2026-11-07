/** Optional account HTTP MCP connections; the official client owns transport, discovery, execution and reconnection. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { AccountMcpConnectionStore, McpConnectionInput, McpConnectionRecord, McpConnectionId } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Explicit native reconnect policy selected by deployment. */
export interface McpConnectionRuntimePolicy {
  readonly maxInstructionBytes: number
  readonly reconnect: Readonly<{ enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }>
}
/** Probe reports only observations from this one authenticated HTTP handshake. */
export type McpConnectionTest = Readonly<{ reachable: true; tools: readonly string[] }>
  | Readonly<{ reachable: false; failure: 'connection-failed' }>

/** Account-owned optional native-client assembly; it never edits Loader entries or installs packages. */
export class AccountMcpConnections {
  private readonly mounted = new Map<McpConnectionId, Fiber>()
  private readonly namespaces = new Map<McpConnectionId, string>()
  private stopping: Promise<void> | undefined

  /**
   * @param ctx Original account plugin scope with the existing native tool registry.
   * @param store Original account-private metadata and credential owner.
   * @param policy Explicit deployment reconnect and instruction budgets.
   * @param current Account generation and business check for public operations.
   * @param toolCurrent Original account/session/Agent authorization repeated before and after calls.
   */
  constructor(private readonly ctx: Context, private readonly store: AccountMcpConnectionStore,
    private readonly policy: McpConnectionRuntimePolicy, private readonly current: () => void,
    toolCurrent: (exec: ToolRunContext) => void) {
    ctx.on('tools/pre-execute', async (exec, next) => {
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
  async restore(): Promise<void> {
    for (const row of this.store.list()) await this.apply(row)
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
        apply: async (scope: Context): Promise<void> => { await McpClient.apply(scope, config) } })
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
    await fiber.dispose()
    while (fiber.inertia !== undefined) await fiber.inertia
    this.mounted.delete(id); this.namespaces.delete(id)
  }

  /** Probe without publishing tools to the account or any model.
   * @param input Validated complete HTTP input, including transient headers for this test.
   * @param signal Original request observer lifetime.
   * @returns Sanitized observation; errors never echo URL headers, token values or remote response bodies.
   */
  async test(input: McpConnectionInput, signal: AbortSignal): Promise<McpConnectionTest> {
    this.check(); signal.throwIfAborted()
    const probe = createScope(this.ctx, {})
    const cancel = (): void => { void probe.dispose() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await probe.ctx.plugin(McpClient, this.config(input, { ...input.headers }, true))
      this.check(); signal.throwIfAborted()
      const tools = probe.ctx.get('tools')
      if (tools === undefined) throw new Error('cloud/mcp-probe-tools-unavailable')
      return { reachable: true, tools: tools.schemas(scopeOf(probe.ctx)).map(tool => tool.name)
        .filter(name => name.startsWith(`mcp__${input.serverName}__`)) }
    } catch (_error) {
      this.check(); signal.throwIfAborted()
      return { reachable: false, failure: 'connection-failed' }
    } finally {
      signal.removeEventListener('abort', cancel)
      await probe.dispose()
    }
  }

  /** Close all retained native clients; repeated calls join the same teardown.
   * @returns Actual client disposal, without declaring unknown work released.
   */
  close(): Promise<void> {
    return this.stopping ??= (async () => {
      const results = await Promise.allSettled([...this.mounted.values()].map(async (fiber) => {
        await fiber.dispose()
        while (fiber.inertia !== undefined) await fiber.inertia
      }))
      if (results.some(result => result.status === 'rejected')) throw new Error('cloud/mcp-close-unconfirmed')
      this.mounted.clear(); this.namespaces.clear()
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
      reconnect: strict ? { ...this.policy.reconnect, enabled: false } : this.policy.reconnect })
  }
}
