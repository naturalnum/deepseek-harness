// @vitest-environment jsdom
/** Exact-version generated file reads; scripted replies do not establish real storage or Web acceptance. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { managedSkillCallbacks, type ManagedSkillRemote } from '../src/client/managed-skill-remote.ts'
import { remoteFixture } from './fixtures/managed-remote.client.ts'

const signal = (): AbortSignal => new AbortController().signal

it('reads a selected file only on request and uses the opened immutable content identity', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  await api.installed(signal())
  const detail = await api.details(f.entry.skillId, signal())
  expect(f.readFile).not.toHaveBeenCalled()
  expect(await detail.readFile?.('SKILL.md', signal())).toEqual({ kind: 'text', text: 'instructions' })
  expect(f.readFile).toHaveBeenCalledExactlyOnceWith({ skillId: f.entry.skillId,
    contentVersion: f.entry.contentVersion, relativePath: 'SKILL.md' }, expect.any(AbortSignal))
  expect(await detail.readFile?.('references/data.bin', signal())).toEqual({ kind: 'binary' })
  await expect(detail.readFile?.('../other/SKILL.md', signal())).rejects.toThrow()
  expect(f.readFile).toHaveBeenCalledTimes(2)
  expect(f.download).not.toHaveBeenCalled()
})

it('closes file reads when the original entry cannot be downloaded', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  const answer = await f.details({ skillId: f.entry.skillId }, signal())
  if (!answer.ok) throw new Error('Expected fixture detail')
  f.details.mockResolvedValueOnce({ ok: true, value: { ...answer.value,
    entry: { ...f.entry, actions: { ...f.entry.actions, download: false } } } })
  await api.installed(signal())
  expect((await api.details(f.entry.skillId, signal())).readFile).toBeUndefined()
})

it.each(['version', 'path', 'length', 'hash', 'budget'] as const)('refuses a mismatched %s without another request', async (field) => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  await api.installed(signal())
  const detail = await api.details(f.entry.skillId, signal())
  const response = await f.readFile({ skillId: f.entry.skillId, contentVersion: f.entry.contentVersion, relativePath: 'SKILL.md' }, signal())
  if (!response.ok) throw new Error('Expected fixture file')
  f.readFile.mockClear()
  f.readFile.mockResolvedValueOnce({ ok: true, value: { ...response.value,
    ...field === 'version' ? { contentVersion: brandString<typeof f.entry.contentVersion>('stale-version') } : {},
    ...field === 'path' ? { relativePath: 'another.py' } : {},
    ...field === 'length' ? { dataBase64: 'YQ==' } : {},
    ...field === 'hash' ? { sha256: '0'.repeat(64) } : {},
    ...field === 'budget' ? { dataBase64: 'A'.repeat(32768) } : {} } })
  await expect(detail.readFile?.('SKILL.md', signal())).rejects.toThrow()
  expect(f.readFile).toHaveBeenCalledTimes(1)
})

it('discards a late file read after revocation without displaying it', async () => {
  const f = remoteFixture(), api = managedSkillCallbacks(f.remote, f.input)
  await api.installed(signal())
  const detail = await api.details(f.entry.skillId, signal())
  const response = await f.readFile({ skillId: f.entry.skillId, contentVersion: f.entry.contentVersion, relativePath: 'SKILL.md' }, signal())
  const held = Promise.withResolvers<Awaited<ReturnType<ManagedSkillRemote['readFile']>>>()
  f.readFile.mockReturnValueOnce(held.promise)
  const pending = detail.readFile?.('SKILL.md', signal()), rejected = expect(pending).rejects.toThrow()
  f.revoke(); held.resolve(response)
  await rejected
})
