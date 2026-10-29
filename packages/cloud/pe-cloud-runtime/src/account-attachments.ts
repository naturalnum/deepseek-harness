/** Native receipts and accepted Session refs become bounded, request-local project paths. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import { AttachmentCleanupError } from '@deepseek-ai/dsh-attachment-local'
import { FileUploads, FileUploadIntakeUnconfirmedError, FileUploadTooLargeError } from '@deepseek-ai/dsh-client-file-upload'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { isAgentLoopRequest, type RequestMessage } from '@deepseek-ai/dsh-llm'
import { CloudAccountFiles, FdMutationFailure, type StageFileResult } from '@deepseek-ai/dsh-pe-cloud-files'
import { CloudApiError } from '@deepseek-ai/dsh-pe-cloud-api'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { posix } from 'node:path'
import { createAttachmentRefCollector, type AttachmentRefLimits } from './attachment-refs.ts'
import type { AccountBinding } from './types.ts'
import { AccountRuntimeError } from './errors.ts'

/** Explicit trial capacities; file contents are streamed and never collected into a batch buffer. */
export interface AccountAttachmentLimits extends AttachmentRefLimits {
  readonly maxPromptFiles: number
  readonly maxFileBytes: number
  readonly maxUploadChunkBytes: number
  readonly intakeReservationBytes: number
  readonly maxPendingReceipts: number
}

interface PreparedPaths {
  readonly workspace: Workspace
  readonly rows: readonly StageFileResult[]
  release(): void
}

function key(ref: FileAttachmentRef): string { return `${ref.attachmentId}\0${ref.name}` }
function original(value: object): object {
  const raw: unknown = Reflect.get(value, symbols.original)
  return raw !== null && typeof raw === 'object' ? raw : value
}
function denied(): never { throw new CloudApiError('cloud/forbidden', 'The attachment is unavailable in this native request.') }

/** Graph-private composition; the original files lane and native receipt service retain their unique ownership. */
export class AccountAttachments {
  private readonly prepared = new Map<Agent, PreparedPaths>()

  /**
   * @param ctx Original account preparation scope, before other native listeners install.
   * @param binding Exact graph lifetime.
   * @param limits Required finite input and retained-result bounds.
   * @param files Original graph files owner, resolved lazily during native activation.
   * @param project Shared native Agent/Session/project admission, without path-derived authority.
   * @param installed Original graph/provider checks for the actual caller.
   */
  constructor(
    private readonly ctx: Context, private readonly binding: AccountBinding, private readonly limits: AccountAttachmentLimits,
    private readonly files: () => Pick<CloudAccountFiles, 'stageAttachments' | 'runAttachmentIntake'>,
    private readonly project: (agent: Agent) => Workspace,
    private readonly installed: (caller: Context) => void,
  ) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
      || limits.maxPromptFiles > limits.maxRefs || limits.maxUploadChunkBytes > limits.maxFileBytes
      || limits.intakeReservationBytes < 3 * limits.maxUploadChunkBytes + 8 * limits.maxRefBytes + 262144) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Attachment capacities do not cover the complete intake.')
    }
    const withdraw = (): void => { for (const agent of this.prepared.keys()) this.release(agent) }
    const checkMessages = this.checkMessages.bind(this), release = this.release.bind(this)
    binding.lifetime.addEventListener('abort', withdraw, { once: true })
    ctx.effect(() => () => { binding.lifetime.removeEventListener('abort', withdraw); withdraw() })
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.release(agent) })
    ctx.on('session/disposed', (session) => {
      for (const agent of this.prepared.keys()) if (agent.session === session) this.release(agent)
    })
    // Installed before native Include listeners, so compaction pricing also sees verified paths.
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      this.release(agent)
      const workspace = this.current(agent)
      const check = (): void => { if (this.current(agent) !== workspace) denied() }
      const held = await this.files().stageAttachments(workspace, () => {
        check()
        const collector = createAttachmentRefCollector(limits)
        collector.addSessionSurface(agent.session)
        collector.addMessages(messages)
        return collector.finish()
      }, check, signal)
      try {
        check()
        signal.throwIfAborted()
        if (held.value.length === 0) held.release()
        else this.prepared.set(agent, { workspace, rows: held.value, release: () => { held.release() } })
        const decision = await next()
        check()
        signal.throwIfAborted()
        if (decision.kind === 'reject') this.release(agent)
        else this.checkMessages(agent, decision.messages)
        return decision
      } catch (error) { this.release(agent); held.release(); throw error }
    }, { prepend: true })
    ctx.on('llm/stream', async function* (options, next) {
      const agent = ctx.get('agents')?.currentInitiator()
      if (agent === undefined) {
        const collector = createAttachmentRefCollector(limits)
        collector.addMessages(options.messages)
        if (collector.finish().length !== 0) denied()
      } else checkMessages(agent, options.messages)
      try { yield* next() }
      finally { if (agent !== undefined && isAgentLoopRequest(options)) release(agent) }
    })
  }

  private current(agent: Agent, caller: Context = agent.ctx): Workspace {
    this.installed(caller)
    if (this.binding.lifetime.aborted || caller.root !== this.ctx.root || caller.get('peAccount') !== this.binding) denied()
    caller.fiber.assertActive()
    const callerScope = scopeOf(caller)
    if (callerScope !== undefined && !scopeChainOf(scopeOf(agent.ctx)).includes(callerScope)) denied()
    return this.project(agent)
  }

  private release(agent: Agent): void {
    const record = this.prepared.get(agent)
    this.prepared.delete(agent)
    record?.release()
  }

  private checkMessages(agent: Agent, messages: readonly RequestMessage[]): void {
    const workspace = this.current(agent)
    const collector = createAttachmentRefCollector(this.limits)
    collector.addMessages(messages)
    const record = this.prepared.get(agent)
    for (const ref of collector.finish()) {
      if (record?.workspace !== workspace || !record.rows.some(row => key(row.ref) === key(ref) && row.ref.bytes === ref.bytes)) denied()
    }
  }

  /**
   * Map only an active Agent's current verified native ref.
   * @param caller Actual Cordis consumer; tagged children cannot borrow a parent's authority.
   * @param ref Canonical native ref from the original LLM projection.
   * @returns Same project copy's host path, or undefined outside the prepared request.
   */
  mapFileHostPath(caller: Context, ref: FileAttachmentRef): string | undefined {
    const agent = this.ctx.get('agents')?.currentInitiator()
    if (agent === undefined) return undefined
    const workspace = this.current(agent, caller), record = this.prepared.get(agent)
    if (record?.workspace !== workspace) return undefined
    const row = record.rows.find(value => key(value.ref) === key(ref) && value.ref.bytes === ref.bytes)
    return row === undefined ? undefined : posix.join(workspace.path, row.relativePath)
  }

  /**
   * Admit a host path only when it names that same active request's verified project copy.
   * @param caller Actual filesystem consumer.
   * @param hostPath Host path supplied by the native attachment provider.
   * @returns Identical process path for the same file; all other host paths have no mapping.
   */
  mapProcessPath(caller: Context, hostPath: string): string | undefined {
    const agent = this.ctx.get('agents')?.currentInitiator()
    if (agent === undefined) return undefined
    const workspace = this.current(agent, caller), record = this.prepared.get(agent)
    return record?.workspace === workspace && record.rows.some(row => posix.join(workspace.path, row.relativePath) === hostPath)
      ? hostPath : undefined
  }

  /**
   * Prepare copies before the original Controller admits and binds the prompt.
   * @param agent Native resolved Agent; ids alone never select a receiver.
   * @param ids Already resolved native receipt ids in content order.
   * @param signal Caller cancellation.
   * @returns Actual copy completion; the native owner retains publication and retirement of receipts.
   */
  async preparePromptFiles(agent: Agent, ids: readonly FileUploadReceiptId[], signal?: AbortSignal): Promise<void> {
    const workspace = this.current(agent), uploads = this.ctx.get('fileUploads')
    if (!(uploads instanceof FileUploads) || ids.length > this.limits.maxPromptFiles) denied()
    const check = (): void => {
      if (this.current(agent) !== workspace || original(this.ctx.fileUploads) !== original(uploads)) denied()
    }
    const held = await this.files().stageAttachments(workspace, () => {
      check()
      const refs = ids.map((id) => {
        const ref = uploads.resolve(agent, id)
        if (ref === undefined) denied()
        return ref
      })
      const collector = createAttachmentRefCollector(this.limits)
      collector.addSessionSurface(agent.session)
      collector.addMessages([{ role: 'user', content: refs.map(attachment => ({ type: 'file', attachment })) }])
      return collector.finish()
    }, check, signal)
    try { check(); signal?.throwIfAborted() } finally { held.release() }
  }

  /**
   * Reserve before the first source pull and preserve actual native persistence settlement.
   * @param agent Original receiving Agent selected by FileUploads.
   * @param input Native streamed upload, never encoded fallback data.
   * @param save Captured original native store implementation.
   * @returns Original durable ref; unknown source/storage cleanup closes native receipt admission.
   */
  async storeFileStream(agent: Agent, input: SaveFileStreamAttachment,
    save: (input: SaveFileStreamAttachment) => Promise<FileAttachmentRef>): Promise<FileAttachmentRef> {
    const workspace = this.current(agent)
    const check = (): void => { if (this.current(agent) !== workspace) denied() }
    let sizeLimitFailure: FdMutationFailure | undefined
    try {
      const held = await this.files().runAttachmentIntake(this.limits.intakeReservationBytes, check, async (control) => {
        const signal = AbortSignal.any(input.signal === undefined
          ? [control, this.binding.lifetime] : [control, input.signal, this.binding.lifetime])
        let iterator: AsyncIterator<Uint8Array> | undefined
        let stopping: Promise<unknown> | undefined
        let inputFailure: FdMutationFailure | undefined
        const stop = (): Promise<unknown> => stopping ??= iterator?.return?.() ?? Promise.resolve()
        const abort = (): void => { void stop().catch((_error: unknown) => {}) }
        signal.addEventListener('abort', abort, { once: true })
        const limits = this.limits
        const data = (async function* () {
          try {
            check()
            signal.throwIfAborted()
            iterator = input.data[Symbol.asyncIterator]()
            let total = 0
            for (;;) {
              check()
              signal.throwIfAborted()
              const part = await iterator.next()
              check()
              signal.throwIfAborted()
              if (part.done === true) return
              const bytes = part.value
              if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
                || bytes.byteLength > limits.maxUploadChunkBytes || bytes.buffer.byteLength > limits.maxUploadChunkBytes) {
                inputFailure = new FdMutationFailure('not-published', 'FS_TOO_LARGE')
                throw inputFailure
              }
              if (total + bytes.byteLength > limits.maxFileBytes) {
                sizeLimitFailure = inputFailure = new FdMutationFailure('not-published', 'FS_TOO_LARGE')
                throw inputFailure
              }
              total += bytes.byteLength
              yield bytes
            }
          } finally { await stop() }
        })()
        try {
          const ref = await save({ data, signal, ...input.name === undefined ? {} : { name: input.name } })
          check()
          return ref
        } catch (error) {
          if (error instanceof AttachmentCleanupError || error instanceof FileUploadIntakeUnconfirmedError) throw error
          if (inputFailure !== undefined) throw inputFailure
          throw new FdMutationFailure('not-published', signal.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR', undefined, { cause: error })
        } finally {
          try { await data.return(undefined); await stop() }
          finally { signal.removeEventListener('abort', abort) }
        }
      }, input.signal)
      try { check(); return held.value } finally { held.release() }
    } catch (error) {
      // Only the exact confirmed byte-limit failure is safe to classify. Cleanup
      // failures and all other upload errors retain their existing disposition.
      if (sizeLimitFailure !== undefined && error === sizeLimitFailure) throw new FileUploadTooLargeError()
      if (error instanceof FdMutationFailure && error.outcome === 'not-published') throw error
      throw new FileUploadIntakeUnconfirmedError()
    }
  }
}
