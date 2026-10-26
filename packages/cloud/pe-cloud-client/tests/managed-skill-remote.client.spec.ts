// @vitest-environment jsdom
/** Generated-method aliases with scripted replies; browser effects do not claim server or disk persistence. */
import { afterEach, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-pe-cloud-api'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { managedSkillCallbacks, type ManagedSkillRemote } from '../src/client/managed-skill-remote.ts'
import { remoteFixture, directoryVersion } from './fixtures/managed-remote.client.ts'

afterEach(() => { vi.restoreAllMocks() })
const signal = (): AbortSignal => new AbortController().signal
const zip = () => ({ kind: 'zip' as const, file: Object.assign(new File(['zip'], 'selected.zip'), {
  arrayBuffer: async () => new TextEncoder().encode('zip').buffer,
}) })

it('reads only on gesture and uses the exact details-issued directory edit after a later list refresh', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  expect(f.installed).not.toHaveBeenCalled()
  await api.installed(signal())
  const edit = await api.details(f.entry.skillId, signal())
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
    actions: { update: false, uninstall: false, download: false } }, version: directoryVersion('details'), files: [] } })
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
