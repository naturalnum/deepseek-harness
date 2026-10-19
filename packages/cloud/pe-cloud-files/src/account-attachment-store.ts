/** Account-local path projection over the unchanged native attachment store. */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, isAttachmentError, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Trusted graph input; the mapper owns Agent/project admission and verified-copy availability. */
export interface AccountAttachmentBackend {
  readonly binding: AccountBinding
  assertCurrent(): void
  assertInstalled(caller: Context): void
  /** Return an already verified copy's absolute host path, or undefined when unavailable; performs no I/O. */
  mapFileHostPath(caller: Context, ref: FileAttachmentRef): string | undefined
}

function unavailable(cause?: unknown): AttachmentError {
  return new AttachmentError('The account attachment path is unavailable.', 'ATTACHMENT_PROJECTION_UNSUPPORTED',
    cause === undefined ? undefined : { cause })
}

function attachmentFailure(error: unknown): AttachmentError {
  return isAttachmentError(error) ? error : unavailable(error)
}

/**
 * Prepare a native store constructor whose file paths come only from the trusted mapper.
 * @param backend Exact graph checks and synchronous verified-copy lookup; no staging or authorization is supplied here.
 * @returns Native constructor with inherited configuration, persistence, streams and image handling.
 *   Path lookup rejects unavailable, stale or replaced owners without exposing the private original.
 */
export function createAccountAttachmentStore(backend: AccountAttachmentBackend): typeof LocalAttachmentStore {
  const binding = backend.binding
  const assertCurrent = backend.assertCurrent.bind(backend)
  const assertInstalled = backend.assertInstalled.bind(backend)
  const mapFileHostPath = backend.mapFileHostPath.bind(backend)
  const current = (caller?: Context): void => {
    try {
      assertCurrent()
      if (binding.lifetime.aborted) throw unavailable()
      if (caller !== undefined) {
        caller.fiber.assertActive()
        assertInstalled(caller)
        if (caller.get('peAccount') !== binding || caller.root.get('peAccount') !== binding) throw unavailable()
      }
    } catch (error) { throw attachmentFailure(error) }
  }
  current()
  return class AccountAttachmentStore extends LocalAttachmentStore {
    private readonly identity = Symbol()

    constructor(...args: ConstructorParameters<typeof LocalAttachmentStore>) {
      current(args[0])
      if (args[0].get('attachments') !== undefined) throw unavailable()
      super(...args)
    }

    private assertMappingCurrent(): void {
      current(this.ctx)
      const installed = this.ctx.get('attachments')
      if (!(installed instanceof AccountAttachmentStore) || installed.identity !== this.identity) throw unavailable()
    }

    override fileHostPath(ref: FileAttachmentRef): string {
      this.assertMappingCurrent()
      // Native canonical-reference validation only; its private path is never returned.
      super.fileHostPath(ref)
      let mapped: string | undefined
      try { mapped = mapFileHostPath(this.ctx, ref) } catch (error) { throw attachmentFailure(error) }
      this.assertMappingCurrent()
      if (mapped === undefined) throw unavailable()
      return mapped
    }
  }
}
