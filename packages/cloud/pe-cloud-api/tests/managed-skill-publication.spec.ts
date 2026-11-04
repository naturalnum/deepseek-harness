/** API coordination with the real Loader, native registry/parser and AccountSaves; files is an explicit in-memory port fixture. */
import { createHash, randomUUID } from 'node:crypto'
import { zipSync, unzipSync } from 'fflate'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { fileURLToPath } from 'node:url'
import { decodeBundle } from '../../pe-cloud-files/src/bundle-codec.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { getEventListeners } from 'node:events'
import SkillRegistry, { type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { FdMutationFailure, FilesFailure, type SkillBundlePort, type SkillBundleVersion, type SkillCatalog, type SkillInstallationId,
  type SkillVersion, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { AccountManagedSkills } from '../src/managed-skill-publication.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'

const apiLimits = { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 }
const bundleLimits = { maxInstallations: 4, maxFiles: 8, maxDirectories: 6, maxDepth: 5, maxPathBytes: 256,
  maxFileBytes: 4096, maxContentBytes: 16384, maxArchiveBytes: 32768, maxArchiveEntries: 16,
  maxExpandedArchiveBytes: 16384, maxInputBytes: 65536, maxManifestBytes: 8192,
  maxCatalogBytes: 8192, maxDownloadBytes: 32768, maxRequestBytes: 65536, maxReplyBytes: 131072,
  maxStagingBytes: 65536, reservationBytes: 65536 }
const sampleLimits = { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 8192, maxRetainedVersions: 8 }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const body = (name: string, text = 'body') => `---\nname: ${name}\ndescription: Description ${name}\n---\n${text}\n`
const bundle = (name: string, text = 'body') => ({ kind: 'files' as const, files: [
  { relativePath: 'SKILL.md', dataBase64: Buffer.from(body(name, text)).toString('base64') },
  { relativePath: 'nested/data.bin', dataBase64: Buffer.from('resource').toString('base64') },
  { relativePath: 'nested/scripts/run.sh', dataBase64: Buffer.from('echo data-only').toString('base64') }] })
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
const own = <T>(value: T) => ({ value, release() {} })
async function fixture(configuredLimits = apiLimits, builtins = false) {
  const home = mkdtempSync(join(tmpdir(), 'managed-skills-api-')), profileDir = join(home, 'profiles/test')
  mkdirSync(profileDir, { recursive: true }); initProfile(profileDir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"managed-api-test"}')
  const config = join(profileDir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([{ id: 'skills', name: 'cordis:skills' }, ...!builtins ? [] : [
    { id: 'office', name: 'cordis:office', config: {
      assetRoot: fileURLToPath(new URL('../../../skill/skill-office/assets', import.meta.url)),
      executionRoot: '/opt/dsh/skills/office', packagedBundles: true,
      executionRuntime: { node: '/opt/dsh/runtime/dependencies/node/bin/node', cli: '/opt/dsh/runtime/dependencies/node/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js' } } },
    { id: 'reports', name: 'cordis:reports', config: { includeDefaultRoots: false, watch: false, providerName: 'dsh-reports',
      bundledSkillDir: fileURLToPath(new URL('../../../skill/skill-office/assets/reports', import.meta.url)),
      bundledExecutionRoot: '/opt/dsh/skills/reports', packagedBundles: true } },
  ]]))
  const ctx = await boot('managed-api-test', config, [], (owner) => {
    owner.provide('profileContext', { name: 'test', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
    Object.assign(owner.loader.builtins, { skills: SkillRegistry, office: SkillOffice, reports: SkillFilesystem })
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const lifetime = new AbortController(), signal = lifetime.signal
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('a'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'test', lifetime: signal }
  const coordinator = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 16, maxQueuedPerAccount: 16,
    maxTrackedOperations: 32, maxTrackedOperationsPerAccount: 32, maxNestedPerOperation: 32, maxWaitersPerAccount: 4 })
  const saves = coordinator.createAccount(binding)
  // Non-null directory exists while sample is absent; this distinguishes the original directory revision from sample presence.
  let catalog: SkillCatalog = Object.freeze({ entries: [], revision: FsVersion('directory-0') })
  let preparationFailure: Error | undefined, commitFailure: Error | undefined, afterCommit: (() => void) | undefined
  let prepares = 0, commits = 0, sources = 0, exports = 0, borrows = 0, failApply = false, unknownCommit = false
  let projectionFailure: Error | undefined
  let exportBlock: ReturnType<typeof deferred> | undefined, sourceBlock: ReturnType<typeof deferred> | undefined
  let afterSource: (() => void) | undefined, sourceResidents = 0, sourceReleases = 0
  const prepared = new Map<SkillBundleVersion, number>(), releases = new Map<string, number>()
  const releaseWhilePending: boolean[] = [], sourcePreparedRefs: number[] = [], commitPreparedRefs: number[] = []
  const preparedResident = <T>(value: T, version: SkillBundleVersion) => {
    prepared.set(version, (prepared.get(version) ?? 0) + 1)
    let released = false
    return { value, release() {
      if (released) throw Error('Prepared resident released more than once')
      released = true; releases.set(version.id, (releases.get(version.id) ?? 0) + 1)
      releaseWhilePending.push(saves.snapshot().pending.some(operation => operation.kind === 'skill-publish'))
      prepared.set(version, (prepared.get(version) ?? 0) - 1)
    } }
  }
  const allowed = (version: SkillBundleVersion): void => {
    if (!(prepared.get(version) ?? 0) && !catalog.entries.some(entry => entry.version === version)) {
      throw new FdMutationFailure('not-published', 'FS_STALE_VERSION')
    }
  }
  const activeSourceLeases = new Set<SkillBundleVersion>(), materialized: SkillBundleVersion[] = []
  const bytes = new Map<SkillBundleVersion, Map<string, Uint8Array<ArrayBuffer>>>(), issued = new Set<SkillCatalog>([catalog])
  const port: SkillBundlePort = {
    async prepareBundle(input, control) {
      control.throwIfAborted(); prepares++
      if (preparationFailure !== undefined) throw preparationFailure
      if (input.kind === 'zip') {
        await decodeBundle(input, bundleLimits, control)
        throw Error('This fixture only decodes ZIPs rejected before preparation')
      }
      const data = new Map(input.files.map(file => [file.relativePath, Uint8Array.from(Buffer.from(file.dataBase64, 'base64'))]))
      const files = [...data].map(([relativePath, value]) => ({ relativePath, bytes: value.byteLength, sha256: hash(value) }))
      const version: SkillBundleVersion = Object.freeze({ binding, id: brandString<SkillBundleVersion['id']>(randomUUID()),
        format: 'bundle-tree-v1', files, directories: ['nested', 'nested/scripts'], treeSha256: hash(JSON.stringify(files)),
        contentBytes: files.reduce((sum, file) => sum + file.bytes, 0), directoryCount: 2, chargedBytes: 4096, chargedInodes: 8 })
      bytes.set(version, data); return preparedResident(version, version)
    },
    async observeCatalog(control) { control.throwIfAborted(); return own(catalog) },
    async commitCatalog(expected, change, control) {
      control.throwIfAborted(); commits++
      if (change.kind !== 'uninstall') {
        commitPreparedRefs.push(prepared.get(change.bundle) ?? 0); allowed(change.bundle)
      }
      if (commitFailure !== undefined) throw commitFailure
      if (!issued.has(expected) || expected !== catalog) throw new FdMutationFailure('not-published', 'FS_STALE_VERSION')
      const entry = change.kind === 'uninstall' ? null : { skillId: change.kind === 'install'
        ? brandString<SkillInstallationId>(randomUUID()) : change.skillId, kind: 'managed' as const, version: change.bundle }
      const entries = change.kind === 'install' ? [...catalog.entries, entry!]
        : change.kind === 'update' ? catalog.entries.map(old => old.skillId === change.skillId ? entry! : old)
          : catalog.entries.filter(old => old.skillId !== change.skillId)
      catalog = Object.freeze({ entries, revision: FsVersion(`directory-${commits}`) }); issued.add(catalog)
      afterCommit?.()
      if (unknownCommit) throw new FdMutationFailure('unknown', 'FS_IO_ERROR')
      return own({ catalog, entry })
    },
    async withBundleSource(version, consume, control) {
      control.throwIfAborted(); sourcePreparedRefs.push(prepared.get(version) ?? 0); allowed(version)
      sources++; borrows++
      const data = bytes.get(version); if (data === undefined) throw Error('Unissued source')
      const lease = Object.freeze({ ...version }); activeSourceLeases.add(lease)
      try {
        await sourceBlock?.promise
        const value = await consume({ version: lease, files: version.files, directories: version.directories,
          async readText(path, child) { child?.throwIfAborted(); return Buffer.from(data.get(path)!).toString('utf8') },
          async readBytes(path, child) { child?.throwIfAborted(); const value = data.get(path); if (value === undefined) throw Error('Missing'); return Uint8Array.from(value) } }, control)
        sourceResidents++; afterSource?.()
        let released = false
        return { value, release() {
          if (released) throw Error('Source resident released more than once')
          released = true; sourceResidents--; sourceReleases++
        } }
      } finally { activeSourceLeases.delete(lease); borrows-- }
    },
    async exportBundle(version, control) {
      control.throwIfAborted(); exports++; borrows++
      try { await exportBlock?.promise; return own(Uint8Array.from(Buffer.from(JSON.stringify([...bytes.get(version)!].map(([path, data]) => [path, Buffer.from(data).toString('base64')]))))) }
      finally { borrows-- }
    },
    materializeBundleVersion() { return Promise.reject(Error('No projection handle is fabricated in this API fixture')) },
  }
  const legacySources = new Map<SkillVersion, SkillBundleVersion>()
  const legacy: SkillVersionPort = {
    async prepare(input, control) {
      control.throwIfAborted(); prepares++
      const content = new Map([['SKILL.md', new TextEncoder().encode(input.skillMarkdown)], ['resource.bin', input.resource]])
      const files = [...content].map(([relativePath, data]) => ({ relativePath, bytes: data.byteLength, sha256: hash(data) }))
      const full: SkillBundleVersion = { binding, id: brandString<SkillBundleVersion['id']>(randomUUID()), format: 'legacy-two-file',
        files, directories: [], treeSha256: hash(JSON.stringify(files)), contentBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        directoryCount: 0, chargedBytes: 4096, chargedInodes: 3 }
      bytes.set(full, content)
      const version: SkillVersion = { binding, id: full.id, skillBytes: files[0]!.bytes, skillSha256: files[0]!.sha256,
        resourceBytes: files[1]!.bytes, resourceSha256: files[1]!.sha256 }
      legacySources.set(version, full); return preparedResident(version, full)
    },
    async current(control) {
      control.throwIfAborted()
      const sample = catalog.entries.find(entry => entry.kind === 'legacy-sample')
      if (sample === undefined) return own(undefined)
      const version = [...legacySources].find(([, full]) => full === sample.version)?.[0]
      if (version === undefined || catalog.revision === null) throw Error('Unknown legacy handle')
      return own({ version, revision: catalog.revision })
    },
    async commit(version, expected, control) {
      control.throwIfAborted()
      if (expected !== catalog.revision) throw new FdMutationFailure('not-published', 'FS_STALE_VERSION')
      const full = legacySources.get(version); if (full === undefined) throw Error('Unissued legacy handle')
      commitPreparedRefs.push(prepared.get(full) ?? 0); allowed(full)
      commits++
      if (commitFailure !== undefined) throw commitFailure
      catalog = { entries: [...catalog.entries.filter(entry => entry.kind !== 'legacy-sample'),
        { skillId: brandString<SkillInstallationId>('sample'), kind: 'legacy-sample', version: full }], revision: FsVersion(`directory-${commits}`) }
      issued.add(catalog)
      afterCommit?.()
      if (unknownCommit) throw new FdMutationFailure('unknown', 'FS_IO_ERROR')
      return own({ version, revision: catalog.revision! })
    },
    withSource(version, consume, control) {
      const full = legacySources.get(version); if (full === undefined) return Promise.reject(Error('Unissued legacy handle'))
      return port.withBundleSource(full, (source, signal) => consume({ version,
        readText: (path, child) => source.readText(path, child),
        readBytes: (path, child) => source.readBytes(path, child) }, signal), control)
    },
  }

  let manager!: AccountManagedSkills, providerSignal!: AbortSignal
  const resources = {
    assertCaller(options: import('@deepseek-ai/dsh-skill').SkillViewOptions) { if (options.scope !== ctx) throw Error('Original live caller required') },
    async materialize(version: SkillBundleVersion, options: import('@deepseek-ai/dsh-skill').SkillViewOptions) {
      if (options.scope !== ctx || !activeSourceLeases.has(version) || bytes.has(version)) throw Error('Exact active operation source lease required')
      materialized.push(version)
      expect(borrows).toBe(1)
      if (projectionFailure !== undefined) throw projectionFailure
      return { resourceBase: { kind: 'directory' as const, path: `/test/project/.pe/skills/${version.id}/` } }
    },
  }
  ctx.skills.registerProvider((control: SkillProviderControl) => {
    providerSignal = control.signal
    const actual = { signal: control.signal, invalidate() { if (failApply) throw Error('Native apply failed'); control.invalidate() } }
    manager = new AccountManagedSkills(ctx, actual, saves, port, legacy, ctx.skills, {
      limits: configuredLimits,
      bundleLimits: builtins ? { ...bundleLimits, maxFiles: 512, maxDirectories: 256,
        maxFileBytes: 2 * 1024 * 1024, maxContentBytes: 8 * 1024 * 1024,
        maxArchiveBytes: 4 * 1024 * 1024 } : bundleLimits,
      assertWorkspace() { throw Error('No workspace authorized in fixture') }, resources }, sampleLimits)
    return manager
  })
  await manager.restore(() => {})
  return { ctx, manager, saves, signal, ports: { bundle: port, legacy }, check: () => {},
    preparedStats: () => ({ active: [...prepared.values()].reduce((sum, count) => sum + count, 0),
      releases: [...releases.values()], releaseWhilePending: [...releaseWhilePending],
      sourcePreparedRefs: [...sourcePreparedRefs], commitPreparedRefs: [...commitPreparedRefs] }),
    failCommit: (error: Error) => { commitFailure = error },
    afterCommit: (callback: () => void) => { afterCommit = callback },
    materialize: resources.materialize.bind(resources), materialized: () => [...materialized],
    stats: () => ({ prepares, commits, sources, exports, borrows, sourceResidents, sourceReleases,
      providerListeners: getEventListeners(providerSignal, 'abort').length }), catalog: () => catalog,
    afterSource: (callback: () => void) => { afterSource = callback },
    failPrepare: (error: Error) => { preparationFailure = error },
    failProjection: (error: Error | undefined) => { projectionFailure = error },
    failApply: () => { failApply = true }, unknownCommit: () => { unknownCommit = true },
    blockExport() { exportBlock = deferred(); return exportBlock }, blockSource() { sourceBlock = deferred(); return sourceBlock } }
}

it('installs two complete roots, exposes native selection and replaces the original directory edit', async () => {
  const f = await fixture(), initial = await f.manager.current(f.check, f.signal)
  expect(initial.current).toBeNull(); expect(f.catalog().revision).not.toBeNull()
  const first = await f.manager.install(initial.version, bundle('first'), f.check, f.signal)
  expect(first.persisted).toBe(true)
  if (first.persisted !== true || first.entry === null) throw Error('Expected confirmed install')
  const before = f.stats().prepares
  await expect(f.manager.install(initial.version, bundle('stale'), f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(f.stats().prepares).toBe(before)
  const second = await f.manager.install(first.version, bundle('second'), f.check, f.signal)
  expect(second.persisted).toBe(true)
  const list = await f.manager.installed({}, f.check, f.signal)
  expect(list.complete).toBe(true); expect(list.entries.map(row => row.name)).toEqual(['first', 'second'])
  expect(list.entries.every(row => row.selection.kind === 'effective')).toBe(true)
  expect(list.entries.every(row => row.fileCount === 3 && !JSON.stringify(row).includes('/skill-source/'))).toBe(true)
  const details = await f.manager.details(first.entry.skillId, f.check, f.signal)
  expect(details.files.map(file => file.relativePath)).toContain('nested/scripts/run.sh')
  expect(details.markdown).toBe(body('first'))
  const loaded = await f.ctx.skills.get('first', { scope: f.ctx, signal: f.signal })
  expect(loaded?.content).toContain('body'); expect(loaded?.resourceBase?.kind).toBe('directory')
  const updated = await f.manager.update(first.entry.skillId, details.version, bundle('first', 'new body'), f.check, f.signal)
  expect(updated.persisted).toBe(true)
  if (updated.persisted !== true || updated.entry === null) throw Error('Expected confirmed update')
  expect(updated.entry.contentVersion).not.toBe(first.entry.contentVersion)
  expect((await f.manager.installed({}, f.check, f.signal)).entries.find(row => row.skillId === first.entry!.skillId)?.contentVersion)
    .toBe(updated.entry.contentVersion)
  await expect(f.manager.download({ skillId: first.entry.skillId, contentVersion: first.entry.contentVersion }, f.check, f.signal))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  const reloaded = await f.ctx.skills.get('first', { scope: f.ctx })
  expect(reloaded?.content).toContain('new body')
  expect(reloaded?.resourceBase).toEqual({ kind: 'directory', path: `/test/project/.pe/skills/${updated.entry.contentVersion}/` })
})

it('keeps the updated native catalog current when workspace projection rejects a stale record', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const old = await f.manager.install(initial.version, bundle('pdf', 'old body'), f.check, f.signal)
  if (old.persisted !== true || old.entry === null) throw Error('Expected confirmed install')
  expect((await f.ctx.skills.get('pdf', { scope: f.ctx }))?.content).toContain('old body')
  const updated = await f.manager.update(old.entry.skillId, old.version, bundle('pdf', 'new body'), f.check, f.signal)
  if (updated.persisted !== true || updated.entry === null) throw Error('Expected confirmed update')
  f.failProjection(new FdMutationFailure('not-published', 'FS_STALE_VERSION'))
  expect((await f.manager.installed({}, f.check, f.signal)).entries[0]?.contentVersion).toBe(updated.entry.contentVersion)
  await expect(f.ctx.skills.get('pdf', { scope: f.ctx })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(f.materialized().at(-1)?.id).toBe(updated.entry.contentVersion)
  f.failProjection(undefined)
  const loaded = await f.ctx.skills.get('pdf', { scope: f.ctx })
  expect(loaded?.content).toContain('new body')
  expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: `/test/project/.pe/skills/${updated.entry.contentVersion}/` })
})

it('retains an unknown save outcome when a committed catalog response omits its revision', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const commit = f.ports.bundle.commitCatalog.bind(f.ports.bundle)
  vi.spyOn(f.ports.bundle, 'commitCatalog').mockImplementation(async (...args) => {
    const held = await commit(...args)
    return { value: { ...held.value, catalog: { ...held.value.catalog, revision: null } },
      release: () => { held.release() } }
  })
  expect(await f.manager.install(initial.version, bundle('missing-revision'), f.check, f.signal))
    .toMatchObject({ persisted: 'unknown', applied: false })
  expect(f.stats().commits).toBe(1)
  expect(f.catalog().entries).toHaveLength(1)
  expect(f.catalog().revision).not.toBeNull()
  expect(f.saves.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
})

it('uses native overriddenBy for a runtime winner without exporting private candidate metadata', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  await f.manager.install(initial.version, bundle('same-name'), f.check, f.signal)
  f.ctx.skills.register({ name: 'same-name', description: 'Runtime wins', content: 'runtime', source: 'runtime' })
  const list = await f.manager.installed({}, f.check, f.signal)
  expect(list.entries[0]?.selection).toEqual({ kind: 'shadowed', by: { name: 'same-name', source: 'runtime', provider: 'runtime' } })
  expect(JSON.stringify(list)).not.toMatch(/locator|rank|resourceBase|\/skill-source\//)
})

it('denies an old candidate queued behind uninstall before new source I/O', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('remove-me'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const inspection = await f.ctx.skills.inspect(), candidate = inspection.candidates.find(row => row.candidate.name === 'remove-me')?.candidate
  if (candidate === undefined) throw Error('Expected original candidate')
  const block = deferred(), running = f.saves.admit('settings', () => block.promise)
  const removed = f.manager.uninstall(installed.entry.skillId, installed.version, f.check, f.signal)
  const load = f.manager.get(candidate, { scope: f.ctx }), reads = f.stats().sources
  block.release(); await running; expect((await removed).persisted).toBe(true)
  expect(await load).toBeUndefined(); expect(f.stats().sources).toBe(reads)
  expect(await f.ctx.skills.get('remove-me', { scope: f.ctx })).toBeUndefined()
})

it('holds an in-flight export and its original save turn through pause observation and later uninstall', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('download-me'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const block = f.blockExport()
  const download = f.manager.download({ skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion },
    f.check, f.signal)
  while (f.stats().exports === 0) await new Promise(resolve => setTimeout(resolve, 0))
  const remove = f.manager.uninstall(installed.entry.skillId, installed.version, f.check, f.signal)
  expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
  expect(f.stats().borrows).toBe(1); expect(f.stats().commits).toBe(1)
  block.release(); const exported = await download; expect(exported.bytes).toBeGreaterThan(0)
  expect(Buffer.from(exported.dataBase64, 'base64').toString()).toContain('nested/scripts/run.sh')
  expect((await remove).persisted).toBe(true); expect(f.stats().borrows).toBe(0)
  expect((await f.saves.pauseAccountChanges(Date.now() + 100)).status).toBe('confirmed')
})

it('reads exact current instruction, script and binary files without executing or exporting the bundle', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const input = bundle('view-files')
  input.files[1] = { relativePath: 'nested/data.bin', dataBase64: 'AP8=' }
  const installed = await f.manager.install(initial.version, input, f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const selectors = { skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion }
  const before = f.stats()
  for (const file of input.files) {
    const content = await f.manager.readFile({ ...selectors, relativePath: file.relativePath }, f.check, f.signal)
    const bytes = Buffer.from(file.dataBase64, 'base64')
    expect(content).toEqual({ ...selectors, relativePath: file.relativePath, bytes: bytes.byteLength,
      sha256: hash(bytes), dataBase64: file.dataBase64 })
  }
  expect(f.stats().sourceReleases).toBe(before.sourceReleases + input.files.length)
  expect(f.stats().sourceResidents).toBe(0); expect(f.stats().borrows).toBe(0)
  expect(f.stats().exports).toBe(before.exports); expect(f.stats().commits).toBe(before.commits)
})

it('rejects stale versions, unknown installations and nonmember paths before borrowing source bytes', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('view-members'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const request = { skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion, relativePath: 'SKILL.md' }
  const before = f.stats().sources
  await expect(f.manager.readFile({ ...request, contentVersion: brandString<typeof request.contentVersion>('old') }, f.check, f.signal))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(f.manager.readFile({ ...request, skillId: brandString<SkillInstallationId>(randomUUID()) }, f.check, f.signal))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  for (const relativePath of ['../SKILL.md', '/SKILL.md', 'nested/../SKILL.md', 'nested\\scripts\\run.sh', 'missing.py']) {
    await expect(f.manager.readFile({ ...request, relativePath }, f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  }
  // Unknown ids now inspect the native packaged catalog before refusal; the read settles in the same save turn.
  expect(f.stats().sources).toBe(before + 1); expect(f.stats().sourceResidents).toBe(0)
  expect(f.saves.snapshot().failures).toEqual([])
})

it('keeps file reading in the save turn until the source settles before uninstall', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('read-and-remove'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const block = f.blockSource(), before = f.stats().sourceReleases
  const read = f.manager.readFile({ skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion,
    relativePath: 'nested/scripts/run.sh' }, f.check, f.signal)
  await vi.waitFor(() => { expect(f.stats().borrows).toBe(1) }, { interval: 1 })
  const remove = f.manager.uninstall(installed.entry.skillId, installed.version, f.check, f.signal)
  expect(f.stats().commits).toBe(1)
  block.release(); expect(Buffer.from((await read).dataBase64, 'base64').toString()).toBe('echo data-only')
  expect((await remove).persisted).toBe(true)
  expect(f.stats().sourceReleases).toBe(before + 1); expect(f.stats().sourceResidents).toBe(0)
})

it.each(['observer', 'peer'] as const)('denies %s revocation after source await and settles the source', async (mode) => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('late-revocation'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const request = { skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion, relativePath: 'SKILL.md' }
  const observer = new AbortController(), before = f.stats().sourceReleases
  let revoked = false
  f.afterSource(() => { if (mode === 'observer') observer.abort(); else revoked = true })
  await expect(f.manager.readFile(request, () => {
    observer.signal.throwIfAborted()
    if (revoked) throw Error('Peer withdrawn')
  }, observer.signal)).rejects.toThrow()
  expect(f.stats().sourceReleases).toBe(before + 1); expect(f.stats().sourceResidents).toBe(0)
  expect(f.saves.snapshot().failures).toEqual([])
})

it('does not borrow file bytes when the Peer ends during catalog observation', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('revoked-before-borrow'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const original = f.ports.bundle.observeCatalog.bind(f.ports.bundle), before = f.stats().sources
  let revoked = false
  f.ports.bundle.observeCatalog = async (signal) => {
    const held = await original(signal); revoked = true; return held
  }
  await expect(f.manager.readFile({ skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion,
    relativePath: 'SKILL.md' }, () => { if (revoked) throw Error('Peer withdrawn') }, f.signal)).rejects.toThrow('Peer withdrawn')
  expect(f.stats().sources).toBe(before); expect(f.stats().sourceResidents).toBe(0)
})

it('refuses oversized complete file responses without publishing or retaining source work', async () => {
  const f = await fixture({ ...apiLimits, maxReplyBytes: 1500 }), initial = await f.manager.installed({}, f.check, f.signal)
  const input = bundle('bounded-read'); input.files[1] = { relativePath: 'nested/data.bin', dataBase64: Buffer.alloc(2000).toString('base64') }
  const installed = await f.manager.install(initial.version, input, f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  await expect(f.manager.readFile({ skillId: installed.entry.skillId, contentVersion: installed.entry.contentVersion,
    relativePath: 'nested/data.bin' }, f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.stats().sourceResidents).toBe(0); expect(f.stats().borrows).toBe(0); expect(f.stats().commits).toBe(1)
  expect(f.saves.snapshot().failures).toEqual([])
})

it('retains a confirmed native apply failure separately from an unknown durable outcome', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  f.failApply(); const applied = await f.manager.install(initial.version, bundle('apply-fail'), f.check, f.signal)
  expect(applied).toMatchObject({ persisted: true, applied: false })
  expect(f.saves.snapshot().failures).toHaveLength(1)
  const g = await fixture(), other = await g.manager.installed({}, g.check, g.signal)
  g.unknownCommit(); const unknown = await g.manager.install(other.version, bundle('unknown'), g.check, g.signal)
  expect(unknown).toEqual({ persisted: 'unknown', applied: false }); expect(g.stats().commits).toBe(1)
  expect(g.saves.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
  await expect(g.manager.install(other.version, bundle('replay'), g.check, g.signal)).rejects.toBeDefined()
  expect(g.stats().commits).toBe(1)
})

it('rejects invalid native bundles without poisoning save responsibility or executing resources', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const input = bundle('valid'); input.files[0]!.dataBase64 = Buffer.from('missing frontmatter').toString('base64')
  await expect(f.manager.install(initial.version, input, f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.stats().commits).toBe(0); expect(f.saves.snapshot().failures).toEqual([])
})


it('preserves the two-file sample and other roots through the same directory edit and legacy CAS', async () => {
  const f = await fixture(), initial = await f.manager.current(f.check, f.signal)
  const sample = await f.manager.publish(initial.version, body('sample', 'legacy body'), Uint8Array.from([1, 2]), f.check, f.signal)
  if (sample.persisted !== true) throw Error('Expected confirmed sample')
  const first = await f.manager.install(sample.version, bundle('separate'), f.check, f.signal)
  if (first.persisted !== true || first.entry === null) throw Error('Expected managed root')
  const stalePrepares = f.stats().prepares
  await expect(f.manager.publish(sample.version, body('sample'), Uint8Array.from([3]), f.check, f.signal))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(f.stats().prepares).toBe(stalePrepares)
  const current = await f.manager.current(f.check, f.signal)
  expect(current.current?.id).toBe(sample.current.id)
  const again = await f.manager.publish(current.version, body('sample', 'replacement'), Uint8Array.from([4]), f.check, f.signal)
  expect(again.persisted).toBe(true)
  const listed = await f.manager.installed({}, f.check, f.signal)
  expect(listed.entries.map(entry => entry.name).sort()).toEqual(['sample', 'separate'])
  const legacy = listed.entries.find(entry => entry.legacySample)
  if (legacy === undefined) throw Error('Expected preserved legacy installation')
  expect(legacy.actions.update).toBe(false)
  const before = f.stats().prepares
  await expect(f.manager.update(legacy.skillId, listed.version, bundle('sample'), f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.stats().prepares).toBe(before)
  expect(f.catalog().entries).toHaveLength(2)
})

it('keeps resource Markdown and nested SKILL.md as data within one native root', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal), input = bundle('only-root')
  input.files.push({ relativePath: 'README.md', dataBase64: Buffer.from(body('not-an-installation')).toString('base64') },
    { relativePath: 'nested/SKILL.md', dataBase64: Buffer.from(body('also-data')).toString('base64') })
  expect((await f.manager.install(initial.version, input, f.check, f.signal)).persisted).toBe(true)
  expect((await f.ctx.skills.list()).map(row => row.name)).toEqual(['only-root'])
  expect((await f.manager.installed({}, f.check, f.signal)).entries[0]?.fileCount).toBe(5)
})


it('settles removed native providers in the original save turn before reporting clean', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('dispose-me'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const block = deferred(), entered = deferred()
  const original: unknown = Reflect.get(FileSystemSkillProvider.prototype, 'dispose')
  if (typeof original !== 'function') throw new Error('Original provider disposer is missing')
  const spy = vi.spyOn(FileSystemSkillProvider.prototype, 'dispose').mockImplementation(async function (this: FileSystemSkillProvider) {
    entered.release(); await block.promise; await Reflect.apply(original, this, [])
  })
  try {
    const removal = f.manager.uninstall(installed.entry.skillId, installed.version, f.check, f.signal)
    await entered.promise
    expect(f.catalog().entries).toHaveLength(0)
    expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
    block.release(); expect(await removal).toMatchObject({ persisted: true, applied: true })
    expect((await f.saves.pauseAccountChanges(Date.now() + 100)).status).toBe('confirmed')
  } finally { block.release(); spy.mockRestore() }
})

it('reuses finite provider capacity after repeated install/uninstall without accumulating parent abort listeners', async () => {
  const f = await fixture()
  for (let i = 0; i < apiLimits.maxRetainedProviders + 2; i++) {
    const read = await f.manager.installed({}, f.check, f.signal)
    const installed = await f.manager.install(read.version, bundle('repeated'), f.check, f.signal)
    if (installed.persisted !== true || installed.entry === null) throw Error('Expected bounded install')
    expect((await f.manager.uninstall(installed.entry.skillId, installed.version, f.check, f.signal)).persisted).toBe(true)
    expect(f.stats().providerListeners).toBe(1)
  }
})


it('materializes only with this source callback lease and rejects catalog and expired lease handles', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('scoped-source'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected install')
  const catalogVersion = f.catalog().entries[0]!.version
  await expect(f.materialize(catalogVersion, { scope: f.ctx })).rejects.toThrow('Exact active operation source lease required')
  expect((await f.ctx.skills.get('scoped-source', { scope: f.ctx }))?.content).toContain('body')
  const lease = f.materialized()[0]
  if (lease === undefined) throw Error('Expected exact callback lease')
  expect(lease).not.toBe(catalogVersion); expect(lease.id).toBe(catalogVersion.id)
  await expect(f.materialize(lease, { scope: f.ctx })).rejects.toThrow('Exact active operation source lease required')
})


it('distinguishes files admission refusal from unsettled preparation before any catalog commit', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  f.failPrepare(new FilesFailure('cloud/capacity', 'Fixture queue full'))
  await expect(f.manager.install(initial.version, bundle('queue-full'), f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.stats().commits).toBe(0); expect(f.saves.snapshot().failures).toEqual([])
  const g = await fixture(), other = await g.manager.installed({}, g.check, g.signal)
  g.failPrepare(new FdMutationFailure('unknown', 'FS_IO_ERROR'))
  await expect(g.manager.install(other.version, bundle('prepare-unknown'), g.check, g.signal)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(g.stats().commits).toBe(0)
  expect(g.saves.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
})

it('reports a confirmed oversized package as capacity before catalog publication', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  f.failPrepare(new FdMutationFailure('not-published', 'FS_TOO_LARGE'))
  await expect(f.manager.install(initial.version, bundle('large'), f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.stats().commits).toBe(0)
})


// These probes require actual prepared authority, rather than treating release() as an empty fixture method.
async function preparedOperation(kind: 'install' | 'update' | 'legacy') {
  const f = await fixture(), read = await f.manager.installed({}, f.check, f.signal)
  let edit = read.version, skillId: import('../src/managed-skill-types.ts').ManagedSkillId | undefined
  if (kind === 'update') {
    const seed = await f.manager.install(edit, bundle('prepared-root', 'original'), f.check, f.signal)
    if (seed.persisted !== true || seed.entry === null) throw Error('Expected update seed')
    edit = seed.version; skillId = seed.entry.skillId
  }
  const submit = (options: { signal?: AbortSignal; invalid?: boolean } = {}) => {
    const signal = options.signal ?? f.signal, check = () => { signal.throwIfAborted() }
    if (kind === 'legacy') return f.manager.publish(edit, options.invalid ? 'no frontmatter' : body('sample', 'prepared legacy'),
      Uint8Array.from([1, 2, 3]), check, signal)
    const input = bundle('prepared-root', 'replacement')
    if (options.invalid) input.files[0]!.dataBase64 = Buffer.from('no frontmatter').toString('base64')
    if (kind === 'install') return f.manager.install(edit, input, check, signal)
    if (skillId === undefined) throw Error('Expected original installation')
    return f.manager.update(skillId, edit, input, check, signal)
  }
  return { f, submit, baseline: f.preparedStats(), before: f.stats() }
}

it('prepared resident: rejects a released uncommitted version at both source and catalog commit', async () => {
  const f = await fixture(), held = await f.ports.bundle.prepareBundle(bundle('not-committed'), f.signal)
  expect(f.preparedStats().active).toBe(1)
  held.release(); expect(f.preparedStats().active).toBe(0)
  await expect(f.ports.bundle.withBundleSource(held.value, async () => 'not reached', f.signal))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await expect(f.ports.bundle.commitCatalog(f.catalog(), { kind: 'install', bundle: held.value }, f.signal))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(f.catalog().entries).toEqual([])
})

it('prepared resident: preserves install, update and legacy authorization through their actual commits', async () => {
  const f = await fixture(), read = await f.manager.installed({}, f.check, f.signal)
  const install = await f.manager.install(read.version, bundle('held-root'), f.check, f.signal)
  if (install.persisted !== true || install.entry === null) throw Error('Expected prepared install')
  const update = await f.manager.update(install.entry.skillId, install.version, bundle('held-root', 'new'), f.check, f.signal)
  if (update.persisted !== true) throw Error('Expected prepared update')
  const legacy = await f.manager.publish(update.version, body('sample'), Uint8Array.from([1]), f.check, f.signal)
  if (legacy.persisted !== true) throw Error('Expected prepared legacy creation')
  expect((await f.manager.publish(legacy.version, body('sample', 'new sample'), Uint8Array.from([2]), f.check, f.signal)).persisted).toBe(true)
  const stats = f.preparedStats()
  expect(stats.active).toBe(0); expect(stats.releases).toEqual([1, 1, 1, 1])
  expect(stats.sourcePreparedRefs).toEqual([1, 1, 1, 1]); expect(stats.commitPreparedRefs).toEqual([1, 1, 1, 1])
  expect(stats.releaseWhilePending).toEqual([true, true, true, true])
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s releases after validation refusal', async (kind) => {
  const { f, submit, baseline, before } = await preparedOperation(kind)
  await expect(submit({ invalid: true })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const stats = f.preparedStats()
  expect(f.stats().commits).toBe(before.commits); expect(stats.active).toBe(0)
  expect(stats.releases.length).toBe(baseline.releases.length + 1); expect(stats.releases.every(count => count === 1)).toBe(true)
  expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s releases after a known commit failure', async (kind) => {
  const { f, submit, baseline } = await preparedOperation(kind)
  f.failCommit(new FdMutationFailure('not-published', 'FS_STALE_VERSION'))
  await expect(submit()).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  const stats = f.preparedStats()
  expect(stats.commitPreparedRefs.at(-1)).toBe(1); expect(stats.active).toBe(0)
  expect(stats.releases.length).toBe(baseline.releases.length + 1); expect(stats.releases.every(count => count === 1)).toBe(true)
  expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s releases after unknown commit settlement', async (kind) => {
  const { f, submit, baseline } = await preparedOperation(kind)
  f.unknownCommit(); expect(await submit()).toMatchObject({ persisted: 'unknown', applied: false })
  const stats = f.preparedStats()
  expect(stats.commitPreparedRefs.at(-1)).toBe(1); expect(stats.active).toBe(0)
  expect(stats.releases.length).toBe(baseline.releases.length + 1); expect(stats.releases.every(count => count === 1)).toBe(true)
  expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
  expect(f.saves.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s releases after confirmed apply failure', async (kind) => {
  const { f, submit, baseline } = await preparedOperation(kind)
  f.failApply(); expect(await submit()).toMatchObject({ persisted: true, applied: false })
  const stats = f.preparedStats()
  expect(stats.active).toBe(0); expect(stats.releases.length).toBe(baseline.releases.length + 1)
  expect(stats.releases.every(count => count === 1)).toBe(true); expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
  expect(f.saves.snapshot().failures).toHaveLength(1)
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s retains through source cancellation settlement', async (kind) => {
  const { f, submit, baseline, before } = await preparedOperation(kind), block = f.blockSource(), observer = new AbortController()
  const pending = submit({ signal: observer.signal }).then(value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }))
  await vi.waitFor(() =>{  expect(f.stats().borrows).toBe(1) }, { timeout: 1000, interval: 1 })
  observer.abort(new Error('Fixture observer cancelled'))
  expect(f.preparedStats().active).toBe(1); expect(f.preparedStats().releases.length).toBe(baseline.releases.length)
  block.release(); expect((await pending).ok).toBe(false)
  const stats = f.preparedStats()
  expect(f.stats().commits).toBe(before.commits); expect(stats.active).toBe(0)
  expect(stats.releases.length).toBe(baseline.releases.length + 1); expect(stats.releases.every(count => count === 1)).toBe(true)
  expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
})

it.each(['install', 'update', 'legacy'] as const)('prepared resident: %s completes confirmed apply despite late observer cancellation', async (kind) => {
  const { f, submit, baseline } = await preparedOperation(kind), observer = new AbortController()
  f.afterCommit(() =>{  observer.abort(new Error('Fixture cancellation after durable handoff')) })
  expect(await submit({ signal: observer.signal })).toMatchObject({ persisted: true, applied: true })
  const stats = f.preparedStats()
  expect(stats.active).toBe(0); expect(stats.releases.length).toBe(baseline.releases.length + 1)
  expect(stats.releases.every(count => count === 1)).toBe(true); expect(stats.releaseWhilePending.every(Boolean)).toBe(true)
})

it('prepared resident: update waits for provider settlement and releases before the next save turn', async () => {
  const { f, submit } = await preparedOperation('update'), block = deferred(), entered = deferred()
  const original: unknown = Reflect.get(FileSystemSkillProvider.prototype, 'dispose')
  if (typeof original !== 'function') throw new Error('Original provider disposer is missing')
  const spy = vi.spyOn(FileSystemSkillProvider.prototype, 'dispose').mockImplementation(async function (this: FileSystemSkillProvider) {
    entered.release(); await block.promise; await Reflect.apply(original, this, [])
  })
  try {
    const update = submit(); await entered.promise
    const queued = f.saves.admit('settings', async () => f.preparedStats().active)
    expect(f.preparedStats().active).toBe(1)
    expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
    block.release(); expect(await update).toMatchObject({ persisted: true, applied: true })
    expect(await queued).toBe(0); expect(f.preparedStats().releases).toEqual([1, 1])
  } finally { block.release(); spy.mockRestore() }
})


it('prepared resident: validation failure waits for rejected provider cleanup before releasing', async () => {
  const { f, submit } = await preparedOperation('install'), block = deferred(), entered = deferred()
  const original: unknown = Reflect.get(FileSystemSkillProvider.prototype, 'dispose')
  if (typeof original !== 'function') throw new Error('Original provider disposer is missing')
  const spy = vi.spyOn(FileSystemSkillProvider.prototype, 'dispose').mockImplementation(async function (this: FileSystemSkillProvider) {
    entered.release(); await block.promise; await Reflect.apply(original, this, [])
  })
  try {
    const failure = submit({ invalid: true }).then(value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }))
    await entered.promise
    expect(f.preparedStats().active).toBe(1); expect(f.preparedStats().releases).toEqual([])
    expect(f.stats().commits).toBe(0)
    expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
    block.release(); const result = await failure
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ code: 'cloud/forbidden' })
    expect(f.preparedStats().active).toBe(0); expect(f.preparedStats().releases).toEqual([1])
    expect(f.saves.snapshot().failures).toEqual([])
  } finally { block.release(); spy.mockRestore() }
})


it('returns a definite invalid-bundle refusal after real ZIP decoding without changing the catalog or save owner', async () => {
  const f = await fixture(), initial = await f.manager.installed({}, f.check, f.signal)
  const installed = await f.manager.install(initial.version, bundle('existing'), f.check, f.signal)
  if (installed.persisted !== true || installed.entry === null) throw Error('Expected original installation')
  const before = await f.manager.installed({}, f.check, f.signal)
  const archive = zipSync({ 'note.txt': new TextEncoder().encode('not a skill') })
  const commits = f.stats().commits
  await expect(f.manager.install(before.version, { kind: 'zip', dataBase64: Buffer.from(archive).toString('base64') }, f.check, f.signal))
    .rejects.toMatchObject({ code: 'cloud/invalid-skill-bundle' })
  expect(f.stats().commits).toBe(commits)
  expect(f.saves.snapshot().failures).toEqual([])
  const after = await f.manager.installed({}, f.check, f.signal)
  expect(after.entries).toEqual(before.entries)
  const valid = await f.manager.install(after.version, bundle('next'), f.check, f.signal)
  expect(valid).toMatchObject({ persisted: true, applied: true })
})

it('advertises built-in downloads only when their complete existing reply fits the installed budget', async () => {
  const f = await fixture(apiLimits, true)
  const view = await f.manager.installed({}, f.check, f.signal)
  expect(view.entries).toHaveLength(13)
  const blocked = ['power-grid-technical-report-writer', 'tech-report-writer', 'technical-report-pre-review']
  for (const entry of view.entries) {
    expect(entry.actions.download).toBe(!blocked.includes(entry.name))
    const detail = await f.manager.details(entry.skillId, f.check, f.signal)
    expect(detail.entry.actions.download).toBe(entry.actions.download)
    const read = f.manager.download({ skillId: entry.skillId, contentVersion: entry.contentVersion }, f.check, f.signal)
    if (entry.actions.download) {
      expect(Buffer.byteLength(JSON.stringify(await read))).toBeLessThanOrEqual(apiLimits.maxReplyBytes)
    } else await expect(read).rejects.toMatchObject({ code: 'cloud/capacity' })
  }
})

it('projects all thirteen complete built-ins from Loader providers and preserves native user precedence', async () => {
  const f = await fixture({ ...apiLimits, maxReplyBytes: 8 * 1024 * 1024 }, true)
  const view = await f.manager.installed({}, f.check, f.signal)
  expect(view.complete).toBe(true)
  expect(view.entries).toHaveLength(13)
  for (const summary of await f.ctx.skills.list()) expect(summary).not.toHaveProperty('package')
  for (const entry of view.entries) {
    expect(entry).toMatchObject({ source: 'bundled', mutable: false, selection: { kind: 'effective' },
      actions: { update: false, uninstall: false, download: true } })
    const detail = await f.manager.details(entry.skillId, f.check, f.signal)
    expect(detail.markdown).toContain('---')
    expect(detail.files).toHaveLength(entry.fileCount)
    const loaded = await f.ctx.skills.get(entry.name)
    expect(loaded?.resourceBase).toEqual({ kind: 'directory',
      path: `/opt/dsh/skills/${entry.provider === 'dsh-office' ? 'office' : 'reports'}/${entry.name}` })
    expect(loaded?.content).not.toContain('/Users/')
    // The fixture's physical user-upload limit is intentionally small; SKILL.md reads still retain the API byte bound.
    const inspection = await f.ctx.skills.inspect()
    const source = inspection.candidates.find(row => row.candidate.name === entry.name)?.candidate.package
    if (source === undefined) throw Error('Missing built-in package')
    const exported = await f.manager.download({ skillId: entry.skillId, contentVersion: entry.contentVersion }, f.check, f.signal)
    expect(exported.sha256).toBe(source.archive.sha256)
    const member = await f.manager.readFile({ skillId: entry.skillId, contentVersion: entry.contentVersion, relativePath: 'SKILL.md' }, f.check, f.signal)
    expect(Buffer.from(member.dataBase64, 'base64').toString()).toBe(detail.markdown)
    await expect(f.manager.readFile({ skillId: entry.skillId, contentVersion: entry.contentVersion, relativePath: '../SKILL.md' }, f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
    const archive = unzipSync(Buffer.from(exported.dataBase64, 'base64'))
    expect(Object.keys(archive).sort()).toEqual(detail.files.map(file => file.relativePath).sort())
    for (const file of detail.files) {
      const bytes = archive[file.relativePath]
      if (bytes === undefined) throw Error('Missing archive member')
      expect(hash(bytes)).toBe(file.sha256)
    }
    await expect(f.manager.uninstall(entry.skillId, view.version, f.check, f.signal)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  }
  const installation = await f.manager.install(view.version, bundle('office-docx', 'User-owned override'), f.check, f.signal)
  expect(installation.persisted).toBe(true)
  expect((await f.ctx.skills.get('office-docx', { scope: f.ctx }))?.content).toContain('User-owned override')
  const changed = await f.manager.installed({}, f.check, f.signal)
  expect(changed.entries.filter(entry => entry.name === 'office-docx')).toHaveLength(2)
  expect(changed.entries.find(entry => entry.name === 'office-docx' && !entry.mutable)?.selection).toMatchObject({ kind: 'shadowed' })
})
