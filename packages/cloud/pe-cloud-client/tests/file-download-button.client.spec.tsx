// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { expect, it, vi, afterEach } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { FileDownloadButton } from '../src/client/FileDownloadButton.tsx'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const labels = { download: 'Download', pending: 'Pending', cancel: 'Cancel', cancelled: 'Cancelled', started: 'Requested',
  failed: 'Unable to download', tooLarge: 'Too large', invalid: 'Invalid' }
it('renders an accessible icon and no persistent success message', async () => {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const fetch = vi.fn(async () => new Response(null))
  render(<FileDownloadButton sessionId={SessionId('s')} resourceAddress={sessionFileAddress(SessionId('s'), '/x')}
    fetch={fetch} navigationUrl={path => path} signal={new AbortController().signal} maxFileBytes={2 ** 40} labels={labels} />)
  const button = screen.getByRole('button', { name: 'Download' })
  expect(button.querySelector('svg')).not.toBeNull()
  fireEvent.click(button)
  await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText('Requested')).toBeNull()
})
