import type {} from '../../../../packages/client/ui-plugin-manager/src/client/slot-contract.ts'
import type {} from '../src/client/index.ts'
// @vitest-environment jsdom
/** Actual native configuration composition with explicit account-scoped HTTP port substitutes. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DeferredConnectorConfiguration as ConnectorConfiguration,
  type DeferredConnectorConfigurationProps as ConnectorConfigurationProps } from '../src/client/DeferredConnectorConfiguration.tsx'
import type { PersonalMcpConnectionPort } from '../src/client/personal-mcp-client.ts'
import { SshHttpError, type PersonalSshConnection, type PersonalSshList, type PersonalSshPort } from '../src/client/ssh-api.ts'
import type { StdioV2Port } from '../src/client/stdio-v2-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const unexpected = async (): Promise<never> => { throw new Error('Unrequested connector mutation') }
const item: PersonalSshConnection = { connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c',
  displayName: 'Account server', host: 'server.example.com', port: 22, username: 'alice',
  hostKeySha256: 'SHA256:1234567890123456789012345678901234567890123', enabled: true, revision: 1,
  credentialRevision: 1, workingDirectory: null, authentication: 'password', secretConfigured: true,
  passphraseConfigured: false, deletedAt: null, createdAt: '2026-09-29T11:00:00Z', updatedAt: '2026-09-29T11:00:00Z' }
function ssh(overrides: Partial<PersonalSshPort> = {}): PersonalSshPort {
  return { list: async () => ({ available: true, items: [item] }), create: unexpected, update: unexpected,
    remove: unexpected, toggle: unexpected, check: unexpected, callList: async () => [],
    callStatus: unexpected, callCancel: unexpected, ...overrides }
}
function props(port: PersonalSshPort): ConnectorConfigurationProps {
  const personalMcp: PersonalMcpConnectionPort = { list: async () => ({ available: false, items: [] }), create: unexpected,
    update: unexpected, toggle: unexpected, remove: unexpected, createCheck: unexpected, getCheck: unexpected,
    cancelCheck: unexpected, createDraftCheck: unexpected, getDraftCheck: unexpected, cancelDraftCheck: unexpected }
  const stdioV2: StdioV2Port = { config: async () => ({ formatVersion: 2, available: false }), list: unexpected,
    create: unexpected, update: unexpected, toggle: unexpected, remove: unexpected, check: unexpected, receipt: unexpected,
    actions: unexpected, detail: unexpected, cancel: unexpected }
  return { view: 'page', usePanelInfo: selector => selector({ activePanelId: null }), ssh: port, personalMcp, stdioV2,
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
    approvalUrl: async () => 'https://platform.test/approval', t: (key: keyof typeof en) => en[key] }
}
const snapshot = { ids: [], byId: {}, current: undefined, phase: 'ready' as const }

it('retries a failed SSH metadata read while the other native sections remain available', async () => {
  const list = vi.fn<PersonalSshPort['list']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ available: true, items: [item] })
  const root = render(<ConnectorConfiguration {...props(ssh({ list }))} />)
  await screen.findByText(en.sshLoadFailed)
  expect(root.container.querySelector('[data-power-evolve-bundle-config]')).toBeTruthy()
  expect(screen.getByRole('heading', { name: en.personalMcpTitle, level: 3 })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(item.displayName)
  expect(screen.queryByText(en.sshLoadFailed)).toBeNull()
  expect(list).toHaveBeenCalledTimes(2)
})

it('commits an SSH metadata change and reloads after a revision conflict', async () => {
  const changed = { ...item, enabled: false, revision: 2 }
  const list = vi.fn<PersonalSshPort['list']>().mockResolvedValueOnce({ available: true, items: [item] }).mockResolvedValueOnce({ available: true, items: [changed] })
  const toggle = vi.fn<PersonalSshPort['toggle']>().mockResolvedValueOnce(changed).mockRejectedValueOnce(new SshHttpError(409))
  render(<ConnectorConfiguration {...props(ssh({ list, toggle }))} />)
  await screen.findByText(item.displayName)
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() =>{  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText(en.sshConflict)
  const section = screen.getByText(item.displayName).closest('[data-power-evolve-ssh-page]')!
  const toolbar = within(section as HTMLElement).getByText(en.sshMyServers.replace('{count}', '1')).closest('div')!
  fireEvent.click(within(toolbar).getByRole('button', { name: en.refreshList }))
  await waitFor(() =>{  expect(list).toHaveBeenCalledTimes(2) })
  await screen.findByText(item.displayName)
  expect(toggle).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it.each(['success', 'failure'] as const)('discards a replaced account port late %s', async (outcome) => {
  const pending = Promise.withResolvers<PersonalSshList>()
  let signal: AbortSignal | undefined
  const old = props(ssh({ list: async (current) => { signal = current; return pending.promise } }))
  const root = render(<ConnectorConfiguration {...old} />)
  root.rerender(<ConnectorConfiguration {...old} ssh={ssh({ list: async () => ({ available: true, items: [{ ...item, displayName: 'Bob server' }] }) })} />)
  await screen.findByText('Bob server'); expect(signal?.aborted).toBe(true)
  await act(async () => { if (outcome === 'success') pending.resolve({ available: true, items: [item] }); else pending.reject(new Error('old account refused')) })
  expect(screen.queryByText(item.displayName)).toBeNull(); expect(screen.queryByText(en.sshLoadFailed)).toBeNull()
})

it('aborts an outstanding SSH list when native bundle configuration closes', async () => {
  const pending = Promise.withResolvers<PersonalSshList>()
  let signal: AbortSignal | undefined
  const root = render(<ConnectorConfiguration {...props(ssh({ list: async (current) => { signal = current; return pending.promise } }))} />)
  root.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve({ available: true, items: [item] }) })
  expect(screen.queryByText(item.displayName)).toBeNull()
})
