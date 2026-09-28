// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CloudWorkspaceFlow } from '../src/client/CloudWorkspaceFlow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('creates an opaque title through the native Workspace flow and respects busy', () => {
  const onPicked = vi.fn()
  const onCancel = vi.fn()
  const props = { open: true, busy: false, onPicked, onCancel, onError: vi.fn(),
    t: (key: keyof typeof en) => en[key] }
  const view = render(<CloudWorkspaceFlow {...props as never} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), { target: { value: ' 项目 A ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(onPicked).toHaveBeenCalledWith('power-evolve-cloud-title:%E9%A1%B9%E7%9B%AE%20A')
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(onPicked).toHaveBeenCalledTimes(1)
  view.rerender(<CloudWorkspaceFlow {...{ ...props, busy: true } as never} />)
  expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
})
