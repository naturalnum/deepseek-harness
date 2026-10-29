/** Generated cloudSkills operations captured by the original prepared page; opaque selectors and directory tokens stay in this adapter. */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type { ManagedSkillBundle, ManagedSkillDetail, ManagedSkillEditingInput, ManagedSkillLimits, ManagedSkillOutcome } from './managed-skill-editing.ts'
import type { SkillCard } from './management/skills/types.ts'
import { encodeManagedSkillBundle } from './managed-skill-files.ts'
import { ClientFailure } from './errors.ts'

/** Actual generated namespace; no alternative RemoteMap, wire envelope, or callable backend is declared here. */
export type ManagedSkillRemote = Pick<TypertClientRemote['cloudSkills'],
  'installed' | 'details' | 'install' | 'update' | 'uninstall' | 'download'>
type Installed = Extract<Awaited<ReturnType<ManagedSkillRemote['installed']>>, { ok: true }>['value']
type Entry = Installed['entries'][number]
type MutationReply = ReturnType<ManagedSkillRemote['install']>

/** Original page/dependency check and explicit observer timer; RPC bodies retain the native transport bounds. */
export interface ManagedSkillRemoteInput {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly assertCurrent: () => void
}

function row(entry: Entry, applied = true): SkillCard {
  return Object.freeze({ id: entry.skillId, name: entry.name, description: entry.description, category: 'other', installed: true,
    recommended: false, status: !applied ? 'catalog-pending' : entry.selection.kind === 'incomplete' ? 'unavailable' : 'published',
    version: entry.contentVersion, sourceLabel: entry.source, fileCount: entry.fileCount, totalBytes: entry.contentBytes,
    ...entry.selection.kind === 'shadowed' ? { shadowedBy: Object.freeze({ name: entry.selection.by.name, source: entry.selection.by.source }) } : {},
    ...entry.selection.kind === 'incomplete' ? {} : { shadowed: entry.selection.kind === 'shadowed' } })
}

/**
 * Capture the real six generated operations without reading or installing anything at registration.
 * @param remote Original generated namespace on the captured page's only Connection.
 * @param input Original admission, lifetime, and explicit deadline.
 * @returns Read callbacks for the original stable source; write callbacks each consume the native version that opened them.
 */
export function managedSkillCallbacks(remote: ManagedSkillRemote, input: ManagedSkillRemoteInput): Pick<ManagedSkillEditingInput, 'installed' | 'details'> {
  const installed = remote.installed.bind(remote), details = remote.details.bind(remote), install = remote.install.bind(remote)
  const update = remote.update.bind(remote), uninstall = remote.uninstall.bind(remote), download = remote.download.bind(remote)
  // These are only the actual opaque wire selectors from displayed native replies, not installation metadata or authorization.
  const selectors = new Map<string, Entry['skillId']>()
  let observed: Installed['limits'] | undefined
  const check = (observer: AbortSignal): void => { input.assertCurrent(); input.signal.throwIfAborted(); observer.throwIfAborted() }
  const request = async <T>(send: (signal: AbortSignal) => Promise<T>, observer: AbortSignal): Promise<T> => {
    check(observer)
    const deadline = new AbortController(), timer = setTimeout(() => { deadline.abort(new ClientFailure('closed')) }, input.timeoutMs)
    try {
      const signal = AbortSignal.any([input.signal, observer, deadline.signal])
      const result = await send(signal)
      signal.throwIfAborted(); input.assertCurrent()
      return result
    } finally { clearTimeout(timer) }
  }
  const bounded = (body: object, limits: Installed['limits']): void => {
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > limits.maxRequestBytes) throw new ClientFailure('closed')
  }
  const uiLimits = (limits: Installed['limits']): ManagedSkillLimits => Object.freeze({ maxFiles: limits.maxFilesPerBundle,
    maxDirectories: limits.maxDirectoriesPerBundle, maxEntries: limits.maxFilesPerBundle + limits.maxDirectoriesPerBundle,
    maxPathDepth: limits.maxPathDepth, maxPathBytes: limits.maxPathBytes, maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxBundleBytes, maxArchiveBytes: limits.maxZipBytes })
  const result = async (send: (signal: AbortSignal) => MutationReply, observer: AbortSignal,
    remove: boolean): Promise<ManagedSkillOutcome> => {
    try {
      const answer = await request(send, observer)
      if (!answer.ok) return { kind: answer.error.code === 'cloud/config-conflict' ? 'conflict'
        : answer.error.code === 'cloud/capacity' ? 'unavailable' : 'unknown' }
      if (answer.value.persisted !== true || remove !== (answer.value.entry === null)) return { kind: 'unknown' }
      const entry = answer.value.entry
      if (entry !== null) selectors.set(entry.skillId, entry.skillId)
      return { kind: 'persisted', applied: answer.value.applied, item: entry === null ? null : row(entry, answer.value.applied) }
    } catch { return { kind: 'unknown' } }
  }
  return Object.freeze({
    installed: async (observer: AbortSignal) => {
      const answer = await request(signal => installed({}, signal), observer)
      if (!answer.ok || !answer.value.complete) throw new ClientFailure('closed')
      const state = answer.value, version = Object.freeze({ ...state.version }), limits = uiLimits(state.limits)
      selectors.clear()
      for (const entry of state.entries) selectors.set(entry.skillId, entry.skillId)
      observed = state.limits
      let used = false
      return Object.freeze({ items: Object.freeze(state.entries.map(entry => row(entry))), limits,
        ...!state.actions.install ? {} : {
          install: async (bundle: ManagedSkillBundle, signal: AbortSignal): Promise<ManagedSkillOutcome> => {
            check(signal)
            if (used) throw new ClientFailure('closed')
            used = true
            const body = { version, bundle: await encodeManagedSkillBundle(bundle, limits, signal) }
            bounded(body, state.limits)
            return result(current => install(body, current), signal, false)
          } },
      })
    },
    details: async (id: string, observer: AbortSignal): Promise<ManagedSkillDetail> => {
      const skillId = selectors.get(id), state = observed
      if (skillId === undefined || state === undefined) throw new ClientFailure('closed')
      const answer = await request(signal => details({ skillId }, signal), observer)
      if (!answer.ok || answer.value.entry.skillId !== skillId) throw new ClientFailure('closed')
      const value = answer.value, version = Object.freeze({ ...value.version }), limits = uiLimits(state)
      let used = false
      return Object.freeze({ item: row(value.entry),
        files: Object.freeze(value.files.map(file => Object.freeze({ path: file.relativePath, bytes: file.bytes }))),
        ...!value.entry.mutable || !value.entry.actions.update ? {} : { update: async (bundle: ManagedSkillBundle, signal: AbortSignal) => {
          check(signal)
          if (used) throw new ClientFailure('closed')
          used = true
          const body = { skillId, version, bundle: await encodeManagedSkillBundle(bundle, limits, signal) }
          bounded(body, state)
          return result(current => update(body, current), signal, false)
        } },
        ...!value.entry.mutable || !value.entry.actions.uninstall ? {} : { uninstall: async (signal: AbortSignal) => {
          check(signal)
          if (used) throw new ClientFailure('closed')
          used = true
          const body = { skillId, version }
          bounded(body, state)
          return result(current => uninstall(body, current), signal, true)
        } },
        ...!value.entry.actions.download ? {} : { download: async (signal: AbortSignal) => {
          const contentVersion = value.entry.contentVersion
          const answer = await request(current => download({ skillId, contentVersion }, current), signal)
          if (!answer.ok || answer.value.skillId !== skillId || answer.value.contentVersion !== contentVersion
            || answer.value.bytes > limits.maxArchiveBytes
            || new TextEncoder().encode(JSON.stringify(answer.value)).byteLength > state.maxReplyBytes) throw new ClientFailure('closed')
          const data = answer.value
          if (data.dataBase64.length > 4 * Math.ceil(limits.maxArchiveBytes / 3)) throw new ClientFailure('closed')
          const bytes = Uint8Array.from(atob(data.dataBase64), char => char.charCodeAt(0))
          if (bytes.byteLength !== data.bytes) throw new ClientFailure('closed')
          const name = data.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, '_')
          if (name === '' || name === '.' || name === '..') throw new ClientFailure('closed')
          signal.throwIfAborted(); input.assertCurrent()
          const url = URL.createObjectURL(new Blob([bytes], { type: data.mediaType })), anchor = document.createElement('a')
          try {
            anchor.href = url; anchor.download = name; anchor.rel = 'noopener noreferrer'; anchor.hidden = true
            document.body.append(anchor); anchor.click()
            // The original file-download consumer uses one browser task before releasing its Blob URL too.
            await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          } finally { anchor.remove(); URL.revokeObjectURL(url) }
        } },
      })
    },
  })
}
