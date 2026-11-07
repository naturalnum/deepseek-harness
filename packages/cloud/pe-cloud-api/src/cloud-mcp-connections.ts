/** Optional account-local Remote over native clients, private files and the original authenticated Peer/save owners. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mcpConnectionInput, McpConnectionWriteRefused, type CloudAccountFiles,
  type AccountMcpConnectionStore, type McpConnectionId, type McpConnectionRecord } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { CloudAccountApi } from './account-service.ts'
import type { ConfigSaveBarrier } from './save-hooks.ts'
import type { ExposureInventory } from './types.ts'
import type { CloudMcpConnectionRequest, CloudMcpConnectionReply } from './mcp-types.ts'
import type { ApprovedMcpConnections } from './mcp-policy.ts'
import { AccountMcpConnections, McpConnectionCleanupError } from './mcp-connection-runtime.ts'
import { CloudApiError } from './errors.ts'

/** Original Root callbacks and selected policy; no authority comes from request JSON. */
export interface CloudMcpConnectionPreparation {
  readonly files: CloudAccountFiles
  readonly policy: ApprovedMcpConnections
  readonly assertBusinessCurrent: () => void
  readonly assertToolCurrent: (exec: Pick<ToolRunContext, 'agent' | 'signal'>) => void
}
declare module '@deepseek-ai/cordis' { interface Context { cloudMcpConnections: CloudMcpConnectionService } }
const namespace = 'cloudMcpConnections'
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'MCP connection management is unavailable.') }
function original(value: object): object { const raw: unknown = Reflect.get(value, symbols.original)
  return raw !== null && typeof raw === 'object' ? raw : value }

/** One optional management capability; protocol implementation remains entirely in dsh-mcp-client. */
export class CloudMcpConnectionService extends TypertRemoteService {
  private readonly runtime: AccountMcpConnections
  private constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly input: CloudMcpConnectionPreparation,
    private readonly data: AccountMcpConnectionStore, private readonly saves: ConfigSaveBarrier) {
    super(ctx, 'cloudMcpConnections', { namespace: 'cloudMcpConnections' })
    this.runtime = new AccountMcpConnections(ctx, data, input.policy.runtime,
      () => { this.current(); input.assertBusinessCurrent() }, input.assertToolCurrent)
    ctx.on('system-prompt/prepare', async (context, next) => {
      if (context.agent === undefined) return next()
      context.signal?.throwIfAborted()
      await this.runtime.restore()
      context.signal?.throwIfAborted()
      return next()
    })
    const owner = ctx.get('peCloudApi')
    if (owner === undefined || original(owner) !== original(api)) unavailable()
    owner.registerCapabilityInventory(namespace, () => this.inspect())
  }

  /** Install only from original account-native preparation before graph publication.
   * @param ctx Original account entry.
   * @param api Original account API.
   * @param input Trusted files, policy and current-auth callbacks.
   * @param saves Original account save barrier.
   * @returns Installed optional service; enabled external clients restore at first admitted read or model step.
   */
  static async prepare(ctx: Context, api: CloudAccountApi, input: CloudMcpConnectionPreparation,
    saves: ConfigSaveBarrier): Promise<CloudMcpConnectionService> {
    api.assertInstalled(ctx); input.files.assertInstalled(ctx)
    if (saves.binding !== api.binding || input.files.binding !== api.binding || ctx.get(namespace) !== undefined) unavailable()
    const data = await input.files.mcpConnections(ctx, input.policy.limits, input.assertBusinessCurrent,
      task => saves.admit('mcp-connection', task))
    api.assertInstalled(ctx)
    return new CloudMcpConnectionService(ctx, api, input, data, saves)
  }

  /** Dispatch bounded account-local operations under the actual authenticated Peer.
   * @param request Complete closed request; headers are transient credential input and never returned.
   * @param signal Original request observer.
   * @returns Actual list, generation revision and optional probe observation after complete application settlement.
   */
  @Remote('action')
  action(request: CloudMcpConnectionRequest, signal: AbortSignal): Promise<CloudMcpConnectionReply> {
    void request
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc(namespace + '/action')
    const invocation = this.ctx.invocation
    if (invocation?.service !== namespace || invocation.request.namespace !== namespace || invocation.request.method !== 'action'
      || Object.keys(invocation.request.args).length !== 1 || !Object.hasOwn(invocation.request.args, 'request')) unavailable()
    const value = this.parse(invocation.request.args.request)
    const operationSignal = AbortSignal.any([signal, invocation.peer.signal, this.api.binding.lifetime])
    return this.api.withPeerUse(invocation.peer, async (_use, principal) => {
      const check = (): void => {
        operationSignal.throwIfAborted(); principal(); this.current()
        this.api.requireRpc(namespace + '/action')
      }
      check(); await this.runtime.restore(); check()
      let test: CloudMcpConnectionReply['test']
      if (value.action === 'test') {
        const probe = await this.saves.admit('mcp-connection', async () => {
          try {
            check()
            const run = async (headers: Record<string, string>) => this.runtime.test({ ...value.connection, headers }, operationSignal)
            const observed = value.connection.headers === undefined && value.id !== undefined
              ? await this.data.withHeaders(value.id, run) : await run({ ...value.connection.headers })
            return { ok: true as const, observed }
          } catch (error) {
            if (error instanceof McpConnectionCleanupError) throw error
            return { ok: false as const, error }
          }
        })
        if (!probe.ok) throw probe.error
        const observed = probe.observed
        check()
        test = observed.reachable ? { reachable: true, toolCount: observed.tools.length }
          : { reachable: false, toolCount: 0, failure: observed.failure }
      } else if (value.action !== 'list') {
        const outcome = await this.saves.admit('mcp-connection', async () => {
          try { check() } catch (error) { return { refused: true as const, error } }
          if (value.version !== this.data.version()) return { conflict: true as const }
          const rows = this.data.list()
          if (value.action === 'save' && (value.id !== undefined && !rows.some(row => row.id === value.id)
            || rows.some(row => row.id !== value.id && row.serverName === value.connection.serverName)
            || value.id === undefined && rows.length >= this.input.policy.limits.maxConnections)) {
            return { conflict: true as const }
          }
          if (value.action === 'remove') {
            if (!this.data.list().some(row => row.id === value.id)) return { conflict: true as const }
            await this.runtime.detach(value.id); check(); await this.data.remove(value.id, check)
          } else {
            const previous = value.action === 'enabled' ? this.data.list().find(row => row.id === value.id) : undefined
            if (value.action === 'enabled' && previous === undefined) return { conflict: true as const }
            const connection = value.action === 'save' ? value.connection : (() => {
              if (previous === undefined) unavailable()
              const { id: _id, ...definition } = previous
              return { ...definition, enabled: value.enabled }
            })()
            let row: McpConnectionRecord
            try { row = await this.data.save(value.id, connection, check) }
            catch (error) {
              if (error instanceof McpConnectionWriteRefused) return { refused: true as const, error: error.reason }
              throw error
            }
            check(); await this.runtime.apply(row)
          }
          check(); return { conflict: false as const }
        })
        if ('refused' in outcome) throw outcome.error
        if (outcome.conflict) throw new CloudApiError('cloud/config-conflict', 'The MCP connections changed; refresh before saving.')
      }
      const snapshot = await this.saves.admit('mcp-connection', async () => {
        // Read-only failures submit no provider write and cannot poison the account save owner.
        try { return { ok: true as const, reply: await this.snapshot(check, test) } }
        catch (error) { return { ok: false as const, error } }
      })
      if (!snapshot.ok) throw snapshot.error
      return snapshot.reply
    })
  }

  private async snapshot(check: () => void, test: CloudMcpConnectionReply['test']): Promise<CloudMcpConnectionReply> {
    check()
    const connections: CloudMcpConnectionReply['connections'][number][] = []
    const tools = this.ctx.get('tools')
    if (tools === undefined) unavailable()
    const schemas = tools.schemas()
    for (const row of this.data.list()) {
      const configured = await this.data.configured(row.id); check()
      connections.push({ ...row, configured,
        toolCount: schemas.filter(tool => tool.name.startsWith(`mcp__${row.serverName}__`)).length })
    }
    const reply: CloudMcpConnectionReply = { connections, version: this.data.version(),
      limits: { maxConnections: this.input.policy.limits.maxConnections,
        maxToolCallTimeoutMs: this.input.policy.limits.maxToolCallTimeoutMs }, ...test === undefined ? {} : { test } }
    check()
    if (Buffer.byteLength(JSON.stringify(reply)) > this.input.policy.limits.maxReplyBytes) unavailable()
    return reply
  }

  /** Audit the exact native service/method declaration; registration alone does not open an endpoint.
   * @returns Current capability inventory with authenticated-account admission.
   */
  inspect(): ExposureInventory {
    this.current()
    const remote = this.typertRemote, methods = remoteMethods(this)
    if (remote.service !== original(this) || remote.serviceKey !== namespace || remote.namespace !== namespace
      || methods.length !== 1 || methods[0]?.method !== 'action'
      || Reflect.get(original(this), 'action') !== CloudMcpConnectionService.prototype.action) unavailable()
    return { recipeVersion: this.api.binding.recipeVersion, rpcEndpoints: [{ endpoint: namespace + '/action',
      handlerId: 'native:' + namespace, guard: 'authenticated-account' }], streamEndpoints: [], exactFetchRoutes: [] }
  }
  private current(): void {
    this.api.assertInstalled(this.ctx); this.input.files.assertInstalled(this.ctx)
    if (original(this.ctx.get(namespace) ?? {}) !== original(this)
      || original(this.ctx.root.get(namespace) ?? {}) !== original(this)) unavailable()
  }
  private parse(raw: unknown): CloudMcpConnectionRequest {
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > this.input.policy.limits.maxRequestBytes) unavailable()
      const id = z.uuid().transform(value => brandString<McpConnectionId>(value)), version = z.string().min(1).max(128)
      const connection = z.unknown().transform(value => mcpConnectionInput(value, this.input.policy.limits))
      return z.discriminatedUnion('action', [z.strictObject({ action: z.literal('list') }),
        z.strictObject({ action: z.literal('save'), id: id.optional(), version, connection }),
        z.strictObject({ action: z.literal('enabled'), id, version, enabled: z.boolean() }),
        z.strictObject({ action: z.literal('remove'), id, version }),
        z.strictObject({ action: z.literal('test'), id: id.optional(), connection })]).parse(raw)
    } catch (_error) { throw new CloudApiError('cloud/forbidden', 'Invalid MCP connection request.') }
  }
}
