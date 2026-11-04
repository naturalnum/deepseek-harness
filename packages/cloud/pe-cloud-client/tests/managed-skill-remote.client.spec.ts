// @vitest-environment jsdom
/** Generated-method aliases with scripted replies; browser effects do not claim server or disk persistence. */
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-pe-cloud-api'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { managedSkillCallbacks, type ManagedSkillRemote } from '../src/client/managed-skill-remote.ts'
import { remoteFixture, directoryVersion } from './fixtures/managed-remote.client.ts'

afterEach(() => { vi.restoreAllMocks() })
const signal = (): AbortSignal => new AbortController().signal
const zip = () => ({ kind: 'zip' as const, file: Object.assign(new File(['zip'], 'selected.zip'), {
  arrayBuffer: async () => new TextEncoder().encode('zip').buffer,
}) })

it('keeps confirmed installation separate from selection awaiting native inspection', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  f.install.mockResolvedValueOnce({ ok: true, value: { persisted: true, applied: true,
    version: directoryVersion('installed'), entry: { ...f.entry, selection: { kind: 'incomplete' } } } })
  const list = await api.installed(signal()), outcome = await list.install?.(zip(), signal())
  expect(outcome).toMatchObject({ kind: 'persisted', applied: true, item: { installed: true, status: 'published' } })
  if (outcome?.kind !== 'persisted') throw new Error('Expected confirmed native installation')
  expect(outcome.item?.shadowed).toBeUndefined()
  expect(outcome.item?.shadowedBy).toBeUndefined()
})

it('reads only on gesture and uses the exact details-issued directory edit after a later list refresh', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  expect(f.installed).not.toHaveBeenCalled()
  await api.installed(signal())
  const edit = await api.details(f.entry.skillId, signal())
  expect(edit.markdown).toBe('instructions')
  f.installed.mockResolvedValueOnce({ ok: true, value: { ...f.state, version: directoryVersion('later-list') } })
  await api.installed(signal())
  expect(await edit.update?.(zip(), signal())).toMatchObject({ kind: 'persisted', applied: false })
  expect(f.update.mock.calls[0]?.[0]).toEqual({ skillId: f.entry.skillId, version: directoryVersion('opened-directory'),
    bundle: { kind: 'zip', dataBase64: 'emlw' } })
  await expect(edit.uninstall?.(signal())).rejects.toThrow()
  expect(f.uninstall).not.toHaveBeenCalled()
})

it.each(['cloud/config-conflict', 'cloud/account-unavailable'] as const)('does not replay or renew an edit after %s', async (code) => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  await api.installed(signal())
  const edit = await api.details(f.entry.skillId, signal())
  f.update.mockResolvedValueOnce({ ok: false, error: new RemoteError(code, 'PRIVATE_DIAGNOSTIC', {}) })
  expect(await edit.update?.(zip(), signal())).toEqual({ kind: code === 'cloud/config-conflict' ? 'conflict' : 'unknown' })
  await expect(edit.update?.(zip(), signal())).rejects.toThrow()
  expect(f.details).toHaveBeenCalledTimes(1)
  expect(f.installed).toHaveBeenCalledTimes(1)
  expect(f.update).toHaveBeenCalledTimes(1)
})

it('reports a confirmed capacity refusal without treating it as an uncertain write', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  f.install.mockResolvedValueOnce({ ok: false, error: new RemoteError('cloud/capacity', 'PRIVATE_DIAGNOSTIC', {}) })
  expect(await list.install?.(zip(), signal())).toEqual({ kind: 'unavailable' })
  expect(f.install).toHaveBeenCalledTimes(1)
})

it('keeps original bound namespace methods and refuses local reads or RPC after original page withdrawal', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  const list = await api.installed(signal())
  const replacement = vi.fn<ManagedSkillRemote['install']>()
  f.remote.install = replacement
  await list.install?.(zip(), signal())
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(replacement).not.toHaveBeenCalled()
  const edit = await api.details(f.entry.skillId, signal()), packageFile = zip()
  const read = vi.spyOn(packageFile.file, 'arrayBuffer')
  f.revoke()
  await expect(edit.update?.(packageFile, signal())).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  expect(f.update).not.toHaveBeenCalled()
})

it('discards a late generated reply after the original page is revoked', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  await api.installed(signal())
  const edit = await api.details(f.entry.skillId, signal())
  const held = Promise.withResolvers<Awaited<ReturnType<ManagedSkillRemote['uninstall']>>>()
  f.uninstall.mockReturnValueOnce(held.promise)
  const pending = edit.uninstall?.(signal())
  f.revoke()
  held.resolve({ ok: true, value: { persisted: true, applied: true, version: directoryVersion('late'), entry: null } })
  expect(await pending).toEqual({ kind: 'unknown' })
})

it('honors actual action flags and native source coverage instead of opening guessed operations', async () => {
  const f = remoteFixture()
  f.installed.mockResolvedValueOnce({ ok: true, value: { ...f.state, actions: { install: false }, entries: [{ ...f.entry,
    selection: { kind: 'shadowed', by: { name: 'one', source: 'project-dsh', provider: 'native-project' } } }] } })
  f.details.mockResolvedValueOnce({ ok: true, value: { entry: { ...f.entry, mutable: false,
    actions: { update: false, uninstall: false, download: false } }, version: directoryVersion('details'), files: [], markdown: 'instructions' } })
  const api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  expect(list.install).toBeUndefined()
  expect(list.items[0]?.shadowedBy).toEqual({ name: 'one', source: 'project-dsh' })
  const edit = await api.details(f.entry.skillId, signal())
  expect(edit.update).toBeUndefined(); expect(edit.uninstall).toBeUndefined(); expect(edit.download).toBeUndefined()
})

it('checks the full serialized request budget before submitting selected bytes', async () => {
  const f = remoteFixture()
  f.installed.mockResolvedValueOnce({ ok: true, value: { ...f.state, limits: { ...f.state.limits, maxRequestBytes: 8 } } })
  const api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  await expect(list.install?.(zip(), signal())).rejects.toThrow()
  expect(f.install).not.toHaveBeenCalled()
})

it('downloads the exact immutable selector and releases its browser URL after requesting a save', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  const create = vi.fn(() => 'blob:owned-zip'), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    await api.installed(signal())
    const edit = await api.details(f.entry.skillId, signal())
    await edit.download?.(signal())
    expect(f.download).toHaveBeenCalledExactlyOnceWith({ skillId: f.entry.skillId, contentVersion: f.entry.contentVersion },
      expect.any(AbortSignal))
    expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-zip')
    expect(document.querySelector('a[download]')).toBeNull()
  } finally { vi.unstubAllGlobals() }
})


it('distinguishes the dedicated invalid bundle refusal from uncertain outcomes without replay', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  f.install.mockResolvedValueOnce({ ok: false, error: new RemoteError('cloud/invalid-skill-bundle', 'fixed', {}) })
  expect(await list.install?.(zip(), signal())).toEqual({ kind: 'invalid-bundle' })
  await expect(list.install?.(zip(), signal())).rejects.toThrow()
  expect(f.install).toHaveBeenCalledTimes(1)
})

it.each(['dsh-office', 'dsh-reports'])('projects immutable %s built-ins into Writing & office and offers complete reads without edit capabilities', async (provider) => {
  const f = remoteFixture(), entry = { ...f.entry, source: 'bundled', provider, mutable: false,
    actions: { update: false, uninstall: false, download: true } }
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, entries: [entry] } })
  f.details.mockResolvedValue({ ok: true, value: { entry, markdown: 'instructions', version: directoryVersion('builtins'),
    files: [{ relativePath: 'SKILL.md', bytes: 12, sha256: createHash('sha256').update('instructions').digest('hex') }] } })
  const api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  expect(list.items[0]).toMatchObject({ category: 'writing-office', source: 'bundled', installed: true })
  const detail = await api.details(entry.skillId, signal())
  expect(detail.update).toBeUndefined(); expect(detail.uninstall).toBeUndefined()
  expect(detail.download).toBeTypeOf('function')
  expect(await detail.readFile?.('SKILL.md', signal())).toEqual({ kind: 'text', text: 'instructions' })
})

it('keeps personal-import metadata separate from opaque content selectors and package release versions', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  const list = await api.installed(signal()), item = list.items[0]
  expect(item).toMatchObject({ category: 'imported', source: 'custom', provider: f.entry.provider,
    contentId: f.entry.contentVersion, invocation: f.entry.invocation })
  expect(item?.version).toBeUndefined()
  expect(item?.enabled).toBeUndefined()
  expect(item?.canToggle).toBeUndefined()
  const detail = await api.details(f.entry.skillId, signal())
  expect(detail.item).toEqual(item)
  expect(f.details).toHaveBeenCalledExactlyOnceWith({ skillId: f.entry.skillId }, expect.any(AbortSignal))
})

it('does not classify every bundled provider as Office', async () => {
  const f = remoteFixture()
  f.installed.mockResolvedValueOnce({ ok: true, value: { ...f.state, entries: [{ ...f.entry, source: 'bundled', provider: 'another-bundle',
    mutable: false, actions: { update: false, uninstall: false, download: true } }] } })
  const api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  expect(list.items[0]).toMatchObject({ source: 'bundled', category: 'other' })
})

it.each([
  { modelInvocable: true, userInvocable: true }, { modelInvocable: true, userInvocable: false },
  { modelInvocable: false, userInvocable: true }, { modelInvocable: false, userInvocable: false },
])('projects native invocation policy %j without synthesizing an enablement mutation', async (invocation) => {
  const f = remoteFixture()
  f.installed.mockResolvedValueOnce({ ok: true, value: { ...f.state, entries: [{ ...f.entry, invocation }] } })
  const api = managedSkillCallbacks(f.remote, f.input), list = await api.installed(signal())
  expect(list.items[0]?.invocation).toEqual(invocation)
  expect(list.items[0]?.enabled).toBeUndefined()
  expect(list.items[0]?.canToggle).toBeUndefined()
})

it('uses the installed binary callback without changing JSON flags or bounded file reads', async () => {
  const f = remoteFixture(), entry = { ...f.entry, source: 'bundled', mutable: false,
    actions: { update: false, uninstall: false, download: false } }
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, entries: [entry] } })
  f.details.mockResolvedValue({ ok: true, value: { entry, version: directoryVersion('readonly'), files: [], markdown: 'instructions' } })
  const download = vi.fn(async (_signal: AbortSignal) => {})
  const prepareBundledDownload = vi.fn(async (_selector: { skillId: string; contentVersion: string }, _signal: AbortSignal) => download)
  const api = managedSkillCallbacks(f.remote, { ...f.input, prepareBundledDownload })
  await api.installed(signal()); const detail = await api.details(entry.skillId, signal())
  expect(prepareBundledDownload).toHaveBeenCalledExactlyOnceWith(
    { skillId: entry.skillId, contentVersion: entry.contentVersion }, expect.any(AbortSignal))
  expect(detail.readFile).toBeTypeOf('function')
  await detail.download?.(signal())
  expect(download).toHaveBeenCalledTimes(1); expect(f.download).not.toHaveBeenCalled()
  expect(detail.update).toBeUndefined(); expect(detail.uninstall).toBeUndefined()
})
