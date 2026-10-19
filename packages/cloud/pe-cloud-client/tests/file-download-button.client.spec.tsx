// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { FileDownloadButton, type FileDownloadButtonProps } from '../src/client/FileDownloadButton.tsx'
import type { CloudFileReadBytes } from '../src/client/file-download.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const id = SessionId('download-original'), next = SessionId('download-next')
const labels = { download: 'Download', pending: 'Downloading', cancel: 'Cancel download', cancelled: 'Download cancelled', started: 'Download requested',
  failed: 'Unable to download. Check this file and try again.', tooLarge: 'File is too large', invalid: 'File cannot be downloaded' }
function complete(): Awaited<ReturnType<CloudFileReadBytes>> {
  return { ok: true, value: { absolutePath: '/native/file', version: 'v', data: new Uint8Array([1, 2]), bytes: 2, offset: 0, eof: true } }
}
function fixture(readBytes = vi.fn<CloudFileReadBytes>().mockResolvedValue(complete())) {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:owned-download')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const clicked: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download) })
  const page = new AbortController()
  const props: FileDownloadButtonProps = { sessionId: id, resourceAddress: sessionFileAddress(id, 'original.bin'),
    signal: page.signal, maxFileBytes: 16, readBytes, labels }
  return { props, page, readBytes, createObjectURL, revokeObjectURL, clicked }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('discards a late native result after unmount and aborts that occurrence', async () => {
  let finish!: (result: Awaited<ReturnType<CloudFileReadBytes>>) => void
  const read = vi.fn<CloudFileReadBytes>(() => new Promise((resolve) => { finish = resolve }))
  const f = fixture(read)
  const view = render(<FileDownloadButton {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: labels.download }))
  view.unmount()
  expect(read.mock.calls[0]?.[3]?.aborted).toBe(true)
  await act(async () => { finish(complete()) })
  expect(f.createObjectURL).not.toHaveBeenCalled()
  expect(f.clicked).toEqual([])
})

it('captures each Session/resource and never adopts old bytes after resource replacement', async () => {
  let finishOld!: (result: Awaited<ReturnType<CloudFileReadBytes>>) => void
  const old = new Promise<Awaited<ReturnType<CloudFileReadBytes>>>((resolve) => { finishOld = resolve })
  const read = vi.fn<CloudFileReadBytes>(session => session === id ? old : Promise.resolve(complete()))
  const f = fixture(read)
  const view = render(<FileDownloadButton {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: labels.download }))
  const replacement = { ...f.props, sessionId: next, resourceAddress: sessionFileAddress(next, 'next.bin') }
  view.rerender(<FileDownloadButton {...replacement} />)
  expect(read.mock.calls[0]?.[3]?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: labels.download }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(labels.started) })
  await act(async () => { finishOld(complete()) })
  expect(f.clicked).toEqual(['next.bin'])
  expect(read.mock.calls.map(call => [call[0], call[1]])).toEqual([[id, 'original.bin'], [next, 'next.bin']])
  expect(f.createObjectURL).toHaveBeenCalledOnce()
  expect(f.revokeObjectURL).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toBe(labels.started)
})

it('shows only localized failure copy and does not retry a refused native read', async () => {
  const read = vi.fn<CloudFileReadBytes>().mockResolvedValue({ ok: false,
    error: new RemoteError('gateway/bad-request', '/private/account', {}) })
  const f = fixture(read)
  render(<FileDownloadButton {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: labels.download }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(labels.failed) })
  expect(screen.queryByText('/private/account')).toBeNull()
  expect(read).toHaveBeenCalledOnce()
  expect(f.createObjectURL).not.toHaveBeenCalled()
})

it('cancels a read explicitly, keeps it owned until settlement, and does not save late bytes', async () => {
  let finish!: (result: Awaited<ReturnType<CloudFileReadBytes>>) => void
  const read = vi.fn<CloudFileReadBytes>(() => new Promise((resolve) => { finish = resolve }))
  const f = fixture(read)
  render(<FileDownloadButton {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: labels.download }))
  fireEvent.click(screen.getByRole('button', { name: labels.cancel }))
  expect(read.mock.calls[0]?.[3]?.aborted).toBe(true)
  expect(screen.getByRole('button', { name: labels.pending }).hasAttribute('disabled')).toBe(true)
  await act(async () => { finish(complete()) })
  expect(screen.getByRole('status').textContent).toBe(labels.cancelled)
  expect(f.clicked).toEqual([])
  expect(f.createObjectURL).not.toHaveBeenCalled()
})
