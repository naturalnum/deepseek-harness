// @vitest-environment jsdom
/** Real native Settings form controls; Gateway/native-client behavior is covered by account composition tests. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { McpConnectionId } from '@deepseek-ai/dsh-pe-cloud-files'
import type { CloudMcpConnectionReply, CloudMcpConnectionRequest } from '@deepseek-ai/dsh-pe-cloud-api/types'
import { McpConnectionsSection } from '../src/client/mcp/McpConnectionsSection.tsx'
import { mcpSettingsDictionaries } from '../src/client/mcp/locales.ts'

afterEach(cleanup)
const en = mcpSettingsDictionaries.en
const unused = (): never => { throw new Error('Unused native slot prop') }
const props = { ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  usePanelInfo: unused, useWorkspaces: unused, useResource: unused, scope: 'A:1', close() {}, t: makeTranslate(en) }
const limits = { maxConnections: 4, maxToolCallTimeoutMs: 2000 }

it('configures HTTP plus a private Bearer token, tests, edits without reading credentials, toggles and removes', async () => {
  let connections: CloudMcpConnectionReply['connections'] = [], revision = 0
  const call = vi.fn(async (request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply> => {
    if (request.action === 'save') {
      const { headers: _headers, ...definition } = request.connection
      connections = [{ ...definition, id: request.id ?? brandString<McpConnectionId>('00000000-0000-4000-8000-000000000001'),
        configured: true, toolCount: 1 }]; revision++
    }
    if (request.action === 'enabled') { connections = connections.map(row => ({ ...row, enabled: request.enabled })); revision++ }
    if (request.action === 'remove') { connections = []; revision++ }
    return { connections, version: String(revision), limits,
      ...request.action === 'test' ? { test: { reachable: true, toolCount: 1 } } : {} }
  })
  render(<McpConnectionsSection {...props} call={call}/>)
  await screen.findByText(en.empty)
  fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'compute' } })
  fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://192.0.2.1:17273/mcp' } })
  const credential = screen.getByLabelText<HTMLInputElement>(en.token)
  expect(credential.type).toBe('password')
  fireEvent.change(credential, { target: { value: 'synthetic-ui-token' } })
  fireEvent.click(screen.getByRole('button', { name: en.test }))
  await screen.findByText(new RegExp(en.reachable))
  fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://192.0.2.1:17273/changed' } })
  expect(screen.queryByText(new RegExp(en.reachable))).toBeNull()
  fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://192.0.2.1:17273/mcp' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await screen.findByText('compute')
  expect(credential.value).toBe('')
  expect(call.mock.calls.find(([request]) => request.action === 'save')?.[0]).toMatchObject({ connection: {
    url: 'http://192.0.2.1:17273/mcp', headers: { Authorization: 'Bearer synthetic-ui-token' }, toolCallTimeoutMs: 2000 } })
  expect(document.body.textContent).not.toContain('synthetic-ui-token')
  fireEvent.click(screen.getByRole('button', { name: en.edit }))
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(call.mock.calls.filter(([request]) => request.action === 'save')).toHaveLength(2) })
  const edit = call.mock.calls.filter(([request]) => request.action === 'save')[1]?.[0]
  expect(edit).toMatchObject({ action: 'save', version: '1' })
  if (edit?.action !== 'save') throw new Error('Expected edit request')
  expect(edit.connection.headers).toBeUndefined()
  await waitFor(() => { expect(screen.getByRole('button', { name: en.disable }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.edit }))
  fireEvent.click(screen.getByLabelText(en.clearHeaders))
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(call.mock.calls.filter(([request]) => request.action === 'save')).toHaveLength(3) })
  expect(call.mock.calls.filter(([request]) => request.action === 'save')[2]?.[0]).toMatchObject({ connection: { headers: {} } })
  await waitFor(() => { expect(screen.getByRole('button', { name: en.disable }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.disable }))
  await screen.findByRole('button', { name: en.enable })
  fireEvent.click(screen.getByRole('button', { name: en.remove }))
  fireEvent.click(screen.getByRole('button', { name: en.removeConfirm }))
  await screen.findByText(en.empty)
  expect(call.mock.calls.some(([request]) => request.action === 'remove' && request.version === '4')).toBe(true)
})

it('withdraws typed secrets and ignores an old account response when the native page changes', async () => {
  const oldProbe = Promise.withResolvers<CloudMcpConnectionReply>()
  const call = vi.fn((request: CloudMcpConnectionRequest) => request.action === 'test' ? oldProbe.promise
    : Promise.resolve({ connections: [], version: 'A:1', limits }))
  const view = render(<McpConnectionsSection {...props} call={call}/>)
  await screen.findByText(en.empty)
  fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'compute' } })
  fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://192.0.2.1:17273/mcp' } })
  fireEvent.change(screen.getByLabelText(en.token), { target: { value: 'synthetic-old-account-token' } })
  fireEvent.click(screen.getByRole('button', { name: en.test }))
  view.rerender(<McpConnectionsSection {...props} scope="B:2" call={async () => ({ connections: [], version: 'B:2', limits })}/>)
  await screen.findByText(en.empty)
  oldProbe.resolve({ connections: [], version: 'A:2', limits, test: { reachable: true, toolCount: 1 } })
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.token).value).toBe('') })
  expect(screen.queryByText(new RegExp(en.reachable))).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(en.serverName).value).toBe('')
})
