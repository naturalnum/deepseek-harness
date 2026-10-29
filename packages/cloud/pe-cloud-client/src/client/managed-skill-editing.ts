/** Page-owned management observations and local drafts; native files and AccountSaves own installed versions and settlement. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SkillCard, SkillManagementView } from './management/skills/types.ts'
import type { SelectedSkillBundle, SkillSelectionLimits } from './management/skills/selected-bundle.ts'
import { ClientFailure } from './errors.ts'

/** Local inputs, read only by the generated Remote adapter at one explicit submission. */
export type ManagedSkillBundle = { readonly kind: 'files'; readonly selection: SelectedSkillBundle; readonly markdown: string }
  | { readonly kind: 'zip'; readonly file: File }
/** Original upload limits projected for file-picker usability; the server independently enforces all limits. */
export interface ManagedSkillLimits extends SkillSelectionLimits { readonly maxArchiveBytes: number }
/** Confirmed metadata and catalog application remain distinct from an uncertain write. */
export type ManagedSkillOutcome = { readonly kind: 'persisted'; readonly applied: boolean; readonly item: SkillCard | null }
  | { readonly kind: 'conflict' | 'unknown' | 'unavailable' }
/** Native detail projection; file paths are relative display data, never private source paths. */
export interface ManagedSkillDetail {
  readonly item: SkillCard
  readonly markdown?: string
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly update?: (bundle: ManagedSkillBundle, signal: AbortSignal) => Promise<ManagedSkillOutcome>
  readonly uninstall?: (signal: AbortSignal) => Promise<ManagedSkillOutcome>
  readonly download?: (signal: AbortSignal) => Promise<void>
}
/** A complete native list observation and its captured directory-version installation callback. */
export interface ManagedSkillList {
  readonly items: readonly SkillCard[]
  readonly limits: ManagedSkillLimits
  readonly install?: (bundle: ManagedSkillBundle, signal: AbortSignal) => Promise<ManagedSkillOutcome>
}
/** Renderer-facing state held in the original page's stable source. Tokens remain in private callbacks. */
export interface ManagedSkillEditing {
  readonly scope: string
  readonly editNumber: number
  readonly canPublish: boolean
  readonly canInstall: boolean | undefined
  readonly phase: 'idle' | 'opening' | 'editing' | 'submitting' | 'downloading' | 'result' | 'unavailable'
  readonly selection: string | null | undefined
  readonly detail: ManagedSkillDetail | undefined
  readonly limits: ManagedSkillLimits | undefined
  readonly draft: { readonly forSkill: string | null; readonly bundle: ManagedSkillBundle } | undefined
  readonly outcome: ManagedSkillOutcome | undefined
  readonly needsRefresh: boolean
  readonly downloadStarted: boolean
  readonly refresh: (signal: AbortSignal) => Promise<void>
  readonly open: (id: string | undefined, signal: AbortSignal) => Promise<void>
  readonly installZip: (file: File, signal: AbortSignal) => Promise<ManagedSkillOutcome>
  readonly choose: (bundle: ManagedSkillBundle) => void
  readonly editMarkdown: (markdown: string) => void
  readonly publish: (signal: AbortSignal) => Promise<ManagedSkillOutcome>
  readonly uninstall: (signal: AbortSignal) => Promise<ManagedSkillOutcome>
  readonly download: (signal: AbortSignal) => Promise<void>
  readonly close: () => void
}
/** Generated Remote operations and original page/dependency admission, with no replacement transport. */
export interface ManagedSkillEditingInput {
  readonly scope: string
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly installed: (signal: AbortSignal) => Promise<ManagedSkillList>
  readonly details: (id: string, signal: AbortSignal) => Promise<ManagedSkillDetail>
}

/**
 * Bind multi-skill display and editing to the existing page source without an installation ledger.
 * @param store Original PreparedCloudPage source; confirmed native answers supply all displayed installation facts.
 * @param input Captured generated operations, original admission, and lifetime.
 * @returns Synchronous withdrawal; late answers cannot update a replacement scope, and unresolved drafts remain visible.
 */
export function attachManagedSkillEditing(store: SnapshotStore<SkillManagementView>, input: ManagedSkillEditingInput): () => void {
  let active: AbortController | undefined
  let prepared: { readonly selection: string | null; readonly publish?: ManagedSkillList['install']; readonly detail?: ManagedSkillDetail } | undefined
  const current = (): ManagedSkillEditing => {
    input.signal.throwIfAborted(); input.assertCurrent()
    const value = store.getSnapshot().managed
    if (value?.scope !== input.scope) throw new ClientFailure('closed')
    return value
  }
  const update = (patch: Partial<ManagedSkillEditing>, view?: Partial<Omit<SkillManagementView, 'managed'>>): void => {
    const value = current()
    store.set(Object.freeze({ ...store.getSnapshot(), ...view, managed: Object.freeze({ ...value, ...patch }) }))
  }
  const begin = (observer: AbortSignal): { readonly operation: AbortController; readonly signal: AbortSignal } => {
    current(); observer.throwIfAborted()
    if (active !== undefined) throw new ClientFailure('closed')
    const operation = new AbortController(); active = operation
    return { operation, signal: AbortSignal.any([observer, operation.signal, input.signal]) }
  }
  const end = (operation: AbortController): void => { if (active === operation) active = undefined }
  const refresh = async (observer: AbortSignal): Promise<void> => {
    const { operation, signal } = begin(observer)
    update({}, { phase: 'loading' })
    try {
      const list = await input.installed(signal)
      signal.throwIfAborted()
      update({ needsRefresh: false, limits: list.limits, canInstall: list.install !== undefined }, { phase: 'ready', items: list.items })
    } catch (error) {
      try { update({}, { phase: 'unavailable' }) } catch (_withdrawn) { /* The retired source keeps its last confirmed rows. */ }
      throw error
    } finally { end(operation) }
  }
  const open = async (id: string | undefined, observer: AbortSignal): Promise<void> => {
    const { operation, signal } = begin(observer)
    prepared = undefined
    const previous = current()
    update({ editNumber: previous.editNumber + 1, phase: 'opening', selection: id ?? null, detail: undefined, downloadStarted: false,
      ...previous.outcome?.kind === 'persisted' ? { outcome: undefined } : {} })
    try {
      if (id === undefined) {
        const list = await input.installed(signal)
        signal.throwIfAborted()
        prepared = { selection: null, ...list.install === undefined ? {} : { publish: list.install } }
        update({ phase: 'editing', needsRefresh: false, outcome: undefined, limits: list.limits, canPublish: list.install !== undefined, canInstall: list.install !== undefined }, { phase: 'ready', items: list.items })
      } else {
        const detail = await input.details(id, signal)
        signal.throwIfAborted()
        prepared = { selection: id, detail, ...detail.update === undefined ? {} : { publish: detail.update } }
        update({ phase: 'editing', outcome: undefined, detail, canPublish: detail.update !== undefined })
      }
      const captured = prepared
      const check = (): void => { current(); if (prepared !== captured) throw new ClientFailure('closed') }
      update({ choose: (bundle) => { check(); choose(bundle) }, editMarkdown: (markdown) => { check(); editMarkdown(markdown) } })
    } catch (error) {
      prepared = undefined
      try { update({ phase: 'unavailable' }) } catch (_withdrawn) { /* Revocation already sealed this editor. */ }
      throw error
    } finally { end(operation) }
  }
  const choose = (bundle: ManagedSkillBundle): void => {
    const value = current()
    if (active !== undefined || value.phase !== 'editing' || prepared?.publish === undefined) throw new ClientFailure('closed')
    update({ draft: Object.freeze({ forSkill: prepared.selection, bundle }) })
  }
  const editMarkdown = (markdown: string): void => {
    const value = current(), draft = value.draft
    if (active !== undefined || value.phase !== 'editing' || draft === undefined || draft.forSkill !== prepared?.selection || draft.bundle.kind !== 'files') {
      throw new ClientFailure('closed')
    }
    update({ draft: Object.freeze({ ...draft, bundle: Object.freeze({ ...draft.bundle, markdown }) }) })
  }
  const submit = async (remove: boolean, observer: AbortSignal): Promise<ManagedSkillOutcome> => {
    const value = current(), held = prepared
    if (held === undefined || value.phase !== 'editing') throw new ClientFailure('closed')
    const send = remove ? held.detail?.uninstall : held.publish, draft = value.draft
    if (send === undefined || !remove && draft?.forSkill !== held.selection) throw new ClientFailure('closed')
    const { operation, signal } = begin(observer)
    prepared = undefined
    update({ phase: 'submitting', outcome: undefined })
    let outcome: ManagedSkillOutcome
    try {
      if (remove) {
        const uninstall = held.detail?.uninstall
        if (uninstall === undefined) throw new ClientFailure('closed')
        outcome = await uninstall(signal)
      } else {
        if (held.publish === undefined || draft === undefined) throw new ClientFailure('closed')
        outcome = await held.publish(draft.bundle, signal)
      }
      signal.throwIfAborted(); current()
    } catch { outcome = { kind: 'unknown' } }
    try {
      if (outcome.kind === 'persisted') {
        const item = outcome.item, previous = store.getSnapshot().items.map((row) => {
          const { shadowed: _shadowed, shadowedBy: _shadowedBy, ...snapshot } = row
          return Object.freeze(snapshot)
        })
        const items = item === null ? previous.filter(row => row.id !== held.selection)
          : previous.some(row => row.id === item.id) ? previous.map(row => row.id === item.id ? item : row) : [...previous, item]
        update({ phase: 'result', outcome, needsRefresh: true }, { items: Object.freeze(items) })
      } else update({ phase: 'result', outcome })
    } catch (_withdrawn) { /* An uncertain draft remains in its original retired source. */ }
    finally { end(operation) }
    return outcome
  }
  const download = async (observer: AbortSignal): Promise<void> => {
    const read = prepared?.detail?.download
    if (read === undefined || current().phase !== 'editing') throw new ClientFailure('closed')
    const { operation, signal } = begin(observer)
    update({ phase: 'downloading', downloadStarted: false })
    try { await read(signal); signal.throwIfAborted(); update({ downloadStarted: true }) }
    finally {
      try { update({ phase: 'editing' }) } catch (_withdrawn) { /* Withdrawal already published the retired state. */ }
      end(operation)
    }
  }
  const close = (): void => {
    current()
    if (active !== undefined) throw new ClientFailure('closed')
    prepared = undefined
    update({ phase: 'idle', selection: undefined, detail: undefined })
  }
  const installZip = async (file: File, observer: AbortSignal): Promise<ManagedSkillOutcome> => {
    try {
      await open(undefined, observer)
      const value = current()
      if (value.limits === undefined || !value.canPublish || !/\.zip$/i.test(file.name)
        || file.size === 0 || file.size > value.limits.maxArchiveBytes) {
        close()
        return { kind: 'unavailable' }
      }
      choose(Object.freeze({ kind: 'zip', file }))
    } catch { return { kind: 'unavailable' } }
    return submit(false, observer)
  }
  const observed = store.getSnapshot().managed
  const previous = observed?.scope === input.scope ? observed : undefined
  const managed: ManagedSkillEditing = Object.freeze({ scope: input.scope, editNumber: 0, canPublish: false, canInstall: undefined, phase: 'idle', selection: undefined, detail: undefined,
    limits: undefined, draft: previous?.draft, outcome: previous?.outcome, needsRefresh: false, downloadStarted: false,
    refresh, open, installZip, choose, editMarkdown, publish: (observer: AbortSignal) => submit(false, observer),
    uninstall: (observer: AbortSignal) => submit(true, observer), download, close })
  const sample = store.getSnapshot().sample
  store.set(Object.freeze({ phase: 'unread', items: Object.freeze([]), managed,
    ...sample?.scope === input.scope ? { sample } : {} }))
  return () => {
    active?.abort(); prepared = undefined
    const value = store.getSnapshot(), managed = value.managed
    if (managed?.scope !== input.scope) return
    store.set(Object.freeze({ ...value, phase: 'unavailable', managed: Object.freeze({ ...managed, phase: 'unavailable',
      outcome: managed.phase === 'submitting' ? { kind: 'unknown' as const } : managed.outcome }) }))
  }
}
