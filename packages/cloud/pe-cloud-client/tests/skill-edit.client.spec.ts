/** Native current-issued edits retain their original token and never replay an uncertain publication. */
import type {} from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { prepareCloudSkillEdit, type CloudSkillRemote, type SkillEditInput } from '../src/client/skill-edit.ts'

type State = Extract<Awaited<ReturnType<CloudSkillRemote['current']>>, { ok: true }>['value']
type Saved = Extract<Awaited<ReturnType<CloudSkillRemote['publish']>>, { ok: true }>['value']
const version = (token: string): State['version'] => ({ epoch: brandString<State['version']['epoch']>('E'),
  editToken: brandString<State['version']['editToken']>(token) })
const metadata = { id: 'sample-version', skillSha256: 'a'.repeat(64), resourceSha256: 'b'.repeat(64), skillBytes: 12, resourceBytes: 3 }
const state = (token = 'opened'): State => ({ slot: 'sample', version: version(token), current: null, applied: false, resources: 'unavailable' })
function bench(reply: Saved = { persisted: true, applied: true, version: version('reply'), current: metadata, resources: 'unavailable' }) {
  const lifetime = new AbortController(), observer = new AbortController(), assertCurrent = vi.fn()
  const current = vi.fn<CloudSkillRemote['current']>(async () => ({ ok: true, value: state() }))
  const publish = vi.fn<CloudSkillRemote['publish']>(async () => ({ ok: true, value: reply }))
  const remote: CloudSkillRemote = { current, publish }
  const input: SkillEditInput = { signal: lifetime.signal, timeoutMs: 1000, assertCurrent }
  return { lifetime, observer, assertCurrent, current, publish, remote, input }
}

it('captures one current token for the fixed sample and consumes exactly one complete-file publication', async () => {
  const b = bench(), edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  b.current.mockResolvedValue({ ok: true, value: state('background') })
  expect(await edit.publish('complete markdown\n', 'AP8B', new AbortController().signal)).toEqual({ kind: 'persisted', applied: true, resources: 'unavailable', source: metadata })
  expect(b.current).toHaveBeenCalledTimes(1)
  expect(b.current.mock.calls[0]?.[0]).toEqual({ slot: 'sample' })
  expect(b.publish.mock.calls[0]?.[0]).toEqual({ slot: 'sample', version: version('opened'), skillMarkdown: 'complete markdown\n', resourceBase64: 'AP8B' })
  await expect(edit.publish('again', 'AA==', new AbortController().signal)).rejects.toMatchObject({ code: 'closed' })
  expect(b.publish).toHaveBeenCalledTimes(1)
})
it.each([true, false])('keeps confirmed persistence separate from applied=%s', async (applied) => {
  const b = bench({ persisted: true, applied, version: version('reply'), current: metadata, resources: 'unavailable' })
  const edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  expect(await edit.publish('full', 'AA==', new AbortController().signal)).toEqual({ kind: 'persisted', applied, resources: 'unavailable', source: metadata })
})
it('does not turn a native unknown result into success or refresh its token', async () => {
  const b = bench({ persisted: 'unknown', applied: false, resources: 'unavailable' })
  const edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  expect(await edit.publish('full', 'AA==', new AbortController().signal)).toEqual({ kind: 'unknown' })
  expect(b.current).toHaveBeenCalledTimes(1)
  await expect(edit.publish('retry', 'AA==', new AbortController().signal)).rejects.toThrow()
  expect(b.publish).toHaveBeenCalledTimes(1)
})
it.each([false, 'true'])('refuses malformed wire persistence acknowledgement %s despite the declared literal', async (flag) => {
  const reply: Saved = { persisted: true, applied: true, version: version('reply'), current: metadata, resources: 'unavailable' }
  // A wire decoder can deliver a value inconsistent with its declaration; reflection introduces only this malformed fixture.
  Object.defineProperty(reply, 'persisted', { value: flag })
  const b = bench(reply), edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  expect(await edit.publish('full', 'AA==', new AbortController().signal)).toEqual({ kind: 'unknown' })
})
it.each(['cloud/config-conflict', 'cloud/account-unavailable', 'gateway/internal'] as const)('keeps %s closed to retries without reading again', async (code) => {
  const b = bench(); b.publish.mockResolvedValue({ ok: false, error: new RemoteError(code, 'PRIVATE_SERVER_DIAGNOSTIC', {}) })
  const edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  expect(await edit.publish('full', 'AA==', new AbortController().signal)).toEqual({ kind: code === 'cloud/config-conflict' ? 'conflict' : 'unknown' })
  await expect(edit.publish('retry', 'AA==', new AbortController().signal)).rejects.toThrow()
  expect(b.current).toHaveBeenCalledTimes(1)
  expect(b.publish).toHaveBeenCalledTimes(1)
})
it.each(['page', 'editor'] as const)('blocks the captured edit after its original %s is revoked', async (which) => {
  const b = bench(), edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  if (which === 'page') b.lifetime.abort(); else b.observer.abort()
  expect(await edit.publish('old', 'AA==', new AbortController().signal)).toEqual({ kind: 'unknown' })
  expect(b.publish).not.toHaveBeenCalled()
})
it('never publishes a late current edit or a late successful result after revocation', async () => {
  const b = bench(), late = Promise.withResolvers<Awaited<ReturnType<CloudSkillRemote['current']>>>()
  b.current.mockReturnValue(late.promise)
  const opening = prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  const rejected = expect(opening).rejects.toThrow()
  b.lifetime.abort(); late.resolve({ ok: true, value: state() }); await rejected
  expect(b.publish).not.toHaveBeenCalled()
  const next = bench(), saving = Promise.withResolvers<Awaited<ReturnType<CloudSkillRemote['publish']>>>()
  next.publish.mockReturnValue(saving.promise)
  const edit = await prepareCloudSkillEdit(next.remote, next.input, next.observer.signal)
  const pending = edit.publish('full', 'AA==', new AbortController().signal)
  next.lifetime.abort(); saving.resolve({ ok: true, value: { persisted: true, applied: true, version: version('reply'), current: metadata, resources: 'unavailable' } })
  expect(await pending).toEqual({ kind: 'unknown' })
  expect(next.publish).toHaveBeenCalledTimes(1)
})
it('admits only one publish even when a second click arrives before the first answer', async () => {
  const b = bench(), gate = Promise.withResolvers<Awaited<ReturnType<CloudSkillRemote['publish']>>>()
  b.publish.mockReturnValue(gate.promise)
  const edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  const first = edit.publish('full', 'AA==', new AbortController().signal)
  await expect(edit.publish('second', 'AA==', new AbortController().signal)).rejects.toThrow()
  gate.resolve({ ok: true, value: { persisted: 'unknown', applied: false, resources: 'unavailable' } }); await first
  expect(b.publish).toHaveBeenCalledTimes(1)
})

it('reports project-on-load only as authorized future preparation, separately from catalog and persistence', async () => {
  const b = bench({ persisted: true, applied: true, version: version('reply'), current: metadata, resources: 'project-on-load' })
  b.current.mockResolvedValue({ ok: true, value: { ...state(), current: metadata, applied: true, resources: 'project-on-load' } })
  const edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  expect(edit.resources).toBe('project-on-load')
  expect(await edit.publish('full', 'AA==', new AbortController().signal)).toEqual({ kind: 'persisted', applied: true, resources: 'project-on-load', source: metadata })
})

it('keeps the original namespace methods when its object is later updated', async () => {
  const b = bench(), edit = await prepareCloudSkillEdit(b.remote, b.input, b.observer.signal)
  const replacement = vi.fn<CloudSkillRemote['publish']>(async () => ({ ok: true, value: { persisted: 'unknown', applied: false, resources: 'unavailable' } }))
  b.remote.publish = replacement
  await edit.publish('full', 'AA==', new AbortController().signal)
  expect(b.publish).toHaveBeenCalledTimes(1)
  expect(replacement).not.toHaveBeenCalled()
})
