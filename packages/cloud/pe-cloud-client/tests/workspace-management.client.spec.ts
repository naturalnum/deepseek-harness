// @vitest-environment jsdom
/** The prepared account callback uses original File HTTP bodies and retains directory paths. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi } from 'vitest'
import { prepareWorkspaceManagement } from '../src/client/workspace-management.ts'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'

it('creates a selected folder hierarchy and sends original File bodies without keeping prompt receipts', async () => {
  const ctx = new Context(), calls: { url: URL; init: RequestInit }[] = []
  const fetch: FileUploadFetch = async (path, init) => {
    const url = new URL(String(path), 'https://fixture/')
    calls.push({ url, init })
    if (init.method === 'HEAD') return new Response(null, { headers: { 'x-workspace-max-files': '100',
      'x-workspace-max-total-bytes': String(2 ** 40), 'x-workspace-max-file-bytes': String(2 ** 40) } })
    if (url.pathname.endsWith('/directory')) return Response.json({ ok: true,
      path: `${url.searchParams.get('directory')}/${url.searchParams.get('name')}` })
    return Response.json({ ok: true, value: { bytes: 3 } })
  }
  const control = new AbortController()
  prepareWorkspaceManagement(ctx, fetch, path => path, control.signal, 2 ** 40, 16384)
  const first = new File(['one'], 'one.txt'), second = new File(['two'], 'two.txt'), progress = vi.fn()
  try {
    await ctx.workspaceFileManagement.upload(SessionId('s'), '.', [
      { file: first, path: 'folder/one.txt' }, { file: second, path: 'folder/nested/two.txt' },
    ], control.signal, progress)
    const uploads = calls.filter(call => call.url.pathname.endsWith('/uploadFileBinary'))
    expect(uploads.map(call => call.init.body)).toEqual([first, second])
    expect(uploads.map(call => call.url.searchParams.get('directory'))).toEqual(['./folder', './folder/nested'])
    expect(uploads.every(call => call.url.searchParams.get('workspaceOnly') === 'true')).toBe(true)
    expect(progress).toHaveBeenLastCalledWith(6, 6)
  } finally { await ctx.fiber.dispose() }
})
it('checks configured selection count before any directory or content write', async () => {
  const ctx = new Context(), fetch = vi.fn<FileUploadFetch>(async () => new Response(null, { headers: {
    'x-workspace-max-files': '1', 'x-workspace-max-total-bytes': '1000', 'x-workspace-max-file-bytes': '1000',
  } }))
  const signal = new AbortController().signal
  prepareWorkspaceManagement(ctx, fetch, path => path, signal, 2 ** 40, 16384)
  try {
    await expect(ctx.workspaceFileManagement.upload(SessionId('s'), '.', [
      { file: new File(['a'], 'a'), path: 'a' }, { file: new File(['b'], 'b'), path: 'b' },
    ], signal, () => {})).rejects.toThrow('upload-too-large')
    expect(fetch).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})
