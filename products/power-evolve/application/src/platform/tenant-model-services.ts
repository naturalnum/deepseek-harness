/** Request-scoped use of the maintained image encoder and Platform's pinned HTTP transport. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentStore, AttachmentError, type ImageAttachmentLimits, type ImageAttachmentRef,
  type ImageRequestTarget, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { readRequestImageFile } from '@deepseek-ai/dsh-attachment-local'
import { McpNetworkOperation, type McpNetworkPolicy, type McpTransportBudgets } from './mcp-network.ts'
import type { NativeImageReader } from './native-images.ts'

/** Reuse the existing DNS/socket policy for every URL selected by a native HTTP SDK. */
export class TenantModelHttp {
  constructor(private readonly budgets: McpTransportBudgets, private readonly policy: McpNetworkPolicy) {}
  /** One native stream or discovery owns its sockets and shared byte/deadline counters.
   * @param signal Original bounded caller lifetime.
   * @param authorize Original current-operation or browser-account verification immediately before HTTP.
   * @returns Native fetch injection plus awaited socket disposal.
   */
  open(signal: AbortSignal, authorize: () => Promise<void>) {
    const operation = new McpNetworkOperation(this.budgets, signal)
    const httpFetch: typeof fetch = async (input, init) => {
      const endpoint = input instanceof Request ? input.url : String(input)
      const pinned = await operation.fetchFor(endpoint, this.policy, authorize, 'native')
      return pinned.fetch(input, init)
    }
    return { fetch: httpFetch, dispose: () => operation.dispose() }
  }
  /** Validate an endpoint using the same maintained policy without issuing HTTP.
   * @param endpoint Configured provider base URL.
   */
  async assertEndpoint(endpoint: string): Promise<void> {
    const operation = new McpNetworkOperation(this.budgets, new AbortController().signal)
    try { await operation.fetchFor(endpoint, this.policy, () => Promise.resolve(), 'native') }
    finally { await operation.dispose() }
  }
}

/** Read-only native attachment provider bound to the original model operation. */
export class TenantModelImages extends AttachmentStore {
  constructor(ctx: Context, readonly imageLimits: ImageAttachmentLimits, private readonly reader: NativeImageReader,
    private readonly token: string, private readonly signal: AbortSignal, private readonly cacheRoot: string) { super(ctx) }
  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new AttachmentError('Model execution cannot upload images.', 'ATTACHMENT_PROJECTION_UNSUPPORTED'))
  }
  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new AttachmentError('Model execution cannot upload images.', 'ATTACHMENT_PROJECTION_UNSUPPORTED'))
  }
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal) {
    return this.reader.read(this.token, ref, signal ? AbortSignal.any([this.signal, signal]) : this.signal)
  }
  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal) {
    const lifetime = signal ? AbortSignal.any([this.signal, signal]) : this.signal
    return readRequestImageFile(this.cacheRoot, await this.readImage(ref, lifetime), target, lifetime)
  }
}
