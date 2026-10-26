/** Scripted generated namespace exercises page adaptation; no HTTP, account credential or backend publication. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { prepareCloudSkillEdit, type CloudSkillRemote } from '../src/client/skill-edit.ts'
import { attachSkillVersionEditing, type SkillSourceMetadata } from '../src/client/skill-version-editing.ts'
import type { SkillManagementView } from '../src/client/management/skills/types.ts'

type Current = Extract<Awaited<ReturnType<CloudSkillRemote['current']>>, { ok: true }>['value']
const version: Current['version'] = { epoch: brandString<Current['version']['epoch']>('original-epoch'),
  editToken: brandString<Current['version']['editToken']>('original-edit-token') }
const metadata: SkillSourceMetadata = { id: 'immutable-original', skillSha256: 'a'.repeat(64), resourceSha256: 'b'.repeat(64), skillBytes: 12, resourceBytes: 3 }
const saved = { ...metadata, id: 'immutable-published', skillBytes: 20 }
const signal = (): AbortSignal => new AbortController().signal
function bench(source: SkillSourceMetadata | null = metadata) {
  const store = createSnapshotStore<SkillManagementView>({ phase: 'unavailable', items: [] }), lifetime = new AbortController()
  let admitted = true
  const assertCurrent = (): void => { if (!admitted) throw new Error('Retired original owner') }
  const current = vi.fn<CloudSkillRemote['current']>(async () => ({ ok: true,
    value: { slot: 'sample', version, current: source, applied: source !== null, resources: 'unavailable' } }))
  const publish = vi.fn<CloudSkillRemote['publish']>(async () => ({ ok: true,
    value: { persisted: true, applied: false, version, current: saved, resources: 'unavailable' } }))
  const remote: CloudSkillRemote = { current, publish }
  const withdraw = attachSkillVersionEditing(store, { scope: 'original-page:original-dependency', signal: lifetime.signal,
    maxFileBytes: 4096, assertCurrent, title: () => 'Actual sample',
    prepare: observer => prepareCloudSkillEdit(remote, { signal: lifetime.signal, timeoutMs: 1000, assertCurrent }, observer) })
  const sample = () => { const value = store.getSnapshot().sample; if (value === undefined) throw new Error('Missing original source'); return value }
  return { store, sample, current, publish, lifetime, withdraw, retire: () => { admitted = false; withdraw() } }
}
it('uses actual current facts and original opaque version while keeping original files separate from the edited copy', async () => {
  const f = bench(), stable = f.store
  expect(f.current).not.toHaveBeenCalled()
  await f.sample().open(signal())
  expect(f.store).toBe(stable)
  expect(f.sample().source).toEqual(metadata)
  expect(Object.isFrozen(f.sample().source)).toBe(true)
  expect(f.store.getSnapshot().items).toEqual([expect.objectContaining({ id: 'sample', installed: true, status: 'published' })])
  expect(f.store.getSnapshot().items[0]?.enabled).toBeUndefined()
  f.sample().copyFiles({ markdown: 'Original local instructions', resourceBase64: 'AP8B' })
  const original = f.sample().draft?.original
  f.sample().editMarkdown('Edited complete instructions')
  expect(original?.markdown).toBe('Original local instructions')
  expect(Object.isFrozen(original)).toBe(true)
  expect(f.sample().draft?.source).toEqual(metadata)
  expect(f.sample().source).toEqual(metadata)
  await expect(f.sample().publish(signal())).resolves.toEqual({ kind: 'persisted', source: saved, applied: false, resources: 'unavailable' })
  expect(f.publish.mock.calls[0]?.[0]).toEqual({ slot: 'sample', version, skillMarkdown: 'Edited complete instructions', resourceBase64: 'AP8B' })
  expect(f.current).toHaveBeenCalledTimes(1)
  expect(f.sample().source).toEqual(saved)
  expect(f.sample().draft?.original).toBe(original)
  expect(f.store.getSnapshot().items[0]?.status).toBe('catalog-pending')
  await expect(f.sample().publish(signal())).rejects.toThrow()
  expect(f.publish).toHaveBeenCalledTimes(1)
})
it('does not turn an enabled management capability into an installed skill', async () => {
  const f = bench(null)
  await f.sample().open(signal())
  expect(f.sample().sourceKnown).toBe(true)
  expect(f.sample().source).toBeNull()
  expect(f.store.getSnapshot().items).toEqual([])
})
it.each(['unknown', 'conflict'] as const)('retains an unconfirmed draft after %s without replay or replacement current reads', async (kind) => {
  const f = bench()
  if (kind === 'unknown') f.publish.mockResolvedValue({ ok: true, value: { persisted: 'unknown', applied: false, resources: 'unavailable' } })
  else f.publish.mockResolvedValue({ ok: false, error: new RemoteError('cloud/config-conflict', 'PRIVATE', {}) })
  await f.sample().open(signal()); f.sample().copyFiles({ markdown: 'Keep my draft', resourceBase64: 'AA==' })
  const draft = f.sample().draft
  expect(await f.sample().publish(signal())).toEqual({ kind })
  expect(f.sample().draft).toBe(draft)
  expect(f.sample().source).toEqual(metadata)
  await expect(f.sample().publish(signal())).rejects.toThrow()
  expect(f.current).toHaveBeenCalledTimes(1); expect(f.publish).toHaveBeenCalledTimes(1)
  f.current.mockRejectedValue(new Error('Current unavailable'))
  await expect(f.sample().open(signal())).rejects.toThrow()
  expect(f.sample().draft).toBe(draft)
  expect(f.sample().outcome).toEqual({ kind })
})
it('refuses a late current reply and callbacks after the original dependency is withdrawn', async () => {
  const f = bench(), held = Promise.withResolvers<Awaited<ReturnType<CloudSkillRemote['current']>>>()
  f.current.mockReturnValue(held.promise)
  const old = f.sample(), opening = old.open(signal()), rejected = expect(opening).rejects.toThrow()
  f.retire(); const retired = f.store.getSnapshot()
  held.resolve({ ok: true, value: { slot: 'sample', version, current: metadata, applied: true, resources: 'unavailable' } })
  await rejected
  expect(f.store.getSnapshot()).toBe(retired)
  expect(f.sample().phase).toBe('unavailable')
  expect(() => { old.copyFiles({ markdown: 'Late copy', resourceBase64: '' }) }).toThrow()
  expect(f.publish).not.toHaveBeenCalled()
})
it('blocks duplicate pending publication and ignores its late success after withdrawal while retaining the draft', async () => {
  const f = bench(), other = bench(null), held = Promise.withResolvers<Awaited<ReturnType<CloudSkillRemote['publish']>>>()
  f.publish.mockReturnValue(held.promise)
  await f.sample().open(signal()); f.sample().copyFiles({ markdown: 'Unconfirmed complete draft', resourceBase64: 'AP8B' })
  const draft = f.sample().draft, old = f.sample(), pending = old.publish(signal()), otherBefore = other.store.getSnapshot()
  await expect(old.publish(signal())).rejects.toThrow()
  f.retire(); const retired = f.store.getSnapshot()
  expect(f.sample().outcome).toEqual({ kind: 'unknown' })
  held.resolve({ ok: true, value: { persisted: true, applied: true, version, current: saved, resources: 'project-on-load' } })
  expect(await pending).toEqual({ kind: 'unknown' })
  expect(f.store.getSnapshot()).toBe(retired)
  expect(f.sample().draft).toBe(draft)
  expect(other.store.getSnapshot()).toBe(otherBefore)
  expect(f.publish).toHaveBeenCalledTimes(1); expect(f.current).toHaveBeenCalledTimes(1)
})
it('rejects a delayed local copy captured before a different explicit current edit opened', async () => {
  const f = bench()
  await f.sample().open(signal())
  const old = f.sample()
  await f.sample().open(signal())
  expect(() => { old.copyFiles({ markdown: 'Delayed original-file read', resourceBase64: 'AA==' }) }).toThrow()
  expect(f.sample().draft).toBeUndefined()
  expect(f.publish).not.toHaveBeenCalled()
})
