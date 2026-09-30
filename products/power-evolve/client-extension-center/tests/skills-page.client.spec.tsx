import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import type { BuiltinSkill, PersonalSkill, SkillPort } from '../src/client/skills-api.ts'
import { SkillHttpError } from '../src/client/skills-api.ts'
import { SkillMarkdown } from '../src/client/SkillMarkdown.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const id = '5a010346-693c-4204-a386-29f66b11a057'
const item: PersonalSkill = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1,
  kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null, manifestDigest: null, observedState: 'ready' }
const t = (key: keyof typeof en) => en[key]
const catalog = Array.from({ length: 9 }, (_, index): BuiltinSkill => ({
  id: index === 0 ? 'builtin.word' : `builtin.example-${index}`,
  name: index === 0 ? 'word' : `Skill ${index}`, summary: `Summary ${index}`,
  description: `Description ${index}`, category: index === 0 ? 'office' : 'other',
  publisher: 'PowerEvolve', version: '1.0.0', manifestDigest: `sha256:${'b'.repeat(64)}`,
  archiveDigest: 'c'.repeat(64), archiveSize: 100, installedSkillId: null,
}))

function port(overrides: Partial<SkillPort> = {}): SkillPort {
  return { list: vi.fn(async () => []), catalog: vi.fn(async () => catalog), read: vi.fn(),
    install: vi.fn(), installBuiltin: vi.fn(), importPackage: vi.fn(), toggle: vi.fn(), revoke: vi.fn(),
    ...overrides }
}

function fixture(client: SkillPort) {
  return render(<SkillsPage {...({ client, t, trySkill: vi.fn() } as SkillsPageProps)} />)
}

test('personal cards search, read instructions, and change enabled state', async () => {
  const client = port({
    list: vi.fn(async () => [item]),
    read: vi.fn(async () => ({ ...item, instructions: '# Instructions\nCheck wording.' })),
    install: vi.fn(),
    importPackage: vi.fn(),
    toggle: vi.fn(async () => ({ ...item, enabled: false, revision: 2 })),
    revoke: vi.fn(),
  })
  fixture(client)
  await screen.findByRole('button', { name: 'Proofreading' })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByText('No matching skills')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'proof' } })
  fireEvent.click(screen.getByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByRole('heading', { name: 'Instructions' })
  fireEvent.click(within(dialog).getByRole('switch'))
  await waitFor(() => expect(client.toggle).toHaveBeenCalledWith(id, false))
  await waitFor(() => expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).toBe('false'))
})

test('uncertain install retries the same request and body', async () => {
  const install = vi.fn().mockRejectedValueOnce(new Error('connection lost'))
    .mockImplementationOnce(async (input: { requestId: string }) => ({ ...item, skillId: input.requestId }))
  const client = port({ list: vi.fn(async () => []), install })
  fixture(client)
  await screen.findByText('No skills are installed for this account')
  fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
  const dialog = screen.getByRole('dialog', { name: 'Install text skill' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Proofreading' } })
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Check wording' } })
  fireEvent.change(within(dialog).getByLabelText('Skill instructions'), { target: { value: 'Check wording.' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install skill' }))
  await within(dialog).findByText('The installation result is uncertain. Retry will use the same request ID.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  expect(install.mock.calls[0]![0]).toEqual(install.mock.calls[1]![0])
  await screen.findByRole('button', { name: 'Proofreading' })
})

test('missing skill detail reports denial and supports a retry', async () => {
  const read = vi.fn().mockRejectedValueOnce(new SkillHttpError(404))
    .mockResolvedValueOnce({ ...item, instructions: 'Read only' })
  fixture(port({ list: async () => [item], read }))
  fireEvent.click(await screen.findByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByText('This skill is unavailable to your account. Refresh the list.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
  await within(dialog).findByText('Read only')
})

test('list failure shows a retry path without presenting an empty library', async () => {
  const list = vi.fn().mockRejectedValueOnce(new SkillHttpError(401)).mockResolvedValueOnce([item])
  fixture(port({ list }))
  await screen.findByText('Your sign-in expired. Please sign in again.')
  expect(screen.queryByText('No skills are installed for this account')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
  await screen.findByRole('button', { name: 'Proofreading' })
})

test('instructions are rendered as text and never injected as HTML', () => {
  const view = render(<SkillMarkdown document={'# Instructions\n<script>window.stolen = true</script>'} />)
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.textContent).toContain('<script>window.stolen = true</script>')
})

test('package import retries the same file and request, then shows version and ready status', async () => {
  const packaged: PersonalSkill = { ...item, kind: 'package', version: '1.2.3',
    packageDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) }
  let listed = false
  const importPackage = vi.fn().mockRejectedValueOnce(new Error('upload response lost'))
    .mockImplementationOnce(async () => { listed = true; return packaged })
  const client = port({ list: vi.fn(async () => listed ? [packaged] : []), importPackage })
  fixture(client)
  fireEvent.click(screen.getByRole('button', { name: 'Import skill package' }))
  const dialog = screen.getByRole('dialog', { name: 'Import ZIP skill package' })
  const file = new File(['ZIP bytes'], 'proofreading.zip', { type: 'application/zip' })
  fireEvent.change(within(dialog).getByLabelText('Skill package file'), { target: { files: [file] } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Import package' }))
  await within(dialog).findByText('The import result is uncertain. Retry uses the same file and request ID.')
  expect((within(dialog).getByLabelText('Skill package file') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => expect(importPackage).toHaveBeenCalledTimes(2))
  expect(importPackage.mock.calls[0]![0]).toBe(file)
  expect(importPackage.mock.calls[0]![1]).toBe(importPackage.mock.calls[1]![1])
  await screen.findByText('Version 1.2.3 · Ready')
})

test('package trial opens the native draft and revoke disables later trials', async () => {
  const packaged: PersonalSkill = { ...item, kind: 'package', version: '1.2.3',
    packageDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) }
  const trySkill = vi.fn(async () => {})
  const revoke = vi.fn(async () => ({ ...packaged, enabled: false, observedState: 'revoked' as const, revision: 2 }))
  const client = port({ list: vi.fn(async () => [packaged]),
    read: vi.fn(async () => ({ ...packaged, instructions: '# Instructions' })),
    revoke })
  render(<SkillsPage {...({ client, t, trySkill } as SkillsPageProps)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByText('Package SHA-256: ' + 'b'.repeat(64))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Try skill' }))
  await waitFor(() => expect(trySkill).toHaveBeenCalledWith(packaged))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke skill' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm revoke' }))
  await waitFor(() => expect(revoke).toHaveBeenCalledWith(id))
  await within(dialog).findByText('Revoked')
  expect((within(dialog).getByRole('button', { name: 'Try skill' }) as HTMLButtonElement).disabled).toBe(true)
})

test('all skills filters the nine-item catalog and previews metadata without a Sandbox', async () => {
  const client = port()
  fixture(client)
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByRole('button', { name: 'word' })
  expect(client.catalog).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Writing & office' }))
  expect(screen.getByRole('button', { name: 'word' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Skill 1' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'word' }))
  const dialog = screen.getByRole('dialog', { name: 'word' })
  expect(within(dialog).getByText('Description 0')).toBeTruthy()
  expect(within(dialog).getByText(/without starting a Sandbox/u)).toBeTruthy()
  expect(client.read).not.toHaveBeenCalled()
})

test('catalog failure stays visible and refresh retries without sample data', async () => {
  const catalogCall = vi.fn().mockRejectedValueOnce(new SkillHttpError(503)).mockResolvedValueOnce(catalog)
  fixture(port({ catalog: catalogCall }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByText('Could not load the built-in skill catalog. Please retry.')
  expect(screen.queryByRole('button', { name: 'word' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
  await screen.findByRole('button', { name: 'word' })
  expect(catalogCall).toHaveBeenCalledTimes(2)
})

test('uncertain built-in install reuses request ID and updates My skills after success', async () => {
  const packaged: PersonalSkill = { ...item, name: 'word', kind: 'package', version: '1.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64) }
  const installBuiltin = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(packaged)
  const client = port({ installBuiltin, read: vi.fn(async () => ({ ...packaged, instructions: '# word instructions' })) })
  fixture(client)
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByRole('button', { name: 'word' })
  fireEvent.click(screen.getAllByRole('button', { name: 'Install built-in skill' })[0]!)
  await screen.findByText('The installation result is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => expect(installBuiltin).toHaveBeenCalledTimes(2))
  expect(installBuiltin.mock.calls[0]![0]).toEqual(installBuiltin.mock.calls[1]![0])
  expect(installBuiltin.mock.calls[0]![0]).toMatchObject({ catalogId: 'builtin.word', version: '1.0.0' })
  await waitFor(() => expect(screen.getByRole('tab', { name: /My skills/u }).getAttribute('aria-selected')).toBe('true'))
  expect(screen.getByRole('button', { name: 'word' })).toBeTruthy()
  await within(screen.getByRole('dialog', { name: 'word' })).findByText('word instructions')
})

test('revoked catalog installation cannot be directly reenabled', async () => {
  const revoked: PersonalSkill = { ...item, name: 'word', kind: 'package', version: '1.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64), enabled: false, observedState: 'revoked' }
  fixture(port({ list: async () => [revoked], catalog: async () => [{ ...catalog[0]!, installedSkillId: id }, ...catalog.slice(1)] }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  const card = (await screen.findByRole('button', { name: 'word' })).closest('article')!
  expect(within(card).getByText('Revoked')).toBeTruthy()
  expect(within(card).queryByRole('switch')).toBeNull()
  expect(within(card).queryByRole('button', { name: 'Install built-in skill' })).toBeNull()
})

test('disabled catalog installation uses the personal state and can be enabled', async () => {
  const disabled: PersonalSkill = { ...item, name: 'word', kind: 'package', version: '1.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64), enabled: false }
  const toggle = vi.fn(async () => ({ ...disabled, enabled: true, revision: 2 }))
  fixture(port({ list: async () => [disabled], catalog: async () => [{ ...catalog[0]!, installedSkillId: id }, ...catalog.slice(1)], toggle }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  const card = (await screen.findByRole('button', { name: 'word' })).closest('article')!
  expect(within(card).getByText('Disabled')).toBeTruthy()
  fireEvent.click(within(card).getByRole('switch'))
  await waitFor(() => expect(toggle).toHaveBeenCalledWith(id, true))
  await within(card).findByText('Enabled')
})

test('catalog waits for the personal list to finish preinstalling', async () => {
  const packaged: PersonalSkill = { ...item, name: 'word', kind: 'package', version: '1.0.0',
    packageDigest: 'c'.repeat(64), manifestDigest: 'b'.repeat(64) }
  let finishPreinstall!: () => void
  let preinstalled = false
  const list = vi.fn(() => new Promise<readonly PersonalSkill[]>(resolve => {
    finishPreinstall = () => { preinstalled = true; resolve([packaged]) }
  }))
  const catalogCall = vi.fn(async () => [{ ...catalog[0]!, installedSkillId: preinstalled ? id : null }, ...catalog.slice(1)])
  fixture(port({ list, catalog: catalogCall }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  expect(catalogCall).not.toHaveBeenCalled()
  await act(async () => { finishPreinstall() })
  const card = (await screen.findByRole('button', { name: 'word' })).closest('article')!
  expect(catalogCall).toHaveBeenCalledTimes(1)
  expect(within(card).getByText('Enabled')).toBeTruthy()
  expect(within(card).queryByRole('button', { name: 'Install built-in skill' })).toBeNull()
})

test('unmount aborts a pending personal read before starting the catalog', async () => {
  let listSignal: AbortSignal | undefined
  const catalogCall = vi.fn(async () => catalog)
  const client = port({
    list: (signal?: AbortSignal) => { listSignal = signal; return new Promise(() => {}) },
    catalog: catalogCall,
  })
  const page = fixture(client)
  expect(listSignal?.aborted).toBe(false)
  expect(catalogCall).not.toHaveBeenCalled()
  page.unmount()
  expect(listSignal?.aborted).toBe(true)
  expect(catalogCall).not.toHaveBeenCalled()
})

test('unmount aborts the catalog once the personal list has settled', async () => {
  let catalogSignal: AbortSignal | undefined
  const catalogCall = vi.fn((signal?: AbortSignal): Promise<readonly BuiltinSkill[]> => {
    catalogSignal = signal; return new Promise(() => {})
  })
  const page = fixture(port({ catalog: catalogCall }))
  await waitFor(() => expect(catalogCall).toHaveBeenCalledTimes(1))
  expect(catalogSignal?.aborted).toBe(false)
  page.unmount()
  expect(catalogSignal?.aborted).toBe(true)
})

test('changing the injected client aborts reads from the prior account', async () => {
  let oldList: AbortSignal | undefined
  let resolveOld!: (items: readonly PersonalSkill[]) => void
  const oldCatalog = vi.fn(async () => catalog)
  const prior = port({
    list: (signal?: AbortSignal) => { oldList = signal; return new Promise<readonly PersonalSkill[]>(resolve => { resolveOld = resolve }) },
    catalog: oldCatalog,
  })
  const next = port()
  const page = fixture(prior)
  page.rerender(<SkillsPage {...({ client: next, t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(oldList?.aborted).toBe(true)
  await act(async () => { resolveOld([item]) })
  expect(oldCatalog).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Proofreading' })).toBeNull()
  await screen.findByText('No skills are installed for this account')
})

test('changing accounts immediately hides the prior personal library', async () => {
  const prior = port({ list: async () => [item] })
  const next = port({ list: () => new Promise(() => {}), catalog: () => new Promise(() => {}) })
  const page = fixture(prior)
  await screen.findByRole('button', { name: 'Proofreading' })
  page.rerender(<SkillsPage {...({ client: next, t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(screen.queryByRole('button', { name: 'Proofreading' })).toBeNull()
  expect(screen.getByText('Loading skills…')).toBeTruthy()
})

test('changing accounts aborts a catalog read already in progress', async () => {
  let priorCatalogSignal: AbortSignal | undefined
  const priorCatalog = vi.fn((signal?: AbortSignal): Promise<readonly BuiltinSkill[]> => {
    priorCatalogSignal = signal; return new Promise(() => {})
  })
  const page = fixture(port({ catalog: priorCatalog }))
  await waitFor(() => expect(priorCatalog).toHaveBeenCalledTimes(1))
  page.rerender(<SkillsPage {...({ client: port(), t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(priorCatalogSignal?.aborted).toBe(true)
})
