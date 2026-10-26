/** Complete local-file encoding checks; archive parsing and stored-version integrity remain backend responsibilities. */
import { expect, it, vi } from 'vitest'
import { encodeManagedSkillBundle } from '../src/client/managed-skill-files.ts'
import { readSelectedSkillBundle } from '../src/client/management/skills/selected-bundle.ts'
import { selectionLimits } from './fixtures/managed-skills.client.ts'

const signal = (): AbortSignal => new AbortController().signal
async function selection() {
  const binary = new File([Uint8Array.of(0, 255, 1)], 'resource.bin')
  const result = await readSelectedSkillBundle([{ path: 'SKILL.md', file: new File(['original'], 'SKILL.md') },
    { path: 'references/resource.bin', file: binary }], selectionLimits, signal())
  if (!result.ok) throw new Error('invalid fixture selection')
  return { binary, selected: result.value }
}

it('uploads the complete selected tree with edited root text and byte-exact binary resources', async () => {
  const f = await selection(), read = vi.spyOn(f.binary, 'arrayBuffer')
  const result = await encodeManagedSkillBundle({ kind: 'files', selection: f.selected, markdown: 'edited 中文' }, selectionLimits, signal())
  expect(result).toEqual({ kind: 'files', files: [
    { relativePath: 'SKILL.md', dataBase64: Buffer.from('edited 中文').toString('base64') },
    { relativePath: 'references/resource.bin', dataBase64: 'AP8B' },
  ] })
  expect(read).toHaveBeenCalledTimes(1)
  expect(f.selected.markdown).toBe('original')
  expect(await f.selected.files[0]?.file.text()).toBe('original')
})

it('checks edited instruction and total content bytes before reading resource files', async () => {
  const f = await selection(), read = vi.spyOn(f.binary, 'arrayBuffer')
  await expect(encodeManagedSkillBundle({ kind: 'files', selection: f.selected, markdown: '中文' },
    { ...selectionLimits, maxFileBytes: 5 }, signal())).rejects.toThrow()
  await expect(encodeManagedSkillBundle({ kind: 'files', selection: f.selected, markdown: 'edited' },
    { ...selectionLimits, maxTotalBytes: 8 }, signal())).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
})

it('treats a ZIP as original bytes without extraction and refuses an over-limit archive before reading', async () => {
  const file = new File([Uint8Array.of(80, 75, 0, 255)], 'complete.skill'), read = vi.spyOn(file, 'arrayBuffer')
  expect(await encodeManagedSkillBundle({ kind: 'zip', file }, selectionLimits, signal())).toEqual({ kind: 'zip', dataBase64: 'UEsA/w==' })
  expect(read).toHaveBeenCalledTimes(1)
  await expect(encodeManagedSkillBundle({ kind: 'zip', file }, { ...selectionLimits, maxArchiveBytes: 3 }, signal())).rejects.toThrow()
  expect(read).toHaveBeenCalledTimes(1)
})

it('does not return a body from a resource read that settles after the original observer aborts', async () => {
  const f = await selection(), held = Promise.withResolvers<ArrayBuffer>(), parent = new AbortController()
  vi.spyOn(f.binary, 'arrayBuffer').mockReturnValueOnce(held.promise)
  const operation = encodeManagedSkillBundle({ kind: 'files', selection: f.selected, markdown: 'edited' }, selectionLimits, parent.signal)
  parent.abort(); held.resolve(Uint8Array.of(0, 255, 1).buffer)
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
})

it('counts parent directories and path depth in the file-picker limits without discarding nested resources', async () => {
  const root = { path: 'SKILL.md', file: new File(['instructions'], 'SKILL.md') }
  const nested = { path: 'a/b/data.bin', file: new File(['data'], 'data.bin') }
  expect(await readSelectedSkillBundle([root, nested], { ...selectionLimits, maxDirectories: 1 }, signal()))
    .toEqual({ ok: false, reason: 'entries' })
  expect(await readSelectedSkillBundle([root, nested], { ...selectionLimits, maxPathDepth: 2 }, signal()))
    .toEqual({ ok: false, reason: 'path' })
  expect(await readSelectedSkillBundle([root, nested], { ...selectionLimits, maxDirectories: 2, maxPathDepth: 3 }, signal()))
    .toMatchObject({ ok: true })
})
