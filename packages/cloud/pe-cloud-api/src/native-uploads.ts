/** Sole native upload owner with account admission and its original streamed persistence hook. */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import { FileUploads, FILE_UPLOAD_PATH, FileUploadIntakeUnconfirmedError } from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposureInventory } from './types.ts'
import { CloudApiError } from './errors.ts'

/** Trusted persistence admission; receipts, native Agent resolution and retirement remain with FileUploads. */
export interface NativeUploadPreparation {
  readonly maxPendingReceipts: number
  storeFileStream(agent: Agent, input: SaveFileStreamAttachment,
    save: (input: SaveFileStreamAttachment) => Promise<FileAttachmentRef>): Promise<FileAttachmentRef>
}

/** Original native service and bounded actual installation checks. */
export interface NativeUploads {
  readonly value: FileUploads
  assertCurrent(): void
  inspect(): ExposureInventory
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

/**
 * Install the original streamed route, storage hook and receipt owner in one native Loader fiber.
 * @param ctx Actual native entry with its complete inject list.
 * @param binding Exact graph lifetime, independent of an HTTP borrow.
 * @param installed Original graph mounting/current check.
 * @param admit Audited Fetch/business admission, repeated before and after storage.
 * @param maximum Finite registry inspection budget.
 * @param preparation Controlled persistence admission and native receipt capacity.
 * @returns Sole native owner; no encoded upload RPC is exposed by this adapter.
 */
export function createNativeUploads(
  ctx: Context, binding: AccountBinding, installed: () => void, admit: () => void,
  maximum: number, preparation: NativeUploadPreparation,
): NativeUploads {
  const unavailable = (): never => { throw new CloudApiError('cloud/account-unavailable', 'The original file upload owner is unavailable.') }
  if (!Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const keys = ['agents', 'attachments', 'commands', 'connection'] as const
  const expected = new Map<string, object>()
  const graph = (): void => {
    installed()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) unavailable()
    for (const key of keys) {
      const local = ctx.get(key), root = ctx.root.get(key), previous = expected.get(key)
      if (local === undefined || root === undefined || original(local) !== original(root)
        || previous !== undefined && original(local) !== previous) unavailable()
    }
  }
  graph()
  for (const key of keys) expected.set(key, original(ctx[key]))
  if (ctx.get('fileUploads') !== undefined) unavailable()
  class AccountFileUploads extends FileUploads {
    protected override async storeFileStream(agent: Agent, input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
      graph()
      admit()
      const first: { completion?: Promise<boolean>; repeated: boolean } = { repeated: false }
      let called = false, open = true
      const save = (next: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
        if (!open) return Promise.reject(new CloudApiError('cloud/account-unavailable', 'The file upload preparation has settled.'))
        if (called) {
          first.repeated = true
          return Promise.reject(new CloudApiError('cloud/account-unavailable', 'The file upload hook was already called.'))
        }
        called = true
        let pending: Promise<FileAttachmentRef>
        try { pending = super.storeFileStream(agent, next) }
        catch (cause) { first.completion = Promise.resolve(false); throw cause }
        first.completion = pending.then(() => true, () => false)
        return pending
      }
      let result: FileAttachmentRef
      try { result = await preparation.storeFileStream(agent, input, save) }
      catch (cause) {
        open = false
        if (first.completion !== undefined) {
          const firstPublished = await first.completion
          if (firstPublished || first.repeated) throw new FileUploadIntakeUnconfirmedError({ cause })
        } else if (first.repeated) throw new FileUploadIntakeUnconfirmedError({ cause })
        throw cause
      }
      open = false
      const completion = first.completion
      const firstPublished = completion === undefined ? false : await completion
      if (completion !== undefined && !firstPublished) throw new FileUploadIntakeUnconfirmedError()
      try { graph(); admit() }
      catch (cause) {
        if (firstPublished) throw new FileUploadIntakeUnconfirmedError({ cause })
        throw cause
      }
      return result
    }

    override upload(): ReturnType<FileUploads['upload']> {
      return Promise.reject(new CloudApiError('cloud/forbidden', 'Encoded file upload is unavailable.'))
    }
  }
  const value = new AccountFileUploads(ctx, { maxPendingReceipts: preparation.maxPendingReceipts })
  const check = (): void => {
    graph()
    if (ctx.fiber.state !== FiberState.ACTIVE
      || original(ctx.fileUploads) !== value || original(ctx.root.fileUploads) !== value) unavailable()
    let visited = 0, owners = 0
    for (const runtime of ctx.registry.values()) {
      if (++visited > maximum) unavailable()
      for (const fiber of runtime.fibers) {
        if (++visited > maximum) unavailable()
        if (fiber.ctx.root !== ctx.root || fiber.state !== FiberState.ACTIVE) continue
        const store = fiber.store?.fileUploads
        if (store?.fiber !== fiber) continue
        const registered: unknown = store.value
        if (++owners !== 1 || fiber !== ctx.fiber || registered === null || typeof registered !== 'object'
          || original(registered) !== value) unavailable()
      }
    }
    if (owners !== 1 || ctx.connection.createSharedFetchHandler('/api').requestBodyMode({
      method: 'POST', url: new URL(FILE_UPLOAD_PATH, 'http://native.invalid'),
    }) !== 'streaming') unavailable()
  }
  return { value, assertCurrent: check, inspect() {
    check()
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [],
      exactFetchRoutes: [{ method: 'POST', path: FILE_UPLOAD_PATH, handlerId: 'native:fileUploads', guard: 'account-session' }] }
  } }
}
