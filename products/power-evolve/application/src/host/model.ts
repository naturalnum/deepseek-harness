/** Native DeepSeek codec with per-operation authorization to platform egress. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { LlmAdapter, resolveImageAttachmentAccess, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type RuntimeScope from './scope.ts'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { mcpModelTool } from '../mcp-model-tools.ts'

export const name = 'power-evolve-model'
export const inject = ['llm', 'powerEvolveRuntime', 'sessions', 'sessionPersistence', 'agents']
export const Config = schema.object({ streamIdleTimeoutMs: schema.number().min(1000).required() })
/** Validated native model transport timeout settings. */
export type Config = ReturnType<typeof Config>

class PlatformModel extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly runtime: RuntimeScope, private readonly config: Config) { super() }
  private adapter(token: string, attachments?: AttachmentStore): DeepSeekAdapter {
    const options = resolveAdapterOptions({
      baseURL: `${this.runtime.config.platformUrl}/model`, thinking: 'disabled',
      streamIdleTimeoutMs: this.config.streamIdleTimeoutMs,
    })
    return new DeepSeekAdapter({
      options: () => options,
      resolveAuth: () => Promise.resolve({ headers: { authorization: `Bearer ${token}` } }),
      resolveUserId: () => getOrCreateAnonymousUserId(),
      resolveAttachments: () => attachments,
      resolveImageAccess: (store, ref) => resolveImageAttachmentAccess(store, () => undefined, ref),
      prepareExtensions: () => Promise.resolve({ fields: {}, accept: async () => {} }),
    })
  }
  override resolveModel(provider: string, model: string) { return this.adapter('').resolveModel(provider, model) }
  override imageRequestPricing(provider: string, model: string) { return this.adapter('').imageRequestPricing(provider, model) }
  async *stream(options: GenerateOptions) {
    if (options.sessionId === undefined) throw new Error('Model call requires a leased Session')
    const id = brandString<SessionId>(options.sessionId)
    const session = this.ctx.sessions.get(id)
    if (!session) throw new Error('Model call requires a live Session')
    const agent = this.ctx.agents.get(id)
    if (!agent || agent.session !== session) throw new Error('Model call requires the exact live Agent')
    const captured = this.runtime.require(id)
    const publisher = this.runtime.publication(captured)
    const assertCurrent = (): void => {
      this.runtime.assertGrant(captured)
      if (this.ctx.sessions.get(id) !== session || this.ctx.agents.get(id) !== agent
        || agent.session !== session || this.runtime.publication(captured) !== publisher) {
        throw new Error('Model call requires the exact live Agent and publisher')
      }
      publisher.assertOpen()
      options.signal?.throwIfAborted()
    }
    // Commit consumed input and the native request events before external inference.
    await this.ctx.sessions.flush(session)
    assertCurrent()
    if (this.runtime.config.runtimeUserId !== '') {
      const external = new Set([...captured.remoteMcpTools.map(tool => tool.model.name),
        ...captured.stdioV2Connections.flatMap(group => group.tools.map(tool => tool.model.name))])
      const native = agent.ctx.tools.schemas(scopeOf(agent.ctx)).filter(tool => !external.has(tool.name))
        .map(tool => mcpModelTool.parse({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      await this.runtime.call('/runtime/tools/register', captured.token, { names: native.map(tool => tool.name), tools: native }, options.signal)
      assertCurrent()
    }
    await publisher.backpressure(options.signal)
    assertCurrent()
    for await (const chunk of this.adapter(captured.token, agent.ctx.get('attachments')).stream(options)) {
      assertCurrent()
      await publisher.backpressure(options.signal)
      assertCurrent()
      yield chunk
      assertCurrent()
      await publisher.backpressure(options.signal)
      assertCurrent()
    }
    await publisher.backpressure(options.signal, true)
    assertCurrent()
  }
}

/** Register the native adapter; real provider credentials remain in the platform.
 * @param ctx - host plugin lifetime.
 * @param config - stream timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(['power-evolve'], new PlatformModel(ctx, ctx.powerEvolveRuntime, config))
}
