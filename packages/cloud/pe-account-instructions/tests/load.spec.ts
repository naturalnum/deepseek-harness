import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { loadInstructionContents } from '../src/load.ts'
import { Reader, limits, budget, directory, signal } from './harness.ts'

describe('instruction content from approved directory targets', () => {
  it('orders sources and selects only AGENTS when both candidates exist', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: ['root'] })
    reader.files.set('/project/CLAUDE.md', { chunks: ['must not load'] })
    reader.files.set('/project/nested/CLAUDE.md', { chunks: ['child'] })
    reader.files.set('/account/AGENTS.md', { chunks: ['account'] })
    reader.files.set('/platform/AGENTS.md', { chunks: ['platform'] })
    const result = await loadInstructionContents(reader, [
      directory('project', '/project', '.'), directory('project', '/project/nested', 'nested'),
      directory('account', '/account', 'preferences'), directory('platform', '/platform', 'declaration'),
    ], limits, signal())
    expect(result.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['platform', 'declaration/AGENTS.md', 'platform'], ['account', 'preferences/AGENTS.md', 'account'],
      ['project', 'AGENTS.md', 'root'], ['project', 'nested/CLAUDE.md', 'child'],
    ])
    expect(reader.probes).not.toContain('/project/CLAUDE.md')
    expect(reader.probes.every(path => ['/project/', '/account/', '/platform/'].some(root => path.startsWith(root)))).toBe(true)
    expect(result.totalBytes).toBe(24)
    expect(Object.isFrozen(result.sources)).toBe(true)
    expect(result.sources.every(source => Object.isFrozen(source) && /^[a-f0-9]{64}$/.test(source.hash))).toBe(true)
  })

  it('does not use CLAUDE when AGENTS is empty or unreadable', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: [] })
    reader.files.set('/project/CLAUDE.md', { chunks: ['fallback'] })
    const dirs = [directory('project', '/project', '.')]
    expect((await loadInstructionContents(reader, dirs, limits, signal())).sources[0]?.text).toBe('')
    const failure = new FsError('unavailable', 'FS_IO_ERROR')
    reader.files.set('/project/AGENTS.md', { chunks: [], error: failure })
    await expect(loadInstructionContents(reader, dirs, limits, signal())).rejects.toBe(failure)
    expect(reader.probes).not.toContain('/project/CLAUDE.md')
  })

  it('distinguishes confirmed absence from a non-regular source', async () => {
    const reader = new Reader()
    const dirs = [directory('project', '/project', '.')]
    expect(await loadInstructionContents(reader, dirs, limits, signal())).toEqual({ sources: [], totalBytes: 0 })
    reader.files.set('/project/AGENTS.md', { chunks: [], type: 'other' })
    await expect(loadInstructionContents(reader, dirs, limits, signal())).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect(reader.reads).toEqual([])
  })

  it('bounds growing streams by actual UTF-8 bytes and closes an oversized iterator', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { size: 1, chunks: ['界', '界', 'unreached'] })
    await expect(loadInstructionContents(reader, [directory('project', '/project', '.')],
      budget(5, 60), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(reader.yielded).toEqual(['界', '界'])
    expect(reader.closed).toEqual(['/project/AGENTS.md'])
  })

  it('accepts exact multibyte limits and rejects the aggregate before retaining another file', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: ['界'] })
    reader.files.set('/project/sub/AGENTS.md', { chunks: ['x'] })
    const dirs = [directory('project', '/project', '.'), directory('project', '/project/sub', 'sub')]
    expect((await loadInstructionContents(reader, dirs.slice(0, 1),
      budget(3, 3), signal())).totalBytes).toBe(3)
    await expect(loadInstructionContents(reader, dirs,
      budget(30, 3), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('rejects invalid limits, excess candidates and cancellation before provider work', async () => {
    const reader = new Reader()
    const dirs = [directory('project', '/project', '.')]
    await expect(loadInstructionContents(reader, dirs, budget(Infinity, 60), signal())).rejects.toThrow('positive safe integer')
    await expect(loadInstructionContents(reader, [...dirs, ...dirs], budget(30, 60, 1), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const cancelled = new AbortController()
    const reason = new Error('cancelled by turn')
    cancelled.abort(reason)
    await expect(loadInstructionContents(reader, dirs, limits, cancelled.signal)).rejects.toBe(reason)
    expect(reader.probes).toEqual([])
  })
})
