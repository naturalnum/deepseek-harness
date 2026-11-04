/** Account-native management Remote over original Peer/Use, private files/credentials and native tool execution. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { Remote, remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { installRemoteServerTools, uploadedSshConfig } from '@deepseek-ai/dsh-remote-server-cloud'
import { assertRemoteSshAvailable, runRemoteSsh, type RemoteSshConfig } from '@deepseek-ai/dsh-pe-opensandbox'
import type { CloudAccountFiles, AccountRemoteServerStore, RemoteStoreLimits } from '@deepseek-ai/dsh-pe-cloud-files'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'
import type { CloudAccountApi } from './account-service.ts'
import type { ConfigSaveBarrier } from './save-hooks.ts'
import type { ExposureInventory } from './types.ts'
import type { RemoteServerRequest, RemoteServerReply } from './remote-server-types.ts'
import { remoteServerApproval } from './remote-server-approval.ts'
import { CloudApiError } from './errors.ts'

/** Trusted Root selection only; all capacity remains with original owners. */
export interface CloudRemoteServerPreparation extends ModelKeyPeerConsumer {
  readonly files: CloudAccountFiles
  readonly limits: RemoteStoreLimits & { readonly maxRequestBytes: number; readonly maxReplyBytes: number; readonly maxImportBytes: number }
  readonly execution: RemoteSshConfig
  readonly assertBusinessCurrent: () => void
  readonly assertToolCurrent: (exec: ToolRunContext) => void
}
declare module '@deepseek-ai/cordis' { interface Context { cloudRemoteServers: CloudRemoteServerService } }
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'Account remote-server management is unavailable.') }
function original(value: object): object { const raw: unknown = Reflect.get(value,
  symbols.original); return raw !== null && typeof raw === 'object' ? raw : value }

/** Fixed audited management endpoint; it cannot execute an SSH command or select an account/path from JSON. */
export class CloudRemoteServerService extends TypertRemoteService {
  private constructor(ctx: Context, private readonly api: CloudAccountApi, private readonly input: CloudRemoteServerPreparation,
    private readonly data: AccountRemoteServerStore) {
    super(ctx, 'cloudRemoteServers', { namespace: 'cloudRemoteServers' })
    installRemoteServerTools(ctx, data.collection, {
      maxReplyBytes: input.limits.maxReplyBytes,
      assertCurrent: (exec) => { this.current(); input.assertBusinessCurrent(); input.assertToolCurrent(exec) },
      approval: exec => remoteServerApproval(ctx, api.binding, exec,
        () => { input.assertBusinessCurrent(); input.assertToolCurrent(exec) }),
      run: (exec, target, command, current, probe) => data.withCredential(target.id,
        secret => runRemoteSsh(ctx, target, secret, command, exec.signal, input.execution, current, probe)),
    })
    ctx.effect(() => () => { api.invalidate() }, 'pe-cloud-api: revoke remote-server management and tools')
  }

  /** Prepare from original files and save owners before native graph publication.
   * @param ctx Original native account effect.
 * @param api Same account API.
   * @param input Root-selected policy and original capabilities.
 * @param saves Original account save barrier.
   * @returns Exact newly installed Remote; no business readiness is issued.
   */
  static async prepare(ctx: Context, api: CloudAccountApi, input: CloudRemoteServerPreparation,
    saves: ConfigSaveBarrier): Promise<CloudRemoteServerService> {
    api.assertInstalled(ctx); input.files.assertInstalled(ctx)
    if (saves.binding !== api.binding || input.files.binding !== api.binding || ctx.get('cloudRemoteServers') !== undefined) unavailable()
    assertRemoteSshAvailable(ctx, input.execution)
    const data = await input.files.remoteServers(ctx, input.limits, input.assertBusinessCurrent, task => saves.admit('remote-server', task))
    api.assertInstalled(ctx)
    return new CloudRemoteServerService(ctx, api, input, data)
  }

  /** Dispatch only strict account-local management JSON through the original authenticated Peer borrow.
   * @param request Bounded untrusted wire request.
 * @param signal Original observer lifetime.
   * @returns Sanitized metadata and actual observations; key material is never returned.
   */
  @Remote('action')
  action(request: RemoteServerRequest, signal: AbortSignal): Promise<RemoteServerReply> {
    void request
    signal.throwIfAborted(); this.inspect(); this.api.requireRpc('cloudRemoteServers/action')
    const invocation = this.ctx.invocation
    if (invocation?.service !== 'cloudRemoteServers' || invocation.request.namespace !== 'cloudRemoteServers'
      || invocation.request.method !== 'action' || Object.keys(invocation.request.args).length !== 1) unavailable()
    const raw: unknown = invocation.request.args.request
    let value: RemoteServerRequest
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > this.input.limits.maxRequestBytes) unavailable()
      const id = z.uuid(), form = z.strictObject({ alias: z.string().max(64), host: z.string().max(255), user: z.string().max(64),
        port: z.number().int(), description: z.string().max(1024), tags: z.array(z.string().max(64)).max(16), alwaysAsk: z.boolean() })
      value = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('list') }),
        z.strictObject({ action: z.literal('add'), entry: form }), z.strictObject({ action: z.literal('update'), id, entry: form }),
        z.strictObject({ action: z.literal('remove'), id }), z.strictObject({ action: z.literal('reorder'),
          ids: z.array(id).max(this.input.limits.maxServers) }),
        z.strictObject({ action: z.literal('credential'), id, privateKey: z.string().max(this.input.limits.maxPrivateKeyBytes),
          knownHosts: z.string().max(this.input.limits.maxKnownHostsBytes) }),
        z.strictObject({ action: z.literal('import'), text: z.string().max(this.input.limits.maxImportBytes) })]).parse(raw)
    } catch (_error) { throw new CloudApiError('cloud/forbidden', 'Invalid remote-server management request.') }
    return this.input.withModelKeyPeerUse(invocation.peer, async (use, principal) => {
      const check = (): void => {
        principal(); use.assertCurrent(); this.current()
        if (use.binding !== this.api.binding || use.context.root !== this.ctx.root) unavailable()
        this.api.requireRpc('cloudRemoteServers/action')
      }
      check(); signal.throwIfAborted()
      let imported: number | undefined
      if (value.action !== 'list') await this.data.mutate(async () => {
        check(); signal.throwIfAborted()
        switch (value.action) {
          case 'add': await this.data.collection.add(value.entry); break
          case 'update': await this.data.collection.update(value.id, value.entry); break
          case 'remove': await this.data.collection.remove(value.id); break
          case 'reorder': await this.data.collection.reorder(value.ids); break
          case 'credential': await this.data.setCredential(value.id, value); break
          case 'import': {
            const candidates = uploadedSshConfig(value.text, this.input.limits.maxImportBytes)
            const existing = new Set(this.data.collection.list().map(row => row.entry.alias))
            const additions = candidates.filter(row => !existing.has(row.alias))
            if (additions.some(row => row.user === undefined) || additions.length + existing.size > this.input.limits.maxServers) {
              throw new CloudApiError('cloud/forbidden', 'Imported hosts need explicit SSH users and must fit the server limit.')
            }
            imported = await this.data.collection.addMany(additions.map(candidate => ({ alias: candidate.alias, host: candidate.host,
              user: candidate.user, port: candidate.port ?? 22, tags: [], description: '', alwaysAsk: false })))
            break
          }
        }
        check()
      })
      check()
      const servers: import('./remote-server-types.ts').RemoteServerView[] = []
      for (const row of this.data.collection.states()) {
        const configured = await this.data.configured(row.entry.id); check()
        servers.push({ ...row, configured })
      }
      const reply: RemoteServerReply = { servers, limits: { maxPrivateKeyBytes: this.input.limits.maxPrivateKeyBytes,
        maxKnownHostsBytes: this.input.limits.maxKnownHostsBytes,
        maxImportBytes: this.input.limits.maxImportBytes }, ...imported === undefined ? {} : { imported } }
      if (Buffer.byteLength(JSON.stringify(reply)) > this.input.limits.maxReplyBytes) {
        for (let index = servers.length - 1; index >= 0; index--) {
          const row = servers[index]
          if (row === undefined) unavailable()
          if (row.facts !== undefined) { const { facts: _facts, ...metadata } = row; servers[index] = { ...metadata, factsOmitted: true } }
          if (Buffer.byteLength(JSON.stringify(reply)) <= this.input.limits.maxReplyBytes) break
        }
        if (Buffer.byteLength(JSON.stringify(reply)) > this.input.limits.maxReplyBytes) unavailable()
      }
      signal.throwIfAborted(); check()
      return reply
    }).catch((_error: unknown) => { throw new CloudApiError('cloud/account-unavailable',
      'Remote-server operation is unavailable or unconfirmed.') })
  }

  /** Exact service/method identity inventory for the original complete account audit.
   * @returns Installed audited endpoint only; no metadata or credential read is performed.
   */
  inspect(): ExposureInventory {
    this.current()
    const remote = this.typertRemote, methods = remoteMethods(this)
    if (remote.service !== original(this) || remote.serviceKey !== 'cloudRemoteServers' || remote.namespace !== 'cloudRemoteServers'
      || methods.length !== 1 || methods[0]?.method !== 'action'
      || Reflect.get(original(this), 'action') !== CloudRemoteServerService.prototype.action) unavailable()
    const descriptor = this.ctx.get('typert')?.local.get('cloudRemoteServers/action')
    if (descriptor === undefined || descriptor.service !== 'cloudRemoteServers' || descriptor.namespace !== 'cloudRemoteServers'
      || descriptor.method !== 'action' || (descriptor.implementation ?? 'action') !== 'action' || (descriptor.mode ?? 'rpc') !== 'rpc'
      || descriptor.invocation.kind !== 'direct' || descriptor.parameters.length !== 1
      || descriptor.parameters[0]?.wire !== 'request' || descriptor.parameters[0].source !== 'json'
      || descriptor.parameters[0].codec.mode !== 'strict' || descriptor.result.mode !== 'strict'
      || descriptor.cancellation?.parameter !== 'signal') unavailable()
    return { recipeVersion: this.api.binding.recipeVersion,
      rpcEndpoints: [{ endpoint: 'cloudRemoteServers/action', handlerId: 'cloud:remote-servers', guard: 'authenticated-account' }],
      streamEndpoints: [], exactFetchRoutes: [] }
  }
  private current(): void {
    this.api.assertInstalled(this.ctx)
    if (original(this.ctx.get('cloudRemoteServers') ?? {}) !== original(this)
      || original(this.ctx.root.get('cloudRemoteServers') ?? {}) !== original(this)) unavailable()
    this.input.files.assertInstalled(this.ctx)
  }
}
