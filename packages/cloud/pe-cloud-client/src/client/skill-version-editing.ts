/** Account-page sample adaptation; native current/publish and AccountSaves retain all version and persistence ownership. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PreparedSkillEdit, SkillPublicationOutcome } from './skill-edit.ts'
import type { SkillCard, SkillManagementView } from './management/skills/types.ts'
import { ClientFailure } from './errors.ts'

/** Immutable facts from actual native current/publish responses, never an approved-catalog installation claim. */
export type SkillSourceMetadata = NonNullable<PreparedSkillEdit['source']>
/** Complete local files selected by the user; strings remain immutable while a separate draft is edited. */
export interface SkillFileSnapshot {
  readonly markdown: string
  readonly resourceBase64: string
}
/** Page-owned editable copy; the selected input and its opened native source stay unchanged. */
export interface SkillEditableCopy extends SkillFileSnapshot {
  readonly original: Readonly<SkillFileSnapshot>
  readonly source: SkillSourceMetadata | null
}
/** Source state and narrow actions consumed through the existing renderer source. */
export interface SampleSkillEditing {
  readonly scope: string
  readonly phase: 'idle' | 'opening' | 'editing' | 'publishing' | 'result' | 'unavailable'
  readonly sourceKnown: boolean
  readonly source: SkillSourceMetadata | null
  readonly applied: boolean
  readonly resources: PreparedSkillEdit['resources']
  readonly maxFileBytes: number
  readonly draft: SkillEditableCopy | undefined
  readonly outcome: SkillPublicationOutcome | undefined
  /** Read a fresh native edit only after an explicit gesture; observer loss retires the edit but preserves its draft. */
  readonly open: (signal: AbortSignal) => Promise<void>
  /** Copy both complete user-selected files without modifying the native immutable source. */
  readonly copyFiles: (files: SkillFileSnapshot) => void
  readonly editMarkdown: (value: string) => void
  /** Submit the original current-issued closure once; no replacement token or replay is created. */
  readonly publish: (signal: AbortSignal) => Promise<SkillPublicationOutcome>
}
/** Original page/dependency admission and the one actual native edit callback. */
export interface SkillVersionEditingInput {
  readonly scope: string
  readonly signal: AbortSignal
  readonly maxFileBytes: number
  readonly assertCurrent: () => void
  readonly prepare: (signal: AbortSignal) => Promise<PreparedSkillEdit>
  readonly title: () => string
}

/**
 * Attach only display adaptation to a store owned by the original PreparedCloudPage.
 * @param store The page's stable source, reused by the management page and retained through observer loss.
 * @param input Exact current dependency, page lifetime and captured native prepare callback.
 * @returns Withdrawal that closes actions synchronously and retains unconfirmed drafts as unresolved evidence.
 */
export function attachSkillVersionEditing(store: SnapshotStore<SkillManagementView>, input: SkillVersionEditingInput): () => void {
  let active: AbortController | undefined
  let prepared: { readonly edit: PreparedSkillEdit; readonly stopObserving: () => void } | undefined
  const forgetPrepared = (): void => {
    const previous = prepared
    prepared = undefined
    previous?.stopObserving()
  }
  const check = (): void => { input.signal.throwIfAborted(); input.assertCurrent() }
  const current = (): SampleSkillEditing => {
    check()
    const value = store.getSnapshot().sample
    if (value?.scope !== input.scope) throw new ClientFailure('closed')
    return value
  }
  const rows = (source: SkillSourceMetadata | null, applied: boolean): readonly SkillCard[] => source === null ? Object.freeze([])
    : Object.freeze([Object.freeze({ id: 'sample', name: input.title(), description: '', category: 'other' as const,
      installed: true, recommended: false, status: applied ? 'published' as const : 'catalog-pending' as const, version: source.id })])
  const update = (patch: Partial<SampleSkillEditing>, phase?: SkillManagementView['phase']): void => {
    const before = current(), sample = Object.freeze({ ...before, ...patch })
    const view = store.getSnapshot(), changed = patch.outcome?.kind === 'persisted' && view.managed !== undefined
    const items = changed ? view.items.map((row) => {
      const { shadowed: _shadowed, shadowedBy: _shadowedBy, ...snapshot } = row
      return Object.freeze(snapshot)
    }) : view.items
    store.set(Object.freeze({ ...view, phase: view.managed === undefined ? phase ?? view.phase : view.phase,
      items: view.managed === undefined ? rows(sample.source, sample.applied) : items, sample,
      ...changed ? { managed: Object.freeze({ ...view.managed, needsRefresh: true }) } : {},
    }))
  }
  const completeFiles = (files: SkillFileSnapshot): void => {
    if (new TextEncoder().encode(files.markdown).byteLength === 0
      || new TextEncoder().encode(files.markdown).byteLength > input.maxFileBytes
      || atob(files.resourceBase64).length > input.maxFileBytes) throw new ClientFailure('closed')
  }
  const open = async (observer: AbortSignal): Promise<void> => {
    current(); observer.throwIfAborted()
    if (active !== undefined) throw new ClientFailure('closed')
    const operation = new AbortController(); active = operation; forgetPrepared()
    const signal = AbortSignal.any([observer, input.signal, operation.signal])
    update({ phase: 'opening' }, 'loading')
    try {
      const edit = await input.prepare(signal)
      signal.throwIfAborted(); check()
      if (active !== operation) throw new ClientFailure('closed')
      const retire = (): void => {
        if (prepared !== attempt) return
        forgetPrepared()
        try { update({ phase: 'idle' }) } catch (_closed) { /* The original page already revoked this edit. */ }
      }
      const attempt = { edit, stopObserving: () => { observer.removeEventListener('abort', retire) } }
      prepared = attempt
      observer.addEventListener('abort', retire, { once: true })
      const sameEdit = (): void => { current(); if (prepared !== attempt) throw new ClientFailure('closed') }
      update({ phase: 'editing', sourceKnown: true, source: edit.source, applied: edit.applied,
        resources: edit.resources, outcome: undefined,
        copyFiles: (files) => { sameEdit(); copyFiles(files) },
        editMarkdown: (markdown) => { sameEdit(); editMarkdown(markdown) },
        publish: async (observer) => { sameEdit(); return publish(observer) },
      }, 'ready')
    } catch (error) {
      if (!operation.signal.aborted) {
        try { update({ phase: 'unavailable' }, 'unavailable') } catch (_closed) { /* The original page already revoked this source. */ }
      }
      throw error
    } finally { if (active === operation) active = undefined }
  }
  const copyFiles = (files: SkillFileSnapshot): void => {
    const value = current()
    if (value.phase !== 'editing' || active !== undefined) throw new ClientFailure('closed')
    completeFiles(files)
    const original = Object.freeze({ markdown: files.markdown, resourceBase64: files.resourceBase64 })
    update({ draft: Object.freeze({ ...original, original, source: value.source }) })
  }
  const editMarkdown = (markdown: string): void => {
    const value = current(), draft = value.draft
    if (value.phase !== 'editing' || active !== undefined || draft === undefined) throw new ClientFailure('closed')
    if (new TextEncoder().encode(markdown).byteLength > input.maxFileBytes) throw new ClientFailure('closed')
    update({ draft: Object.freeze({ ...draft, markdown }) })
  }
  const publish = async (observer: AbortSignal): Promise<SkillPublicationOutcome> => {
    const value = current(), draft = value.draft, edit = prepared?.edit
    observer.throwIfAborted()
    if (value.phase !== 'editing' || active !== undefined || draft === undefined || edit === undefined) throw new ClientFailure('closed')
    completeFiles(draft)
    const operation = new AbortController(); active = operation; forgetPrepared()
    const signal = AbortSignal.any([observer, input.signal, operation.signal])
    update({ phase: 'publishing', outcome: undefined })
    let outcome: SkillPublicationOutcome
    try {
      outcome = await edit.publish(draft.markdown, draft.resourceBase64, signal)
      signal.throwIfAborted(); check()
      if (active !== operation) throw new ClientFailure('closed')
    } catch { outcome = { kind: 'unknown' } }
    try {
      update({ phase: 'result', outcome, ...outcome.kind === 'persisted'
        ? { sourceKnown: true, source: outcome.source, applied: outcome.applied, resources: outcome.resources } : {} })
    } catch (_closed) { /* The revoked page keeps its last draft; a late reply cannot republish it into another scope. */ }
    finally { if (active === operation) active = undefined }
    return outcome
  }
  const observed = store.getSnapshot().sample
  const previous = observed?.scope === input.scope ? observed : undefined
  const sample: SampleSkillEditing = Object.freeze({ scope: input.scope, phase: 'idle', sourceKnown: false, source: null,
    applied: false, resources: 'unavailable', maxFileBytes: input.maxFileBytes, draft: previous?.draft,
    outcome: previous?.outcome, open, copyFiles, editMarkdown, publish })
  const view = store.getSnapshot()
  store.set(Object.freeze({ ...view, phase: view.managed === undefined ? 'unread' : view.phase,
    items: view.managed === undefined ? Object.freeze([]) : view.items, sample }))
  return () => {
    active?.abort(); forgetPrepared()
    const view = store.getSnapshot(), sample = view.sample
    if (sample?.scope !== input.scope) return
    store.set(Object.freeze({ ...view, phase: 'unavailable', sample: Object.freeze({ ...sample, phase: 'unavailable',
      outcome: sample.phase === 'publishing' ? { kind: 'unknown' as const } : sample.outcome }) }))
  }
}
