/** The native DeepSeek Search consumer uses operation-scoped Platform egress instead of provider credentials. */
import type { Context } from '@deepseek-ai/cordis'
import { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_API_VERSION, DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES, DEEPSEEK_DEFAULT_MODEL } from '@deepseek-ai/dsh-web-search-deepseek'
import type { Config as NativeSearchConfig } from '@deepseek-ai/dsh-web-search-deepseek'
import { PlatformError } from '../contracts.ts'

import schema from '@deepseek-ai/schemastery'

/** Native search preferences; endpoint and credentials are fixed by Platform authority. */
export const Config = schema.object({
  model: schema.string().default(DEEPSEEK_DEFAULT_MODEL).volatile(),
  apiVersion: schema.string().default(DEEPSEEK_DEFAULT_API_VERSION).volatile(),
  maxTokens: schema.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: schema.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES).volatile(),
})
/** The maintained native live request preferences, excluding Platform-owned credentials. */
export type SearchConfig = Pick<NativeSearchConfig, 'model' | 'apiVersion' | 'maxTokens' | 'maxUses'>
/** Native search provider diagnostics retain the upstream namespace. */
export const name = 'power-evolve-native-web-search'
/** Search registrations require the actual native Agent registry and bounded Platform transport. */
export const inject = ['web', 'agents', 'sessions', 'powerEvolveRuntime']

/** Preserve the native Search codec, request logging, sources and result presentation.
 * @param ctx One account's trusted native process.
 * @param config The native live search configuration; provider endpoints and keys remain Platform-owned.
 * @returns Nothing; registration belongs to the caller's plugin lifetime.
 */
export function apply(ctx: Context, config: SearchConfig): void {
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => {
    const agent = ctx.agents.currentInitiator()
    const captured = agent === undefined ? undefined : ctx.powerEvolveRuntime.require(agent.id)
    return {
      baseURL: new URL('/runtime/web-search', ctx.powerEvolveRuntime.config.platformUrl).href,
      model: config.model.get(), apiVersion: config.apiVersion.get(),
      maxTokens: config.maxTokens.get(), maxUses: config.maxUses.get(),
      resolveApiKey: () => {
        if (!captured || !agent) throw new PlatformError(403, 'native_execution_scope_missing')
        ctx.powerEvolveRuntime.assertGrant(captured)
        return Promise.resolve(captured.token)
      },
      recordRequest: (request) => {
        if (!captured || !agent) throw new PlatformError(403, 'native_execution_scope_missing')
        ctx.powerEvolveRuntime.assertGrant(captured)
        agent.session.append('web/deepseek-search-llm-request', request)
      },
      fetch: async (address, init) => {
        if (!captured || !agent) throw new PlatformError(403, 'native_execution_scope_missing')
        await ctx.sessions.flush(agent.session)
        ctx.powerEvolveRuntime.assertGrant(captured)
        const publisher = ctx.powerEvolveRuntime.publication(captured)
        await publisher.backpressure(init?.signal ?? undefined)
        ctx.powerEvolveRuntime.assertGrant(captured)
        return fetch(address, init)
      },
    }
  }))
}
