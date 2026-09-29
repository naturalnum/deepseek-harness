import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import type { PersonalSkill, SkillPort } from '../src/client/skills-api.ts'
import { SkillHttpError } from '../src/client/skills-api.ts'
import { SkillMarkdown } from '../src/client/SkillMarkdown.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const id = '5a010346-693c-4204-a386-29f66b11a057'
const item: PersonalSkill = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1 }
const t = (key: keyof typeof en) => en[key]

function fixture(client: SkillPort) {
  return render(<SkillsPage {...({ client, t } as SkillsPageProps)} />)
}

test('personal cards search, read instructions, and change enabled state', async () => {
  const client: SkillPort = {
    list: vi.fn(async () => [item]),
    read: vi.fn(async () => ({ ...item, instructions: '# Instructions\nCheck wording.' })),
    install: vi.fn(),
    toggle: vi.fn(async () => ({ ...item, enabled: false, revision: 2 })),
  }
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
  const client: SkillPort = { list: vi.fn(async () => []), read: vi.fn(), install, toggle: vi.fn() }
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
  fixture({ list: async () => [item], read, install: vi.fn(), toggle: vi.fn() })
  fireEvent.click(await screen.findByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByText('This skill is unavailable to your account. Refresh the list.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
  await within(dialog).findByText('Read only')
})

test('list failure shows a retry path without presenting an empty library', async () => {
  const list = vi.fn().mockRejectedValueOnce(new SkillHttpError(401)).mockResolvedValueOnce([item])
  fixture({ list, read: vi.fn(), install: vi.fn(), toggle: vi.fn() })
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
