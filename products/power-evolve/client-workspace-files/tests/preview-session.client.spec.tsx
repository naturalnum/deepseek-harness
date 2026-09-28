// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PreviewDownload } from '../src/client/PreviewDownload.tsx'
import { PreviewEdit } from '../src/client/PreviewEdit.tsx'
import { en } from '../src/client/locales.ts'

const sessionId = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const path = '/workspace/notes/sample.txt'
const t = (key: keyof typeof en) => en[key]

afterEach(cleanup)

it('disables preview file actions without a current Session', () => {
  const download = render(<PreviewDownload {...{ absolutePath: path, sessionId: '',
    client: { read: vi.fn() }, t } as never} />)
  expect(screen.getByRole('button', { name: 'Download file' }).hasAttribute('disabled')).toBe(true)
  download.unmount()
  render(<PreviewEdit {...{ absolutePath: path, sessionId: '',
    client: { open: vi.fn(), save: vi.fn() }, t } as never} />)
  expect(screen.getByRole('button', { name: 'Edit text' }).hasAttribute('disabled')).toBe(true)
})

it('binds preview download and conditional edit to the visible Session', async () => {
  const read = vi.fn().mockRejectedValue(new Error('probe'))
  const download = render(<PreviewDownload {...{ absolutePath: path, sessionId,
    client: { read }, t } as never} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }))
  await waitFor(() => expect(read).toHaveBeenCalledWith(sessionId, path, expect.any(AbortSignal)))
  download.unmount()

  const opened = { sessionId, absolutePath: path, revision: 'a'.repeat(64), text: 'old' }
  const open = vi.fn().mockResolvedValue(opened)
  const save = vi.fn().mockResolvedValue('b'.repeat(64))
  render(<PreviewEdit {...{ absolutePath: path, sessionId, client: { open, save }, t } as never} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit text' }))
  const editor = await screen.findByRole('textbox', { name: 'File contents' })
  fireEvent.change(editor, { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(sessionId, opened, 'new', expect.any(String), expect.any(AbortSignal)))
})
