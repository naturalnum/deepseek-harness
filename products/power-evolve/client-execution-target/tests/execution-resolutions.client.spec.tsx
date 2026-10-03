/** Actual read-only React component with Host replies and primitives substituted; not native E2E. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionResolutions } from '../src/client/ExecutionResolutions.tsx'
import { ExecutionResolutionClient } from '../src/client/execution-resolution-client.ts'
import { en, zh, type ExecutionTargetLocaleKey } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) =>
    open ? <section role="dialog" aria-label={title}>{children}{footer}</section> : null,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const sessionId = '00000000-0000-4000-8000-000000000001'
const executionId = '00000000-0000-4000-8000-000000000002'
const requestId = '00000000-0000-4000-8000-000000000003'
const command = '<img src=x onerror=attack()>; printf exact'
const receipt = { sessionId, executionId, requestId, target: 'cloud', state: 'completed',
  finalState: 'closed_unknown', stopConfirmed: true, continuationQueued: true, errorCode: null }
const item = { sessionId, executionId, target: 'cloud', executionState: 'closed_unknown', command, cwd: '/workspace',
  createdAt: '2026-10-03T00:00:00Z', errorCode: null, resolution: receipt }
const locale = (dictionary: Record<ExecutionTargetLocaleKey, string>) => (key: ExecutionTargetLocaleKey) => dictionary[key]

it('shows both locales with original command, unknown outcome and only the independent trusted link', async () => {
  for (const dictionary of [zh, en]) {
    const calls: string[] = []
    const client = new ExecutionResolutionClient(async input => {
      calls.push(String(input))
      return Response.json(input === '/config' ? { approvalUrl: 'https://platform.test/approval' }
        : { available: true, items: [item] })
    })
    const view = render(<ExecutionResolutions sessionId={sessionId} removed={false} client={client} t={locale(dictionary)} />)
    fireEvent.click(screen.getByText(dictionary.resolutions))
    await screen.findByText(command)
    expect(screen.getByText(dictionary.resolutionClosedUnknownHelp)).toBeTruthy()
    expect(screen.queryByText(dictionary.resolutionSucceeded)).toBeNull()
    const link = await screen.findByRole('link', { name: dictionary.resolutionTrustedEntry })
    expect(link.getAttribute('href')).toBe(`https://platform.test/approval#execution=${executionId}`)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(view.container.querySelector('img,script,iframe,textarea')).toBeNull()
    expect(calls).toEqual(['/config', '/api/powerEvolve/executionResolutionsList'])
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      dictionary.resolutions, dictionary.resolutionRefresh, dictionary.resolutionInspect, dictionary.close,
    ])
    view.unmount()
  }
})

it('shows the exact canStop=false reason without any confirmation route or control', async () => {
  const calls: string[] = []
  const original = { ...item, executionState: 'uncertain', resolution: null }
  const client = new ExecutionResolutionClient(async input => {
    calls.push(String(input))
    return Response.json(input === '/config' ? { approvalUrl: 'https://platform.test/approval' }
      : String(input).endsWith('Inspect') ? { item: original, fingerprint: null, canStop: false,
        blockedReason: 'pod_uid_missing', runnerObservation: 'unavailable' } : { available: true, items: [original] })
  })
  render(<ExecutionResolutions sessionId={sessionId} removed={false} client={client} t={locale(zh)} />)
  fireEvent.click(screen.getByText(zh.resolutions)); await screen.findByText(command)
  fireEvent.click(screen.getByText(zh.resolutionInspect)); await screen.findByText('pod_uid_missing')
  expect(calls.every(path => path === '/config' || path.startsWith('/api/powerEvolve/executionResolution'))).toBe(true)
  expect(screen.queryByText('停止旧执行者并对账')).toBeNull()
})

it('a revoked account during inspection closes the sensitive view and clears its command', async () => {
  const client = new ExecutionResolutionClient(async input => input === '/config'
    ? Response.json({ approvalUrl: 'https://platform.test/approval' })
    : String(input).endsWith('Inspect') ? new Response('', { status: 401 }) : Response.json({ available: true, items: [item] }))
  render(<ExecutionResolutions sessionId={sessionId} removed={false} client={client} t={locale(zh)} />)
  fireEvent.click(screen.getByText(zh.resolutions)); await screen.findByText(command)
  fireEvent.click(screen.getByText(zh.resolutionInspect))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByText(command)).toBeNull()
})
