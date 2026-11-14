/** Actual Fetch/stream/ZIP registration; external Session/storage admission is a typed fixture. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { registerWorkspaceTransfers, type SelectWorkspaceTransfer } from '../src/workspace-transfers.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

function fixture(upload = false) {
  const ctx = new Context(), routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
    routes.set(route.path, route); return async () => { routes.delete(route.path) }
  } } } as never)
  const data = new Map([['a/report.bin', Uint8Array.of(0, 255, 2)], ['b/report.bin', Uint8Array.of(9, 8)]])
  let version = '1'
  let afterRead: (() => void) | undefined
  const ranges: { offset: number; length: number }[] = []
  const held = { active: 0, peak: 0 }
  const resident = <T>(value: T) => {
    held.active++; held.peak = Math.max(held.peak, held.active)
    return { value, release() { held.active-- } }
  }
  const backend = {
    lstat: async (path: string) => resident(data.has(path) ? { type: 'file', size: data.get(path)!.length, version } : undefined),
    readByteRange: async (path: string, range: { offset: number; length: number }) => {
      ranges.push(range)
      const result = resident(data.get(path)!.slice(range.offset, range.offset + range.length))
      afterRead?.()
      return result
    },
  }
  const select: SelectWorkspaceTransfer = async (id) => {
    if (id !== SessionId('account-a-session')) throw new Error('foreign-session')
    return { workspace: { path: '/project-a' }, assertCurrent() {},
      ...!upload ? {} : { workspaceUpload: { protocol: 'workspace-upload-v1', root: '/project-a', chunkBytes: 2 } }, files: {
        workspaceContent: async () => backend,
        createWorkspaceDirectory: async () => 'folder_1',
      } } as never
  }
  const life = new AbortController()
  registerWorkspaceTransfers(ctx, { maxFileBytes: 2 ** 32, maxFiles: 100, maxTotalBytes: 2 ** 34,
    chunkBytes: 2, maxPathBytes: 4096, timeoutMs: 30000 }, select, () => {}, life.signal)
  const request = (path: string, method = 'GET') => routes.get(path.split('?')[0]!)!.fetch(new Request(`http://test${path}`, { method }))
  return { ctx, request, held, life, ranges,
    changeVersion: () => { version = '2' }, afterRead: (callback: () => void) => { afterRead = callback } }
}

it('streams an original file and a ZIP preserving duplicate basenames in distinct directories', async () => {
  const f = fixture()
  try {
    const response = await f.request('/api/workspace-files/download?sessionId=account-a-session&path=a/report.bin')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0, 255, 2))
    const zip = await f.request('/api/workspace-files/download?sessionId=account-a-session&path=a/report.bin&path=b/report.bin')
    const contents = unzipSync(new Uint8Array(await zip.arrayBuffer()))
    expect(Object.keys(contents)).toEqual(['a/report.bin', 'b/report.bin'])
    expect(contents['b/report.bin']).toEqual(Uint8Array.of(9, 8))
    expect(f.held.active).toBe(0)
    expect(f.held.peak).toBeLessThanOrEqual(2)
  } finally { f.life.abort(); await f.ctx.fiber.dispose() }
})
it('rejects a foreign Session and traversal before content reads', async () => {
  const f = fixture()
  try {
    for (const query of ['sessionId=foreign&path=a/report.bin', 'sessionId=account-a-session&path=../foreign/file']) {
      expect((await f.request(`/api/workspace-files/download?${query}`)).ok).toBe(false)
    }
    expect(f.held.active).toBe(0)
  } finally { f.life.abort(); await f.ctx.fiber.dispose() }
})
it.each([1, 2])('fails the download and releases its bytes if the file changes after range %i', async (changeAfter) => {
  const f = fixture()
  try {
    f.afterRead(() => { if (f.ranges.length === changeAfter) f.changeVersion() })
    const response = await f.request('/api/workspace-files/download?sessionId=account-a-session&path=a/report.bin')
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(f.ranges).toHaveLength(changeAfter)
    expect(f.held.active).toBe(0)
  } finally { f.life.abort(); await f.ctx.fiber.dispose() }
})
it('rechecks account lifetime for GET after a successful HEAD without starting content reads', async () => {
  const f = fixture()
  const path = '/api/workspace-files/download?sessionId=account-a-session&path=a/report.bin'
  try {
    expect((await f.request(path, 'HEAD')).ok).toBe(true)
    f.life.abort()
    expect((await f.request(path)).ok).toBe(false)
    expect(f.ranges).toEqual([])
    expect(f.held.active).toBe(0)
  } finally { f.life.abort(); await f.ctx.fiber.dispose() }
})
it('returns configured policy without buffering content during a picker preflight', async () => {
  const f = fixture()
  try {
    const response = await f.request('/api/workspace-files/download?sessionId=account-a-session', 'HEAD')
    expect(response.headers.get('x-workspace-max-files')).toBe('100')
    expect(response.body).toBeNull()
    expect(f.held.peak).toBe(0)
  } finally { f.life.abort(); await f.ctx.fiber.dispose() }
})


it('projects only the original selected workspace upload metadata on the existing HEAD preflight', async () => {
  const f = fixture(true)
  try {
    const head = await f.request('/api/workspace-files/download?sessionId=account-a-session', 'HEAD')
    expect(head.headers.get('x-workspace-upload-protocol')).toBe('workspace-upload-v1')
    expect(head.headers.get('x-workspace-upload-root')).toBe(encodeURIComponent('/project-a'))
    expect(head.headers.get('x-workspace-upload-chunk-bytes')).toBe('2')
    const foreign = await f.request('/api/workspace-files/download?sessionId=foreign-session', 'HEAD')
    expect(foreign.ok).toBe(false)
    expect(foreign.headers.get('x-workspace-upload-root')).toBeNull()
  } finally { await f.ctx.fiber.dispose() }
})
