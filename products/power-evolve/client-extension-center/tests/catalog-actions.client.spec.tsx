// @vitest-environment jsdom
/** Native catalog gestures with explicit public skill-port replies. */
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import type { PersonalSkill, SkillPort } from '../src/client/skills-api.ts'
import { en } from '../src/client/locales.ts'
import { builtinWord } from './builtin-catalog-fixture.ts'
import { deferredResult } from './deferred-result.ts'

afterEach(cleanup)
const skill: PersonalSkill = { skillId: '00000000-0000-4000-8000-000000000201', name: 'Personal report',
  description: 'A personal report helper', enabled: true, revision: 1, kind: 'text', version: null,
  digest: 'a'.repeat(64), packageDigest: null, manifestDigest: null, observedState: 'ready' }
const t = (key: keyof typeof en) => en[key]

function makePort(overrides: Partial<SkillPort> = {}): SkillPort {
  return { list: async () => [skill], catalog: async () => [], read: async () => ({ ...skill, instructions: 'Public instructions' }),
    install: vi.fn(), installBuiltin: vi.fn(), importPackage: vi.fn(), toggle: vi.fn(), revoke: vi.fn(), ...overrides }
}
function page(client: SkillPort) {
  return render(<SkillsPage client={client} t={t} trySkill={vi.fn()}
    usePanelInfo={selector => selector({ activePanelId: null })} />)
}

test.each([
  ['Office automation', 'skillCategoryWritingOffice'], ['Data analytics', 'skillCategoryDataAnalysis'],
  ['Knowledge reading', 'skillCategoryResearchKnowledge'], ['Web development', 'skillCategoryDevelopmentTools'],
  ['Music production', 'skillCategoryOther'],
] as const)('new catalog entries remain discoverable through their %s category', async (category, label) => {
  const entry = { ...builtinWord, id: 'catalog.new-entry', name: 'New catalog entry', category, installedSkillId: null }
  page(makePort({ list: async () => [], catalog: async () => [entry] }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  await screen.findByRole('button', { name: entry.name })
  fireEvent.click(screen.getByRole('button', { name: en[label] }))
  expect(screen.getByRole('button', { name: entry.name })).toBeTruthy()
  expect(screen.getByRole('button', { name: en[label] }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing entry' } })
  expect(screen.queryByRole('button', { name: entry.name })).toBeNull()
  expect(screen.getByText(en.searchEmpty)).toBeTruthy()
})

test('personal card details can be opened and dismissed through the native modal control', async () => {
  page(makePort())
  await screen.findByRole('button', { name: skill.name })
  fireEvent.click(screen.getByRole('button', { name: en.viewDetails }))
  const dialog = await screen.findByRole('dialog', { name: skill.name })
  await within(dialog).findByText('Public instructions')
  fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('installed catalog details open the matching personal skill without reinstalling it', async () => {
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>()
  page(makePort({ catalog: async () => [{ ...builtinWord, installedSkillId: skill.skillId }], installBuiltin }))
  await screen.findByRole('button', { name: skill.name })
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  await screen.findByRole('button', { name: builtinWord.name })
  fireEvent.click(screen.getByRole('button', { name: en.viewDetails }))
  const catalog = await screen.findByRole('dialog', { name: builtinWord.name })
  fireEvent.click(within(catalog).getByRole('button', { name: en.viewDetails }))
  const personal = await screen.findByRole('dialog', { name: skill.name })
  await within(personal).findByText('Public instructions')
  expect(installBuiltin).not.toHaveBeenCalled()
  fireEvent.click(within(personal).getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('installed catalog metadata without a personal record cannot expose another account detail', async () => {
  const read = vi.fn<SkillPort['read']>()
  page(makePort({ list: async () => [], catalog: async () => [{ ...builtinWord, installedSkillId: skill.skillId }], read }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
  const dialog = await screen.findByRole('dialog', { name: builtinWord.name })
  expect(within(dialog).getByText(en.builtinInstalled)).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: en.viewDetails })).toBeNull()
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('two native catalog install gestures before React commits reserve one request', async () => {
  const result = deferredResult<PersonalSkill>()
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>(() => result.promise)
  page(makePort({ list: async () => [], catalog: async () => [builtinWord], installBuiltin }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
  const dialog = await screen.findByRole('dialog', { name: builtinWord.name })
  const button = within(dialog).getByRole('button', { name: en.builtinInstall })
  act(() => { button.click(); button.click() })
  expect(installBuiltin).toHaveBeenCalledOnce()
  expect(button).toHaveProperty('disabled', true)
  await act(async () => { result.resolve(skill) })
  await screen.findByRole('dialog', { name: skill.name })
})

test('an uncertain catalog install blocks a different entry until the original outcome is resolved', async () => {
  const second = { ...builtinWord, id: 'catalog.second', name: 'Second entry' }
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>().mockRejectedValueOnce(new Error('reply lost'))
  page(makePort({ list: async () => [], catalog: async () => [builtinWord, second], installBuiltin }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  const firstCard = (await screen.findByRole('button', { name: builtinWord.name })).closest('article')
  if (!firstCard) throw new Error('Missing first native catalog card')
  fireEvent.click(within(firstCard).getByRole('button', { name: en.builtinInstall }))
  await screen.findByText(en.builtinInstallUncertain)
  fireEvent.click(screen.getByRole('button', { name: second.name }))
  const dialog = await screen.findByRole('dialog', { name: second.name })
  const blocked = within(dialog).getByRole('button', { name: en.builtinInstall })
  expect(blocked).toHaveProperty('disabled', true)
  fireEvent.click(blocked)
  expect(installBuiltin).toHaveBeenCalledOnce()
})

test('toggling a personal card retains the other account-owned cards', async () => {
  const other = { ...skill, skillId: '00000000-0000-4000-8000-000000000202', name: 'Other report' }
  const toggle = vi.fn<SkillPort['toggle']>(async () => ({ ...skill, enabled: false, revision: 2 }))
  page(makePort({ list: async () => [skill, other], toggle }))
  const card = (await screen.findByRole('button', { name: skill.name })).closest('article')
  if (!card) throw new Error('Missing personal native card')
  fireEvent.click(within(card).getByRole('switch'))
  await waitFor(() => { expect(within(card).getByRole('switch').getAttribute('aria-checked')).toBe('false') })
  const remaining = screen.getByRole('button', { name: other.name }).closest('article')
  if (!remaining) throw new Error('Missing unchanged native card')
  expect(within(remaining).getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

test('queued native toggle gestures share a pending mutation', async () => {
  const result = deferredResult<PersonalSkill>(), toggle = vi.fn<SkillPort['toggle']>(() => result.promise)
  page(makePort({ toggle }))
  await screen.findByRole('button', { name: skill.name })
  const button = screen.getByRole('switch')
  act(() => { button.click(); button.click() })
  expect(toggle).toHaveBeenCalledOnce()
  await act(async () => { result.resolve({ ...skill, enabled: false, revision: 2 }) })
  expect(button.getAttribute('aria-checked')).toBe('false')
})

test('queued revoke confirmations share one mutation and preserve unrelated cards', async () => {
  const result = deferredResult<PersonalSkill>(), revoke = vi.fn<SkillPort['revoke']>(() => result.promise)
  const other = { ...skill, skillId: '00000000-0000-4000-8000-000000000203', name: 'Unchanged report' }
  page(makePort({ list: async () => [skill, other], revoke }))
  fireEvent.click(await screen.findByRole('button', { name: skill.name }))
  const dialog = await screen.findByRole('dialog', { name: skill.name })
  await within(dialog).findByText('Public instructions')
  fireEvent.click(within(dialog).getByRole('button', { name: en.revokeSkill }))
  const button = within(dialog).getByRole('button', { name: en.confirmRevoke })
  act(() => { button.click(); button.click() })
  expect(revoke).toHaveBeenCalledOnce()
  await act(async () => { result.resolve({ ...skill, enabled: false, observedState: 'revoked', revision: 2 }) })
  expect(screen.getByRole('button', { name: other.name })).toBeTruthy()
  expect(within(dialog).getByRole('switch')).toHaveProperty('disabled', true)
})

test('successful text installation sorts the new skill with the retained personal library', async () => {
  const old = { ...skill, name: 'Zulu report' }
  const other = { ...skill, skillId: '00000000-0000-4000-8000-000000000204', name: 'Other report' }
  const installed = { ...skill, skillId: '00000000-0000-4000-8000-000000000205', name: 'Alpha report' }
  const install = vi.fn<SkillPort['install']>(async () => installed)
  const root = page(makePort({ list: async () => [old, other], install }))
  await screen.findByRole('button', { name: old.name })
  fireEvent.click(screen.getByRole('button', { name: en.installSkill }))
  const dialog = screen.getByRole('dialog', { name: en.installTitle })
  fireEvent.change(within(dialog).getByLabelText(en.name), { target: { value: installed.name } })
  fireEvent.change(within(dialog).getByLabelText(en.description), { target: { value: 'A public description' } })
  fireEvent.change(within(dialog).getByLabelText(en.instructions), { target: { value: 'Public instructions' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.installSkill }))
  await screen.findByRole('button', { name: installed.name })
  expect(Array.from(root.container.querySelectorAll('.pext-extension-title'), button => button.textContent))
    .toEqual(['Alpha report', 'Other report', 'Zulu report'])
  expect(screen.queryByRole('dialog')).toBeNull()
})

test.each(['install', 'import'] as const)('the page withdraws its %s dialog after native close', async (action) => {
  page(makePort())
  await screen.findByRole('button', { name: skill.name })
  fireEvent.click(screen.getByRole('button', { name: action === 'install' ? en.installSkill : en.importSkillPackage }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
