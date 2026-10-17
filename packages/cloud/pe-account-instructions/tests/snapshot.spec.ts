import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { jsonBytes, jsonStringBytes, requiredResidentBytes } from '../src/budget.ts'
import { prepareInstructionSnapshot } from '../src/snapshot.ts'
import type { Config } from '../src/types.ts'
import { Reader, directory, identity, signal } from './harness.ts'

function caps(maxSnapshotBytes = 8192, maxResidentBytes?: number): Config {
  const limits = { maxFiles: 8, maxFileBytes: 256, maxTotalBytes: 512, maxSnapshotBytes }
  return { ...limits, maxResidentBytes: maxResidentBytes ?? requiredResidentBytes(limits) }
}

describe('complete native instruction snapshots', () => {
  it('orders every source, records actual-text hashes and freezes the complete payload', async () => {
    const reader = new Reader()
    reader.files.set('/platform/AGENTS.md', { chunks: ['platform'] })
    reader.files.set('/account/CLAUDE.md', { chunks: ['account'] })
    reader.files.set('/project/AGENTS.md', { chunks: ['root'] })
    reader.files.set('/project/CLAUDE.md', { chunks: ['excluded'] })
    reader.files.set('/project/nested/AGENTS.md', { chunks: ['child'] })
    const message = await prepareInstructionSnapshot(reader, [
      directory('project', '/project/nested', 'nested'), directory('account', '/account', 'preferences'),
      directory('project', '/project', '.'), directory('platform', '/platform', 'declaration'),
    ], identity, caps(), signal())
    const snapshot = message.source.snapshot
    expect(message.source.kind).toBe('pe-account-instructions')
    expect(message.source.form).toBe('instructions')
    expect(snapshot).toMatchObject(identity)
    expect(snapshot.sources.map(source => [source.kind, source.relativeName, source.text])).toEqual([
      ['platform', 'declaration/AGENTS.md', 'platform'], ['account', 'preferences/CLAUDE.md', 'account'],
      ['project', 'AGENTS.md', 'root'], ['project', 'nested/AGENTS.md', 'child'],
    ])
    for (const source of snapshot.sources) {
      expect(source.hash).toBe(createHash('sha256').update(source.text, 'utf8').digest('hex'))
      expect(Object.isFrozen(source)).toBe(true)
    }
    expect(snapshot.totalBytes).toBe(Buffer.byteLength(snapshot.text, 'utf8'))
    expect(message.content).toEqual([{ type: 'text', text: snapshot.text }])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sources)).toBe(true)
    expect(Object.isFrozen(message)).toBe(true)
    reader.files.set('/project/AGENTS.md', { chunks: ['changed later'] })
    expect(snapshot.sources[2]?.text).toBe('root')
    expect(reader.probes).not.toContain('/project/CLAUDE.md')
  })

  it('sizes every encoded metadata/content copy and accepts the exact final limit', async () => {
    const reader = new Reader()
    const text = '\u0001"界\n'
    reader.files.set('/project/AGENTS.md', { chunks: [text] })
    const dirs = [directory('project', '/project', '.')]
    const first = await prepareInstructionSnapshot(reader, dirs, identity, caps(), signal())
    const exact = Buffer.byteLength(JSON.stringify(first), 'utf8')
    expect(jsonBytes(first)).toBe(exact)
    expect(exact).toBeGreaterThan(Buffer.byteLength(first.source.snapshot.text, 'utf8'))
    const admitted = await prepareInstructionSnapshot(reader, dirs, identity, caps(exact), signal())
    expect(jsonBytes(admitted)).toBe(exact)
    await expect(prepareInstructionSnapshot(reader, dirs, identity, caps(exact - 1), signal()))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('rejects labels and copy-budget shortages before any reader operation', async () => {
    const reader = new Reader()
    await expect(prepareInstructionSnapshot(reader, [directory('account', '/account', 'x'.repeat(8192))],
      identity, caps(), signal())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const config = caps()
    await expect(prepareInstructionSnapshot(reader, [directory('project', '/project', '.')], identity,
      caps(8192, config.maxResidentBytes - 1), signal())).rejects.toMatchObject({ code: 'cloud/invalid-config' })
    expect(reader.probes).toEqual([])
  })

  it('bounds identity metadata and empty-snapshot framing independently of source bytes', async () => {
    const reader = new Reader()
    const enormous = { ...identity, accountId: 'a'.repeat(8192) as typeof identity.accountId }
    await expect(prepareInstructionSnapshot(reader, [], enormous, caps(), signal()))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const empty = await prepareInstructionSnapshot(reader, [], identity, caps(), signal())
    expect(empty.source.snapshot.sources).toEqual([])
    expect(empty.source.snapshot.text).toContain('No optional instruction files are present.')
    expect(empty.source.snapshot.totalBytes).toBeGreaterThan(0)
    expect(reader.probes).toEqual([])
  })

  it('rejects sibling, skipped-parent and escaping display chains without granting path authority', async () => {
    const reader = new Reader()
    for (const labels of [['.', 'a', 'b'], ['.', 'a/b'], ['a'], ['../outside'], ['/outside'], ['a\\b']]) {
      const dirs = labels.map(label => directory('project', '/approved', label))
      await expect(prepareInstructionSnapshot(reader, dirs, identity, caps(), signal()))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    expect(reader.probes).toEqual([])
  })

  it('hashes the exact concatenated text even across surrogate boundaries', async () => {
    const reader = new Reader()
    reader.files.set('/project/AGENTS.md', { chunks: ['\uD83D', '\uDE00'] })
    const message = await prepareInstructionSnapshot(reader, [directory('project', '/project', '.')], identity, caps(), signal())
    expect(message.source.snapshot.sources[0]).toMatchObject({
      text: '😀', hash: createHash('sha256').update('😀', 'utf8').digest('hex'),
    })
  })

  it('preserves provider failure and never replaces it with an empty snapshot', async () => {
    const reader = new Reader()
    const failure = new FsError('temporarily unavailable', 'FS_IO_ERROR')
    reader.files.set('/project/AGENTS.md', { chunks: [], error: failure })
    reader.files.set('/project/CLAUDE.md', { chunks: ['must not load'] })
    await expect(prepareInstructionSnapshot(reader, [directory('project', '/project', '.')], identity, caps(), signal()))
      .rejects.toBe(failure)
    expect(reader.probes).toEqual(['/project/AGENTS.md'])
  })

  it('measures escaped JSON and unpaired surrogates without serialized-envelope allocation', () => {
    for (const text of ['plain', '界😀', '\uD800', '\uDC00', '"\\\n\t\u0000\u001F', '\b\f\r']) {
      expect(jsonStringBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text), 'utf8'))
    }
    const sample = { a: ['\uD800', '界', null, false, 17], b: { escaped: '\u0000' } }
    expect(jsonBytes(sample)).toBe(Buffer.byteLength(JSON.stringify(sample), 'utf8'))
  })
})
