// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudProjectFlow } from '../src/client/project-flow.tsx'
import type { CloudProjectFlowInjected } from '../src/client/project-flow.tsx'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

const labels: Record<string, string> = { title: 'Create project', name: 'Project name', placeholder: 'Name your project',
  create: 'Create', cancel: 'Cancel', close: 'Close',
  pending: 'Creating project', unknown: 'Refresh and check your projects before trying again' }
const t: CloudProjectFlowInjected['t'] = (key) => {
  if (typeof key !== 'string') throw new TypeError('The translation fixture requires a string key')
  return labels[key] ?? key
}
function owner(): DirectoryFlowOwnerProps {
  return { open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }
}
afterEach(cleanup)

it('keeps the named project field and both dismiss actions inside the shared modal', () => {
  const props = owner(), createProject = vi.fn(async () => '/unused')
  render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  expect(screen.getByRole('dialog', { name: 'Create project' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Create project' })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Project name' }).getAttribute('placeholder')).toBe('Name your project')
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(props.onCancel).toHaveBeenCalledOnce()
  expect(createProject).not.toHaveBeenCalled()
})

it('collects only a title and returns the server allocated native path to the original owner', async () => {
  const props = owner(), createProject = vi.fn(async () => '/trusted/native-path')
  render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: '  Name  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(props.onPicked).toHaveBeenCalledWith('/trusted/native-path') })
  expect(createProject).toHaveBeenCalledOnce()
  expect(createProject).toHaveBeenCalledWith('Name', expect.any(AbortSignal))
  expect(props.onError).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(createProject).toHaveBeenCalledOnce()
})

it('does not duplicate a pending submit, cancels its signal, and ignores its late path', async () => {
  let finish!: (path: string) => void
  const createProject = vi.fn((_title: string, _signal: AbortSignal) => new Promise<string>((resolve) => { finish = resolve }))
  const props = owner()
  const view = render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(createProject).toHaveBeenCalledOnce()
  fireEvent.click(screen.getAllByRole('button', { name: /^Cancel$/ }).at(-1)!)
  expect(createProject.mock.calls[0]?.[1].aborted).toBe(true)
  expect(props.onCancel).toHaveBeenCalledOnce()
  await act(async () => { finish('/late/path') })
  expect(props.onPicked).not.toHaveBeenCalled()
  view.rerender(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(labels.unknown)
  expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
})

it('keeps an unknown result visible without exposing server details or automatically retrying', async () => {
  const createProject = vi.fn(async () => { throw new Error('/private/account/secret') })
  const props = owner()
  render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(labels.unknown) })
  expect(screen.queryByText('/private/account/secret')).toBeNull()
  expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
  expect(createProject).toHaveBeenCalledOnce()
})

it('aborts and discards a pending result when the slot unmounts', async () => {
  let finish!: (path: string) => void
  const createProject = vi.fn((_title: string, _signal: AbortSignal) => new Promise<string>((resolve) => { finish = resolve }))
  const props = owner()
  const view = render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Name' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  view.unmount()
  expect(createProject.mock.calls[0]?.[1].aborted).toBe(true)
  await act(async () => { finish('/late/path') })
  expect(props.onPicked).not.toHaveBeenCalled()
})

it('keeps an oversized multibyte title in the form without allocating', () => {
  const props = owner(), createProject = vi.fn(async () => '/unused')
  render(<CloudProjectFlow {...props} createProject={createProject} t={t} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '中'.repeat(86) } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(createProject).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toBe('invalid')
})
