/** Closing-scoped observation and publication; unsubscribing ends polling and pending actions. */
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { EXECUTION_FILES_MAX_EXECUTIONS } from '@power-evolve/contracts/execution-files'
import type { ExecutionFilesItem, ExecutionProducedFile } from '@power-evolve/contracts/execution-files'
import { ArtifactHttpError, artifactDownloadUrl } from './api.ts'
import type { Artifact, ArtifactHttpClient } from './api.ts'
import { referencesForClosing } from './produced-artifacts.ts'
import type { ExecutionReference } from './produced-artifacts.ts'

/** A Platform file version together with the native execution that owns it. */
export interface ProducedFile extends ExecutionProducedFile { readonly executionId: string }
/** One publication attempt's visible state; retries keep their request identity. */
export type PublicationState = 'busy' | 'done' | 'failed' | 'changed'
/** Files remain scoped to one viewed Session and closing; failed reads claim no new file facts. */
export interface ClosingFacts {
  readonly state: 'idle' | 'loading' | 'ready' | 'failed'
  readonly items: readonly ExecutionFilesItem[]
  readonly publications: Readonly<Record<string, PublicationState>>
}
/** Observable face shared by the output row and its inline code actions. */
export interface ClosingFactsSource extends ObservableSnapshot<ClosingFacts> {
  /** Opaque identity used only by this plugin’s generated keyed hook. */
  readonly key: string
  /** Refresh durable facts while this closing has observers. */
  refresh(): void
  /** Publish the displayed version and start its native browser download.
   * @param file - version present in this closing’s verified facts.
   * @returns after the explicit action settles or is cancelled.
   */
  publish(file: ProducedFile): Promise<void>
}

interface Attempt { readonly requestId: string; controller: AbortController | undefined; artifact: Artifact | undefined }
interface Entry {
  readonly source: ClosingFactsSource
  readonly stop: () => void
  readonly refreshReferences: (references: readonly ExecutionReference[]) => void
}

/** One native version's action identity.
 * @param file - verified execution and file version.
 * @returns an unambiguous local key for duplicate-click suppression and retry.
 */
export function producedFileKey(file: ProducedFile): string { return JSON.stringify([file.executionId, file.path, file.sha256]) }

/** Read verified files allowed by this closing; loaded receipts additionally constrain their call ids.
 * @param snapshot - latest closing observation.
 * @param references - native receipts allowed by the caller's closing sequence.
 * @returns verified versions in native receipt order, retaining versions from different executions.
 */
export function filesForClosing(snapshot: ClosingFacts, references: readonly ExecutionReference[]): readonly ProducedFile[] {
  return references.flatMap(reference => {
    const item = snapshot.items.find(item => item.executionId === reference.executionId
      && (reference.callId === undefined || item.callId === reference.callId))
    return item === undefined ? [] : item.files.map(file => ({ ...file, executionId: item.executionId }))
  })
}

/** Bounded native-history fact reads; sources contain no physical paths or credentials. */
export class ExecutionFacts {
  private readonly entries = new Map<string, Entry>()
  private readonly sources = new Map<string, { sessionId: Session['sessionId']; source: ClosingFactsSource }>()
  private readonly revisions = new Map<string, SnapshotStore<number>>()
  private sequence = 0
  private readonly lifetime = new AbortController()
  private active = 0
  private readonly waiters = new Set<() => void>()

  constructor(private readonly client: ArtifactHttpClient, private readonly published: () => void,
    private readonly failed: (sessionId: Session['sessionId'], changed: boolean) => void,
    private readonly options = { pollMs: 3000, maxPolls: 20, requestMs: 15_000 }) {}

  /** Borrow one closing's observable state; subscribing starts reads, and the last release cancels work.
   * @param sessionId - viewed Session, never the global current selection.
   * @param owner - native turn/closing coordinates and their receipt data.
   * @returns a stable source shared by the row and its prose resolver.
   */
  forClosing(sessionId: Session['sessionId'], owner: TurnTailOwnerProps): ClosingFactsSource {
    const key = JSON.stringify([sessionId, owner.turn.turn, owner.seq])
    const through = owner.turn.end?.seq ?? owner.seq
    const references = referencesForClosing({ ...owner, seq: through }, true)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = this.createEntry(sessionId, references)
      this.entries.set(key, entry)
      this.sources.set(entry.source.key, { sessionId, source: entry.source })
    } else entry.refreshReferences(references)
    return entry.source
  }

  /** Resolve an opaque source key inside its viewed Session for a generated keyed hook.
   * @param sessionId - Session bound by the native slot renderer.
   * @param key - source identity returned by forClosing.
   * @returns the same closing source, or absence for another Session.
   */
  source(sessionId: Session['sessionId'], key: string): ClosingFactsSource | undefined {
    const entry = this.sources.get(key)
    return entry?.sessionId === sessionId ? entry.source : undefined
  }

  /** Stable version observable consumed by the native Assistant registration.
   * @param sessionId - viewed Session whose displayed resolvers should refresh.
   * @returns a Session-isolated source incremented when facts or actions change.
   */
  changesForSession(sessionId: Session['sessionId']): ObservableSnapshot<number> {
    let source = this.revisions.get(sessionId)
    if (source === undefined) { source = createSnapshotStore(0); this.revisions.set(sessionId, source) }
    return source
  }

  /** Cancel all observers and actions when the owning plugin unloads. */
  dispose(): void {
    this.lifetime.abort()
    for (const entry of this.entries.values()) entry.stop()
    this.entries.clear()
    this.sources.clear()
  }

  private createEntry(sessionId: Session['sessionId'], initial: readonly ExecutionReference[]): Entry {
    const store = createSnapshotStore<ClosingFacts>({ state: 'idle', items: [], publications: {} })
    const update = (next: Partial<ClosingFacts>): void => {
      store.set({ ...store.getSnapshot(), ...next })
      const revision = this.revisions.get(sessionId)
      revision?.set(revision.getSnapshot() + 1)
    }
    const publication = (key: string, state?: PublicationState): void => {
      const publications = { ...store.getSnapshot().publications }
      if (state === undefined) delete publications[key]
      else publications[key] = state
      update({ publications })
    }
    const attempts = new Map<string, Attempt>()
    let references = initial
    let signature = JSON.stringify(initial)
    let subscribers = 0
    let observation: AbortController | undefined
    let workspaceId: string | undefined
    const stop = (): void => {
      observation?.abort()
      observation = undefined
      for (const attempt of attempts.values()) attempt.controller?.abort()
    }
    const refresh = (): void => {
      stop()
      if (subscribers === 0 || references.length === 0 || this.lifetime.signal.aborted) return
      const controller = new AbortController()
      observation = controller
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
      update({ state: 'loading' })
      void (async () => {
        try {
          for (let poll = 0; poll < this.options.maxPolls; poll++) {
            const ids = [...new Set(references.map(reference => reference.executionId))]
            const items: ExecutionFilesItem[] = []
            for (let index = 0; index < ids.length; index += EXECUTION_FILES_MAX_EXECUTIONS) {
              const deadline = new AbortController()
              const timer = setTimeout(() => { deadline.abort(new Error('Execution files read timed out')) }, this.options.requestMs)
              try {
                const result = await this.limited(() => this.client.executionFiles(sessionId,
                  ids.slice(index, index + EXECUTION_FILES_MAX_EXECUTIONS), AbortSignal.any([signal, deadline.signal])), AbortSignal.any([signal, deadline.signal]))
                signal.throwIfAborted()
                if (workspaceId !== undefined && workspaceId !== result.workspaceId) throw new Error('Execution Workspace changed')
                workspaceId = result.workspaceId
                for (const item of result.items) {
                  if (references.some(reference => reference.executionId === item.executionId
                    && reference.callId !== undefined && reference.callId !== item.callId)) {
                    throw new Error('Execution does not belong to its native tool call')
                  }
                  items.push(item)
                }
              } finally { clearTimeout(timer) }
            }
            signal.throwIfAborted()
            update({ state: 'ready', items })
            if (!items.some(item => item.status === 'pending') || poll + 1 === this.options.maxPolls) return
            await delay(this.options.pollMs, signal)
          }
        } catch (_error) {
          if (!signal.aborted) update({ state: 'failed', items: [] })
        }
      })()
    }
    const source: ClosingFactsSource = {
      key: String(++this.sequence),
      getSnapshot: store.getSnapshot,
      subscribe: listener => {
        const detach = store.subscribe(listener)
        subscribers++
        if (subscribers === 1) refresh()
        let attached = true
        return () => {
          if (!attached) return
          attached = false
          detach()
          if (--subscribers === 0) stop()
        }
      },
      refresh,
      publish: async file => {
        if (observation === undefined || this.lifetime.signal.aborted) return
        const available = filesForClosing(store.getSnapshot(), references)
          .some(candidate => producedFileKey(candidate) === producedFileKey(file))
        if (!available) return
        const key = producedFileKey(file)
        const previous = attempts.get(key)
        if (previous?.controller !== undefined && !previous.controller.signal.aborted) return
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal, observation.signal, this.lifetime.signal])
        const attempt: Attempt = { requestId: previous?.requestId ?? crypto.randomUUID(), controller, artifact: previous?.artifact }
        attempts.set(key, attempt)
        publication(key, 'busy')
        try {
          const artifact = attempt.artifact ?? await this.client.publish(sessionId, `/workspace/${file.path}`,
            attempt.requestId, signal, file.sha256)
          signal.throwIfAborted()
          if (artifact.workspaceId !== workspaceId) throw new Error('Published artifact Workspace mismatch')
          attempt.artifact = artifact
          startArtifactDownload(artifact)
          publication(key, 'done')
          this.published()
        } catch (error) {
          if (!signal.aborted) {
            const changed = error instanceof ArtifactHttpError && error.status === 409 && error.code === 'artifact_source_changed'
            publication(key, changed ? 'changed' : 'failed')
            this.failed(sessionId, changed)
          }
        } finally {
          if (attempt.controller === controller) attempt.controller = undefined
          if (signal.aborted && attempts.get(key) === attempt) publication(key)
        }
      },
    }
    return { source, stop, refreshReferences: next => {
      const nextSignature = JSON.stringify(next)
      if (signature === nextSignature) return
      signature = nextSignature
      references = next
      // The renderer borrows sources during render; schedule reads after its binding commits.
      queueMicrotask(refresh)
    } }
  }

  private async limited<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (this.active >= 2) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const resume = (): void => { cleanup(); resolve() }
        const cancel = (): void => { cleanup(); reject(signal.reason) }
        const cleanup = (): void => { this.waiters.delete(resume); signal.removeEventListener('abort', cancel) }
        this.waiters.add(resume)
        signal.addEventListener('abort', cancel, { once: true })
      })
    }
    signal.throwIfAborted()
    this.active++
    try { return await operation() }
    finally { this.active--; for (const wake of [...this.waiters]) wake() }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    const cancel = (): void => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
  })
}

function startArtifactDownload(artifact: Artifact): void {
  const link = document.createElement('a')
  link.href = artifactDownloadUrl(artifact.artifactId)
  link.download = artifact.filename
  link.target = '_blank'
  link.rel = 'noopener'
  document.body.append(link)
  try { link.click() } finally { link.remove() }
}
