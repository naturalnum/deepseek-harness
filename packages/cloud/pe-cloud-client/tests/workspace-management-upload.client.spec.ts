/** Original management callbacks with native absolute tree paths, bounded Files and the explicit server-selected upload metadata. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { prepareWorkspaceManagement } from '../src/client/workspace-management.ts'

it.each([
  [507, 'not-published', 'quota-exceeded', true],
  [507, 'not-published', 'disk-full', true],
  [507, 'unknown', 'quota-exceeded', false],
  [400, 'not-published', 'disk-full', false],
  [200, 'not-published', 'disk-full', false],
  [507, 'not-published', 'unrecognized', false],
] as const)('uses the same mkdir refusal for direct and recursive requests with HTTP %i and %s (%s)',
  async (status, outcome, reason, known) => {
    const ctx = new Context(), signal = new AbortController().signal, progress = vi.fn()
    const fetch = vi.fn<FileUploadFetch>(async (_path, init) => {
      if (init.method === 'HEAD') return new Response(null, { headers: {
        'x-workspace-max-files': '10', 'x-workspace-max-total-bytes': '4096', 'x-workspace-max-file-bytes': '4096',
        'x-workspace-upload-protocol': 'workspace-upload-v1', 'x-workspace-upload-root': encodeURIComponent('/project-a'),
        'x-workspace-upload-chunk-bytes': '1024',
      } })
      return Response.json({ ok: false, code: 'transfer/failed', outcome, reason,
        ...(status === 200 ? { path: '/project-a/ambiguous' } : {}) }, { status })
    })
    prepareWorkspaceManagement(ctx, fetch, value => value, signal, 4096, 1024)
    const expected = known ? { message: 'directory-storage-refused', outcome: 'not-published', reason }
      : { message: 'directory-unconfirmed' }
    try {
      const id = SessionId('session'), file = new File(['one'], 'report.txt')
      const direct = await ctx.workspaceFileManagement.createDirectory(id, '/project-a', 'folder', signal).catch((error: unknown) => error)
      const recursive = await ctx.workspaceFileManagement.upload(id, '/project-a', [{ file, path: 'folder/report.txt' }], signal, progress)
        .catch((error: unknown) => error)
      for (const error of [direct, recursive]) {
        expect(error).toMatchObject(expected)
        if (!known) expect(error).not.toHaveProperty('reason')
      }
      expect(fetch.mock.calls.map(([path, init]) => [String(path).split('?')[0], init.method])).toEqual([
        ['api/workspace-files/directory', 'POST'], ['api/workspace-files/download', 'HEAD'], ['api/workspace-files/directory', 'POST'],
      ])
      expect(progress).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  },
)

it('normalizes the native absolute root, preserves folder results and consumes the actual suffixed receipt', async () => {
  const ctx = new Context(), signal = new AbortController().signal
  const calls: { url: URL; init: RequestInit }[] = [], file = new File(['one'], 'report.txt'), progress = vi.fn()
  const whole = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Whole-file read is forbidden'))
  const fetch: FileUploadFetch = async (path, init) => {
    const url = new URL(String(path), 'https://fixture/'); calls.push({ url, init })
    if (init.method === 'HEAD') return new Response(null, { headers: {
      'x-workspace-max-files': '10', 'x-workspace-max-total-bytes': '4096', 'x-workspace-max-file-bytes': '4096',
      'x-workspace-upload-protocol': 'workspace-upload-v1', 'x-workspace-upload-root': encodeURIComponent('/project-a'),
      'x-workspace-upload-chunk-bytes': '1024',
    } })
    if (url.pathname.endsWith('/directory')) return Response.json({ path: '/project-a/folder_1' })
    expect(url.pathname).toBe('/api/workspace-files/upload')
    expect(url.searchParams.get('directory')).toBe('folder_1')
    expect(init.body).toBe(file)
    expect(new Headers(init.headers).get('x-content-sha256')).toBe(createHash('sha256').update('one').digest('hex'))
    return Response.json({ ok: true, value: { kind: 'workspace-upload', path: 'folder_1/report_2.txt', bytes: file.size,
      sha256: new Headers(init.headers).get('x-content-sha256'), outcome: 'published' } })
  }
  prepareWorkspaceManagement(ctx, fetch, value => value, signal, 4096, 1024)
  try {
    await ctx.workspaceFileManagement.upload(SessionId('session'), '/project-a', [{ file, path: 'folder/report.txt' }], signal, progress)
    expect(calls.filter(call => call.url.pathname.includes('uploadFileBinary'))).toHaveLength(0)
    expect(progress).toHaveBeenLastCalledWith(3, 3); expect(whole).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('retains completed file progress when a later directory is refused without publication', async () => {
  const ctx = new Context(), signal = new AbortController().signal, progress = vi.fn()
  const saved = new File(['one'], 'saved.txt'), blocked = new File(['two'], 'blocked.txt')
  const fetch = vi.fn<FileUploadFetch>(async (path, init) => {
    if (init.method === 'HEAD') return new Response(null, { headers: {
      'x-workspace-max-files': '10', 'x-workspace-max-total-bytes': '4096', 'x-workspace-max-file-bytes': '4096',
      'x-workspace-upload-protocol': 'workspace-upload-v1', 'x-workspace-upload-root': encodeURIComponent('/project-a'),
      'x-workspace-upload-chunk-bytes': '1024',
    } })
    if (String(path).startsWith('api/workspace-files/directory?')) {
      return Response.json({ ok: false, code: 'transfer/failed', outcome: 'not-published', reason: 'quota-exceeded' }, { status: 507 })
    }
    expect(init.body).toBe(saved)
    return Response.json({ ok: true, value: { kind: 'workspace-upload', path: saved.name, bytes: saved.size,
      sha256: new Headers(init.headers).get('x-content-sha256'), outcome: 'published' } })
  })
  prepareWorkspaceManagement(ctx, fetch, value => value, signal, 4096, 1024)
  try {
    await expect(ctx.workspaceFileManagement.upload(SessionId('session'), '/project-a', [
      { file: saved, path: saved.name }, { file: blocked, path: 'nested/blocked.txt' },
    ], signal, progress)).rejects.toMatchObject({ outcome: 'not-published', reason: 'quota-exceeded' })
    expect(progress.mock.calls).toEqual([[saved.size, saved.size + blocked.size]])
    expect(fetch.mock.calls.map(([path]) => String(path).split('?')[0])).toEqual([
      'api/workspace-files/download', 'api/workspace-files/upload', 'api/workspace-files/directory',
    ])
  } finally { await ctx.fiber.dispose() }
})

it('rejects an absolute sibling path before hashing or sending any file body', async () => {
  const ctx = new Context(), signal = new AbortController().signal, file = new File(['one'], 'report.txt')
  const sliced = vi.spyOn(file, 'slice')
  const fetch = vi.fn<FileUploadFetch>(async () => new Response(null, { headers: {
    'x-workspace-max-files': '10', 'x-workspace-max-total-bytes': '4096', 'x-workspace-max-file-bytes': '4096',
    'x-workspace-upload-protocol': 'workspace-upload-v1', 'x-workspace-upload-root': encodeURIComponent('/project-a'),
    'x-workspace-upload-chunk-bytes': '1024',
  } }))
  prepareWorkspaceManagement(ctx, fetch, value => value, signal, 4096, 1024)
  try {
    await expect(ctx.workspaceFileManagement.upload(SessionId('session'), '/project-a-other', [{ file, path: 'report.txt' }],
      signal, () => {})).rejects.toThrow('invalid-path')
    expect(fetch).toHaveBeenCalledOnce(); expect(sliced).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
