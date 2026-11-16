/** Bounded in-memory source/sink facts for Node component tests; no Linux capability or deployment authority is issued. */
import { createHash } from 'node:crypto'
import { expect, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SkillBundleSource, SkillBundleVersion } from '../../src/skill-bundles.ts'
import type { WorkspaceSkillWork } from '../../src/workspace-skill.ts'

export function workspaceSkillFixture(actualBinding?: AccountBinding): {
  work: WorkspaceSkillWork
  source: SkillBundleSource
  version: SkillBundleVersion
  members: Map<string, Uint8Array<ArrayBuffer>>
  directories: Set<string>
  published: Map<string, Uint8Array<ArrayBuffer>>
  order: string[]
  releases: () => void
} {
  const signal = new AbortController().signal
  const binding: AccountBinding = actualBinding ?? { accountId: brandString<AccountBinding['accountId']>('workspace-skill-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'fixture', lifetime: signal }
  const members = new Map([
    ['SKILL.md', new TextEncoder().encode('---\nname: workspace-fixture\ndescription: Run nested resources.\n---\nRun scripts/check.py.\n')],
    ['scripts/check.py', new TextEncoder().encode('from pathlib import Path\nprint(Path(__file__).parent.parent.joinpath("data/value.bin").read_bytes().hex())\n')],
    ['data/value.bin', Uint8Array.from([0, 255, 128, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])],
  ])
  const files = [...members].map(([relativePath, data]) => ({ relativePath, bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex') }))
  const version: SkillBundleVersion = { binding, id: brandString<SkillBundleVersion['id']>('11111111-1111-4111-8111-111111111111'),
    format: 'bundle-tree-v1', files, directories: ['scripts', 'data'], treeSha256: 'a'.repeat(64),
    contentBytes: files.reduce((n, file) => n + file.bytes, 0), directoryCount: 2, chargedBytes: 4096, chargedInodes: 6 }
  const source: SkillBundleSource = { version, files, directories: version.directories,
    readText: async () => new TextDecoder().decode(members.get('SKILL.md')),
    readBytes: async (name) => {
      const data = members.get(name)
      if (data === undefined) throw new Error('Unexpected member')
      return Uint8Array.from(data)
    } }
  const directories = new Set<string>(), published = new Map<string, Uint8Array<ArrayBuffer>>(), order: string[] = []
  const releases = vi.fn(), current = vi.fn()
  const work: WorkspaceSkillWork = { source, signal, chunkBytes: 8, assertCurrent: current,
    content: { assertCurrent: current, lstat: async path => ({ value: directories.has(path)
      ? { type: 'directory', version: 'directory', identity: '1:2' }
      : published.has(path) ? { type: 'file', version: 'file', identity: '1:3', size: published.get(path)!.byteLength }
        : undefined, release: releases }) },
    createDirectory: vi.fn<WorkspaceSkillWork['createDirectory']>(async (parent, name) => {
      const path = parent === '.' ? name : `${parent}/${name}`
      if (directories.has(path)) throw new Error('Unexpected directory collision')
      directories.add(path); return path
    }),
    publish: vi.fn<WorkspaceSkillWork['publish']>(async (input) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of input.open(signal)) {
        expect(chunk.byteLength).toBeLessThanOrEqual(8)
        expect(chunk.buffer.byteLength).toBeLessThanOrEqual(8)
        chunks.push(chunk)
      }
      const data = Uint8Array.from(Buffer.concat(chunks))
      expect(data.byteLength).toBe(input.claim.bytes)
      expect(createHash('sha256').update(data).digest('hex')).toBe(input.claim.sha256)
      const path = `${input.workspaceDirectory}/${input.claim.name}`
      order.push(path); published.set(path, data)
      return { value: [{ kind: 'workspace-upload', claim: input.claim, relativePath: path,
        outcome: 'published', facts: { kind: 'published', code: 'OK', publication: 'published', closed: true,
          clean: true, temporaryPresent: false, writtenBytes: data.byteLength, readBytes: 0, sequence: chunks.length,
          retainedCreatedDirectories: 0, publishedName: input.claim.name } }], release: releases }
    }),
  }
  return { work, source, version, members, directories, published, order, releases }
}
