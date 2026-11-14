/** Host file-upload service: streamed intake and Session-owned staged receipts. */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CommandFileReceiptResolver } from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { handleFileUploadHttp } from './http-route.ts'
import { FILE_UPLOAD_PATH } from './protocol.ts'
import type {
  EncodedFileUploadRequest, FileUploadReceiptId, FileUploadValue, ImageUploadValue, StagedAttachment,
} from './types.ts'

export type * from './types.ts'
export { FILE_UPLOAD_PATH } from './protocol.ts'

/** Native receipt/intake capacity; omission retains the original finite 128-slot bound. */
export interface Config {
  /** Positive safe-integer bound shared by actual active intakes and staged receipts; defaults to 128. */
  readonly maxPendingReceipts?: number
}

interface ResolvedConfig {
  readonly maxPendingReceipts: number
}

/** Actual upload work whose cleanup or publication has not confirmed settlement. */
export class FileUploadIntakeUnconfirmedError extends Error {
  /** @param options - original private cleanup/publication cause, not an HTTP payload. */
  constructor(options?: ErrorOptions) {
    super('File upload intake settlement is unconfirmed.', options)
    this.name = 'FileUploadIntakeUnconfirmedError'
  }
}

/** Confirmed file-size refusal before any receipt is published. */
export class FileUploadTooLargeError extends HarnessError {
  /** Stable classification of an actual confirmed file-size refusal. */
  override readonly code = 'FS_TOO_LARGE'
  /** No receipt was published; the producing storage owner has confirmed this refusal. */
  readonly outcome = 'not-published'

  constructor() {
    super('File exceeds the upload size limit.', 'FS_TOO_LARGE')
    this.name = 'FileUploadTooLargeError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host storage and staged-receipt service for browser file and image uploads. */
    fileUploads: FileUploads
  }
}

interface StagedFileUpload {
  readonly attachment: StagedAttachment
  /** An inserted row remains unavailable until the original intake commits its handoff. */
  unconfirmed?: boolean
  /** Prompt that accepted this receipt; absent until successful admission. */
  requestId?: string
}

/** Resolve or resume the ordinary Agent that owns one Session identity. */
export type AgentResolver = (sessionId: SessionId) => Promise<Agent>

/** Prompt receipt binding that restores its previous owners unless delivery commits it. */
export interface PromptFileBinding extends Disposable {
  /** Keep the receipt bindings until queue or history observation retires them. */
  commit(): void
}

class PromptFileBindingGuard implements PromptFileBinding {
  private settled = false

  constructor(private readonly rollback: () => void) {}

  commit(): void {
    this.settled = true
  }

  [Symbol.dispose](): void {
    if (this.settled) return
    this.settled = true
    this.rollback()
  }
}

/** Host service owning upload storage and receipts keyed by each receiving Agent's exact Session. */
export class FileUploads extends TypertRemoteService {
  static inject = ['agents', 'attachments', 'commands', 'connection']
  static Config: z<Config, ResolvedConfig> = z.object({
    maxPendingReceipts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128)
      .description('Maximum staged receipts and in-flight native intakes combined.'),
  }).default({})

  private readonly stagedFiles = new Map<Session, Map<FileUploadReceiptId, StagedFileUpload>>()
  private readonly disposedSessions = new WeakSet<Session>()
  private readonly intakes = new Set<Promise<unknown>>()
  private readonly maxPendingReceipts: number
  // A plain holder keeps one state and resolver identity across Cordis caller proxies.
  private readonly state: { occupied: number; closed: boolean; resolver: AgentResolver | undefined } = {
    occupied: 0, closed: false, resolver: undefined,
  }

  /**
   * @param ctx - Host context carrying Agent, attachment, command, and Connection services.
   * @param config - finite combined receipt/intake capacity; defaults to the original 128.
   */
  constructor(ctx: Context, config: Config = {}) {
    const resolved = FileUploads.Config(config)
    super(ctx, 'fileUploads')
    this.maxPendingReceipts = resolved.maxPendingReceipts
    // Commands accept staged files only; an image receipt is unknown to them.
    const resolve: CommandFileReceiptResolver = (agent, receiptId) => {
      const staged = this.resolve(agent, receiptId as FileUploadReceiptId)
      return staged?.type === 'file' ? staged.attachment : undefined
    }
    ctx.effect(
      () => ctx.commands.registerFileReceiptResolver(resolve),
      'file-upload: command file receipt resolver',
    )
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: FILE_UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: request => handleFileUploadHttp(this, request),
      }),
      'file-upload: streaming route',
    )
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('session/disposed', (session) => {
      this.disposedSessions.add(session)
      this.dropSession(session)
    })
    ctx.effect(() => async () => {
      this.state.closed = true
      for (const session of this.stagedFiles.keys()) this.dropSession(session)
      await Promise.allSettled(this.intakes)
      if (this.state.occupied !== 0) throw new FileUploadIntakeUnconfirmedError()
    }, 'file-upload: intake settlement')
  }

  /**
   * Register the ordinary-Session resolver used when a raw upload addresses a cold Session.
   * @param resolve - resolver that returns the exact live Agent or throws a Remote error.
   * @returns disposer removing this resolver.
   */
  registerAgentResolver(resolve: AgentResolver): () => void {
    if (this.state.resolver !== undefined) throw new Error('file-upload: Agent resolver is already registered')
    this.state.resolver = resolve
    return () => {
      if (this.state.resolver === resolve) this.state.resolver = undefined
    }
  }

  /**
   * Persist one encoded upload and stage it under the Agent receiver selected by Typert.
   * @param agent - receiving Agent resolved from the Remote Agent scope.
   * @param request - canonical base64 bytes and optional display name.
   * @param signal - caller cancellation before storage begins.
   * @returns the staged receipt and durable file reference.
   */
  @Remote('upload')
  async upload(agent: Agent, request: EncodedFileUploadRequest, signal: AbortSignal): Promise<FileUploadValue> {
    signal.throwIfAborted()
    return this.intake(async (retainReceipt) => {
      const file = await this.store(agent, async () => this.ctx.attachments.admitEncodedFile({
        data: request.data,
        ...(request.name === undefined ? {} : { name: request.name }),
      }))
      return { receiptId: this.stage(agent, { type: 'file', attachment: file }, retainReceipt), file }
    })
  }

  /**
   * Persist raw chunks for one Session without aggregating the upload.
   * @param request - Session identity, ordered bytes, cancellation, and optional display name.
   * @returns the staged receipt and durable file reference.
   */
  async uploadStream(request: {
    readonly sessionId: SessionId
    readonly workspaceDirectory?: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileUploadValue> {
    return this.intake(async (retainReceipt) => {
      request.signal?.throwIfAborted()
      const agent = await this.resolveAgent(request.sessionId)
      request.signal?.throwIfAborted()
      const file = await this.store(agent, async () => this.storeFileStream(agent, {
        data: request.data,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.name === undefined ? {} : { name: request.name }),
      }, request.workspaceDirectory))
      return { receiptId: this.stage(agent, { type: 'file', attachment: file }, retainReceipt), file }
    })
  }

  /**
   * Store through the same admitted file hook without retaining a conversation receipt.
   * @param request - original Session, ordered bytes and explicit workspace destination.
   * @returns the durable file after the hook's actual publication settles; late ownership failure remains unknown.
   */
  uploadWorkspaceStream(request: {
    readonly sessionId: SessionId
    readonly workspaceDirectory: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileAttachmentRef> {
    return this.intake(async () => {
      request.signal?.throwIfAborted()
      const agent = await this.resolveAgent(request.sessionId)
      request.signal?.throwIfAborted()
      const file = await this.store(agent, () => this.storeFileStream(agent, {
        data: request.data,
        ...request.signal === undefined ? {} : { signal: request.signal },
        ...request.name === undefined ? {} : { name: request.name },
      }, request.workspaceDirectory))
      try { this.assertCurrentAgent(agent); return file }
      catch (cause) { throw new FileUploadIntakeUnconfirmedError({ cause }) }
    })
  }

  /**
   * Persist one prompt image for a Session: read at most the smaller of the
   * deployment's per-image and per-message byte limits, then validate,
   * normalize, and store the image the way prompt admission does, so a later
   * prompt cites it by receipt.
   * Cancellation before storage begins stores nothing; a cancelled upload
   * never receives a receipt, although an image whose storage already began
   * stays in the content-addressed store.
   * @param request - Session identity, ordered bytes, the declared media type that this deployment
   * must accept, cancellation, and optional display name.
   * @returns the staged receipt and durable normalized image reference.
   */
  async uploadImageStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<ImageUploadValue> {
    return this.intake(async (retainReceipt) => {
      request.signal?.throwIfAborted()
      const agent = await this.resolveAgent(request.sessionId)
      request.signal?.throwIfAborted()
      const limits = this.ctx.attachments.imageLimits
      const mediaType = limits.mediaTypes.find(type => type === request.mediaType)
      if (mediaType === undefined) {
        throw new RemoteError(
          'session/attachment-invalid' as never,
          `Image type ${request.mediaType} is not accepted by this deployment.`,
          { reason: 'UNSUPPORTED_IMAGE_TYPE' } as never,
        )
      }
      const staged = await this.store(agent, async () => {
        // One image must also fit a whole message; stop at the smaller bound, as read-image does.
        const data = await readAtMost(request.data, Math.min(limits.maxImageBytes, limits.maxMessageImageBytes), request.signal)
        // readAtMost checks cancellation per chunk; an abort after the last chunk still stops here.
        request.signal?.throwIfAborted()
        const refs = await this.ctx.attachments.saveImages([{
          data,
          mediaType,
          ...(request.name === undefined ? {} : { name: request.name }),
        }])
        request.signal?.throwIfAborted()
        // saveImages returns one reference per input, in input order.
        return { type: 'image' as const, attachment: refs[0] as ImageAttachmentRef, encodedBytes: data.byteLength }
      })
      return { receiptId: this.stage(agent, staged, retainReceipt), image: staged.attachment }
    })
  }

  /**
   * Resolve one staged receipt for the receiving Agent's exact Session.
   * @param agent - receiving Agent.
   * @param receiptId - opaque receipt minted for one completed upload.
   * @returns the staged file or image, or `undefined` for an unknown or foreign receipt.
   */
  resolve(agent: Agent, receiptId: FileUploadReceiptId): StagedAttachment | undefined {
    const staged = this.stagedFiles.get(agent.session)?.get(receiptId)
    return staged?.unconfirmed === true ? undefined : staged?.attachment
  }

  /**
   * Bind receipts while one prompt enters an Agent inbox.
   * Disposal restores every prior binding unless the caller commits successful delivery.
   * @param agent - receiving Agent.
   * @param receiptIds - distinct staged receipts referenced by the prompt.
   * @param requestId - prompt identity later observed in queue or history.
   * @returns binding kept after commit until queue or history observation retires its receipts.
   */
  bindPrompt(
    agent: Agent,
    receiptIds: readonly FileUploadReceiptId[],
    requestId: string,
  ): PromptFileBinding {
    const staged = this.stagedFiles.get(agent.session)
    const bound = receiptIds.map((receiptId) => {
      const upload = staged?.get(receiptId)
      if (upload === undefined || upload.unconfirmed === true) throw fileNotStaged()
      return { upload, previous: upload.requestId }
    })
    for (const { upload } of bound) upload.requestId = requestId
    return new PromptFileBindingGuard(() => {
      for (const { upload, previous } of bound) {
        if (previous === undefined) delete upload.requestId
        else upload.requestId = previous
      }
    })
  }

  /**
   * Retire every receipt accepted by one removed queue occurrence.
   * @param agent - receiving Agent.
   * @param requestId - prompt identity carried by the queue occurrence.
   */
  retirePrompt(agent: Agent, requestId: string): void {
    this.retire(agent.session, requestId)
  }

  /** Reserve before source work, transferring only confirmed receipt handoffs to staged accounting. */
  private intake<T>(run: (retainReceipt: () => void) => Promise<T>): Promise<T> {
    if (this.state.closed || this.state.occupied >= this.maxPendingReceipts) {
      return Promise.reject(new RemoteError('session/attachment-invalid' as never,
        'File upload intake is closed or at capacity.', { reason: 'FILE_UPLOAD_CAPACITY' } as never))
    }
    this.state.occupied++
    let disposition: 'pending' | 'staged' | 'unconfirmed' = 'pending'
    const job = Promise.resolve().then(() => run(() => { disposition = 'staged' })).catch((error: unknown) => {
      if (error instanceof FileUploadIntakeUnconfirmedError) {
        disposition = 'unconfirmed'
        this.state.closed = true
      }
      throw error
    }).finally(() => {
      if (disposition === 'pending') this.state.occupied--
      this.intakes.delete(job)
    })
    this.intakes.add(job)
    return job
  }

  /**
   * Store the original stream before its receipt is published.
   * Overrides may await admission without pulling bytes and retain their actual storage/publication work through settlement.
   * Rejection alone establishes neither rollback nor source closure; unknown work must throw FileUploadIntakeUnconfirmedError.
   * @param agent - exact ordinary Agent resolved by this service.
   * @param input - original ordered bytes, cancellation signal and optional name.
   * @param workspaceDirectory - explicit workspace destination; the default Native owner does not grant workspace publication.
   * @returns the authoritative durable file after the storage hook settles.
   */
  protected storeFileStream(agent: Agent, input: SaveFileStreamAttachment, workspaceDirectory?: string): Promise<FileAttachmentRef> {
    void agent
    if (workspaceDirectory !== undefined) throw new RemoteError('gateway/bad-request', 'Workspace upload is unavailable.', {})
    return this.ctx.attachments.saveFileStream(input)
  }

  /** Store one upload for an ordinary Agent; storage failures become Remote failures. */
  private async store<T>(agent: Agent, save: () => Promise<T>): Promise<T> {
    this.assertOrdinaryAgent(agent)
    this.assertCurrentAgent(agent)
    try {
      return await save()
    } catch (error) {
      if (error instanceof FileUploadIntakeUnconfirmedError) throw error
      if (error instanceof Error && error.cause instanceof FileUploadIntakeUnconfirmedError) throw error.cause
      if (error instanceof FileUploadTooLargeError) {
        throw new RemoteError('session/attachment-invalid' as never,
          'File exceeds the upload size limit.', { reason: 'FILE_UPLOAD_TOO_LARGE' } as never)
      }
      if (remoteErrorOf(error) !== undefined) throw error
      if (this.ctx.attachments.isAttachmentError(error)) {
        if (error.settlement === 'unknown') throw new FileUploadIntakeUnconfirmedError({ cause: error })
        throw new RemoteError('session/attachment-invalid' as never, error.message, { reason: error.code } as never)
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to store file upload: ${String(error)}`,
        {},
        { cause: error },
      )
    }
  }

  /** Stage one stored upload under a new receipt for the Agent's exact Session. */
  private stage(agent: Agent, attachment: StagedAttachment, retainReceipt: () => void): FileUploadReceiptId {
    try {
      this.assertCurrentAgent(agent)
      let staged = this.stagedFiles.get(agent.session)
      if (staged === undefined) {
        staged = new Map()
        this.stagedFiles.set(agent.session, staged)
      }
      const receiptId = randomUUID() as FileUploadReceiptId
      const row: StagedFileUpload = { attachment, unconfirmed: true }
      staged.set(receiptId, row)
      this.assertCurrentAgent(agent)
      if (this.stagedFiles.get(agent.session) !== staged || staged.get(receiptId) !== row) {
        throw new Error('The upload receipt owner changed before handoff.')
      }
      retainReceipt()
      row.unconfirmed = false
      return receiptId
    } catch (cause) {
      throw new FileUploadIntakeUnconfirmedError({ cause })
    }
  }

  /** Recheck the original Agent after actual storage and before receipt handoff. */
  private assertCurrentAgent(agent: Agent): void {
    if (this.state.closed || this.disposedSessions.has(agent.session) || this.ctx.agents.get(agent.id) !== agent) {
      throw new RemoteError(
        'session/not-found',
        `session "${agent.id}" was disposed before its file upload completed`,
        { sessionId: agent.id },
      )
    }
  }

  /** Retire only known receipt responsibilities; unknown handoffs keep their original charge. */
  private dropSession(session: Session): void {
    const staged = this.stagedFiles.get(session)
    if (staged === undefined) return
    for (const upload of staged.values()) if (upload.unconfirmed !== true) this.state.occupied--
    this.stagedFiles.delete(session)
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const resolver = this.state.resolver
    if (resolver === undefined) {
      throw new RemoteError('session/not-found', `session "${sessionId}" is not attached`, { sessionId })
    }
    return resolver(sessionId)
  }

  private assertOrdinaryAgent(agent: Agent): void {
    if (agent.session.header.origin === 'subagent') {
      throw new RemoteError(
        'subagent/attachment-invalid' as never,
        'subagent conversations do not accept file uploads',
        { reason: 'SUBAGENT_FILE_UNSUPPORTED' } as never,
      )
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user'
      || !('rpcId' in event.data.source)) return
    if (typeof event.data.source.rpcId === 'string') this.retire(session, event.data.source.rpcId)
  }

  private retire(session: Session, requestId: string): void {
    const staged = this.stagedFiles.get(session)
    if (staged === undefined) return
    for (const [receiptId, upload] of staged) {
      if (upload.unconfirmed !== true && upload.requestId === requestId) {
        staged.delete(receiptId)
        this.state.occupied--
      }
    }
    if (staged.size === 0) this.stagedFiles.delete(session)
  }
}

/** Collect one body of at most `limit` bytes, refusing it as soon as it passes the limit. */
async function readAtMost(data: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of data) {
    signal?.throwIfAborted()
    length += chunk.byteLength
    if (length > limit) {
      throw new RemoteError(
        'session/attachment-invalid' as never,
        'Image exceeds the configured byte limit.',
        { reason: 'IMAGE_TOO_LARGE' } as never,
      )
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function fileNotStaged(): RemoteError {
  return new RemoteError(
    'session/attachment-invalid' as never,
    'File was not uploaded for this session.',
    { reason: 'FILE_NOT_STAGED' } as never,
  )
}

export default FileUploads
