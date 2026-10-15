/** Native provider metadata and lossless chunks with per-operation Platform authorization. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { LlmAdapter, ReasoningEffortId, resolveImageAttachmentAccess, type GenerateOptions,
  type LlmResolvedModelInfo, type LlmImageRequestPricing, type PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { DeepSeekAdapter, resolveAdapterOptions, deepSeekImageRequestPricing, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type RuntimeScope from './scope.ts'
import type { Grant } from '../contracts.ts'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { mcpModelTool } from '../mcp-model-tools.ts'
import { z } from 'zod'
import { streamNativeModel } from './native-model-stream.ts'
import { nativeModelPreparationId, type NativeModelPreparationId, type NativePreparedModel,
  type NativeModelImagePricing } from '../model-runtime-contracts.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { powerEvolveModelHeader: number | null }
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeModelRoutes: { refresh(signal?: AbortSignal): Promise<void> } }
}

/** Preserve the operation's captured native provider and optional reasoning intent when resuming its Agent.
 * @param settings Immutable model selection admitted for this operation or interactive owner.
 * @returns Native Agent options, retaining the historical PowerEvolve provider when absent.
 */
export function nativeModelAgentOptions(settings: Grant['settings']): {
  provider: string; model: string; maxTokens: number; reasoningEffort?: ReasoningEffortId
} {
  return { provider: settings.provider ?? 'power-evolve', model: settings.model, maxTokens: settings.maxTokens,
    ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) }) }
}

const providers = z.object({ registered: z.array(z.object({ id: z.string().min(1), name: z.string() }).strict()),
  directory: z.array(z.unknown()), retryPolicies: z.record(z.string(), z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('normal'), maxRetries: z.number().int().nonnegative(), retryableCodes: z.array(z.string()),
      initialDelayMs: z.number().positive(), maxDelayMs: z.number().positive(), jitterRatio: z.number().min(0).max(1) }).strict(),
    z.object({ mode: z.literal('always'), initialDelayMs: z.number().positive(), maxDelayMs: z.number().positive(),
      jitterRatio: z.number().min(0).max(1) }).strict(),
  ])) }).strict().superRefine((value, context) => {
  for (const provider of value.registered) if (!Object.hasOwn(value.retryPolicies, provider.id)) {
    context.addIssue({ code: 'custom', message: 'Registered provider has no native retry policy', path: ['retryPolicies', provider.id] })
  }
})
const modelInfo = z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string(), description: z.string().optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).optional(),
  context: z.object({ contextWindow: z.number().positive() }).strict().optional(),
  defaultMaxTokens: z.number().positive().optional(), reasoning: z.object({
    defaultEffort: z.string().transform(ReasoningEffortId).optional(),
    efforts: z.array(z.object({ id: z.string().transform(ReasoningEffortId), name: z.string(),
      description: z.string().optional() }).strict()) }).strict().optional(),
  systemPromptUpdate: z.literal('in-history').optional(), toolUpdate: z.enum(['in-history', 'addition-only']).optional() }).strict()
const resolvedModel = z.custom<LlmResolvedModelInfo>(value => modelInfo.safeParse(value).success)
const deepSeekModel = z.object({ id: z.string().min(1), name: z.string().optional(), description: z.string().optional(),
  contextWindow: z.number().positive().optional(), maxTokens: z.number().positive().optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).optional(), imagePixelBudget: z.union([z.number().positive(), z.literal('low')]).optional(),
  imageMaxBytes: z.number().positive().optional(), systemPromptUpdate: z.literal('in-history').optional(),
  toolUpdate: z.enum(['in-history', 'addition-only']).optional() }).strict()
const priceFields = z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('deepseek'), model: z.custom<DeepSeekCatalogModel>(value => deepSeekModel.safeParse(value).success).optional() }).strict()])

const imagePricing = z.custom<NativeModelImagePricing>(value => priceFields.safeParse(value).success)
const preparedModel = z.custom<NativePreparedModel>(value => z.object({ preparationId: nativeModelPreparationId,
  model: resolvedModel, imagePricing }).strict().safeParse(value).success)

export const name = 'power-evolve-model'
export const inject = ['llm', 'powerEvolveRuntime', 'sessions', 'sessionPersistence', 'agents', 'sessionProjections']
export const Config = schema.object({ streamIdleTimeoutMs: schema.number().min(1000).required() })
/** Validated native model transport timeout settings. */
export type Config = ReturnType<typeof Config>

class PlatformModel extends LlmAdapter {
  providers = new Map<string, { id: string; name: string }>()
  retryPolicies: z.infer<typeof providers>['retryPolicies'] = {}
  private readonly pricing = new Map<string, LlmImageRequestPricing>()
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
  override providerInfo(provider: string) { return this.providers.get(provider) ?? { id: provider, name: provider } }
  override providerRetryPolicy(provider: string) { return this.retryPolicies[provider] }
  override async listModels(provider: string) {
    if (this.runtime.config.runtimeUserId === '') return this.adapter('').listModels(provider)
    const catalog = z.object({ groups: z.array(z.object({ id: z.string(), models: z.array(z.object({ id: z.string(), name: z.string(),
      description: z.string().optional() }).loose()) }).loose()) }).loose().parse(await this.runtime.callModelMetadata('/runtime/models/catalog', {}))
    return catalog.groups.find(group => group.id === provider)?.models.map(model => ({ provider, id: model.id, name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }) })) ?? []
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    if (this.runtime.config.runtimeUserId === '') return this.adapter('').resolveModel(provider, model, signal)
    const [result, price] = await Promise.all([
      this.runtime.callModelMetadata('/runtime/models/resolve', { provider, model }, signal).then(value => resolvedModel.parse(value)),
      this.runtime.callModelMetadata('/runtime/models/image-pricing', { provider, model }, signal).then(value => imagePricing.parse(value)),
    ])
    if (result.provider !== provider || result.id !== model) throw new Error('Platform model resolution identity differs')
    this.acceptPricing(provider, model, price)
    return result
  }
  private acceptPricing(provider: string, model: string, price: NativeModelImagePricing): void {
    if (price.kind === 'deepseek') {
      if (price.model !== undefined && price.model.id !== model) throw new Error('Platform image pricing model identity differs')
      this.pricing.set(JSON.stringify([provider, model]), deepSeekImageRequestPricing(resolveAdapterOptions({
        models: price.model === undefined ? [] : [price.model], thinking: 'disabled',
      }), model, (ref) => {
        const attachments = this.ctx.agents.currentInitiator()?.ctx.get('attachments') ?? this.ctx.get('attachments')
        return attachments === undefined ? undefined : resolveImageAttachmentAccess(attachments, () => undefined, ref)
      }))
    } else this.pricing.delete(JSON.stringify([provider, model]))
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (this.runtime.config.runtimeUserId === '') return { model: await this.resolveModel(provider, model, signal), stream: options => this.dispatch(options) }
    const prepared = preparedModel.parse(await this.runtime.callModelMetadata('/runtime/models/prepare', { provider, model }, signal))
    if (prepared.model.provider !== provider || prepared.model.id !== model) throw new Error('Platform model preparation identity differs')
    this.acceptPricing(provider, model, prepared.imagePricing)
    return { model: prepared.model, stream: options => this.dispatch(options, prepared.preparationId) }
  }
  override imageRequestPricing(provider: string, model: string) {
    return this.runtime.config.runtimeUserId === '' ? this.adapter('').imageRequestPricing(provider, model) : this.pricing.get(JSON.stringify([provider, model]))
  }
  async *stream(options: GenerateOptions) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
  private async *dispatch(options: GenerateOptions, preparationId?: NativeModelPreparationId) {
    if (this.runtime.config.runtimeUserId !== '' && preparationId === undefined) throw new Error('Native model dispatch requires preparation')
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
      const headerSeq = this.ctx.sessionProjections.stateOf(session, 'powerEvolveModelHeader')
      if (headerSeq === undefined || headerSeq === null) throw new Error('Native model call requires its committed request header')
      await this.runtime.call('/runtime/tools/register', captured.token,
        { names: native.map(tool => tool.name), tools: native, headerSeq }, options.signal)
      assertCurrent()
    }
    await publisher.backpressure(options.signal)
    assertCurrent()
    const source = preparationId === undefined ? this.adapter(captured.token, agent.ctx.get('attachments')).stream(options)
      : streamNativeModel({ ...this.config, platformUrl: this.runtime.config.platformUrl,
        maxResponseBytes: this.runtime.config.maxResponseBytes }, captured.token, options, preparationId)
    for await (const chunk of source) {
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
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.sessionProjections.register({ key: 'powerEvolveModelHeader', stateSchema: z.number().int().nonnegative().nullable(),
    stateVersion: 1, init: () => null, apply: (state, event) => event.type === 'request/header' ? event.seq : state })
  const adapter = new PlatformModel(ctx, ctx.powerEvolveRuntime, config)
  const initial = ctx.powerEvolveRuntime.config.runtimeUserId === '' ? { registered: [{ id: 'power-evolve', name: 'PowerEvolve' }], retryPolicies: {} }
    : providers.parse(await ctx.powerEvolveRuntime.callModelMetadata('/runtime/models/providers', {}))
  adapter.providers = new Map(initial.registered.map(row => [row.id, row]))
  adapter.retryPolicies = initial.retryPolicies
  const registration = ctx.llm.registerAdapter(initial.registered.map(row => row.id), adapter)
  let refreshGeneration = 0
  const stop = new AbortController(), active = new Set<Promise<void>>()
  ctx.effect(() => async () => { stop.abort(); await Promise.allSettled(active) })
  const refresh = async (caller?: AbortSignal): Promise<void> => {
    const signal = caller === undefined ? stop.signal : AbortSignal.any([stop.signal, caller])
    signal.throwIfAborted()
    if (ctx.powerEvolveRuntime.config.runtimeUserId === '') return
    const generation = ++refreshGeneration
    const next = providers.parse(await ctx.powerEvolveRuntime.callModelMetadata('/runtime/models/providers', {}, signal))
    signal.throwIfAborted()
    if (generation !== refreshGeneration) return
    if (JSON.stringify([...adapter.providers.values()]) === JSON.stringify(next.registered)
      && JSON.stringify(adapter.retryPolicies) === JSON.stringify(next.retryPolicies)) return
    const previous = adapter.providers, previousPolicies = adapter.retryPolicies
    adapter.providers = new Map(next.registered.map(row => [row.id, row]))
    adapter.retryPolicies = next.retryPolicies
    try { registration.replace(next.registered.map(row => row.id)) }
    catch (error) { adapter.providers = previous; adapter.retryPolicies = previousPolicies; throw error }
  }
  ctx.provide('nativeModelRoutes', { refresh(signal) {
    const work = refresh(signal)
    active.add(work)
    void work.then(() => { active.delete(work) }, (_settledFailure: unknown) => { active.delete(work) })
    return work
  } })
}
