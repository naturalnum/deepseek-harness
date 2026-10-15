/** Browser-only key upload; Host requests contain metadata and original receipt identities. */
import type { ModelsCredentialIntake, ModelDiscoveryOutcome } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { modelCredentialReceipt, modelCredentialTicket, modelDiscoveryDraft } from '@power-evolve/contracts/model-settings'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { productRpcRequestInit } from '@power-evolve/contracts/account'

type Messages = { failed: string; uncertain: string }
type Pending = { requestId: string; digest: string }

/** Remote credential intake installed beside the native account policy. */
export class ModelCredentialIntake implements ModelsCredentialIntake {
  private readonly pending = new Map<string, Pending>()
  private readonly stop = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  constructor(private readonly platformOrigin: (signal: AbortSignal) => Promise<string>, private readonly messages: () => Messages,
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args), private readonly changed: () => void = () => {}) {}

  private async metadata(route: 'modelCredentialTicket' | 'modelCredentialReceipt', input: object): Promise<unknown> {
    this.stop.signal.throwIfAborted()
    const response = await this.request(`/api/powerEvolve/${route}`, productRpcRequestInit(input, this.stop.signal))
    if (!response.ok) throw new Error('Model credential metadata unavailable')
    return response.json()
  }

  private async submit(ref: string, value: string, discovery?: ReturnType<typeof modelDiscoveryDraft.parse>) {
    this.stop.signal.throwIfAborted()
    const bytes = new TextEncoder().encode(value.trim())
    const key = JSON.stringify([ref, discovery ?? null])
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      const previous = this.pending.get(key)
      if (previous !== undefined) {
        const receipt = modelCredentialReceipt.parse(await this.metadata('modelCredentialReceipt', { requestId: previous.requestId }))
        if (!receipt.saved && receipt.models === undefined) throw new Error(this.messages().uncertain)
        this.pending.delete(key)
        if (previous.digest === digest) return receipt
      }
      const requestId = randomUUID()
      const ticket = modelCredentialTicket.parse(await this.metadata('modelCredentialTicket', {
        requestId, ref, sizeBytes: bytes.byteLength, ...(discovery === undefined ? {} : { discovery }),
      }))
      const upload = new URL(ticket.uploadUrl)
      if (ticket.requestId !== requestId || upload.origin !== await this.platformOrigin(this.stop.signal)
        || upload.pathname !== '/model-credentials/upload' || upload.username || upload.password || upload.search || upload.hash) {
        throw new Error('Model credential upload authority unavailable')
      }
      this.pending.set(key, { requestId, digest })
      try {
        const response = await this.request(upload.href, { method: 'POST', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', signal: this.stop.signal,
          headers: { authorization: `Bearer ${ticket.ticket}`, 'content-type': 'application/octet-stream' }, body: bytes })
        if (!response.ok) throw new Error('Model credential upload unavailable')
        const receipt = modelCredentialReceipt.parse(await response.json())
        if (!receipt.saved && receipt.models === undefined) throw new Error('Model credential receipt incomplete')
        this.pending.delete(key)
        return receipt
      } catch (error) {
        // An uncertain upload is reconciled by its original identity; key bytes are never resent.
        const receipt = modelCredentialReceipt.parse(await this.metadata('modelCredentialReceipt', { requestId }))
        if (!receipt.saved && receipt.models === undefined) throw error
        this.pending.delete(key)
        return receipt
      }
    } finally { bytes.fill(0) }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const work = operation()
    this.active.add(work)
    void work.then(() => { this.active.delete(work) }, (_settledFailure: unknown) => { this.active.delete(work) })
    return work
  }

  /** Abort and join all browser requests before the providing plugin leaves.
   * @returns Completion after each accepted original request has settled.
   */
  async close(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled(this.active)
  }

  /** Store one key through a direct Platform upload and reconcile an uncertain response.
   * @param ref Native credential reference.
   * @param value Browser-owned key draft.
   * @returns Localized refusal, or absence after the original receipt confirms storage.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined> {
    return this.run(async () => {
      try {
        if (!(await this.submit(ref, value)).saved) return this.messages().uncertain
        this.stop.signal.throwIfAborted()
        this.changed()
        return undefined
      } catch (_intakeFailure) { return this.pending.has(JSON.stringify([ref, null])) ? this.messages().uncertain : this.messages().failed }
    })
  }

  /** Discover with a one-shot draft key, preserving its native model metadata without storing the key.
   * @param settingsNs Maintained adapter namespace.
   * @param request Original browser draft; apiKey is used only by the direct upload.
   * @returns Native discovered models or a localized refusal.
   */
  discoverModels(settingsNs: string, request: Parameters<ModelsCredentialIntake['discoverModels']>[1]): Promise<ModelDiscoveryOutcome> {
    return this.run(async () => {
      const { apiKey, ...draft } = request
      if (apiKey === undefined) return { kind: 'refused', message: this.messages().failed }
      try {
        const discovery = modelDiscoveryDraft.parse({ settingsNs, ...draft })
        const receipt = await this.submit('MODEL_DISCOVERY_API_KEY', apiKey, discovery)
        return receipt.models === undefined ? { kind: 'refused', message: this.messages().uncertain }
          : { kind: 'found', models: receipt.models.map(model => ({ id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
          })) }
      } catch (_discoveryFailure) { return { kind: 'refused', message: this.messages().uncertain } }
    })
  }
}
