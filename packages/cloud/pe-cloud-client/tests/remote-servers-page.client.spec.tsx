// @vitest-environment jsdom
/** Actual server page controls over explicit backend answers; no authentication or execution claim. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ServersSection } from '../src/client/remote-servers/ServersSection.tsx'
import { remoteServerDictionaries } from '../src/client/remote-servers/locales.ts'
import type { RemoteServerReply, RemoteServerRequest } from '@deepseek-ai/dsh-pe-cloud-api/types'
afterEach(cleanup)
it('uses account callbacks for CRUD and shows unknown facts and the native never limitation without password controls', async () => {
  const en = remoteServerDictionaries.en
  let servers: RemoteServerReply['servers'] = []
  const call = vi.fn(async (request: RemoteServerRequest): Promise<RemoteServerReply> => {
    if (request.action === 'add') servers = [{ entry: { ...request.entry, id: 'actual-row' }, configured: false,
      reference: 'current-reference' }]
    if (request.action === 'remove') servers = []
    return { servers, limits: { maxPrivateKeyBytes: 2048, maxKnownHostsBytes: 2048, maxImportBytes: 4096 } }
  })
  const unused = (): never => { throw new Error('Unused native slot prop') }
  render(<ServersSection {...allowAllAccess} useSessions={unused} useSessionStatus={unused} useSessionRetainInfo={unused}
    usePanelInfo={unused} useWorkspaces={unused} useResource={unused} scope="account-A-generation-1" close={() => {}} t={makeTranslate(en)} call={call}/>)
  await screen.findByText(en.empty)
  fireEvent.change(screen.getByLabelText(en.alias), { target: { value: 'fixture' } })
  fireEvent.change(screen.getByLabelText(en.host), { target: { value: '192.0.2.1' } })
  fireEvent.change(screen.getByLabelText(en.user), { target: { value: 'fixture' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await screen.findByText('fixture@192.0.2.1:22')
  expect(screen.getByText(en.approvalHint)).toBeTruthy()
  expect(screen.getByText(new RegExp(en.unknown))).toBeTruthy()
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(document.querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.remove }))
  await waitFor(() =>{  expect(screen.getByText(en.empty)).toBeTruthy() })
  expect(call.mock.calls.some(([value]) => value.action === 'remove' && value.id === 'actual-row')).toBe(true)
})
