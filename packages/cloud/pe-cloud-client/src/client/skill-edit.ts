/** Captured native current/publish callbacks; no file store, replacement token, request envelope or retry. */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
export type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import { ClientFailure } from './errors.ts'

/** Original generated native skill namespace, derived from the actual Host Remote methods. */
export type CloudSkillRemote = Pick<TypertClientRemote['cloudSkills'], 'current' | 'publish'>
type Current = Extract<Awaited<ReturnType<CloudSkillRemote['current']>>, { ok: true }>['value']
/** UI outcomes retain persistence and native catalog application as separate facts. */
export type SkillPublicationOutcome = {
  readonly kind: 'persisted'
  readonly applied: boolean
  readonly resources: Current['resources']
  readonly source: Readonly<NonNullable<Current['current']>>
}
  | { readonly kind: 'unknown' | 'conflict' }
/** One current-issued edit; its opaque version stays only in its captured publication callback. */
export interface PreparedSkillEdit {
  readonly source: Readonly<Current['current']>
  readonly installed: boolean
  readonly applied: boolean
  readonly resources: Current['resources']
  readonly publish: (markdown: string, resourceBase64: string, signal: AbortSignal) => Promise<SkillPublicationOutcome>
}
/** Original page and dependency admission plus its explicit observer budget. */
export interface SkillEditInput {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly assertCurrent: () => void
}
const booleanFlag = (value: unknown): boolean | undefined => value === true ? true : value === false ? false : undefined
function resourceMode(value: unknown): Current['resources'] | undefined {
  return value === 'unavailable' || value === 'project-on-load' ? value : undefined
}
function validVersion(value: unknown): value is Current['version'] {
  return value !== null && typeof value === 'object' && 'epoch' in value && typeof value.epoch === 'string'
    && 'editToken' in value && typeof value.editToken === 'string'
}

/**
 * Read once for this explicit edit and capture its original version without renewing it after publication.
 * @param remote Actual traced namespace supplied by the package's one generated contribution mount.
 * @param input Original immutable page/dependency checks, lifetime and finite deadline.
 * @param observer Current editor interaction; closing it cancels observation without asserting backend rollback.
 * @returns One immutable edit; even a conflict or uncertain answer consumes its only publication attempt.
 */
export async function prepareCloudSkillEdit(remote: CloudSkillRemote, input: SkillEditInput,
  observer: AbortSignal): Promise<PreparedSkillEdit> {
  const current = remote.current.bind(remote), publish = remote.publish.bind(remote)
  const request = async <T>(send: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
    input.assertCurrent(); input.signal.throwIfAborted(); observer.throwIfAborted(); signal.throwIfAborted()
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new ClientFailure('closed')) }, input.timeoutMs)
    try {
      const combined = AbortSignal.any([input.signal, observer, signal, deadline.signal])
      const answer = await send(combined)
      combined.throwIfAborted(); input.assertCurrent()
      return answer
    } finally { clearTimeout(timer) }
  }
  const answer = await request(signal => current({ slot: 'sample' }, signal), observer)
  if (!answer.ok || !validVersion(answer.value.version)) throw new ClientFailure('closed')
  const applied = booleanFlag(answer.value.applied), resources = resourceMode(answer.value.resources)
  if (applied === undefined || resources === undefined || resources === 'project-on-load' && !applied) throw new ClientFailure('closed')
  const version = Object.freeze({ epoch: answer.value.version.epoch, editToken: answer.value.version.editToken })
  let used = false
  return Object.freeze({ source: answer.value.current === null ? null : Object.freeze({ ...answer.value.current }),
    installed: answer.value.current !== null, applied, resources,
    publish: async (skillMarkdown: string, resourceBase64: string, signal: AbortSignal): Promise<SkillPublicationOutcome> => {
      if (used) throw new ClientFailure('closed')
      used = true
      try {
        const saved = await request(observer => publish({ slot: 'sample', version, skillMarkdown, resourceBase64 }, observer), signal)
        if (!saved.ok) return { kind: saved.error.code === 'cloud/config-conflict' ? 'conflict' : 'unknown' }
        if (saved.value.persisted !== true) return { kind: 'unknown' }
        const applied = booleanFlag(saved.value.applied), resources = resourceMode(saved.value.resources)
        return applied === undefined || resources === undefined || resources === 'project-on-load' && !applied
          ? { kind: 'unknown' } : { kind: 'persisted', applied, resources, source: Object.freeze({ ...saved.value.current }) }
      } catch { return { kind: 'unknown' } }
    },
  })
}
