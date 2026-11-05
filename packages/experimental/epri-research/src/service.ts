/** Research business ownership; account admission and execution remain platform-owned. */
import { join, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountFeatureAdmission } from '@deepseek-ai/dsh-pe-cloud-api'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-fs'
import type { Config } from './index.ts'

interface CommandResult { stdout: string; stderr: string; exitCode: number | null }
interface ResearchScope {
  check(): void
  workspaceRoot: string
  run(argv: readonly string[], input: string, signal: AbortSignal, timeout: number): Promise<CommandResult>
  readBytes(path: string, signal: AbortSignal, maximum: number): Promise<Uint8Array>
  stat(path: string, signal: AbortSignal): Promise<{ size: number }>
}
interface ResearchStore {
  execute(op: string, args: unknown, actor: 'human' | 'agent', sessionId: string, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}
/** Interface of the independently built research backend; no network credentials are accepted. */
export interface ResearchBackend {
  install(kind: 'tools' | 'skills' | 'workbench', ctx: Context): void
  openCloudStore(input: {
    directory: string
    lifetime: AbortSignal
    assertCurrent: () => void
    python: string
    authorizeSession: (sessionId: string, signal: AbortSignal) => Promise<ResearchScope> }): ResearchStore
}

declare module '@deepseek-ai/cordis' {
  interface Context { epriResearch: ResearchService }
}

/** One research database beneath this account's private, physically capped storage. */
export class ResearchService extends TypertRemoteService {
  private readonly admission: AccountFeatureAdmission
  private readonly store: ResearchStore
  private readonly owner: Context

  constructor(ctx: Context, private readonly config: Config, private readonly backend: ResearchBackend) {
    const profile = ctx.get('profileContext'), api = ctx.peCloudApi
    api.assertInstalled(ctx)
    if (profile === undefined || !isAbsolute(profile.home) || ctx.get('epriResearch') !== undefined) {
      throw new Error('Research requires one original account profile and service.')
    }
    super(ctx, 'epriResearch')
    this.owner = ctx
    this.admission = api.registerFeature(ctx, this)
    this.store = backend.openCloudStore({
      directory: join(profile.home, 'storage', 'epri-research'), lifetime: api.binding.lifetime,
      assertCurrent: () => { this.admission.assertCurrent() }, python: config.python,
      authorizeSession: (id, signal) => this.authorize(brandString<SessionId>(id), signal),
    })
    ctx.effect(() => () => this.store.close(), 'epri-research: stop and join account work')
  }

  private checkBytes(value: string): void {
    if (Buffer.byteLength(value) > this.config.maxJsonBytes) throw new RangeError('Research JSON exceeds the configured account limit.')
  }

  /** Install the fixed research contribution into this account's Loader scope.
   * @param kind Fixed backend contribution selected by a package entry.
   * @param ctx Actual account or Preset Loader scope.
   */
  install(kind: 'tools' | 'skills' | 'workbench', ctx: Context): void {
    this.owner.peCloudApi.assertInstalled(ctx)
    if (ctx.root !== this.owner.root) throw new Error('Research contributions must share their original account.')
    this.backend.install(kind, ctx)
  }

  /** Project immutable bundled resources using the platform's existing skill files owner.
   * @param args Complete trusted skill bundle and native scoped lookup.
   * @returns Actual account/project resource location.
   */
  materializeSkill(...args: Parameters<AccountFeatureAdmission['materializeSkill']>): ReturnType<AccountFeatureAdmission['materializeSkill']> {
    return this.admission.materializeSkill(...args)
  }

  /** Read this account's human-published lab skills for the original native Agent.
   * @param agent Original native skill lookup scope.
   * @param signal Original lookup cancellation.
   * @returns Published research methods within this account only.
   */
  labSkills(agent: Agent, signal?: AbortSignal): Promise<unknown> {
    this.admission.assertAgent(agent)
    return this.store.execute('lab_skills', {}, 'agent', agent.session.id, signal)
  }

  /** Execute a research operation for the authenticated browser's current Session.
   * @param sessionId Existing Session selected in the platform.
   * @param operation Research operation name, validated by the backend.
   * @param argsJson Operation arguments, validated by the backend schema.
   * @param signal Original browser-call cancellation.
   * @returns Research result serialized as JSON within the configured limit.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async execute(sessionId: SessionId, operation: string, argsJson: string, signal: AbortSignal): Promise<string> {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal.kind !== 'owner' || invocation.peer.ctx.root !== this.owner.root || invocation.service !== 'epriResearch'
      || invocation.request.namespace !== 'epriResearch' || invocation.request.method !== 'execute') {
      throw new Error('Research browser operations require the original authenticated platform Peer.')
    }
    this.owner.peCloudApi.requireRpc('epriResearch/execute')
    this.checkBytes(operation); this.checkBytes(argsJson)
    const result = JSON.stringify(await this.store.execute(operation, JSON.parse(argsJson), 'human', sessionId, signal))
    this.admission.assertCurrent(); signal.throwIfAborted(); this.checkBytes(result)
    return result
  }

  /** Execute a model operation under the original native tool's Agent.
   * Human decisions are supplied only by the native conversation review continuation.
   * @param operation Backend operation name.
   * @param args Validated research tool arguments.
   * @param execution Original native tool execution.
   * @returns Research operation result; no caller-provided actor field is used.
   */
  async tool(operation: string, args: unknown, execution: ToolRunContext): Promise<unknown> {
    if (execution.agent === undefined) throw new Error('Research requires the original tool Agent.')
    this.admission.assertAgent(execution.agent)
    return this.store.execute(operation, args, 'agent', execution.agent.session.id, execution.signal)
  }

  /** Run the reviewed native question continuation without exposing a human actor on the wire.
   * @param execution Original tool Agent and cancellation.
   * @param review Trusted plugin's native question/revision comparison; it calls human only after an explicit answer.
   * @returns Decline or the exact reviewed mutation result.
   */
  async review(execution: ToolRunContext, review: (port: {
    read: (operation: string, args: unknown) => Promise<unknown>
    human: (operation: string, args: unknown) => Promise<unknown>
  }) => Promise<unknown>): Promise<unknown> {
    const agent = execution.agent
    if (agent === undefined) throw new Error('Research approval requires the original tool Agent.')
    const call = (actor: 'human' | 'agent', operation: string, args: unknown): Promise<unknown> => {
      this.admission.assertAgent(agent); execution.signal.throwIfAborted()
      return this.store.execute(operation, args, actor, agent.session.id, execution.signal)
    }
    this.admission.assertAgent(agent)
    const result = await review({ read: (op, args) => call('agent', op, args), human: (op, args) => call('human', op, args) })
    this.admission.assertAgent(agent); execution.signal.throwIfAborted()
    return result
  }

  private async authorize(id: SessionId, signal: AbortSignal): Promise<ResearchScope> {
    const agent = await this.admission.resolveAgent(id, signal)
    const check = (): void => { this.admission.assertAgent(agent) }
    const directory = agent.ctx.get('workingDirectory')
    if (directory === undefined) throw new Error('Research requires the native Session working directory.')
    const workspaceRoot = await directory.ensure(agent, signal)
    check(); signal.throwIfAborted()
    return { check, workspaceRoot,
      run: (argv, input, control, timeout) => this.run(agent, workspaceRoot, argv, input, control, timeout),
      readBytes: async (path, control, maximum) => {
        check(); const fs = agent.ctx.get('fs')
        if (fs === undefined) throw new Error('Research requires the native Session filesystem.')
        const target = await fs.resolve(path, { cwd: workspaceRoot, signal: control })
        const bytes = await fs.readBytes(target, control, maximum)
        check(); return bytes
      },
      stat: async (path, control) => {
        check(); const fs = agent.ctx.get('fs')
        if (fs === undefined) throw new Error('Research requires the native Session filesystem.')
        const target = await fs.resolve(path, { cwd: workspaceRoot, signal: control })
        const info = await fs.stat(target, control)
        check()
        if (info?.size === undefined) throw Object.assign(new Error('Research file is unavailable.'), { code: 'ENOENT' })
        return { size: info.size }
      },
    }
  }

  private async run(agent: Agent, cwd: string, argv: readonly string[], input: string,
    signal: AbortSignal, timeout: number): Promise<CommandResult> {
    this.admission.assertAgent(agent); signal.throwIfAborted()
    const control = AbortSignal.any([signal, this.owner.peCloudApi.binding.lifetime, AbortSignal.timeout(timeout)])
    const subprocess = agent.ctx.get('subprocess')
    if (subprocess === undefined) throw new Error('Research requires the native Session execution provider.')
    const handle = subprocess.spawn({ argv, cwd, signal: control, graceMs: this.config.graceMs,
      stdio: { stdin: { data: input }, stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes } } })
    try {
      const outcome = await handle.done
      if (!await handle.waitForExit(AbortSignal.timeout(this.config.graceMs))) throw new Error('Research execution cleanup is unconfirmed.')
      this.admission.assertAgent(agent); control.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0), stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) {
        throw new RangeError('Research execution output exceeds its retained limit.')
      }
      return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text }
    } finally {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(this.config.graceMs))) throw new Error('Research execution cleanup is unconfirmed.')
    }
  }
}
