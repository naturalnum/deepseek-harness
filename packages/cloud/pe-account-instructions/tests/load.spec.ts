import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { loadInstructionContents } from '../src/load.ts'
import { Reader, limits, budget, directory, signal } from './harness.ts'

describe('instruction content from approved directory targets', () => {
  it('orders sources and reads same-named files through each directory owner', async () => {
    const project = new Reader()
    const child = new Reader()
    const account = new Reader()
    const platform = new Reader()
    // Identical display paths cannot select a provider; the directory owns that choice.
    project.files.set('/source/AGENTS.md', { chunks: ['root'] })
    project.files.set('/source/CLAUDE.md', { chunks: ['must not load'] })
    child.files.set('/source/CLAUDE.md', { chunks: ['child'] })
    account.files.set('/source/AGENTS.md', { chunks: ['account'] })
    platform.files.set('/source/AGENTS.md', { chunks: ['platform'] })
    const result = await loadInstructionContents([
      directory(project, 'project', '/source', '.'), directory(child, 'project', '/source', 'nested'),
      directory(account, 'account', '/source', 'preferences'), directory(platform, 'platform', '/source', 'declaration'),
    ], limits, signal())
    expect(result.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['platform', 'declaration/AGENTS.md', 'platform'], ['account', 'preferences/AGENTS.md', 'account'],
      ['project', 'AGENTS.md', 'root'], ['project', 'nested/CLAUDE.md', 'child'],
    ])
    expect(project.probes).toEqual(['/source/AGENTS.md'])
    expect(project.reads).toEqual(['/source/AGENTS.md'])
    expect(child.probes).toEqual(['/source/AGENTS.md', '/source/CLAUDE.md'])
    expect(child.reads).toEqual(['/source/CLAUDE.md'])
    expect(account.probes).toEqual(['/source/AGENTS.md'])
    expect(account.reads).toEqual(['/source/AGENTS.md'])
    expect(platform.probes).toEqual(['/source/AGENTS.md'])
    expect(platform.reads).toEqual(['/source/AGENTS.md'])
    expect(result.totalBytes).toBe(24)
    expect(Object.isFrozen(result.sources)).toBe(true)
    expect(result.sources.every(source => Object.isFrozen(source) && /^[a-f0-9]{64}$/.test(source.hash))).toBe(true)
  })

  it('preserves the owning reader rejection of another reader target without fallback', async () => {
    const reader = new Reader()
    const other = new Reader()
    reader.files.set('/source/CLAUDE.md', { chunks: ['must not load'] })
    other.files.set('/source/AGENTS.md', { chunks: ['other owner'] })
    const own = directory(reader, 'project', '/source', '.')
    await expect(loadInstructionContents([{ ...own, target: other.target('/source') }], limits, signal()))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(reader.probes).toEqual([])
    expect(reader.reads).toEqual([])
    expect(other.probes).toEqual([])
    expect(other.reads).toEqual([])
  })

  it('falls back only in the owning reader after resolve or stat confirms absence', async () => {
    const project = new Reader()
    const account = new Reader()
    account.files.set('/source/AGENTS.md', { chunks: [], error: new FsError('absent', 'FS_NOT_FOUND') })
    account.files.set('/source/CLAUDE.md', { chunks: ['account fallback'] })
    project.files.set('/source/CLAUDE.md', { chunks: ['project fallback'] })
    const result = await loadInstructionContents([
      directory(project, 'project', '/source', '.'), directory(account, 'account', '/source', 'preferences'),
    ], limits, signal())
    expect(result.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['account', 'preferences/CLAUDE.md', 'account fallback'], ['project', 'CLAUDE.md', 'project fallback'],
    ])
    for (const reader of [account, project]) {
      expect(reader.probes).toEqual(['/source/AGENTS.md', '/source/CLAUDE.md'])
      expect(reader.reads).toEqual(['/source/CLAUDE.md'])
    }
  })

  it('does not use CLAUDE when AGENTS is empty or unreadable', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: [] })
    reader.files.set('/project/CLAUDE.md', { chunks: ['fallback'] })
    const dirs = [directory(reader, 'project', '/project', '.')]
    expect((await loadInstructionContents(dirs, limits, signal())).sources[0]?.text).toBe('')
    const failure = new FsError('unavailable', 'FS_IO_ERROR')
    reader.files.set('/project/AGENTS.md', { chunks: [], error: failure })
    await expect(loadInstructionContents(dirs, limits, signal())).rejects.toBe(failure)
    expect(reader.probes).not.toContain('/project/CLAUDE.md')
  })

  it('distinguishes confirmed absence from a non-regular source', async () => {
    const reader = new Reader()
    const dirs = [directory(reader, 'project', '/project', '.')]
    expect(await loadInstructionContents(dirs, limits, signal())).toEqual({ sources: [], totalBytes: 0 })
    reader.files.set('/project/AGENTS.md', { chunks: [], type: 'other' })
    await expect(loadInstructionContents(dirs, limits, signal())).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect(reader.reads).toEqual([])
  })

  it('bounds growing streams by actual UTF-8 bytes and closes an oversized iterator', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { size: 1, chunks: ['界', '界', 'unreached'] })
    await expect(loadInstructionContents([directory(reader, 'project', '/project', '.')],
      budget(5, 60), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(reader.yielded).toEqual(['界', '界'])
    expect(reader.closed).toEqual(['/project/AGENTS.md'])
  })

  it('accepts exact multibyte limits and rejects the aggregate before retaining another file', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: ['界'] })
    reader.files.set('/project/sub/AGENTS.md', { chunks: ['x'] })
    const dirs = [directory(reader, 'project', '/project', '.'), directory(reader, 'project', '/project/sub', 'sub')]
    expect((await loadInstructionContents(dirs.slice(0, 1),
      budget(3, 3), signal())).totalBytes).toBe(3)
    await expect(loadInstructionContents(dirs,
      budget(30, 3), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('rejects invalid limits, excess candidates and cancellation before provider work', async () => {
    const reader = new Reader()
    const dirs = [directory(reader, 'project', '/project', '.')]
    await expect(loadInstructionContents(dirs, budget(Infinity, 60), signal())).rejects.toThrow('positive safe integer')
    await expect(loadInstructionContents([...dirs, ...dirs], budget(30, 60, 1), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const cancelled = new AbortController()
    const reason = new Error('cancelled by turn')
    cancelled.abort(reason)
    await expect(loadInstructionContents(dirs, limits, cancelled.signal)).rejects.toBe(reason)
    expect(reader.probes).toEqual([])
  })
})
