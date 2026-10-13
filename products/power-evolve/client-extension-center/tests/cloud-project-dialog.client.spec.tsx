// @vitest-environment jsdom
/** Native controls and flow callbacks with a substituted cloud directory operation. */
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudProjectDialog, type CloudProjectDialogProps } from '../src/client/CloudProjectDialog.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(overrides: Partial<CloudProjectDialogProps> = {}) {
  const labels: Readonly<Record<string, string | undefined>> = zh
  const props: CloudProjectDialogProps = {
    open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    createProjectDirectory: vi.fn(async name => `/workspace/${name}`),
    t: (key) => { const label = labels[key]; if (label === undefined) throw new Error('Missing project fixture label'); return label },
    ...overrides,
  }
  const view = render(<CloudProjectDialog {...props} />)
  return { props, view, input: () => screen.getByRole<HTMLInputElement>('textbox', { name: zh.projectName }),
    create: () => screen.getByRole<HTMLButtonElement>('button', { name: zh.projectCreate }) }
}

it('asks only for a project name and disables creation for blank or invalid folder names', () => {
  const b = mount()
  expect(screen.getByRole('dialog', { name: zh.projectCreateTitle })).toBeTruthy()
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.queryByText('选择一个文件夹')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(b.create().disabled).toBe(true)
  for (const name of ['  ', '..', 'project/nested', 'project\\nested']) {
    fireEvent.change(b.input(), { target: { value: name } })
    expect(b.create().disabled).toBe(true)
  }
  expect(b.props.createProjectDirectory).not.toHaveBeenCalled()
})

it('creates the normalized cloud folder before handing its path to the native workspace owner', async () => {
  const b = mount()
  fireEvent.change(b.input(), { target: { value: '  我的项目  ' } })
  fireEvent.click(b.create())
  await waitFor(() => { expect(b.props.onPicked).toHaveBeenCalledExactlyOnceWith('/workspace/我的项目') })
  expect(b.props.createProjectDirectory).toHaveBeenCalledExactlyOnceWith('我的项目')
})

it('keeps the dialog open and prevents duplicate submission or dismissal during creation and adoption', async () => {
  let finish: (path: string) => void = () => { throw new Error('Missing pending creation') }
  const createProjectDirectory = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
  const b = mount({ createProjectDirectory })
  fireEvent.change(b.input(), { target: { value: '项目' } })
  fireEvent.click(b.create()); fireEvent.click(b.create())
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(createProjectDirectory).toHaveBeenCalledOnce()
  expect(b.input().disabled).toBe(true)
  expect(b.props.onCancel).not.toHaveBeenCalled()
  await act(async () => { finish('/workspace/项目') })
  expect(b.props.onPicked).toHaveBeenCalledOnce()
  b.view.rerender(<CloudProjectDialog {...b.props} busy />)
  expect(b.create().disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.cancel }).disabled).toBe(true)
})

it('retains the name on failure and allows correction and retry without adopting an existing project', async () => {
  const createProjectDirectory = vi.fn(async () => { throw new Error('directory_exists') })
  const b = mount({ createProjectDirectory })
  fireEvent.change(b.input(), { target: { value: '已有项目' } }); fireEvent.click(b.create())
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.projectCreateFailed)
  expect(b.input().value).toBe('已有项目')
  expect(b.props.onPicked).not.toHaveBeenCalled()
  fireEvent.change(b.input(), { target: { value: '新项目' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(b.create().disabled).toBe(false)
})

it('does not submit while an IME is composing and supports Enter after composition finishes', async () => {
  const b = mount()
  fireEvent.change(b.input(), { target: { value: '项目' } })
  const form = b.input().closest('form')
  if (!form) throw new Error('Missing creation form')
  fireEvent.compositionStart(b.input()); fireEvent.submit(form)
  expect(b.props.createProjectDirectory).not.toHaveBeenCalled()
  fireEvent.compositionEnd(b.input()); fireEvent.submit(form)
  await waitFor(() => { expect(b.props.onPicked).toHaveBeenCalledOnce() })
})

it('dismisses without creating a folder and discards a late result if the owner withdraws the flow', async () => {
  const b = mount()
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(b.props.onCancel).toHaveBeenCalledOnce()
  expect(b.props.createProjectDirectory).not.toHaveBeenCalled()
  b.view.unmount()
  let finish: (path: string) => void = () => { throw new Error('Missing pending creation') }
  const pending = mount({ createProjectDirectory: () => new Promise((resolve) => { finish = resolve }) })
  fireEvent.change(pending.input(), { target: { value: '项目' } }); fireEvent.click(pending.create())
  pending.view.rerender(<CloudProjectDialog {...pending.props} open={false} />)
  await act(async () => { finish('/workspace/项目') })
  expect(pending.props.onPicked).not.toHaveBeenCalled()
})
