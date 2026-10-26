import { describe, expect, it } from 'vitest'
import { managedSkillApiLimits, managedSkillCodecs } from '../src/managed-skill-json.ts'

const limits = { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 }
const codecs = managedSkillCodecs(limits)
const version = { epoch: '34', editToken: 'abce1234-1234-1234-1234-abce12345678' }
const skillId = 'abcd1234-1234-1234-1234-abcd12345678'
const contentVersion = 'version:abcd1234-1234-1234-1234-abcd12345678'
const digest = 'a'.repeat(64)
const bundle = { kind: 'files', files: [
  { relativePath: 'SKILL.md', dataBase64: Buffer.from('---\nname: example\ndescription: Example\n---\nBody').toString('base64') },
  { relativePath: 'nested/resource.bin', dataBase64: 'AP8=' },
] }
const entry = { skillId, contentVersion, name: 'example', description: 'Example', source: 'custom',
  provider: 'account-published-skills', invocation: { modelInvocable: true, userInvocable: true },
  fileCount: 2, contentBytes: 3, legacySample: false, selection: { kind: 'effective' }, mutable: true,
  actions: { update: true, uninstall: true, download: true } }
const publicLimits = { maxSkills: 8, maxFilesPerBundle: 32, maxDirectoriesPerBundle: 16, maxFileBytes: 4096,
  maxBundleBytes: 16384, maxZipBytes: 16384, maxPathBytes: 256, maxPathDepth: 8,
  maxRequestBytes: limits.maxRequestBytes, maxReplyBytes: limits.maxReplyBytes }

describe('managed skill strict JSON', () => {
  it('accepts complete nested-file, ZIP, legacy-id and workspace requests without deriving identity', () => {
    expect(codecs.install.create().parse({ version, bundle })).toEqual({ version, bundle })
    expect(codecs.update.create().parse({ skillId, version, bundle: { kind: 'zip', dataBase64: 'UEs=' } })).toEqual({
      skillId, version, bundle: { kind: 'zip', dataBase64: 'UEs=' } })
    expect(codecs.details.create().parse({ skillId: 'sample' })).toEqual({ skillId: 'sample' })
    expect(codecs.installed.create().parse({})).toEqual({})
    expect(codecs.installed.create().parse({ workspaceId: 'workspace-1' })).toEqual({ workspaceId: 'workspace-1' })
  })

  it.each(['accountId', 'cwd', 'rank', 'nativeRevision'])('rejects caller authority field %s', (key) => {
    expect(() => codecs.install.create().parse({ version, bundle, [key]: 'untrusted' })).toThrow()
    expect(() => codecs.installed.create().parse({ [key]: 'untrusted' })).toThrow()
  })

  it('rejects URL import, mixed input variants, noncanonical base64 and incomplete files', () => {
    for (const value of [
      { kind: 'url', url: 'https://example.test/x.skill' },
      { kind: 'zip', dataBase64: 'UEs=', files: [] },
      { kind: 'files', files: [], dataBase64: '' },
      { kind: 'files', files: [{ relativePath: 'SKILL.md', dataBase64: 'YQ' }] },
      { kind: 'files', files: [{ relativePath: 'SKILL.md' }] },
    ]) expect(() => codecs.install.create().parse({ version, bundle: value })).toThrow()
  })

  it('requires every explicit finite limit and refuses request overflow', () => {
    expect(() => managedSkillApiLimits({ ...limits, maxRequestBytes: 0 })).toThrow()
    expect(() => managedSkillApiLimits({ ...limits, maxRetainedProviders: Number.POSITIVE_INFINITY })).toThrow()
    const extra = { ...limits, extra: 1 }
    expect(() => managedSkillApiLimits(extra)).toThrow()
    expect(() => managedSkillCodecs({ ...limits, maxRequestBytes: 64 }).install.create().parse({ version, bundle })).toThrow()
  })

  it('preserves complete versus incomplete native observations and exposes no private locator', () => {
    const value = { entries: [entry], version, complete: false, actions: { install: true }, limits: publicLimits }
    expect(codecs.installedResult.create().parse(value)).toEqual(value)
    expect(() => codecs.installedResult.create().parse({ ...value, entries: [{ ...entry, path: '/private/skills' }] })).toThrow()
    expect(() => codecs.installedResult.create().parse({ ...value, entries: [{ ...entry, selection: { kind: 'effective', by: {} } }] })).toThrow()
  })

  it('keeps persistence/application/unknown independent and does not attach a replay token to unknown', () => {
    expect(codecs.mutationResult.create().parse({ persisted: 'unknown', applied: false })).toEqual({ persisted: 'unknown', applied: false })
    expect(codecs.mutationResult.create().parse({ persisted: true, applied: false, version, entry })).toEqual({
      persisted: true, applied: false, version, entry })
    expect(codecs.mutationResult.create().parse({ persisted: true, applied: true, version, entry: null })).toEqual({
      persisted: true, applied: true, version, entry: null })
    expect(() => codecs.mutationResult.create().parse({ persisted: 'unknown', applied: false, version })).toThrow()
    expect(() => codecs.mutationResult.create().parse({ persisted: 'unknown', applied: true })).toThrow()
  })

  it('requires complete detail byte totals and a bounded full ZIP export', () => {
    const files = [{ relativePath: 'SKILL.md', bytes: 1, sha256: digest }, { relativePath: 'nested/resource.bin', bytes: 2, sha256: digest }]
    expect(codecs.detailsResult.create().parse({ entry, files, version })).toEqual({ entry, files, version })
    expect(() => codecs.detailsResult.create().parse({ entry, files: files.slice(0, 1), version })).toThrow()
    const exported = { skillId, contentVersion, fileName: 'example.skill', mediaType: 'application/zip', bytes: 2,
      sha256: digest, dataBase64: 'UEs=' }
    expect(codecs.downloadResult.create().parse(exported)).toEqual(exported)
    expect(() => codecs.downloadResult.create().parse({ ...exported, bytes: 3 })).toThrow()
  })
})
