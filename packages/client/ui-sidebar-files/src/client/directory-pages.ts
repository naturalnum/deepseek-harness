/** The Files face's single original directory stream, with no reconnect or cursor replay. */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryFrame, WorkspaceDirectoryControl } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { DirLevel } from './store.ts'

/** Transient stream state belongs to the face, never the view store. */
export interface DirectoryPages {
  /** Actual stream termination, preserving operation and carrier failures. */
  readonly ended: Promise<void>
  /** Pull one page with exactly one current credit. */
  next(): Promise<DirLevel>
  /** Join Host close confirmation and natural terminal delivery; disposal alone never confirms closure. */
  close(): Promise<void>
}

/** Open the selected Native stream; its lifetime ends through the same uplink's close action. */
export type OpenDirectoryPages = (sessionId: SessionId, path: string, signal: AbortSignal) => DirectoryPages

/**
 * Bind paging to the existing Remote carrier without the reconnecting watch supervisor.
 * @param remote - generated Client Remote face.
 * @returns one logical enumeration per call.
 */
export function createDirectoryPages(
  remote: { readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'listPages'> },
): OpenDirectoryPages {
  return (sessionId, path, signal) => {
    signal.throwIfAborted()
    // Keep the carrier alive long enough to receive the Host close acknowledgement
    // when the local node is collapsed or its tab is removed.
    const stream = remote.workspaceFiles.listPages(sessionId, path)
    let ready: Extract<WorkspaceDirectoryFrame, { kind: 'ready' }> | undefined
    let cursor: WorkspaceDirectoryControl['cursor'] | null | undefined
    let waiting: ReturnType<typeof Promise.withResolvers<DirLevel>> | undefined
    let credit = false, closing = signal.aborted, hostClosed = false, pageNumber = 0
    const finished = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
    void finished.promise.catch(() => {})
    void closed.promise.catch(() => {})
    const invalid = (): RemoteError => new RemoteError('gateway/bad-request', 'Directory page stream violated its current credit.', {})
    const send = (): void => {
      if (ready === undefined || cursor === undefined || cursor === null || credit || hostClosed) return
      if (!closing && waiting === undefined) return
      stream.send({ kind: closing ? 'close' : 'credit', version: ready.version, cursor })
      credit = true
    }
    const close = (): Promise<void> => {
      closing = true
      try { send() } catch (error) { stream.dispose(); closed.reject(error) }
      return closed.promise
    }
    const onAbort = (): void => { void close().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    const pump = async (): Promise<void> => {
      try {
        for await (const frame of stream) {
          if (hostClosed) throw invalid()
          if (frame.kind === 'ready') {
            if (ready !== undefined || credit) throw invalid()
            ready = frame; cursor = frame.cursor
            send()
            continue
          }
          if (ready === undefined || frame.version !== ready.version || !credit) throw invalid()
          if (frame.kind === 'closed') {
            if (!closing) throw invalid()
            hostClosed = true; cursor = null; credit = false
            waiting?.reject(new RemoteError('gateway/bad-request', 'Directory enumeration was closed.', {}))
            waiting = undefined
            continue
          }
          if (frame.path !== ready.path || frame.closed !== (frame.nextCursor === null)
            || (!frame.closed && frame.entries.length === 0) || frame.nextCursor === cursor) throw invalid()
          cursor = frame.nextCursor; credit = false; hostClosed = frame.closed
          pageNumber++
          waiting?.resolve({ entries: frame.entries, truncated: !frame.closed, directoryPaging: true,
            page: { number: pageNumber, more: !frame.closed } })
          waiting = undefined
          // A close while scanning consumes the in-flight page, then uses the new
          // token. Sending the old token concurrently would revoke the stream.
          if (closing) send()
        }
        if (!hostClosed) throw new RemoteError('gateway/internal', 'Directory closure was not confirmed by the Host.', {})
        finished.resolve(); closed.resolve()
      } catch (error) {
        closing = true
        const failure = remoteErrorOf(error)
        const confirmed = (failure?.code === 'workspace-file/directory-changed' || failure?.code === 'workspace-file/directory-stopped')
          && failure.details.closed === true
        const observed = confirmed ? error : new RemoteError('workspace-file/directory-close-unconfirmed',
          'Directory closure was not confirmed by the Host.', { path }, { cause: error })
        waiting?.reject(observed); waiting = undefined
        finished.reject(observed)
        if (confirmed) closed.resolve()
        else closed.reject(observed)
      } finally {
        signal.removeEventListener('abort', onAbort)
        stream.dispose()
      }
    }
    void pump()
    return {
      ended: finished.promise,
      next: () => {
        if (closing || hostClosed || waiting !== undefined) return Promise.reject(invalid())
        waiting = Promise.withResolvers<DirLevel>()
        const next = waiting.promise
        try { send() } catch (error) { waiting.reject(error); waiting = undefined; stream.dispose(); closed.reject(error) }
        return next
      }, close,
    }
  }
}
