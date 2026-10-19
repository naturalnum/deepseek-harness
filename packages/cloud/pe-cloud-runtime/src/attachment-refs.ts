/** Bounded file-ref collection only; Session ownership and projection reads remain with the caller. */
import { AttachmentError, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { AccountRuntimeError } from './errors.ts'

/** Required bounds on one surface traversal and the complete retained ref metadata. */
export interface AttachmentRefLimits {
  readonly maxSurfaceNodes: number
  readonly maxRefs: number
  /** Sum of UTF-8 JSON bytes for distinct { attachmentId, name, bytes } refs, excluding file contents. */
  readonly maxRefBytes: number
}

/** One operation's bounded snapshots; any failed add invalidates the collector. */
export interface AttachmentRefCollector {
  addSessionSurface(session: Session): void
  addMessages(messages: readonly RequestMessage[]): void
  finish(): readonly FileAttachmentRef[]
}

/**
 * Collect user/file occurrences without retaining messages, paths or authority.
 * @param limits Positive safe-integer capacities; maxSurfaceNodes also bounds each direct message batch.
 * @returns A collector sharing deduplication and metadata accounting across surface, claimed and final inputs.
 *   Each finish returns a frozen snapshot; id/name duplicates must agree on bytes. Failed collection cannot finish.
 *   The caller must reserve the bounded native message snapshots before collecting a Session surface.
 */
export function createAttachmentRefCollector(limits: AttachmentRefLimits): AttachmentRefCollector {
  const { maxSurfaceNodes, maxRefs, maxRefBytes } = limits
  if ([maxSurfaceNodes, maxRefs, maxRefBytes].some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Attachment ref capacities must be positive safe integers.')
  }
  const refs: FileAttachmentRef[] = []
  const seen = new Map<FileAttachmentRef['attachmentId'], Map<string, FileAttachmentRef>>()
  let retainedBytes = 0, failed = false
  const capacity = (): never => { throw new AccountRuntimeError('cloud/capacity', 'Attachment ref collection exceeds its capacity.') }
  const checked = (collect: () => void): void => {
    if (failed) throw new AccountRuntimeError('cloud/account-unavailable', 'Attachment ref collection did not complete.')
    try { collect() } catch (error) { failed = true; throw error }
  }
  const addMessage = (message: RequestMessage): void => {
    if (message.role !== 'user') return
    for (const block of message.content) {
      if (block.type !== 'file') continue
      const { attachmentId, name, bytes } = block.attachment
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new AttachmentError('File attachment byte length is invalid.', 'INVALID_ATTACHMENT_REF')
      }
      if (Buffer.byteLength(attachmentId) > maxRefBytes || Buffer.byteLength(name) > maxRefBytes) capacity()
      const names = seen.get(attachmentId), previous = names?.get(name)
      if (previous !== undefined) {
        if (previous.bytes !== bytes) throw new AttachmentError('File attachment references disagree on byte length.', 'INVALID_ATTACHMENT_REF')
        continue
      }
      if (refs.length >= maxRefs) capacity()
      const ref = Object.freeze({ attachmentId, name, bytes })
      const cost = Buffer.byteLength(JSON.stringify(ref))
      if (cost > maxRefBytes - retainedBytes) capacity()
      retainedBytes += cost
      refs.push(ref)
      if (names === undefined) seen.set(attachmentId, new Map([[name, ref]]))
      else names.set(name, ref)
    }
  }
  return {
    addSessionSurface: (session) => {
      checked(() => {
        const nodes = session.surface.nodes
        if (nodes.length > maxSurfaceNodes) capacity()
        for (const message of session.deriveMessages()) addMessage(message)
      })
    },
    addMessages: (messages) => {
      checked(() => {
        if (messages.length > maxSurfaceNodes) capacity()
        for (const message of messages) addMessage(message)
      })
    },
    finish: () => {
      checked(() => {})
      return Object.freeze([...refs])
    },
  }
}
