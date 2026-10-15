/** Tenant-owned native adapter configuration, public catalogs and immutable per-request adapter snapshots. */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { LlmError, type GenerateOptions, type LlmAdapter, type LlmConfigurableProvider, type LlmProviderInfo, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, catalogModelInfo, type DeepSeekAdapterOptions, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { Config as PiAiConfig, PiAiAdapter, resolveProfiles, assertServiceable, catalogProviderIds, discoverModels } from '@deepseek-ai/dsh-llm-pi-ai'
import { applySettingsPathOp, mergeSettingsLayers } from '@deepseek-ai/dsh-settings'
import { modelSettingsNamespace, modelSettingsWrite, modelDiscoveryDraft, type ModelSettingsLimits } from '@power-evolve/contracts/model-settings'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { settings, PlatformError, type UserId } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireBrowserAccount } from './account-authority.ts'
import type { TenantModelCredentials } from './tenant-model-credentials.ts'
import type { TenantModelHttp } from './tenant-model-services.ts'
import type { NativeRuntimeAuthority } from './native-runtime-authority.ts'

type Namespace = z.infer<typeof modelSettingsNamespace>
const jsonRecord = z.record(z.string(), z.json())
const stored = z.object({ namespace: modelSettingsNamespace, configuration: jsonRecord, revision: z.number().int().positive() })
/** Private original configuration facts; no credential value is stored in a prepared model call. */
export const tenantModelSnapshot = z.array(stored)
type Section = z.infer<typeof stored>
type NativeAdapters = ReadonlyMap<string, LlmAdapter>
type Authorization = (client: PoolClient) => Promise<void>
function piProviders(value: z.infer<typeof jsonRecord>) {
  return structuredClone(PiAiConfig(value).providers.get()) as NonNullable<Parameters<typeof assertServiceable>[0]['providers']>
}
/** Platform-owned attachment services bound to the original authorized model request. */
export type TenantModelAttachments = Pick<DeepSeekAdapterOptions, 'resolveAttachments' | 'resolveImageAccess' | 'fetch'>
/** Existing deployment model service retained for historical power-evolve grants. */
export interface TenantModelDeployment {
  readonly baseURL: string
  readonly apiKey: string
  readonly streamIdleTimeoutMs: number
}

function detached(value: unknown): z.infer<typeof jsonRecord> { return jsonRecord.parse(JSON.parse(JSON.stringify(value))) }
function validated(ns: Namespace, raw: z.infer<typeof jsonRecord>, previous?: z.infer<typeof jsonRecord>) {
  try {
    if (ns === 'llm-deepseek') {
      const config = DeepSeekConfig(raw), options = plainOptions(config)
      resolveAdapterOptions(options)
      return detached(options)
    }
    const providers = piProviders(raw)
    const prior = previous === undefined ? undefined : { providers: piProviders(previous) }
    assertServiceable({ providers }, prior)
    const profiles = resolveProfiles(providers, 'deferred')
    if (profiles.has('deepseek-official') || profiles.has('power-evolve')) throw new Error('Provider route already registered')
    if ([...profiles.values()].some(profile => profile.transport !== undefined && profile.transport !== 'sse')) {
      throw new PlatformError(400, 'model_transport_unavailable')
    }
    return detached({ providers })
  } catch (invalidConfiguration) {
    if (invalidConfiguration instanceof PlatformError) throw invalidConfiguration
    throw new PlatformError(400, 'model_settings_invalid')
  }
}

/** Adapter snapshots keep each tenant's key resolver and native replay implementation together. */
export class TenantModelSettings {
  constructor(private readonly pool: Pool, readonly credentials: TenantModelCredentials, private readonly limits: ModelSettingsLimits,
    private readonly assertEndpoint: (url: string) => Promise<void>, private readonly deployment: TenantModelDeployment,
    private readonly http?: TenantModelHttp, private readonly runtimeAuthority?: NativeRuntimeAuthority) {}

  private async owner(client: PoolClient, token: string, runtime: boolean, update = false) {
    if (!runtime) return requireBrowserAccount(client, token, { lock: update ? 'update' : 'share' })
    if (!this.runtimeAuthority) throw new PlatformError(503, 'model_runtime_unavailable')
    return this.runtimeAuthority.authenticateInTransaction(client, token, undefined, update ? 'update' : 'share')
  }

  private async sections(client: PoolClient, userId: UserId,
    snapshot?: z.infer<typeof tenantModelSnapshot>): Promise<Map<Namespace, Section>> {
    if (snapshot !== undefined) return new Map(snapshot.map(section => [section.namespace, section]))
    const rows = await client.query<Record<string, unknown>>('SELECT namespace,configuration,revision FROM pe_tenant_model_settings WHERE user_id=$1', [userId])
    return new Map(rows.rows.map((row) => { const value = stored.parse(row); return [value.namespace, value] }))
  }
  /** Capture the native namespace generation while the original owner is locked.
   * @param client Original account-authorized transaction.
   * @param userId Server-derived tenant owner.
   * @returns Private configuration references for one native prepared call.
   */
  async snapshot(client: PoolClient, userId: UserId): Promise<z.infer<typeof tenantModelSnapshot>> {
    return [...(await this.sections(client, userId)).values()]
  }
  private view(ns: Namespace, section: Section | undefined) {
    const schema = ns === 'llm-deepseek' ? DeepSeekConfig : PiAiConfig
    const base = ns === 'llm-deepseek' ? detached(plainOptions(DeepSeekConfig({}))) : { providers: {} }
    return { ns, schema: detached(schema.toJSON()), autoGenerate: false, value: section?.configuration ?? base,
      base, user: section?.configuration ?? {}, secrets: [], applies: 'live', revision: section?.revision ?? 1 }
  }
  /** Native public Settings descriptors, isolated by the original authenticated owner.
   * @param token Current browser Agent credential.
   * @returns Both maintained adapter-family descriptors with references instead of keys.
   */
  async describe(token: string) {
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token)
      const sections = await this.sections(client, owner.userId)
      return { writable: true, hasDocument: true,
        namespaces: modelSettingsNamespace.options.map(ns => this.view(ns, sections.get(ns))) }
    })
  }
  private async adapters(client: PoolClient, userId: UserId, authorize: Authorization,
    attachments?: TenantModelAttachments, snapshot?: z.infer<typeof tenantModelSnapshot>): Promise<NativeAdapters> {
    const sections = await this.sections(client, userId, snapshot)
    const deep = resolveAdapterOptions(plainOptions(DeepSeekConfig(sections.get('llm-deepseek')?.configuration ?? {})))
    const profiles = resolveProfiles(piProviders(sections.get('llm-pi-ai')?.configuration ?? {}), 'deferred')
    const nativeAuth = this.credentials.nativeAuth(userId, authorize)
    const lookup = (ref: string) => transaction(this.pool, async (connection) => {
      await authorize(connection)
      const value = await this.credentials.resolve(connection, userId, ref)
      if (value === undefined) throw new LlmError('Model credential is unavailable.', 'MISSING_CREDENTIAL')
      return value
    })
    const deepseek = new DeepSeekAdapter({ options: () => deep,
      discoverModels: provider => Promise.resolve(deep.models.map(model => catalogModelInfo(provider, model))),
      resolveAuth: async () => ({ headers: { 'x-api-key': await lookup(deep.apiKeyEnv) } }),
      resolveUserId: () => brandString<AnonymousUserId>(createHash('sha256').update(`tenant-model:${userId}`).digest('hex')),
      providerName: 'DeepSeek', prepareExtensions: () => Promise.resolve({ fields: {}, accept: async () => {} }),
      ...attachments,
    })
    const pi = new PiAiAdapter({ profiles: () => profiles, auth: nativeAuth,
      resolveApiKey: (_provider, profile) => profile.apiKeyEnv === undefined ? Promise.resolve(undefined) : lookup(profile.apiKeyEnv),
      ...attachments,
    })
    const deployment = resolveAdapterOptions({ baseURL: this.deployment.baseURL, thinking: 'disabled',
      streamIdleTimeoutMs: this.deployment.streamIdleTimeoutMs })
    const legacy = new DeepSeekAdapter({ options: () => deployment, resolveAuth: async () => {
      await transaction(this.pool, authorize)
      return { headers: { 'x-api-key': this.deployment.apiKey } }
    }, resolveUserId: () => brandString<AnonymousUserId>(createHash('sha256').update(`tenant-model:${userId}`).digest('hex')),
    providerName: 'PowerEvolve', prepareExtensions: () => Promise.resolve({ fields: {}, accept: async () => {} }), ...attachments })
    return new Map<string, LlmAdapter>([['power-evolve', legacy], ['deepseek-official', deepseek],
      ...[...profiles.keys()].map(provider => [provider, pi] as const)])
  }
  private async catalog(client: PoolClient, userId: UserId, adapters: NativeAdapters) {
    const models: { provider: string; descriptor: Awaited<ReturnType<LlmAdapter['resolveModel']>> }[] = []
    const failures: { id: string; name: string; message: string }[] = []
    for (const [provider, adapter] of adapters) {
      if (provider === 'power-evolve') continue
      try {
        for (const model of await adapter.listModels(provider)) {
          if (models.length >= this.limits.maxCatalogModels) throw new PlatformError(413, 'model_catalog_limit')
          models.push({ provider, descriptor: await adapter.resolveModel(provider, model.id) })
        }
      } catch (error) {
        if (error instanceof PlatformError) throw error
        failures.push({ id: provider, name: adapter.providerInfo(provider).name, message: 'model_catalog_unavailable' })
      }
    }
    const current = settings.parse((await client.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [userId])).rows[0]?.settings)
    await client.query('DELETE FROM pe_tenant_model_catalog WHERE user_id=$1', [userId])
    for (const row of models) {
      await client.query('INSERT INTO pe_tenant_model_catalog(user_id,provider,model_id,descriptor,max_tokens) VALUES($1,$2,$3,$4,$5)',
        [userId, row.provider, row.descriptor.id, row.descriptor, row.descriptor.defaultMaxTokens ?? current.maxTokens])
    }
    return { models, failures, current }
  }
  /** Apply native revisioned settings mutations and refresh the owned authorized model catalog atomically.
   * @param token Current Agent credential, rechecked under the account update lock.
   * @param value Native namespace operation, without credential literals.
   * @returns The exact persisted native namespace view.
   */
  async write(token: string, value: unknown) {
    const request = modelSettingsWrite.parse(value)
    if (Buffer.byteLength(JSON.stringify(request.value)) > this.limits.maxSettingsBytes) throw new PlatformError(413, 'model_settings_too_large')
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token, { lock: 'update' })
      const sections = await this.sections(client, owner.userId), original = sections.get(request.ns)
      const revision = original?.revision ?? 1
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) throw new PlatformError(409, 'settings/conflict')
      const schema = request.ns === 'llm-deepseek' ? DeepSeekConfig : PiAiConfig
      let next: Record<string, unknown> = original?.configuration ?? {}
      if (request.mode === 'mutate') {
        const edits = z.array(z.discriminatedUnion('op', [
          z.object({ op: z.literal('set'), path: z.array(z.string()), value: z.json() }).strict(),
          z.object({ op: z.literal('unset'), path: z.array(z.string()) }).strict(),
        ])).parse(request.value)
        for (const edit of edits) next = applySettingsPathOp(next, edit, schema)
      } else next = jsonRecord.parse(request.mode === 'replace' ? request.value : mergeSettingsLayers(next, request.value))
      const configuration = validated(request.ns, jsonRecord.parse(next), original?.configuration)
      if (Buffer.byteLength(JSON.stringify(configuration)) > this.limits.maxSettingsBytes) throw new PlatformError(413, 'model_settings_too_large')
      await client.query(`INSERT INTO pe_tenant_model_settings(user_id,namespace,configuration,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,namespace) DO UPDATE SET configuration=EXCLUDED.configuration,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,
      [owner.userId, request.ns, configuration, revision + 1])
      const adapters = await this.adapters(client, owner.userId, async (connection) => {
        const current = await requireBrowserAccount(connection, token)
        if (current.userId !== owner.userId) throw new PlatformError(401, 'unauthorized')
      })
      await this.catalog(client, owner.userId, adapters)
      return this.view(request.ns, { namespace: request.ns, configuration, revision: revision + 1 })
    })
  }
  /** Read registered and configurable native routes without publishing endpoint credentials.
   * @param token Current browser Agent credential.
   * @param runtime Require the original tenant-runtime audience instead of browser Agent.
   * @returns The native provider directory and active route metadata.
   */
  async providers(token: string, runtime = false): Promise<{
    registered: LlmProviderInfo[]
    directory: LlmConfigurableProvider[]
    retryPolicies: Record<string, ResolvedRetryPolicy> }> {
    return transaction(this.pool, async (client) => {
      const owner = await this.owner(client, token, runtime), sections = await this.sections(client, owner.userId)
      const profiles = resolveProfiles(piProviders(sections.get('llm-pi-ai')?.configuration ?? {}), 'deferred')
      const nativeCatalog = new Set(catalogProviderIds())
      const directory: LlmConfigurableProvider[] = [{ provider: 'deepseek-official', displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek', settingsPath: [] }, ...[...new Set([...nativeCatalog, ...profiles.keys()])].map(provider => ({
        provider, displayName: profiles.get(provider)?.displayName ?? provider, settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider], declared: !nativeCatalog.has(provider),
        ...profiles.get(provider)?.catalogError === undefined ? {} : { error: 'model_catalog_unavailable' },
      }))]
      const adapters = await this.adapters(client, owner.userId, async (connection) => { await this.owner(connection, token, runtime) })
      const retryPolicies = Object.fromEntries([...adapters].flatMap(([id, adapter]) => {
        const policy = adapter.providerRetryPolicy(id)
        return policy === undefined ? [] : [[id, policy]]
      }))
      return { registered: [{ id: 'power-evolve', name: 'PowerEvolve' }, { id: 'deepseek-official', name: 'DeepSeek' },
        ...[...profiles].map(([id, profile]) => ({ id, name: profile.displayName }))], directory, retryPolicies }
    })
  }
  /** Build the native composer catalog and refresh admission facts for both adapter families.
   * @param token Current browser Agent credential.
   * @param runtime Require the original tenant-runtime audience instead of browser Agent.
   * @returns Current account default, native groups and per-provider diagnostics.
   */
  async modelCatalog(token: string, runtime = false): Promise<ModelCatalog> {
    return transaction(this.pool, async (client) => {
      const owner = await this.owner(client, token, runtime, true)
      const adapters = await this.adapters(client, owner.userId, async (connection) => { await this.owner(connection, token, runtime) })
      const { models, failures, current } = await this.catalog(client, owner.userId, adapters)
      const legacy = await client.query<{ id: string; name: string }>('SELECT model_id AS id,label AS name FROM pe_user_models WHERE user_id=$1 AND enabled ORDER BY model_id', [owner.userId])
      const groups = [...adapters].filter(([id]) => id !== 'power-evolve').map(([id, adapter]) => ({ id, name: adapter.providerInfo(id).name,
        models: models.filter(row => row.provider === id).map(({ descriptor }) => ({ id: descriptor.id, name: descriptor.name,
          ...descriptor.reasoning === undefined ? {} : { reasoning: descriptor.reasoning } })) }))
      if (legacy.rows.length) groups.unshift({ id: 'power-evolve', name: 'PowerEvolve', models: legacy.rows })
      return { default: { provider: current.provider ?? 'power-evolve', model: current.model,
        ...current.reasoningEffort === undefined ? current.provider === undefined ? { reasoningEffort: 'off' } : {}
          : { reasoningEffort: current.reasoningEffort } },
      routableProviders: groups.filter(group => group.models.length).map(group => group.id), groups, failures }
    })
  }
  /** Construct one native adapter snapshot only after the caller proves the operation owner.
   * @param client Original current-operation transaction.
   * @param userId Original server-derived operation owner.
   * @param provider Requested provider route.
   * @param authorize Rechecks the exact operation before every private credential read or refresh.
   * @param attachments Platform-only image services for this exact request.
   * @param snapshot Original prepared namespace generation, private to Platform.
   * @returns Native adapter and replay ownership filter retaining that exact configuration generation.
   */
  async adapter(client: PoolClient, userId: UserId, provider: string, authorize: Authorization,
    attachments?: TenantModelAttachments, snapshot?: z.infer<typeof tenantModelSnapshot>) {
    const sections = await this.sections(client, userId, snapshot)
    if (provider === 'deepseek-official') {
      const options = resolveAdapterOptions(plainOptions(DeepSeekConfig(sections.get('llm-deepseek')?.configuration ?? {})))
      await this.assertEndpoint(options.baseURL)
    } else if (provider !== 'power-evolve') {
      const profiles = resolveProfiles(piProviders(sections.get('llm-pi-ai')?.configuration ?? {}), 'deferred')
      const profile = profiles.get(provider)
      if (!profile) throw new PlatformError(403, 'model_not_authorized')
      if (profile.baseURL !== undefined) await this.assertEndpoint(profile.baseURL)
    }
    const adapters = await this.adapters(client, userId, authorize, attachments, snapshot), adapter = adapters.get(provider)
    if (!adapter) throw new PlatformError(403, 'model_not_authorized')
    return { adapter, filterReplay: (options: GenerateOptions): GenerateOptions => ({ ...options,
      messages: options.messages.map((message) => {
        if (message.role !== 'assistant' || message.source.replayState === undefined
        || adapters.get(message.source.provider) === adapter) return message
        return { ...message, source: { kind: 'model' as const, provider: message.source.provider, model: message.source.model } }
      }) }) }
  }
  /** Public immutable facts used by the native synchronous image pricing helper on the Host.
   * @param client Original authenticated runtime transaction.
   * @param userId Exact runtime account.
   * @param provider Requested adapter route.
   * @param model Exact granted model identity.
   * @param snapshot Original prepared namespace generation, private to Platform.
   * @returns Native DeepSeek catalog fields only, or the native absence of pricing on other adapters.
   */
  async imagePricing(client: PoolClient, userId: UserId, provider: string, model: string,
    snapshot?: z.infer<typeof tenantModelSnapshot>): Promise<
    { kind: 'none' } | { kind: 'deepseek'; model?: DeepSeekCatalogModel }> {
    if (provider !== 'power-evolve' && provider !== 'deepseek-official') return { kind: 'none' }
    const sections = await this.sections(client, userId, snapshot)
    const options = provider === 'power-evolve' ? resolveAdapterOptions({ thinking: 'disabled' })
      : resolveAdapterOptions(plainOptions(DeepSeekConfig(sections.get('llm-deepseek')?.configuration ?? {})))
    const entry = options.models.find(item => item.id === model)
    return { kind: 'deepseek', ...entry === undefined ? {} : { model: entry } }
  }
  /** Discover a draft without sending a typed key through the Host.
   * @param token Current browser Agent credential.
   * @param value Public native draft metadata; credential literals are rejected.
   * @param signal Original browser request lifetime.
   * @returns Native adapter-discovered model candidates.
   */
  async discover(token: string, value: unknown, signal: AbortSignal) {
    const draft = modelDiscoveryDraft.parse(value)
    return transaction(this.pool, async (client) => {
      const owner = await requireBrowserAccount(client, token)
      return this.discoverOwned(client, owner.userId, draft, undefined, signal, async () => {
        // The caller retains the original account transaction until discovery has settled.
        await requireBrowserAccount(client, token)
      })
    })
  }
  /** Private direct-intake discovery under its caller-held original account lock; its key is never persisted.
   * @param client Original authorized browser or intake transaction.
   * @param userId Server-derived account owner.
   * @param draft Public endpoint and protocol facts.
   * @param apiKey One-shot direct-upload key, absent when the saved source should be used.
   * @param signal Original bounded request lifetime.
   * @param authorize Original browser or direct-intake proof immediately before HTTP.
   * @returns Native model listing without modifying saved keys or settings.
   */
  async discoverOwned(client: PoolClient, userId: UserId, draft: z.infer<typeof modelDiscoveryDraft>,
    apiKey: string | undefined, signal: AbortSignal, authorize: () => Promise<void> = () => Promise.resolve()) {
    signal.throwIfAborted()
    const sections = await this.sections(client, userId)
    if (draft.settingsNs === 'llm-deepseek') {
      const options = resolveAdapterOptions(plainOptions(DeepSeekConfig(sections.get('llm-deepseek')?.configuration ?? {})))
      return options.models.map(model => ({ id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens } }))
    }
    const profiles = resolveProfiles(piProviders(sections.get('llm-pi-ai')?.configuration ?? {}), 'deferred')
    const profile = draft.provider === undefined ? undefined : profiles.get(draft.provider)
    if (draft.baseURL !== undefined) await this.assertEndpoint(draft.baseURL)
    const transport = this.http?.open(signal, authorize)
    try {
      return await discoverModels({ ...draft.provider === undefined ? {} : { provider: draft.provider },
        ...draft.baseURL === undefined ? {} : { baseURL: draft.baseURL }, ...draft.api === undefined ? {} : { api: draft.api },
        ...apiKey === undefined ? {} : { apiKey }, signal }, () => ({
        headers: profile?.headers,
        resolveApiKey: () => profile?.apiKeyEnv === undefined ? Promise.resolve(undefined)
          : this.credentials.resolve(client, userId, profile.apiKeyEnv),
      }), transport?.fetch)
    } finally { await transport?.dispose() }
  }
}
