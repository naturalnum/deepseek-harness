/** Native DeepSeek codec with per-operation authorization to platform egress. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { SessionId } from '@deepseek-ai/dsh-session'
import type RuntimeScope from './scope.ts'

export const name = 'power-evolve-model'
export const inject = ['llm', 'powerEvolveRuntime', 'sessions', 'sessionPersistence']
export const Config = schema.object({ streamIdleTimeoutMs: schema.number().min(1000).required() })
export type Config = ReturnType<typeof Config>

class PlatformModel extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly runtime: RuntimeScope, private readonly config: Config) { super() }
  private adapter(token: string): DeepSeekAdapter {
    const options = resolveAdapterOptions({
      baseURL: `${this.runtime.config.platformUrl}/model`, thinking: 'disabled',
      streamIdleTimeoutMs: this.config.streamIdleTimeoutMs,
    })
    return new DeepSeekAdapter({
      options: () => options,
      resolveAuth: async () => ({ headers: { authorization: `Bearer ${token}` } }),
      resolveUserId: () => getOrCreateAnonymousUserId(),
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    })
  }
  override resolveModel(provider: string, model: string) { return this.adapter('').resolveModel(provider, model) }
  async *stream(options: GenerateOptions) {
    if (options.sessionId === undefined) throw new Error('Model call requires a leased Session')
    const id = SessionId(options.sessionId)
    const session = this.ctx.sessions.get(id)
    if (!session) throw new Error('Model call requires a live Session')
    // Commit consumed input and the native request events before external inference.
    await this.ctx.sessions.flush(session)
    yield* this.adapter(this.runtime.require(id).token).stream(options)
  }
}

/** Register the native adapter; real provider credentials remain in the platform.
 * @param ctx - host plugin lifetime.
 * @param config - stream timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(['power-evolve'], new PlatformModel(ctx, ctx.powerEvolveRuntime, config))
}
