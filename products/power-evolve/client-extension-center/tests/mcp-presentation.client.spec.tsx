// @vitest-environment jsdom
/** Native presentation supports sparse metadata as well as complete connector records. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpPageFrame, McpList, McpListRow, McpDetailFrame, McpDetailCard, McpDefinitionGrid,
  McpDialogFrame, McpDialogField } from '../src/client/McpPresentation.tsx'

afterEach(cleanup)
it.each(['minimal', 'complete'] as const)('renders $0 metadata with native search, navigation and dialog controls', (mode) => {
  const complete = mode === 'complete', search = vi.fn(), open = vi.fn(), back = vi.fn(), close = vi.fn()
  const root = render(<>
    <McpPageFrame title="Connections" subtitle="Owned services" tabLabel="My services" searchLabel="Find service"
      searchPlaceholder="Search" searchValue="" onSearchChange={search}
      {...(complete ? { tabMeta: 2, toolbar: <button>Create service</button>, notice: 'Approval required' } : {})}>
      <McpList><McpListRow title="Example" description="Remote endpoint" openLabel="Open Example" onOpen={open}
        {...(complete ? { badge: 'Configured', meta: 'Revision 2', status: 'Disabled', action: <button>Enable Example</button> } : {})} /></McpList>
    </McpPageFrame>
    <McpDetailFrame label="Service details" backLabel="Back to services" name="Example details" description="Saved metadata" onBack={back}
      {...(complete ? { meta: 'Saved revision 2', status: 'Ready', action: <button>Check Example</button> } : {})}>
      <McpDetailCard title="Configuration" {...(complete ? { description: 'Literal endpoint' } : {})}>
        <McpDefinitionGrid entries={[{ key: 'url', term: 'URL', value: 'https://example.test' }, { key: 'auth', term: 'Auth', value: 'None' }]}
          {...(complete ? { monoFirst: true } : {})} />
      </McpDetailCard>
    </McpDetailFrame>
    <McpDialogFrame open title="Edit service" closeLabel="Close editor" onClose={close}
      {...(complete ? { description: 'Write-only credentials', footer: <button>Save service</button> } : {})}>
      <McpDialogField label="Display name"><input /></McpDialogField>
    </McpDialogFrame>
  </>)
  expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find service' }), { target: { value: 'remote' } })
  expect(search).toHaveBeenCalledWith('remote')
  fireEvent.click(screen.getByRole('button', { name: 'Open Example' })); expect(open).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Back to services' })); expect(back).toHaveBeenCalledOnce()
  expect(root.container.querySelectorAll('.pext-mcp-detail-mono')).toHaveLength(complete ? 1 : 0)
  expect(screen.queryByText('Write-only credentials') !== null).toBe(complete)
  expect(screen.queryByRole('button', { name: 'Save service' }) !== null).toBe(complete)
  fireEvent.click(screen.getByRole('button', { name: 'Close editor' })); expect(close).toHaveBeenCalledOnce()
})

it.each(['status', 'action'] as const)('keeps a standalone row %s outside the primary navigation button', (mode) => {
  render(<McpListRow title="Service" description="Endpoint" openLabel="Open service" onOpen={vi.fn()}
    {...(mode === 'status' ? { status: 'Queued' } : { action: <button>Cancel check</button> })} />)
  const primary = screen.getByRole('button', { name: 'Open service' })
  expect(primary.textContent).not.toContain(mode === 'status' ? 'Queued' : 'Cancel check')
  expect(mode === 'status' ? screen.getByText('Queued') : screen.getByRole('button', { name: 'Cancel check' })).toBeTruthy()
})
