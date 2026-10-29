/**
 * The address-to-read translation: a `dsh-resource://file/session/<id>/<path>`
 * address names the session the read runs under and the workspace-relative path
 * it hands the Host; absolute paths also travel inside the Session address.
 * An address without a Session fails loud.
 */
import { describe, expect, it, vi } from 'vitest'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { createReadPage, hostFileOf, readDelimitedBytes } from '../src/client/rpc.ts'
import type { ReadWorkspaceFilePage, WorkspaceFilesReadRemote } from '../src/client/index.ts'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { ADDRESS, FILE, PATH, SESSION, page } from './fixtures.client.ts'

describe('hostFileOf', () => {
  it('reads the session and the decoded relative path out of a session file address', () => {
    expect(hostFileOf(ADDRESS)).toEqual(FILE)
    expect(hostFileOf('dsh-resource://file/session/s%2F1/work/a%20b%23c.md')).toEqual({ sessionId: 's/1', path: 'work/a b#c.md' })
  })

  it.each(['/etc/hosts', 'C:/w/a b.md', '//host/share/a b.md'])('preserves the Session address\'s absolute path %s for the Host', (path) => {
    expect(hostFileOf(sessionFileAddress(SESSION, path))).toEqual({ sessionId: SESSION, path })
  })

  it('throws for an address that is not a Session file address', () => {
    for (const address of [
      'dsh-resource://file/absolute/etc/hosts', 'dsh-resource://file/absolute/C:/w/a.md',
      'dsh-resource://file/shared/team/notes.md', 'dsh-resource://file/session', 'file:///work/notes.md', 'sidebar://guide',
    ]) {
      expect(() => hostFileOf(address)).toThrow('not a session file address')
    }
  })
})

describe('createReadPage', () => {
  it('binds the paged read to the Remote with the offset as the only range', async () => {
    const read = vi.fn<WorkspaceFilesReadRemote['workspaceFiles']['read']>(() => Promise.resolve(page(4, ['d'], true)))
    const signal = new AbortController().signal
    const readPage: ReadWorkspaceFilePage = createReadPage({ workspaceFiles: { read } })
    await expect(readPage(SESSION, PATH, 4, signal)).resolves.toEqual(page(4, ['d'], true))
    expect(read).toHaveBeenCalledWith(SESSION, PATH, { offset: 4 }, signal)
  })
})

describe('readDelimitedBytes', () => {
  it('reads a 100KiB CSV through authorized bounded ranges and returns the complete stable version', async () => {
    const source = Uint8Array.from({ length: 102_672 }, (_, i) => i % 251)
    const read = vi.fn<TypertClientRemote['workspaceFiles']['readBytes']>(async (_session, _path, options) => {
      const range = options?.range
      if (range?.offset === undefined || range.length === undefined) throw new Error('expected explicit range')
      const data = source.slice(range.offset, range.offset + range.length)
      return { ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: source.length,
        offset: range.offset, data, eof: range.offset + data.length === source.length } }
    })
    const signal = new AbortController().signal
    const result = await readDelimitedBytes(read, { sessionId: SESSION, path: 'data.csv' }, 128 * 1024, signal)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected complete CSV')
    expect(result.value.data).toEqual(source)
    expect(result.value.eof).toBe(true)
    expect(read.mock.calls.map(call => call[2]?.range?.offset)).toEqual([0, 32768, 65536, 98304, 102672])
    expect(read.mock.calls.every(call => call[0] === SESSION && call[1] === 'data.csv'
      && (call[2]?.range?.length ?? 0) <= 32768)).toBe(true)
  })

  it('refuses a file above the configured preview cap without assembling it', async () => {
    const read = vi.fn<TypertClientRemote['workspaceFiles']['readBytes']>().mockResolvedValue({
      ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: 17,
        offset: 0, data: new Uint8Array([1]), eof: false },
    })
    const result = await readDelimitedBytes(read, { sessionId: SESSION, path: 'data.csv' }, 16, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'workspace-file/too-large', details: { limit: 16 } } })
    expect(read).toHaveBeenCalledOnce()
  })

  it('refuses a file that changes between windows', async () => {
    const read = vi.fn<TypertClientRemote['workspaceFiles']['readBytes']>()
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: 4,
        offset: 0, data: new Uint8Array([1, 2]), eof: false } })
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v2', bytes: 4,
        offset: 2, data: new Uint8Array([3, 4]), eof: true } })
    const result = await readDelimitedBytes(read, { sessionId: SESSION, path: 'data.csv' }, 16, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  })

  it('refuses a changed final version before exposing the assembled file', async () => {
    const read = vi.fn<TypertClientRemote['workspaceFiles']['readBytes']>()
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: 4,
        offset: 0, data: new Uint8Array([1, 2]), eof: false } })
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: 4,
        offset: 2, data: new Uint8Array([3, 4]), eof: true } })
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v2', bytes: 4,
        offset: 4, data: new Uint8Array(), eof: true } })
    const result = await readDelimitedBytes(read, { sessionId: SESSION, path: 'data.csv' }, 16, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it.each([{ values: [] }, { values: [7] }])('rechecks the final version for a single-window preview with bytes $values', async ({ values }) => {
    const read = vi.fn<TypertClientRemote['workspaceFiles']['readBytes']>()
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v1', bytes: values.length,
        offset: 0, data: new Uint8Array(values), eof: true } })
      .mockResolvedValueOnce({ ok: true, value: { absolutePath: '/work/data.csv', version: 'v2', bytes: values.length,
        offset: values.length, data: new Uint8Array(), eof: true } })
    const result = await readDelimitedBytes(read, { sessionId: SESSION, path: 'data.csv' }, 16, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  })
})
