import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginsPage, type PluginsPageProps } from '../src/client/PluginsPage.tsx'
import { en } from '../src/client/locales.ts'
import type { FixedMcpPort } from '../src/client/mcp-api.ts'
import type { PersonalMcpConnection, PersonalMcpConnectionPort } from '../src/client/personal-mcp-client.ts'
import type { PersonalMcpSessionSource } from '../src/client/personal-mcp-session-view.ts'

afterEach(cleanup)

test('Remote MCP and fixed MCP keep separate installed cards and open their own connection pages', async () => {
  const item: PersonalMcpConnection = {
    connection_id: '00000000-0000-4000-8000-000000000001', revision: 1,
    display_name: 'Remote knowledge', server_name: 'mcp_remote', server_url: 'https://remote.example.test/mcp',
    authentication: { kind: 'none', secret_configured: false }, enabled: false, latest_check: null,
    created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z',
  }
  // Explicit Port substitutes exercise native card routing without a running backend.
  const remote: PersonalMcpConnectionPort = {
    list: vi.fn(async () => ({ available: true, items: [item] })),
    create: vi.fn(), update: vi.fn(), toggle: vi.fn(), remove: vi.fn(),
    createCheck: vi.fn(), getCheck: vi.fn(), cancelCheck: vi.fn(),
    createDraftCheck: vi.fn(), getDraftCheck: vi.fn(), cancelDraftCheck: vi.fn(),
  }
  const fixed: FixedMcpPort = { list: vi.fn(async () => ({ available: true,
    preset: { toolName: 'mcp__personal__whoami', description: 'Operator endpoint' },
    items: [{ connectionId: '00000000-0000-4000-8000-000000000002', name: 'Fixed identity',
      enabled: true, revision: 1, toolName: 'mcp__personal__whoami', description: 'Read only identity' }] })),
  install: vi.fn(), toggle: vi.fn(), check: vi.fn() }
  const snapshot = { ids: [], byId: {}, phase: 'ready' as const }
  const sessions: PersonalMcpSessionSource = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
  const props = {
    plugins: { list: async () => [], setEnabled: vi.fn() }, mcp: fixed, personalMcp: remote, mcpSessions: sessions,
    stdio: { list: async () => ({ available: false, items: [],
      preset: { toolName: 'mcp__stdio__whoami', description: 'Process identity' } }),
    install: vi.fn(), toggle: vi.fn(), calls: vi.fn(), status: vi.fn() },
    ssh: { list: async () => ({ available: false, items: [] }), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
      check: vi.fn(), callList: vi.fn(), callStatus: vi.fn(), callCancel: vi.fn() },
    approvalUrl: async () => 'https://platform.example.test/approval', t: (key: keyof typeof en) => en[key],
  } as PluginsPageProps
  const view = render(<PluginsPage {...props} />)
  await screen.findByRole('tab', { name: 'My plugins2' })
  expect(screen.getByRole('button', { name: 'MCP', exact: true })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remote MCP', exact: true }))
  await screen.findByRole('button', { name: 'View MCP connection Remote knowledge' })
  expect(view.container.querySelector('[data-power-evolve-plugin-detail="personal-mcp"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add connection' })).toHaveProperty('disabled', false)
  expect(screen.queryByText('Fixed identity')).toBeNull()
  expect(fixed.install).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.pluginsTitle, exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'MCP', exact: true }))
  expect(view.container.querySelector('[data-power-evolve-plugin-detail="mcp"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Fixed identity' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull()
  expect(screen.queryByText('Remote knowledge')).toBeNull()
  expect(remote.create).not.toHaveBeenCalled()
})
