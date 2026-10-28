/** Canonical bootstrap preparation and the page owner consumed by the real Cloud Loader entry. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { installConnection, type ConnectionHandle, type ConnectionWebSocketFactory, type RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type ClientPersistence } from '@deepseek-ai/dsh-client-store'
import type { ModelsCredentialEditing, ModelsSettingsIntegration, ModelsSettingsReads } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { ClientFileUploadHooks } from '@deepseek-ai/dsh-client-file-upload/types'
import { decodeCloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/schema'
import type { BindingFieldNames, BootstrapDecodeLimits, CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { parseCloudClientConfig } from '../config.ts'
import type { CloudClientConfig } from '../types.ts'
import { BootstrapAttempt, type BootstrapSnapshot } from './bootstrap.ts'
import { ClientFailure } from './errors.ts'
import type { CloudServicePreviewNavigation } from './service-preview.ts'
import { CloudPageLifetime, type CloudNativeEntry, type CloudPageSnapshot } from './page-lifetime.ts'
import type { PreparedSkillEdit } from './skill-edit.ts'
import type { SkillManagementView } from './management/skills/types.ts'
import { attachManagedSkillEditing, type ManagedSkillEditingInput } from './managed-skill-editing.ts'
import { attachSkillVersionEditing } from './skill-version-editing.ts'
import type { CloudPersistenceLimits, CloudPersistenceStorage } from './persistence.ts'

/** Fixed page inputs supplied by the pre-Cordis application owner, never by bootstrap JSON. */
export interface CloudPagePreparationInput {
  readonly baseUrl: string
  readonly config: CloudClientConfig
  readonly decodeLimits: BootstrapDecodeLimits
  readonly persistenceLimits: CloudPersistenceLimits
  readonly fields: BindingFieldNames
  readonly storage: CloudPersistenceStorage
  readonly fetch: RpcFetch
  readonly createWebSocket: ConnectionWebSocketFactory
  /** Original Web entry's joined local cleanup and Cookie sign-out; never supplied by bootstrap JSON. */
  readonly signOut?: () => void
  /** Optional actual navigation/feedback carrier; absence supplies no no-op preview entry. */
  readonly previewNavigation?: CloudPreviewNavigationPort
}

/** Apply-owned actual Remote callbacks; the original page supplies their currentness and observable admission. */
export interface CloudModelSettingsCallbacks extends Omit<ModelsSettingsReads, 'isCurrent'> {
  readonly prepare: ModelsCredentialEditing['prepare']
}

/** Native application owner supplies ordinary navigation and localized refusal feedback. */
export interface CloudPreviewNavigationPort {
  /** @param url Exact bound URL for synchronous ordinary GET navigation; never publish it to model/history or diagnostics. */
  open(url: string): void
  /** @param code Safe local refusal; no rejected selector, token, URL or original error is exposed. */
  refused(code: 'closed' | 'target-denied'): void
}

/** Prompt bootstrap outcome and actual request cleanup remain separate. */
export interface CloudPagePreparation {
  /** Resolves only after canonical decoding and request settlement, before any native entry starts. */
  readonly ready: Promise<PreparedCloudPage>
  /** Actual bootstrap carrier settlement; this does not assert native graph cleanup. */
  readonly settled: Promise<void>
  /**
   * Observe the actual bootstrap request independently of ready rejection.
   * @returns the request and cleanup disposition without account data.
   */
  getSnapshot(): BootstrapSnapshot
  /**
   * Cancel preparation, revoke any issued page, and join request/page cleanup.
   * @returns actual cleanup; an unconfirmed body cancellation or page stop rejects.
   */
  dispose(): Promise<void>
}

/** Captured native lifecycle inputs; preparation settles before bootClient and revocation precedes cleanup. */
export interface CloudPreparedNativeOptions {
  readonly persistence: ClientPersistence
  readonly requirePersistence: true
  /**
   * Bind this prepared owner and its captured upload carrier before plugins activate.
   * @param ctx - native root Context, already carrying the exact captured persistence port.
   */
  readonly prepareContext: (ctx: Context) => void
  /** Revoke fixed storage/owner and carrier admission before any native child starts cleanup. */
  readonly beforeDispose: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Fixed pre-Cordis Cloud page owner; unavailable in ordinary native applications. */
    peCloudPage: PreparedCloudPage
  }
}

/**
 * One decoded browser page. The Cloud Loader entry consumes this exact owner and
 * supplies upload fetch before boot and installs the native Connection with captured carriers. The fixed Cloud
 * recipe must omit ordinary Connection plugin activation; it remains a module supplier.
 * Socket closure rechecks canonical identity without replacing the captured owner.
 */
export class PreparedCloudPage {
  /** Sanitized canonical metadata; this is not server authorization or an account-ready proof. */
  readonly bootstrap: CloudBootstrap
  /** Existing page lifetime owns all transport, persistence and native graph cleanup. */
  readonly lifetime: CloudPageLifetime
  /** Pass these options when constructing the existing AppWebEntry. */
  readonly nativeOptions: CloudPreparedNativeOptions
  /** Original immutable-page callback consumed by the native preview Tool installer. */
  readonly servicePreviewNavigation?: CloudServicePreviewNavigation
  /** Original page's optional Models integration; its source starts closed and is revoked before cleanup waits. */
  readonly modelsSettingsIntegration: ModelsSettingsIntegration
  /** Request the captured Web sign-out once from this page's active native scope. */
  readonly accountSignOut?: (owner: Context) => void
  private readonly modelsEditing = createSnapshotStore<ModelsCredentialEditing | null>(null)
  private readonly skillEditing = createSnapshotStore<SkillManagementView>(Object.freeze({ phase: 'unavailable', items: Object.freeze([]) }))
  private skillVersionBinding: { readonly owner: Context; withdraw?: () => void } | undefined
  private modelSettingsBinding: { readonly owner: Context; readonly callbacks: CloudModelSettingsCallbacks } | undefined
  private root: Context | undefined
  private activation: Context | undefined
  private connection: ConnectionHandle | undefined
  private uploadHooks: ClientFileUploadHooks | undefined
  private readonly config: Readonly<CloudClientConfig>
  private readonly location: { readonly hostname: string }

  private constructor(bootstrap: CloudBootstrap, input: CloudPagePreparationInput) {
    this.bootstrap = bootstrap
    this.config = Object.freeze({ ...input.config,
      ...input.config.skillSettings === undefined ? {} : { skillSettings: Object.freeze({ ...input.config.skillSettings }) },
    })
    this.location = Object.freeze({ hostname: new URL(input.baseUrl).hostname })
    const signOut = input.signOut
    if (signOut !== undefined) {
      let requested = false
      this.accountSignOut = (owner) => {
        this.assertAccountManagementCurrent(owner)
        if (requested) return
        requested = true
        signOut()
      }
    }
    const expectation = { accountId: bootstrap.account.id, connectionGeneration: bootstrap.connectionGeneration }
    this.lifetime = new CloudPageLifetime({
      expectation,
      storage: input.storage, persistenceLimits: input.persistenceLimits,
      transport: {
        baseUrl: input.baseUrl, fields: input.fields, fetch: input.fetch,
        ...this.config.servicePreview === undefined ? {} : { servicePreview: this.config.servicePreview },
        createWebSocket: input.createWebSocket, limits: this.config,
        revalidate: signal => new BootstrapAttempt({
          baseUrl: input.baseUrl, config: this.config,
          fetch: async (target, init) => {
            const response = await input.fetch(target, init)
            // Revoke on headers; BootstrapAttempt still owns response disposal.
            if (response.status === 401 && !init.signal?.aborted) void this.lifetime.transport.close('unauthenticated')
            return response
          },
          decode: (value) => {
            const current = decodeCloudBootstrap(value, input.decodeLimits)
            if (current.account.id !== expectation.accountId || current.connectionGeneration !== expectation.connectionGeneration) {
              throw new ClientFailure('stale-generation')
            }
          },
        }, signal),
      },
    })
    const read = async <T>(consume: (callbacks: CloudModelSettingsCallbacks) => Promise<T>): Promise<T> => {
      const binding = this.modelSettingsBinding
      if (binding === undefined || !this.modelsCurrent(binding)) throw new ClientFailure('closed')
      const value = await consume(binding.callbacks)
      if (!this.modelsCurrent(binding)) throw new ClientFailure('closed')
      return value
    }
    this.modelsSettingsIntegration = Object.freeze({ onboarding: false, editing: this.modelsEditing,
      reads: Object.freeze({
        isCurrent: () => this.modelSettingsBinding !== undefined && this.modelsCurrent(this.modelSettingsBinding),
        metadata: () => read(callbacks => callbacks.metadata()),
        credentials: (refs: readonly string[]) => read(callbacks => callbacks.credentials(refs)),
      }),
    })
    this.lifetime.transport.signal.addEventListener('abort', () => { this.revokeModels(); this.revokeSkillVersions() }, { once: true })
    this.nativeOptions = Object.freeze({
      ...this.lifetime.nativeOptions, prepareContext: (ctx: Context) => { this.bind(ctx) },
      beforeDispose: () => {
        this.revokeModels()
        this.revokeSkillVersions()
        this.lifetime.persistence.revoke()
        // close seals carrier admission synchronously; beforeClose joins the existing lifetime.
        // AppWebEntry has already published its disposal promise, so its reentrant dispose joins.
        void this.lifetime.transport.close()
      },
    })
    const navigation = input.previewNavigation
    if (bootstrap.capabilities.servicePreview.state === 'available' && this.config.servicePreview !== undefined && navigation !== undefined) {
      this.servicePreviewNavigation = (selection) => {
        try {
          if (this.activation === undefined || this.lifetime.transport.signal.aborted
            || this.lifetime.getSnapshot().phase !== 'running') throw new ClientFailure('closed')
          this.assertCurrent(this.activation)
          navigation.open(this.lifetime.transport.servicePreviewNavigationUrl(selection))
        } catch (error) {
          const code = error instanceof ClientFailure && error.code === 'closed' ? 'closed' : 'target-denied'
          try { navigation.refused(code) } catch (_feedbackError) {
            try { console.error('Cloud preview navigation feedback unavailable.') }
            catch (_loggerError) { /* The original UI callback must remain contained even when feedback is unavailable. */ }
          }
        }
      }
    }
  }

  /**
   * Perform the real bounded bootstrap request with the canonical access decoder.
   * No storage, native Connection or UI is activated before ready resolves.
   * @param input - fixed browser carriers and explicit public/decode/cache budgets.
   * @param signal - parent page lifetime; cancellation never confirms actual carrier cleanup.
   * @returns owned preparation with separate prompt ready and actual settled observations.
   */
  static prepare(input: CloudPagePreparationInput, signal: AbortSignal): CloudPagePreparation {
    const captured = {
      ...input, config: Object.freeze({ ...parseCloudClientConfig(input.config) }),
      decodeLimits: Object.freeze({ ...input.decodeLimits }),
      persistenceLimits: Object.freeze({ ...input.persistenceLimits }), fields: Object.freeze({ ...input.fields }),
      ...input.previewNavigation === undefined ? {} : { previewNavigation: Object.freeze({
        open: input.previewNavigation.open.bind(input.previewNavigation),
        refused: input.previewNavigation.refused.bind(input.previewNavigation),
      }) },
    }
    const abort = new AbortController()
    let page: PreparedCloudPage | undefined
    let closing: Promise<void> | undefined
    let disposed = false
    const forward = (): void => {
      disposed = true
      if (page !== undefined) page.stopAfterFailure()
      abort.abort(signal.reason)
    }
    signal.addEventListener('abort', forward, { once: true })
    if (signal.aborted) forward()
    const attempt = new BootstrapAttempt({
      baseUrl: captured.baseUrl, config: captured.config, fetch: captured.fetch,
      decode: value => decodeCloudBootstrap(value, captured.decodeLimits),
    }, abort.signal)
    const ready = attempt.result.then(async (bootstrap) => {
      await attempt.settled
      if (disposed || abort.signal.aborted) throw new ClientFailure('closed')
      page = new PreparedCloudPage(bootstrap, captured)
      return page
    })
    // Preserve the rejected public promise while preparation remains owned during cancellation.
    void ready.catch((_failure: unknown) => { /* The public ready promise retains this failure for its owner. */ })
    return Object.freeze({
      ready, settled: attempt.settled,
      getSnapshot: () => attempt.getSnapshot(),
      dispose: () => {
        if (closing !== undefined) return closing
        let complete!: () => void
        let fail!: (reason: unknown) => void
        closing = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
        disposed = true
        const stopping = page?.dispose()
        abort.abort(new ClientFailure('closed'))
        const actual = (async () => {
          const results = await Promise.allSettled([attempt.settled, stopping])
          signal.removeEventListener('abort', forward)
          const failures: unknown[] = []
          for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
          if (attempt.getSnapshot().cleanup === 'unconfirmed') failures.push(new ClientFailure('close-unconfirmed'))
          if (failures.length > 0) throw new AggregateError(failures, 'Cloud page preparation cleanup unconfirmed')
        })()
        void actual.then(complete, fail)
        return closing
      },
    })
  }

  /**
   * Activate through pe-cloud-client/client on this prepared native root only.
   * @param ctx - Cloud Loader entry Context on the previously bound root.
   * @throws Error if ownership, cache, upload carrier, lifecycle or the sole Connection provider differs.
   */
  activate(ctx: Context): void {
    this.assertCurrent(ctx)
    if (this.activation !== undefined) throw new Error('Cloud page Loader entry is already activated')
    if (ctx.get('connection', false) !== undefined) throw new Error('Cloud page requires the sole native Connection installer')
    installConnection(ctx, { transport: this.lifetime.transport.hooks, location: this.location })
    // The installer owns this provider while its Cloud Loader fiber is still activating.
    this.connection = ctx.get('connection', false) as ConnectionHandle
    this.activation = ctx
    ctx.effect(() => () => {
      // Awaiting disposal from its own child disposer would wait on this same graph.
      this.stopAfterFailure()
    }, 'pe-cloud-client: captured page owner')
  }

  /**
   * Start the existing native entry with this owner's pre-activation options.
   * @param entry - unstarted AppWebEntry constructed with nativeOptions.
   * @returns actual startup; rejects if the real Cloud Loader entry did not consume this owner.
   */
  async start(entry: CloudNativeEntry): Promise<void> {
    try {
      await this.lifetime.start(entry)
      if (this.activation === undefined || this.connection === undefined) {
        throw new Error('Cloud page native startup did not activate its prepared Loader owner')
      }
      this.assertCurrent(this.activation)
      if (this.activation.get('connection') !== this.connection) throw new Error('Cloud page native Connection provider changed')
    } catch (error) {
      this.stopAfterFailure()
      throw error
    }
  }

  /**
   * Read the existing page lifetime disposition.
   * @returns the owned native page disposition, without implying server account readiness.
   */
  getSnapshot(): CloudPageSnapshot { return this.lifetime.getSnapshot() }

  /**
   * Read the optional limit captured with this page's original configuration.
   * @returns maximum download bytes, or undefined when downloads are not configured.
   */
  get maxDownloadBytes(): number | undefined { return this.config.maxDownloadBytes }

  /**
   * Revoke, stop, join and clear through the existing captured lifetime.
   * @returns actual local cleanup, rejecting any unconfirmed stop or namespace removal.
   */
  dispose(): Promise<void> { this.revokeModels(); this.revokeSkillVersions(); return this.lifetime.dispose() }

  /**
   * Attach actual generated model Remote callbacks after their native contribution is mounted; reads retain server admission.
   * @param owner Original Cloud dependency fiber; replacing or disposing it revokes this binding.
   * @param callbacks Captured actual Remote functions; the caller enrolls the returned disposer in owner.effect.
   * @returns Idempotent withdrawal; it clears editing synchronously without claiming backend settlement.
   */
  attachModels(owner: Context, callbacks: CloudModelSettingsCallbacks): () => void {
    this.assertCurrent(owner)
    if (this.config.modelSettingsRequestTimeoutMs === undefined || this.modelSettingsBinding !== undefined) {
      throw new ClientFailure('closed')
    }
    const binding = Object.freeze({ owner, callbacks: Object.freeze({ metadata: callbacks.metadata,
      credentials: callbacks.credentials, prepare: callbacks.prepare }) })
    this.modelSettingsBinding = binding
    const isCurrent = (): boolean => this.modelsCurrent(binding)
    this.modelsEditing.set(Object.freeze({ scope: this.bootstrap.connectionGeneration + ':' + String(owner.fiber.uid), isCurrent,
      prepare: async (ref: string, signal: AbortSignal) => {
        const current = (): boolean => isCurrent() && !signal.aborted
        if (!current()) return null
        const prepared = await binding.callbacks.prepare(ref, AbortSignal.any([signal, this.lifetime.transport.signal]))
        if (!current() || prepared === null) return null
        const store = prepared.store, remove = prepared.remove
        const commit = async (operation: () => Promise<string | undefined>): Promise<string | undefined> => {
          if (!isCurrent()) throw new ClientFailure('closed')
          const failure = await operation()
          if (!isCurrent()) throw new ClientFailure('closed')
          return failure
        }
        return Object.freeze({ ref: prepared.ref,
          store: (value: string) => commit(() => store(value)), remove: () => commit(remove) })
      },
    }))
    return () => { if (this.modelSettingsBinding === binding) this.revokeModels() }
  }

  /**
   * Read the configured model-settings observer deadline.
   * @returns Explicit per-RPC deadline, or undefined while model settings remain unconfigured.
   */
  get modelSettingsRequestTimeoutMs(): number | undefined { return this.config.modelSettingsRequestTimeoutMs }

  /** Original page's stable observable; only this page's captured native adapter may publish updates.
   * @returns The same read-only source throughout this page's lifetime, including unresolved drafts after revocation.
   */
  get skillVersionEditing(): HostObservable<SkillManagementView> { return this.skillEditing }

  /**
   * Bind sample adaptation to the actual generated dependency and this original page's stable source.
   * @param owner Original dependency fiber; the caller enrolls withdrawal in its existing effect.
   * @param prepare Captured current-issued edit callback, using the same original page and Remote.
   * @param title Current locale lookup for the native sample card.
   * @returns Synchronous withdrawal; unresolved draft contents remain in this page's retired source.
   */
  attachSkillVersions(owner: Context, prepare: (signal: AbortSignal) => Promise<PreparedSkillEdit>, title: () => string): () => void {
    this.assertCurrent(owner)
    if (this.skillSettings === undefined || !this.bootstrap.capabilities.configuration.skills.manage
      || this.skillVersionBinding !== undefined) throw new ClientFailure('closed')
    const binding: NonNullable<PreparedCloudPage['skillVersionBinding']> = { owner }
    this.skillVersionBinding = binding
    binding.withdraw = attachSkillVersionEditing(this.skillEditing, {
      scope: this.bootstrap.connectionGeneration + ':' + String(owner.fiber.uid),
      signal: this.lifetime.transport.signal, maxFileBytes: this.skillSettings.maxFileBytes, prepare, title,
      assertCurrent: () => {
        if (this.skillVersionBinding !== binding) throw new ClientFailure('closed')
        this.assertSkillSettingsCurrent(owner)
      },
    })
    return () => { if (this.skillVersionBinding === binding) this.revokeSkillVersions() }
  }

  /**
   * Attach generated multi-skill operations to this page's original observable and dependency binding.
   * @param owner Original generated namespace owner; replacement withdraws this exact binding.
   * @param callbacks Captured operations whose private closures hold native directory versions.
   * @param legacy Captured original two-file sample editor; it uses the same page and directory authority.
   * @returns Synchronous withdrawal preserving only the retired scope's own unresolved draft.
   */
  attachManagedSkills(owner: Context, callbacks: Pick<ManagedSkillEditingInput, 'installed' | 'details'>,
    legacy: { readonly prepare: (signal: AbortSignal) => Promise<PreparedSkillEdit>; readonly title: () => string }): () => void {
    this.assertCurrent(owner)
    if (this.skillSettings === undefined || !this.bootstrap.capabilities.configuration.skills.manage
      || this.skillVersionBinding !== undefined) throw new ClientFailure('closed')
    const binding: NonNullable<PreparedCloudPage['skillVersionBinding']> = { owner }
    this.skillVersionBinding = binding
    const scope = JSON.stringify([this.bootstrap.account.id, this.bootstrap.connectionGeneration, owner.fiber.uid])
    const assertCurrent = (): void => {
      if (this.skillVersionBinding !== binding) throw new ClientFailure('closed')
      this.assertSkillSettingsCurrent(owner)
    }
    const withdrawManaged = attachManagedSkillEditing(this.skillEditing, {
      ...callbacks, signal: this.lifetime.transport.signal, scope,
      assertCurrent,
    })
    const withdrawSample = attachSkillVersionEditing(this.skillEditing, {
      scope, signal: this.lifetime.transport.signal, maxFileBytes: this.skillSettings.maxFileBytes,
      prepare: legacy.prepare, title: legacy.title, assertCurrent,
    })
    binding.withdraw = () => { withdrawSample(); withdrawManaged() }
    return () => { if (this.skillVersionBinding === binding) this.revokeSkillVersions() }
  }

  private revokeSkillVersions(): void {
    const binding = this.skillVersionBinding
    this.skillVersionBinding = undefined
    binding?.withdraw?.()
  }

  /**
   * Read the skill RPC deadline and legacy sample file limit.
   * @returns Explicit skill bounds; omission leaves skill management unregistered.
   */
  get skillSettings(): Readonly<NonNullable<CloudClientConfig['skillSettings']>> | undefined { return this.config.skillSettings }

  /**
   * Check the original page, active dependency and captured Connection before and after a skill RPC.
   * @param owner Original Cloud dependency fiber; no replacement page or carrier is acquired.
   * @throws Error after page, dependency, persistence or Connection revocation.
   */
  assertSkillSettingsCurrent(owner: Context): void { this.assertAccountManagementCurrent(owner) }

  /**
   * Check the same immutable page and Connection for approved account management.
   * @param owner Original management dependency fiber.
   * @throws Error after owner, page, persistence, transport or Connection revocation.
   */
  assertAccountManagementCurrent(owner: Context): void {
    owner.fiber.assertActive(); this.assertCurrent(owner); this.lifetime.transport.signal.throwIfAborted()
    if (this.activation === undefined || this.connection === undefined || this.activation.get('connection') !== this.connection) {
      throw new ClientFailure('closed')
    }
  }

  private modelsCurrent(binding: NonNullable<PreparedCloudPage['modelSettingsBinding']>): boolean {
    if (this.modelSettingsBinding !== binding || this.lifetime.transport.signal.aborted
      || this.activation === undefined || this.connection === undefined
      || this.activation.get('connection') !== this.connection) return false
    try { this.assertCurrent(binding.owner); return true } catch { return false }
  }

  private revokeModels(): void {
    this.modelSettingsBinding = undefined
    if (this.modelsEditing.getSnapshot() !== null) this.modelsEditing.set(null)
  }

  private bind(ctx: Context): void {
    if (ctx !== ctx.root) throw new Error('Cloud page preparation requires its native root Context')
    if (this.root !== undefined || ctx.get('peCloudPage', false) !== undefined) throw new Error('Cloud page owner is already bound')
    if (ctx.get('connection', false) !== undefined) throw new Error('Cloud page requires the sole native Connection installer')
    if (ctx.get('modelsSettingsIntegration', false) !== undefined) throw new Error('Cloud page Models integration is already bound')
    if (ctx.get('fileUpload', false) !== undefined) throw new Error('Cloud page requires upload preparation before the native upload service')
    if (this.lifetime.getSnapshot().phase !== 'running'
      || this.lifetime.persistence.getSnapshot().phase !== 'active'
      || ctx.get('clientPersistence') !== this.lifetime.nativeOptions.persistence) {
      throw new Error('Cloud page requires its prepared persistence before native activation')
    }
    const fetch = this.lifetime.transport.hooks.fetch
    if (fetch === undefined) throw new Error('Cloud page requires its captured upload fetch')
    const existing = ctx.get('fileUploadHooks', false)
    if (existing !== undefined && (existing.fetch !== fetch || !Object.isFrozen(existing))) {
      throw new Error('Cloud page upload carrier is incompatible with its prepared owner')
    }
    this.uploadHooks = existing ?? Object.freeze({ fetch })
    if (existing === undefined) ctx.provide('fileUploadHooks', this.uploadHooks)
    this.root = ctx.root
    ctx.provide('peCloudPage', this)
    ctx.provide('modelsSettingsIntegration', this.modelsSettingsIntegration)
  }

  private assertCurrent(ctx: Context): void {
    if (this.root === undefined || ctx.root !== this.root || ctx.get('peCloudPage') !== this
      || ctx.get('modelsSettingsIntegration') !== this.modelsSettingsIntegration
      || this.uploadHooks === undefined || ctx.get('fileUploadHooks') !== this.uploadHooks
      || ctx.get('clientPersistence') !== this.nativeOptions.persistence
      || this.lifetime.persistence.getSnapshot().phase !== 'active'
      || this.lifetime.getSnapshot().phase !== 'running') {
      throw new Error('Cloud page prepared owner is missing, stale or bound to another native root')
    }
  }

  private stopAfterFailure(): void {
    void this.dispose().catch((error: unknown) => { console.error('Cloud prepared page cleanup unconfirmed:', error) })
  }
}
