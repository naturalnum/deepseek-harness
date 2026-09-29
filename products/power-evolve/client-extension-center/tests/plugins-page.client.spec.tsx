import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PluginsPageProps } from '../src/client/PluginsPage.tsx'
import { PluginsPage } from '../src/client/PluginsPage.tsx'
import type { NotesPlugin, PluginPort } from '../src/client/plugins-api.ts'
import type { FixedMcpPort } from '../src/client/mcp-api.ts'
import type { PersonalSshPort } from '../src/client/ssh-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const initial: NotesPlugin = { id: 'notes', title: '受控便签', category: 'tools', kind: 'builtin',
  enabled: true, revision: 1, requiresApproval: true }
const t = (key: keyof typeof en) => en[key]

const fixedMcp: FixedMcpPort = {
  list: async () => ({ available: false,
    preset: { toolName: 'mcp__personal__whoami', description: 'Fixed whoami' }, items: [] }),
  install: vi.fn(), toggle: vi.fn(), check: vi.fn(),
}
const fixedSsh: PersonalSshPort = { list: async () => ({ available: false, items: [] }),
  createPassword: vi.fn(), toggle: vi.fn() }

function page(plugins: PluginPort, getApproval = async () => 'http://127.0.0.1:19211/approval',
  mcp: FixedMcpPort = fixedMcp, ssh: PersonalSshPort = fixedSsh) {
  return render(<PluginsPage {...({ plugins, mcp, ssh, approvalUrl: getApproval, t } as PluginsPageProps)} />)
}

test('native Plugins page lists a real personal card and labels unavailable future entries', async () => {
  const list = vi.fn(async () => [initial])
  page({ list, setEnabled: vi.fn() })
  await screen.findByRole('button', { name: 'Controlled notes' })
  expect(screen.getByRole('tab', { name: 'My plugins1' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByText('MCP')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'All plugins' }))
  expect(screen.getByText('MCP')).toBeTruthy()
  expect(screen.getByText('SSH')).toBeTruthy()
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: 'MCP' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'server' } })
  expect(screen.getByText('SSH')).toBeTruthy()
  expect(screen.queryByText('MCP')).toBeNull()
})

test('available SSH opens the native personal server page', async () => {
  const ssh: PersonalSshPort = { ...fixedSsh, list: async () => ({ available: true, items: [] }) }
  page({ list: async () => [initial], setEnabled: vi.fn() }, undefined, fixedMcp, ssh)
  fireEvent.click(screen.getByRole('tab', { name: 'All plugins' }))
  fireEvent.click(await screen.findByRole('button', { name: 'SSH' }))
  expect(screen.getByRole('button', { name: 'Add server' }).getAttribute('disabled')).toBeNull()
})

test('notes detail links the trusted approval page and retries the same request ID', async () => {
  const setEnabled = vi.fn().mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce({ ...initial, enabled: false, revision: 2 })
  page({ list: async () => [initial], setEnabled })
  fireEvent.click(await screen.findByRole('button', { name: 'Controlled notes' }))
  const approval = await screen.findByRole('link', { name: 'Open approval page' })
  expect(approval.getAttribute('href')).toBe('http://127.0.0.1:19211/approval')
  expect(approval.getAttribute('rel')).toBe('noopener noreferrer')
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText('The result is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry this change' }))
  await waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(2))
  expect(setEnabled.mock.calls[0]![0]).toEqual(setEnabled.mock.calls[1]![0])
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
})

test('revision conflict asks for refresh instead of replaying an obsolete mutation', async () => {
  const list = vi.fn(async () => [initial])
  const setEnabled = vi.fn(async () => { throw new Error('placeholder') })
  const { PluginHttpError } = await import('../src/client/plugins-api.ts')
  setEnabled.mockImplementationOnce(async () => { throw new PluginHttpError(409) })
  page({ list, setEnabled })
  fireEvent.click(await screen.findByRole('button', { name: 'Controlled notes' }))
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText('Plugin state changed. Refresh and retry.')
  expect(screen.queryByRole('button', { name: 'Retry this change' })).toBeNull()
})

test('installed fixed MCP appears in native My plugins and opens its real connection page', async () => {
  const mcp: FixedMcpPort = { ...fixedMcp, list: async () => ({ available: true,
    preset: { toolName: 'mcp__personal__whoami', description: 'Operator endpoint' },
    items: [{ connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c', name: 'My whoami',
      enabled: true, revision: 1, toolName: 'mcp__personal__whoami', description: 'Read only identity' }] }) }
  page({ list: async () => [initial], setEnabled: vi.fn() }, undefined, mcp)
  const tab = await screen.findByRole('tab', { name: 'My plugins2' })
  expect(tab.getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'MCP' }))
  expect(screen.getByRole('button', { name: 'My whoami' })).toBeTruthy()
  expect(screen.getByText('Operator endpoint')).toBeTruthy()
})
