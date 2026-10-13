/** Host access to platform APIs and operation-local execution grants. */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { grant, type Grant, PlatformError } from '../contracts.ts'
import type { NativeAssistantPublisher, NativePublicationSeal } from './native-assistant-publisher.ts'
import type { NativeInputCoordinator } from './native-input-coordinator.ts'
import type { InputCommandReceipt, NativeInputQueueCommand } from '../native-input-ledger-contracts.ts'
import { NativeRetainedIntentClient } from './native-retained-intent-client.ts'
import type { NativeRetainedIntentId, NativeRetainedMutation, NativeRetainedReceipt } from '../native-retained-intent-contracts.ts'
import { ACCOUNT_ERROR_CODES } from '../account-contracts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { powerEvolveRuntime: RuntimeScope }
}

/** Deployment-owned platform endpoint, worker identity, and transport bounds. */
export const Config = schema.object({
  platformUrl: schema.string().required(), workerTokenFile: schema.string().required(),
  workerId: schema.string().default(''),
  timeoutMs: schema.number().min(1000).required(), maxResponseBytes: schema.number().min(1024).required(),
  nativePublicationMaxQueueItems: schema.number().step(1).min(1).default(256),
  nativePublicationMaxQueueBytes: schema.number().step(1).min(1).default(4_194_304),
  nativePublicationMaxBatchItems: schema.number().step(1).min(1).default(32),
  nativePublicationMaxBatchBytes: schema.number().step(1).min(1).default(1_048_576),
  nativePublicationMaxItemBytes: schema.number().step(1).min(1).default(1_048_576),
  nativeIntentReconcileLimit: schema.number().step(1).min(1).max(2_147_483_647).default(32),
  nativeIntentMaxLocalReceipts: schema.number().step(1).min(1).max(2_147_483_647).default(65_536),
})
/** Validated deployment settings for platform transport and native publication limits. */
export type Config = ReturnType<typeof Config>

/** A shared host keeps grants by Session; it never has a mutable current user. */
export default class RuntimeScope extends Service {
  static Config = Config
  /** Identity of this RuntimeScope instance, presented when claiming work. */
  readonly workerId: string
  /** Shared Platform mutation journal; historical results remain separate from the live Grant map. */
  readonly nativeRetainedIntents: NativeRetainedIntentClient
  /** Current Session grants; exact object identity fences asynchronous access. */
  readonly grants = new Map<SessionId, Grant>()
  private readonly inputOwners = new Map<SessionId, { grant: Grant; coordinator: NativeInputCoordinator }>()
  private readonly publications = new Map<SessionId, {
    readonly publisher: NativeAssistantPublisher
    readonly synchronize: (expectedEventCount: number, events: readonly SessionEvent[]) => void
    readonly retire: (seal: NativePublicationSeal) => void
  }>()
  private workerToken = ''
  private retainedDispatches = 0
  private readonly retainedAcknowledgements = new Map<NativeRetainedIntentId, {
    readonly grant: Grant
    readonly receipt: NativeRetainedReceipt
    ready: boolean
  }>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'powerEvolveRuntime')
    this.workerId = config.workerId === '' ? randomUUID() : z.uuid().parse(config.workerId)
    this.nativeRetainedIntents = new NativeRetainedIntentClient(this.workerId,
      (path, token, input, signal) => this.call(path, token, input, signal),
      (path, input, signal) => this.call(path, this.workerToken, input, signal))
  }

  async [Service.init](): Promise<void> { this.workerToken = (await readFile(this.config.workerTokenFile, 'utf8')).trim() }

  /** Dispatch a complete original mutation through the shared journal before returning its provider reply.
   * @param token Exact locally installed operation bearer.
   * @param mutation Full original transaction request, without generating replacement identities.
   * @param signal Original consumer lifetime.
   * @returns Strict original provider result, still subject to its consumer's semantic and local mirror checks.
   */
  async commitNativeMutation(token: string, mutation: NativeRetainedMutation, signal?: AbortSignal): Promise<unknown> {
    const expected = [...this.grants.values()].find(value => value.token === token)
    if (!expected) throw new PlatformError(409, 'lease_lost')
    if (this.retainedAcknowledgements.size + this.retainedDispatches >= this.config.nativeIntentMaxLocalReceipts) {
      throw new PlatformError(413, 'native_intent_local_receipt_budget')
    }
    this.assertGrant(expected)
    ++this.retainedDispatches
    try {
      const dispatch = await this.nativeRetainedIntents.commit(token, mutation, signal)
      this.assertGrant(expected)
      this.retainedAcknowledgements.set(dispatch.intentId, { grant: expected, receipt: dispatch.receipt, ready: false })
      return dispatch.result.result
    } finally { --this.retainedDispatches }
  }

  /** Acknowledge a generation only after all native receipts and local publication barriers succeeded.
   * @param expected Exact original generation; a replacement cannot confirm its predecessor's pending mirror.
   */
  confirmNativeIntents(expected: Grant): void {
    for (const item of this.retainedAcknowledgements.values()) if (item.grant === expected) item.ready = true
  }

  /** Reconcile shared outcomes before claims and clear only validated, consumed or fully retired requests.
   * @param signal Scheduler lifetime; the whole maintenance pass also has a configured deadline.
   */
  async reconcileNativeIntents(signal?: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline
    let remaining = this.config.nativeIntentReconcileLimit
    for (const [id, item] of this.retainedAcknowledgements) {
      if (!item.ready) continue
      try { await this.nativeRetainedIntents.resolve(id, item.receipt, lifetime) }
      catch (error) {
        if (!(error instanceof PlatformError) || error.status !== 401
          || error.code !== ACCOUNT_ERROR_CODES.disabled && error.code !== ACCOUNT_ERROR_CODES.deleted) throw error
        // Shared storage retains the original request until account maintenance permits reconciliation.
      }
      this.retainedAcknowledgements.delete(id)
      if (--remaining === 0) break
    }
    const result = await this.nativeRetainedIntents.reconcile(this.config.nativeIntentReconcileLimit, lifetime)
    for (const item of result.items) {
      if (item.outcome.state !== 'committed' || !item.outcome.retired) continue
      const local = this.retainedAcknowledgements.get(item.intentId)
      if (local && !local.ready && this.grants.get(local.grant.sessionId) === local.grant) continue
      await this.nativeRetainedIntents.resolve(item.intentId, item.outcome.receipt, lifetime)
      this.retainedAcknowledgements.delete(item.intentId)
    }
  }

  /** Claim at most one eligible operation selected by the trusted platform.
   * @param signal Admission lifetime, including Host shutdown.
   * @returns a scoped grant or null when no work is available.
   */
  async claim(signal?: AbortSignal): Promise<Grant | null> {
    return grant.nullable().parse(await this.call('/runtime/claim', this.workerToken, { workerId: this.workerId }, signal))
  }

  /** Claim only current storage ownership for an unfinished archival stop.
   * @param signal Admission lifetime including Host shutdown.
   * @returns Original fenced operation under a new storage attempt, or absence of eligible archival maintenance.
   */
  async claimArchiveStop(signal?: AbortSignal): Promise<Grant | null> {
    return grant.nullable().parse(await this.call('/runtime/claim-archive-stop', this.workerToken,
      { workerId: this.workerId }, signal))
  }

  /** Require a live grant before accessing one Session's resources.
   * @param id - the native Session identity.
   * @returns its active operation grant.
   */
  require(id: SessionId): Grant {
    const value = this.grants.get(id)
    if (!value) throw new PlatformError(403, 'session_not_leased')
    return value
  }

  /** Register the exact live Agent's native input consumer for routed browser commands.
   * @param expected Original current Grant; a replacement cannot use the old consumer.
   * @param coordinator Actual native reservation and atomic Platform commit adapter.
   * @returns Exact disposer; an old Agent cannot remove a replacement registration.
   */
  registerInputOwner(expected: Grant, coordinator: NativeInputCoordinator): () => void {
    this.assertGrant(expected)
    if (this.inputOwners.has(expected.sessionId)) throw new PlatformError(409, 'native_input_owner_busy')
    const registration = { grant: expected, coordinator }
    this.inputOwners.set(expected.sessionId, registration)
    return () => { if (this.inputOwners.get(expected.sessionId) === registration) this.inputOwners.delete(expected.sessionId) }
  }

  /** Apply one routed original browser command through the current native Session owner.
   * @param credential Browser bearer rechecked by the actual Platform transaction.
   * @param command Validated original payload and retained carrier nonce.
   * @returns Immutable tokenless result; unavailable or replaced owners refuse.
   */
  queueInput(credential: string, command: NativeInputQueueCommand): Promise<InputCommandReceipt> {
    const owner = this.inputOwners.get(command.payload.sessionId)
    if (!owner) throw new PlatformError(409, 'native_input_owner_unavailable')
    this.assertGrant(owner.grant)
    return owner.coordinator.queue(credential, command)
  }

  /** Bind one publication owner to the native writer's exact lifetime.
   * @param expected Exact grant captured before any asynchronous snapshot read.
   * @param publisher Ordered writer installed before its Agent is published.
   * @param synchronize Exact write handle's silent committed-suffix import.
   * @param retire Exact write handle's retirement after a proved Platform generation transfer.
   * @returns A disposer that cannot remove a replacement writer.
   */
  registerPublication(expected: Grant, publisher: NativeAssistantPublisher,
    synchronize: (expectedEventCount: number, events: readonly SessionEvent[]) => void,
    retire: (seal: NativePublicationSeal) => void): () => void {
    this.assertGrant(expected)
    if (!publisher.owns(expected)) throw new PlatformError(409, 'lease_lost')
    const id = expected.sessionId
    if (this.publications.has(id)) throw new PlatformError(409, 'native_publication_owned')
    const registration = { publisher, synchronize, retire }
    this.publications.set(id, registration)
    return () => { if (this.publications.get(id) === registration) this.publications.delete(id) }
  }

  /** Locate the native writer during unpublished Agent setup.
   * @param expected The exact operation being resumed.
   * @returns Its owned ordered publisher; absence prevents Agent publication.
   */
  publication(expected: Grant): NativeAssistantPublisher {
    this.assertGrant(expected)
    const publisher = this.publications.get(expected.sessionId)?.publisher
    if (!publisher || !publisher.owns(expected)) throw new PlatformError(409, 'native_publication_missing')
    return publisher
  }

  /** Synchronize the exact write handle after a proved atomic input commit, without publishing events twice.
   * @param expected Original current operation; replacement refuses the old mirror.
   * @param expectedEventCount Protected native prefix before the committed suffix.
   * @param events Exact canonical events whose PG receipt has already been verified.
   */
  synchronizeCommitted(expected: Grant, expectedEventCount: number, events: readonly SessionEvent[]): void {
    this.assertGrant(expected)
    const registration = this.publications.get(expected.sessionId)
    if (!registration?.publisher.owns(expected)) throw new PlatformError(409, 'native_publication_missing')
    registration.synchronize(expectedEventCount, events)
  }

  /** Retire only the original local generation after its Platform transition has been reconciled.
   * @param expected Original Grant still installed while its Agent reaches quiescence.
   * @param seal Exact watermark proved and consumed by that committed transition.
   */
  retirePublication(expected: Grant, seal: NativePublicationSeal): void {
    this.assertGrant(expected)
    const registration = this.publications.get(expected.sessionId)
    if (!registration?.publisher.owns(expected)) throw new PlatformError(409, 'native_publication_missing')
    registration.retire(seal)
    this.confirmNativeIntents(expected)
  }

  /** Refresh an existing writer after renewing its grant; opening may still be in progress.
   * @param expected Original operation whose grant was renewed; a predecessor is never refreshed.
   */
  heartbeatPublication(expected: Grant): void {
    const publisher = this.publications.get(expected.sessionId)?.publisher
    if (publisher?.owns(expected)) { this.assertGrant(expected); publisher.heartbeat() }
  }

  /** Recheck grant identity after an await and at native Agent publication.
   * @param expected Original operation and epoch captured by the caller.
   */
  assertGrant(expected: Grant): void {
    if (this.grants.get(expected.sessionId) !== expected) throw new PlatformError(409, 'lease_lost')
  }

  /** Call one configured platform endpoint with an explicit credential.
   * @param path - product-owned endpoint path.
   * @param token - user or operation bearer credential.
   * @param input - JSON request fields.
   * @param signal - Optional caller lifetime; the configured request timeout still applies.
   * @returns bounded decoded JSON, validated by its consumer.
   */
  async call(path: string, token: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const response = await fetch(new URL(path, this.config.platformUrl), {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    return this.responseValue(response)
  }

  /** Forward an authorized native file stream without retaining complete upload bytes in the Host.
   * @param token Original receiving user's browser credential.
   * @param id Receiving Session, validated by the native carrier.
   * @param name Optional display name, never a storage path.
   * @param body Bounded original file chunks.
   * @param signal Transport lifetime; the configured Platform timeout also applies.
   * @returns Durable upload receipt validated by the native carrier.
   */
  async uploadFile(token: string, id: SessionId, name: string | undefined,
    body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
    const url = new URL('/native/attachments/upload', this.config.platformUrl)
    url.searchParams.set('sessionId', id)
    if (name !== undefined) url.searchParams.set('name', name)
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', redirect: 'error', duplex: 'half', body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    }
    return this.responseValue(await fetch(url, init))
  }

  private async responseValue(response: Response): Promise<unknown> {
    if (!response.body) throw new PlatformError(502, 'platform_empty_response')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > this.config.maxResponseBytes) throw new PlatformError(502, 'platform_response_limit')
      chunks.push(chunk)
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!response.ok) {
      const error = z.object({ error: z.string(), details: z.record(z.string(), z.json()).optional() }).safeParse(data)
      throw new PlatformError(response.status, error.success ? error.data.error : 'platform_error', error.success ? error.data.details : undefined)
    }
    return data
  }
}
