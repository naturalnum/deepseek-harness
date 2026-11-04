// @vitest-environment jsdom
/** Original details snapshots and account observers, without a live account or replacement file service. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as sha from 'fast-sha256'
import { brandString } from '@deepseek-ai/dsh-brand'
import { managedSkillCallbacks } from '../src/client/managed-skill-remote.ts'
import { remoteFixture, directoryVersion } from './fixtures/managed-remote.client.ts'
import { managedFixture } from './fixtures/managed-skills.client.ts'

const original = readFileSync(resolve(import.meta.dirname, '../../../skill/skill-office/assets/reports/tech-report-writer/SKILL.md'), 'utf8')
const signal = (): AbortSignal => new AbortController().signal
const metadata = (relativePath: string, text: string) => ({ relativePath, bytes: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex') })
afterEach(() => { vi.restoreAllMocks() })
function fixture(markdown = original) {
  const f = remoteFixture(), entry = { ...f.entry, source: 'bundled', mutable: false, provider: 'dsh-reports',
    actions: { update: false, uninstall: false, download: false } }
  const files = [metadata('SKILL.md', markdown), metadata('references/small.txt', 'small'),
    metadata('references/large.txt', 'x'.repeat(8193)), metadata('nested/SKILL.md', original)]
  const state = { ...f.state, entries: [entry], limits: { ...f.state.limits, maxFileBytes: 8192, maxReplyBytes: 131072 } }
  const value = { entry, files, markdown, version: directoryVersion('opened-root') }
  f.installed.mockResolvedValue({ ok: true, value: state }); f.details.mockResolvedValue({ ok: true, value })
  f.readFile.mockImplementation(async (request) => {
    const file = files.find(file => file.relativePath === request.relativePath)
    if (file === undefined) throw Error('Unexpected member')
    return { ok: true, value: { ...request, bytes: file.bytes, sha256: file.sha256,
      dataBase64: Buffer.from(request.relativePath === 'SKILL.md' ? markdown : 'small').toString('base64') } }
  })
  return { ...f, entry, files, state, value, api: managedSkillCallbacks(f.remote, f.input) }
}
async function opened(f: ReturnType<typeof fixture>) {
  await f.api.installed(signal())
  return f.api.details(f.entry.skillId, signal())
}
function editing(f: ReturnType<typeof fixture>) {
  const page = managedFixture()
  page.installed.mockImplementation(f.api.installed); page.details.mockImplementation(f.api.details)
  return page
}

it('reuses the original18428-byte immutable root details under the unchanged8192-byte member limit', async () => {
  const f = fixture(), detail = await opened(f)
  expect(Buffer.byteLength(original)).toBe(18428)
  expect(f.state.limits.maxFileBytes).toBe(8192)
  expect(await detail.readFile?.('SKILL.md', signal())).toEqual({ kind: 'text', text: original })
  expect(f.readFile).not.toHaveBeenCalled()
})
it.each(['references/large.txt', 'nested/SKILL.md', '../SKILL.md', 'SKILL.MD'])('does not reuse root text for %s', async (path) => {
  const f = fixture(), detail = await opened(f)
  await expect(detail.readFile?.(path, signal())).rejects.toThrow()
  expect(f.readFile).not.toHaveBeenCalled()
})
it('keeps small non-root members on the exact original RPC', async () => {
  const f = fixture(), detail = await opened(f)
  expect(await detail.readFile?.('references/small.txt', signal())).toEqual({ kind: 'text', text: 'small' })
  expect(f.readFile).toHaveBeenCalledExactlyOnceWith({ skillId: f.entry.skillId, contentVersion: f.entry.contentVersion,
    relativePath: 'references/small.txt' }, expect.any(AbortSignal))
})
it.each(['missing-root', 'wrong-bytes', 'wrong-hash'] as const)('rejects %s metadata without a root RPC fallback', async (kind) => {
  const f = fixture()
  const files = kind === 'missing-root' ? f.files.filter(file => file.relativePath !== 'SKILL.md')
    : f.files.map(file => file.relativePath !== 'SKILL.md' ? file : { ...file,
      ...kind === 'wrong-bytes' ? { bytes: file.bytes + 1 } : { sha256: '0'.repeat(64) } })
  f.details.mockResolvedValue({ ok: true, value: { ...f.value, files } })
  const detail = await opened(f)
  await expect(detail.readFile?.('SKILL.md', signal())).rejects.toThrow()
  expect(f.readFile).not.toHaveBeenCalled()
})
it('rejects a foreign detail id before exposing its root text', async () => {
  const f = fixture()
  f.details.mockResolvedValue({ ok: true, value: { ...f.value, entry: { ...f.entry, skillId: brandString<typeof f.entry.skillId>('foreign') } } })
  await expect(opened(f)).rejects.toThrow()
})
it('accepts fresh V2 details after an older V1 list without mixing their text or metadata', async () => {
  const f = fixture(), markdown = original + '\nV2\n'
  const entry = { ...f.entry, contentVersion: brandString<typeof f.entry.contentVersion>('content-v2') }
  f.details.mockResolvedValue({ ok: true, value: { ...f.value, entry, markdown,
    files: [metadata('SKILL.md', markdown)] } })
  const detail = await opened(f)
  expect(detail.item.contentId).toBe(entry.contentVersion)
  expect(await detail.readFile?.('SKILL.md', signal())).toEqual({ kind: 'text', text: markdown })
})
it('rejects wrong-version non-root RPC replies under the original member checks', async () => {
  const f = fixture(), detail = await opened(f)
  f.readFile.mockResolvedValueOnce({ ok: true, value: { skillId: f.entry.skillId,
    contentVersion: brandString<typeof f.entry.contentVersion>('wrong-version'), ...metadata('references/small.txt', 'small'), dataBase64: 'c21hbGw=' } })
  await expect(detail.readFile?.('references/small.txt', signal())).rejects.toThrow()
})
it.each(['meeting-notes', 'python-unittest', 'csv-summary', 'pdf'])('preserves the original mutable member limit for %s', async (name) => {
  const f = fixture(), entry = { ...f.entry, name, source: 'custom', mutable: true,
    actions: { update: true, uninstall: true, download: true } }
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, entries: [entry] } })
  f.details.mockResolvedValue({ ok: true, value: { ...f.value, entry } })
  const detail = await opened(f)
  await expect(detail.readFile?.('SKILL.md', signal())).rejects.toThrow()
  expect(f.readFile).not.toHaveBeenCalled()
  expect(detail.update).toBeTypeOf('function'); expect(detail.uninstall).toBeTypeOf('function')
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, entries: [entry], version: directoryVersion('later-list') } })
  await f.api.installed(signal())
  const file = Object.assign(new File(['zip'], 'original.zip'), { arrayBuffer: async () => new TextEncoder().encode('zip').buffer })
  await detail.update?.({ kind: 'zip', file }, signal())
  expect(f.update.mock.calls[0]?.[0].version).toEqual(f.value.version)
  await expect(detail.uninstall?.(signal())).rejects.toThrow()
})
it('does not reuse root text for a mutable bundled entry', async () => {
  const f = fixture(), entry = { ...f.entry, mutable: true }
  f.details.mockResolvedValue({ ok: true, value: { ...f.value, entry } })
  const detail = await opened(f)
  await expect(detail.readFile?.('SKILL.md', signal())).rejects.toThrow()
})
it('preserves NUL classification and rejects a non-roundtripping UTF8 string', async () => {
  const binary = fixture('text\u0000data'), invalid = fixture('\ud800')
  expect(await (await opened(binary)).readFile?.('SKILL.md', signal())).toEqual({ kind: 'binary' })
  await expect((await opened(invalid)).readFile?.('SKILL.md', signal())).rejects.toThrow()
})
it('rechecks original scope after hashing before returning local text', async () => {
  const f = fixture(), detail = await opened(f), hash = sha.hash
  vi.spyOn(sha, 'hash').mockImplementationOnce((bytes) => { const digest = hash(bytes); f.revoke(); return digest })
  await expect(detail.readFile?.('SKILL.md', signal())).rejects.toThrow()
})
it('rejects an aborted local root observation before hashing', async () => {
  const f = fixture(), detail = await opened(f), observer = new AbortController(), hash = vi.spyOn(sha, 'hash')
  observer.abort()
  await expect(detail.readFile?.('SKILL.md', observer.signal)).rejects.toThrow()
  expect(hash).not.toHaveBeenCalled()
})
it.each(['replaced', 'removed'] as const)('revokes an opened immutable root when refresh observes it %s', async (kind) => {
  const f = fixture(), page = editing(f), verified = Promise.withResolvers<undefined>(), held = Promise.withResolvers<undefined>()
  onTestFinished(() => { held.resolve(undefined) })
  page.details.mockImplementation(async (id, observer) => {
    const detail = await f.api.details(id, observer), read = detail.readFile
    if (read === undefined) throw Error('Missing original reader')
    return { ...detail, readFile: async (path, signal) => {
      const content = await read(path, signal)
      verified.resolve(undefined); await held.promise
      return content
    } }
  })
  await page.editor().refresh(signal()); await page.editor().open(f.entry.skillId, signal())
  const detail = page.editor().detail, editNumber = page.editor().editNumber
  const pending = detail?.readFile?.('SKILL.md', signal()).then(() => true, () => false)
  await verified.promise
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, entries: kind === 'removed' ? []
    : [{ ...f.entry, contentVersion: brandString<typeof f.entry.contentVersion>('new-content') }] } })
  await page.editor().refresh(signal())
  expect(page.editor().selection).toBeUndefined(); expect(page.editor().detail).toBeUndefined()
  expect(page.editor().editNumber).toBeGreaterThan(editNumber)
  held.resolve(undefined)
  expect(await pending).toBe(false)
  await expect(detail?.readFile?.('SKILL.md', signal())).rejects.toThrow()
})
it('rejects a verified local result after close before its original editor publishes it', async () => {
  const f = fixture(), page = editing(f)
  await page.editor().refresh(signal()); await page.editor().open(f.entry.skillId, signal())
  const pending = page.editor().detail?.readFile?.('SKILL.md', signal())
  page.editor().close()
  await expect(pending).rejects.toThrow()
})
it('discards an old native details response after its original observer is revoked', async () => {
  const f = fixture(), held = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.details>>>(), observer = new AbortController()
  await f.api.installed(signal()); f.details.mockReturnValueOnce(held.promise)
  const pending = f.api.details(f.entry.skillId, observer.signal)
  observer.abort(); held.resolve({ ok: true, value: f.value })
  await expect(pending).rejects.toThrow()
})
it('keeps the same selected content snapshot during an unrelated directory edit-token refresh', async () => {
  const f = fixture(), page = editing(f)
  await page.editor().refresh(signal()); await page.editor().open(f.entry.skillId, signal())
  const detail = page.editor().detail, editNumber = page.editor().editNumber
  f.installed.mockResolvedValue({ ok: true, value: { ...f.state, version: directoryVersion('unrelated-edit') } })
  await page.editor().refresh(signal())
  expect(page.editor().editNumber).toBe(editNumber)
  expect(page.editor().detail).toBe(detail)
  expect(await detail?.readFile?.('SKILL.md', signal())).toEqual({ kind: 'text', text: original })
})
