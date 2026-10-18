/** Canonical bootstrap preparation and the page owner consumed by the real Cloud Loader entry. */
import type { Context } from '@deepseek-ai/cordis'
import { installConnection, type ConnectionHandle, type ConnectionWebSocketFactory, type RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientPersistence } from '@deepseek-ai/dsh-client-store'
import { decodeCloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/schema'
import type { BindingFieldNames, BootstrapDecodeLimits, CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { parseCloudClientConfig } from '../config.ts'
import type { CloudClientConfig } from '../types.ts'
import { BootstrapAttempt, type BootstrapSnapshot } from './bootstrap.ts'
import { ClientFailure } from './errors.ts'
import { CloudPageLifetime, type CloudNativeEntry, type CloudPageSnapshot } from './page-lifetime.ts'
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
   * Bind this prepared owner to the native entry's private root before plugins activate.
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
 * installs the existing native Connection with captured carriers. The fixed Cloud
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
  private root: Context | undefined
  private activation: Context | undefined
  private connection: ConnectionHandle | undefined
  private readonly config: Readonly<CloudClientConfig>
  private readonly location: { readonly hostname: string }

  private constructor(bootstrap: CloudBootstrap, input: CloudPagePreparationInput) {
    this.bootstrap = bootstrap
    this.config = Object.freeze({ ...input.config })
    this.location = Object.freeze({ hostname: new URL(input.baseUrl).hostname })
    const expectation = { accountId: bootstrap.account.id, connectionGeneration: bootstrap.connectionGeneration }
    this.lifetime = new CloudPageLifetime({
      expectation,
      storage: input.storage, persistenceLimits: input.persistenceLimits,
      transport: {
        baseUrl: input.baseUrl, fields: input.fields, fetch: input.fetch,
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
    this.nativeOptions = Object.freeze({
      ...this.lifetime.nativeOptions, prepareContext: (ctx: Context) => { this.bind(ctx) },
      beforeDispose: () => {
        this.lifetime.persistence.revoke()
        // close seals carrier admission synchronously; beforeClose joins the existing lifetime.
        // AppWebEntry has already published its disposal promise, so its reentrant dispose joins.
        void this.lifetime.transport.close()
      },
    })
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
   * @throws Error if ownership, cache, lifecycle or the sole Connection provider differs.
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
   * Revoke, stop, join and clear through the existing captured lifetime.
   * @returns actual local cleanup, rejecting any unconfirmed stop or namespace removal.
   */
  dispose(): Promise<void> { return this.lifetime.dispose() }

  private bind(ctx: Context): void {
    if (this.root !== undefined || ctx.get('peCloudPage', false) !== undefined) throw new Error('Cloud page owner is already bound')
    if (ctx.get('connection', false) !== undefined) throw new Error('Cloud page requires the sole native Connection installer')
    if (this.lifetime.getSnapshot().phase !== 'running'
      || this.lifetime.persistence.getSnapshot().phase !== 'active'
      || ctx.get('clientPersistence') !== this.lifetime.nativeOptions.persistence) {
      throw new Error('Cloud page requires its prepared persistence before native activation')
    }
    this.root = ctx.root
    ctx.provide('peCloudPage', this)
  }

  private assertCurrent(ctx: Context): void {
    if (this.root === undefined || ctx.root !== this.root || ctx.get('peCloudPage') !== this
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
