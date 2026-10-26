/** Complete catalogs and immutable bundles extend the original files owner, mutation gate and resident lane. */
import { reclaimSkillBundles } from './skill-bundle-reclaim.ts'
import type { BundleReclaimInput } from './skill-bundle-reclaim.ts'
import { randomUUID } from 'node:crypto'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { SkillBundlePort, SkillBundleVersion, SkillBundleLimits, SkillCatalog, SkillCatalogEntry,
  SkillInstallationId, SkillBundleSource, SkillBundleWorkingCopy } from './skill-bundles.ts'
import type { SkillVersion, SkillVersionId, SkillVersionPort } from './skill-versions.ts'
import { observeSkillCurrent } from './skill-version-work.ts'
import type { SkillVersionWork } from './skill-version-work.ts'
import type { SkillProjectGrant } from './skill-projection.ts'
import type { ResidentResult } from './work-queue.ts'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { FdWorkerClient } from './worker-client.ts'
import { FdMutationFailure } from './worker-client.ts'
import { bundleHash, decodeBundle, describeBundle, encodeBundleZip, parseBundleManifest, rejectBundle, validateBundleTree } from './bundle-codec.ts'
import type { BundleManifest, BundleTree } from './bundle-codec.ts'

/** Original lane hooks; bundle objects remain owned by this same account port. */
export interface SkillBundleWork {
  readonly work: SkillVersionWork
  readonly limits: SkillBundleLimits
  readonly issueLegacy: (value: SkillVersion) => SkillVersion
  readonly forgetLegacy: (id: SkillVersionId) => void
  readonly reclaim: Omit<BundleReclaimInput, 'binding' | 'root' | 'uid' | 'gid' | 'limits' | 'sourceLimits' | 'assertCurrent'>
  bind(read: (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<BundleTree>,
    resolve: (version: Omit<SkillBundleVersion, 'binding'>) => SkillBundleVersion,
    authorize: (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal) => Promise<void>): void
  materialize(project: SkillProjectGrant, version: SkillBundleVersion, signal: AbortSignal): Promise<ResidentResult<SkillBundleWorkingCopy>>
}

function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).length === keys.length
  && keys.every(k => Object.hasOwn(v, k)) }
function uuid(v: unknown): v is SkillVersionId { return typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) }
function stale(): never { throw new FdMutationFailure('not-published', 'FS_STALE_VERSION') }
function legacyVersion(version: SkillBundleVersion): SkillVersion {
  const skill = version.files.find(f => f.relativePath === 'SKILL.md'), resource = version.files.find(f => f.relativePath === 'resource.bin')
  if (version.format !== 'legacy-two-file' || version.files.length !== 2 || version.directories.length !== 0
    || skill === undefined || resource === undefined) rejectBundle()
  return { binding: version.binding, id: version.id, skillSha256: skill.sha256, resourceSha256: resource.sha256,
    skillBytes: skill.bytes, resourceBytes: resource.bytes }
}
function manifest(version: SkillBundleVersion): BundleManifest {
  return { schema: 1, files: version.files, directories: version.directories, contentBytes: version.contentBytes,
    treeSha256: version.treeSha256 }
}
function descriptor(version: SkillBundleVersion) {
  return { id: version.id, format: version.format, manifest: manifest(version) }
}

/**
 * Exact anchored child resolver; all actual private I/O stays inside the original worker client.
 * @param client Original exclusive worker client.
 * @param parent Verified containing directory identity.
 * @param leaf Fixed internal relative child name.
 * @param signal Actual operation cancellation.
 * @returns The anchored child identity, or undefined only for confirmed absence.
 */
export async function bundleChild(client: FdWorkerClient, parent: FdRootIdentity, leaf: string, signal: AbortSignal)
  : Promise<FdRootIdentity | undefined> {
  const info = await client.lstat(parent, leaf, signal)
  if (info === undefined) return undefined
  const [rootDevice, rootInode] = info.identity.split(':')
  if (info.type !== 'directory' || parent.rootMountId === undefined || rootDevice !== parent.rootDevice || rootInode === undefined) rejectBundle()
  return { rootPath: `${parent.rootPath}/${leaf}`, rootDevice, rootInode, rootMountId: parent.rootMountId }
}

/**
 * Stable bounded complete file read; absence, parse errors and replacement are distinct from an empty catalog.
 * @param client Original exclusive worker client.
 * @param root Verified containing directory identity.
 * @param name Fixed internal relative member.
 * @param maximum Explicit complete read capacity.
 * @param signal Actual operation cancellation.
 * @returns Complete stable bytes and native revision, or undefined only for confirmed absence.
 */
export async function bundleFile(client: FdWorkerClient, root: FdRootIdentity, name: string, maximum: number, signal: AbortSignal)
  : Promise<{ bytes: Uint8Array<ArrayBuffer>; revision: FsVersion } | undefined> {
  const before = await client.lstat(root, name, signal)
  if (before === undefined) return undefined
  if (before.type !== 'file' || before.size === undefined || before.size > maximum) rejectBundle()
  const bytes = await client.read(root, name, maximum, signal), after = await client.lstat(root, name, signal)
  if (after?.version !== before.version || bytes.byteLength !== before.size) stale()
  return { bytes, revision: FsVersion(before.version) }
}

/**
 * Build the production helper's exact immutable on-disk tree, preserving the legacy flat layout.
 * @param tree Complete canonical owned source bytes.
 * @param format The files-owned immutable layout selection.
 * @returns The exact helper plan, including manifest and tree directory for full bundles.
 */
export function skillBundlePlan(tree: BundleTree, format: SkillBundleVersion['format']): BundleTree {
  if (format === 'legacy-two-file') return tree
  const data = new TextEncoder().encode(JSON.stringify(describeBundle(tree)))
  return { directories: ['tree', ...tree.directories.map(d => `tree/${d}`)], files: [{ relativePath: 'manifest.json', data },
    ...tree.files.map(f => ({ relativePath: `tree/${f.relativePath}`, data: f.data }))] }
}

/**
 * Verify every member and directory against an anchored durable descriptor before use or cold retention.
 * @param input Original verified root and explicit bundle capacities.
 * @param client Original exclusive worker client.
 * @param version Validated files-owned or protected-record source descriptor.
 * @param control Actual operation cancellation.
 * @returns Complete verified source bytes, rejecting changed or incomplete trees.
 */
export async function readSkillBundleTree(input: { readonly root: FdRootIdentity; readonly limits: SkillBundleLimits },
  client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal): Promise<BundleTree> {
  const skills = await bundleChild(client, input.root, 'skills', control)
  const root = skills === undefined ? undefined : await bundleChild(client, skills, version.id, control)
  if (root === undefined) rejectBundle()
  let treeRoot = root
  if (version.format === 'bundle-tree-v1') {
    const meta = await bundleFile(client, root, 'manifest.json', input.limits.maxManifestBytes, control)
    if (meta === undefined || bundleHash(meta.bytes) !== bundleHash(JSON.stringify(manifest(version)))) stale()
    const top = await client.list(root, '.', 2, input.limits.maxReplyBytes, control)
    if (top.length !== 2 || !top.some(e => e.name === 'manifest.json' && e.type === 'file')
        || !top.some(e => e.name === 'tree' && e.type === 'directory')) rejectBundle()
    const child = await bundleChild(client, root, 'tree', control)
    if (child === undefined) rejectBundle()
    treeRoot = child
  }
  const wantedFiles = new Map(version.files.map(f => [f.relativePath, f])), wantedDirs = new Set(version.directories)
  const files: Array<{ relativePath: string; data: Uint8Array<ArrayBuffer> }> = [], foundDirs: string[] = []
  const scan = async (path: string): Promise<void> => {
    const directory = path ? await bundleChild(client, treeRoot, path, control) : treeRoot
    if (directory === undefined) rejectBundle()
    const before = await client.lstat(directory, '.', control)
    const names = await client.list(directory, '.', input.limits.maxFiles + input.limits.maxDirectories, input.limits.maxReplyBytes, control)
    for (const entry of names) {
      const relativePath = path ? `${path}/${entry.name}` : entry.name
      if (entry.type === 'directory' && wantedDirs.has(relativePath)) { foundDirs.push(relativePath); await scan(relativePath) }
      else {
        const expected = wantedFiles.get(relativePath)
        if (entry.type !== 'file' || expected === undefined) rejectBundle()
        const result = await bundleFile(client, directory, entry.name, input.limits.maxFileBytes, control)
        if (result === undefined || result.bytes.byteLength !== expected.bytes || bundleHash(result.bytes) !== expected.sha256) stale()
        files.push({ relativePath, data: Uint8Array.from(result.bytes) })
      }
    }
    const after = await client.lstat(directory, '.', control)
    if (after?.version !== before?.version) stale()
  }
  await scan('')
  if (files.length !== version.files.length || foundDirs.length !== version.directories.length) stale()
  const byName = new Map(files.map(f => [f.relativePath, f]))
  const tree: BundleTree = { files: version.files.map((f) => {
    const found = byName.get(f.relativePath); if (found === undefined) stale(); return found
  }), directories: version.directories }
  if (describeBundle(tree).treeSha256 !== version.treeSha256) stale()
  new TextDecoder('utf-8', { fatal: true }).decode(tree.files.find(f => f.relativePath === 'SKILL.md')?.data)
  return tree
}

/**
 * Add managed bundles to the existing version port without a new queue or independent lifecycle.
 * @param input Original owner and its projection hooks, issued only by the original pool.
 * @returns One replacement legacy port with the same sample compatibility and an explicit bundle capability.
 */
export function createSkillBundleWork(input: SkillBundleWork): SkillVersionPort {
  const { work, limits } = input
  const issued = new Map<SkillVersionId, SkillBundleVersion>(), observations = new WeakSet<SkillCatalog>()
  const prepared = new Map<SkillVersionId, number>(), borrows = new Map<SkillVersionId, number>()
  const borrowed = new WeakMap<SkillBundleVersion, { readonly original: SkillBundleVersion; active: boolean }>()
  const current = (): void => { work.assertCurrent(); if (work.binding.lifetime.aborted) rejectBundle() }
  work.binding.lifetime.addEventListener('abort', () => { issued.clear(); prepared.clear(); borrows.clear() }, { once: true })
  const issue = (id: SkillVersionId, format: SkillBundleVersion['format'], m: BundleManifest): SkillBundleVersion => {
    const previous = issued.get(id)
    if (previous !== undefined) {
      if (previous.format !== format || previous.treeSha256 !== m.treeSha256) stale()
      return previous
    }
    if (issued.size >= work.limits.maxVersions) rejectBundle(true)
    const overhead = format === 'legacy-two-file' ? 0 : Buffer.byteLength(JSON.stringify(m))
    if (overhead > limits.maxManifestBytes) rejectBundle(true)
    const value = Object.freeze({ binding: work.binding, id, format, files: m.files, directories: m.directories,
      treeSha256: m.treeSha256, contentBytes: m.contentBytes, directoryCount: m.directories.length,
      chargedBytes: m.contentBytes + overhead, chargedInodes: format === 'legacy-two-file' ? 3 : 3 + m.files.length + m.directories.length })
    if (format === 'legacy-two-file') legacyVersion(value)
    if (!work.binding.lifetime.aborted) issued.set(id, value)
    return value
  }
  const recognize = (version: SkillBundleVersion): void => {
    current()
    const lease = borrowed.get(version)
    if (version.binding !== work.binding || (lease === undefined ? issued.get(version.id) !== version
      : !lease.active || issued.get(version.id) !== lease.original)) rejectBundle()
  }
  const read = (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal): Promise<BundleTree> => {
    recognize(version)
    return readSkillBundleTree({ root: work.root, limits }, client, version, control)
  }
  const parseVersion = (value: unknown): SkillBundleVersion => {
    if (!object(value) || !exact(value, ['id', 'format', 'manifest']) || !uuid(value.id)
      || value.format !== 'legacy-two-file' && value.format !== 'bundle-tree-v1') rejectBundle()
    return issue(value.id, value.format, parseBundleManifest(value.manifest, limits))
  }
  const observe = async (client: FdWorkerClient, control: AbortSignal): Promise<SkillCatalog> => {
    current()
    const skills = await bundleChild(client, work.root, 'skills', control)
    const pointer = skills === undefined ? undefined : await bundleFile(client, skills, 'current.json', limits.maxCatalogBytes, control)
    const entries: SkillCatalogEntry[] = []
    if (pointer !== undefined) {
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pointer.bytes)) } catch (_error) { rejectBundle() }
      if (!object(raw)) rejectBundle()
      if (raw.schema === 1) {
        const legacy = await observeSkillCurrent(work, client, control)
        if (legacy === undefined || legacy.revision !== pointer.revision) stale()
        const v = input.issueLegacy(legacy.version)
        const files = Object.freeze([{ relativePath: 'SKILL.md', bytes: v.skillBytes, sha256: v.skillSha256 },
          { relativePath: 'resource.bin', bytes: v.resourceBytes, sha256: v.resourceSha256 }])
        const m: BundleManifest = { schema: 1, files, directories: [], contentBytes: v.skillBytes + v.resourceBytes,
          treeSha256: bundleHash(JSON.stringify({ files, directories: [] })) }
        entries.push(Object.freeze({ skillId: 'sample' as SkillInstallationId, kind: 'legacy-sample', version: issue(v.id, 'legacy-two-file', m) }))
      } else {
        if (!exact(raw, ['schema', 'entries']) || raw.schema !== 2 || !Array.isArray(raw.entries)
          || raw.entries.length > limits.maxInstallations) rejectBundle()
        for (const value of raw.entries) {
          if (!object(value) || !exact(value, ['skillId', 'kind', 'version']) || typeof value.skillId !== 'string'
            || value.kind !== 'legacy-sample' && value.kind !== 'managed'
            || (value.kind === 'legacy-sample' ? value.skillId !== 'sample' : !uuid(value.skillId))) rejectBundle()
          const version = parseVersion(value.version)
          if (value.kind === 'legacy-sample') legacyVersion(version)
          entries.push(Object.freeze({ skillId: value.skillId as SkillInstallationId, kind: value.kind, version }))
        }
        if (new Set(entries.map(e => e.skillId)).size !== entries.length) rejectBundle()
      }
      for (const entry of entries) await read(client, entry.version, control)
    }
    const result = Object.freeze({ entries: Object.freeze(entries), revision: pointer?.revision ?? null })
    observations.add(result); return result
  }
  const allowed = async (client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal): Promise<void> => {
    recognize(version)
    if (borrowed.get(version)?.active === true) return
    const catalog = await observe(client, control)
    if (!(prepared.get(version.id) ?? 0) && !catalog.entries.some(e => e.version === version)) stale()
  }
  input.bind((client, version, control) => read(client, version, control),
    v => issue(v.id, v.format, parseBundleManifest(manifest({ ...v, binding: work.binding }), limits)), allowed)
  const prepare = async (tree: BundleTree, format: SkillBundleVersion['format'], client: FdWorkerClient, control: AbortSignal) => {
    const m = describeBundle(tree), meta = new TextEncoder().encode(JSON.stringify(m))
    if (meta.byteLength > limits.maxManifestBytes || tree.files.reduce((sum, f) => sum + f.data.byteLength, 0)
      + meta.byteLength > limits.maxStagingBytes) rejectBundle(true)
    const plan = skillBundlePlan(tree, format)
    const id = randomUUID() as SkillVersionId
    const facts = await client.bundle({ kind: 'bundle-prepare', root: work.root, uid: work.uid, gid: work.gid, version: id,
      tree: plan, metadata: null, expectedCopyInode: '0', retained: [], revision: '', limits, storage: work.limits }, control)
    if (facts.outcome !== 'complete' || !facts.closed) throw new FdMutationFailure('unknown', 'FS_IO_ERROR', undefined, { cause: facts })
    return issue(id, format, m)
  }
  const reference = (counts: Map<SkillVersionId, number>) => {
    let state: { readonly kind: 'pending' } | { readonly kind: 'held'; readonly id: SkillVersionId }
      | { readonly kind: 'released' } = { kind: 'pending' }
    return {
      acquire: (id: SkillVersionId): void => {
        if (state.kind !== 'pending') return
        if (work.binding.lifetime.aborted) { state = { kind: 'released' }; return }
        counts.set(id, (counts.get(id) ?? 0) + 1); state = { kind: 'held', id }
      },
      release: (): void => {
        if (state.kind === 'held') {
          const count = counts.get(state.id)
          if (count !== undefined) {
            if (count === 1) counts.delete(state.id)
            else counts.set(state.id, count - 1)
          }
        }
        state = { kind: 'released' }
      },
    }
  }
  const prepareHeld = async (build: () => BundleTree | Promise<BundleTree>, format: SkillBundleVersion['format'], signal: AbortSignal) => {
    current()
    const pin = reference(prepared)
    let result: ResidentResult<SkillBundleVersion>
    try { result = await work.mutate('prepare', async (client, control) => {
      const active = new Set<SkillVersionId>()
      for (const [id, count] of prepared) if (count > 0) active.add(id)
      for (const [id, count] of borrows) if (count > 0) active.add(id)
      const retained = await reclaimSkillBundles({ ...input.reclaim, binding: work.binding, root: work.root, uid: work.uid,
        gid: work.gid, limits, sourceLimits: work.limits, assertCurrent: current }, client, active, control)
      for (const id of issued.keys()) if (!retained.has(id)) {
        issued.delete(id); prepared.delete(id); borrows.delete(id); input.forgetLegacy(id)
      }
      let tree: BundleTree
      try { tree = await build() } catch (cause) {
        if (cause instanceof FdMutationFailure) throw cause
        throw new FdMutationFailure('not-published', 'FS_PERMISSION_DENIED', undefined, { cause })
      }
      const version = await prepare(tree, format, client, control)
      pin.acquire(version.id); return version
    }, signal) } catch (error) {
      // Queue abandonment may precede actual success or occur between callback completion and result delivery.
      // This settles only the unobserved reference; actual work and unpublished disk data remain original-owner charged.
      pin.release(); throw error
    }
    let released = false
    return { value: result.value, release: () => { if (released) return; released = true
      pin.release(); result.release() } }
  }
  const bundles: SkillBundlePort = {
    prepareBundle: (value, signal) => prepareHeld(() => decodeBundle(value, limits, signal), 'bundle-tree-v1', signal),
    observeCatalog: signal => work.mutate('prepare', observe, signal),
    commitCatalog: (expected, change, signal) => {
      current(); if (!observations.has(expected)) rejectBundle()
      if (change.kind !== 'uninstall') recognize(change.bundle)
      return work.mutate('commit', async (client, control) => {
        const actual = await observe(client, control)
        if (actual.revision !== expected.revision) stale()
        const entries = [...actual.entries]
        let entry: SkillCatalogEntry | null = null
        if (change.kind === 'install') {
          if (entries.length >= limits.maxInstallations) rejectBundle(true)
          await allowed(client, change.bundle, control)
          entry = Object.freeze({ skillId: randomUUID() as SkillInstallationId, kind: 'managed', version: issued.get(change.bundle.id) ?? change.bundle }); entries.push(entry)
        } else {
          const index = entries.findIndex(e => e.skillId === change.skillId)
          if (index < 0) stale()
          if (change.kind === 'uninstall') entries.splice(index, 1)
          else {
            const previous = entries[index]; if (previous === undefined) stale()
            if (previous.kind === 'legacy-sample') legacyVersion(change.bundle)
            await allowed(client, change.bundle, control)
            entry = Object.freeze({ ...previous, version: issued.get(change.bundle.id) ?? change.bundle }); entries[index] = entry
          }
        }
        const text = JSON.stringify({ schema: 2, entries: entries.map(e => ({ skillId: e.skillId, kind: e.kind,
          version: descriptor(e.version) })) })
        if (Buffer.byteLength(text) > limits.maxCatalogBytes) rejectBundle(true)
        const outcome = await client.writeText(work.root, 'skills/current.json', text,
          actual.revision === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: actual.revision }, work.maxReadBytes, control)
        const catalog = Object.freeze({ entries: Object.freeze(entries), revision: FsVersion(outcome.version) })
        observations.add(catalog)
        return Object.freeze({ catalog, entry })
      }, signal)
    },
    withBundleSource: async (version, consume, signal) => {
      recognize(version)
      const pin = reference(borrows)
      let snapshot: ResidentResult<BundleTree>
      try { snapshot = await work.mutate('prepare', async (client, control) => {
        await allowed(client, version, control)
        const tree = await read(client, version, control)
        pin.acquire(version.id); return tree
      }, signal) } catch (error) { pin.release(); throw error }
      const leaseVersion = Object.freeze({ ...version }), lease = { original: borrowed.get(version)?.original ?? version, active: true }
      borrowed.set(leaseVersion, lease)
      let active = true, emitted = 0, released = false
      const release = (): void => { if (released) return; released = true
        pin.release(); snapshot.release() }
      const bytes = (name: string, control?: AbortSignal): Uint8Array<ArrayBuffer> => {
        current(); signal.throwIfAborted(); control?.throwIfAborted(); if (!active) rejectBundle()
        const file = snapshot.value.files.find(f => f.relativePath === name); if (file === undefined) rejectBundle()
        emitted += 2 * file.data.byteLength + 512
        if (emitted > Math.floor(limits.reservationBytes / 4)) rejectBundle(true)
        return file.data
      }
      const source: SkillBundleSource = Object.freeze({ version: leaseVersion, files: version.files, directories: version.directories,
        readText: (name: string, control?: AbortSignal) => Promise.resolve().then(() => {
          if (name !== 'SKILL.md') rejectBundle(); return new TextDecoder('utf-8', { fatal: true }).decode(bytes(name, control))
        }), readBytes: (name: string, control?: AbortSignal) => Promise.resolve().then(() => Uint8Array.from(bytes(name, control))) })
      try { return { value: await consume(source, signal), release } }
      catch (error) { release(); throw error }
      finally { active = false; lease.active = false }
    },
    exportBundle: (version, signal) => bundles.withBundleSource(version, async (source) => {
      const files: Array<{ relativePath: string; data: Uint8Array<ArrayBuffer> }> = []
      for (const file of source.files) {
        files.push({ relativePath: file.relativePath, data: await source.readBytes(file.relativePath, signal) })
      }
      return encodeBundleZip({ files, directories: source.directories }, limits.maxDownloadBytes)
    }, signal),
    materializeBundleVersion: (project, version, signal) => { recognize(version); return input.materialize(project, version, signal) },
  }
  return { bundles,
    prepare: async (value, signal) => {
      current(); signal.throwIfAborted()
      const markdown = value.skillMarkdown, resource = value.resource
      if (Buffer.from(markdown).toString('utf8') !== markdown || !(resource.buffer instanceof ArrayBuffer)
        || resource.byteOffset !== 0 || resource.byteLength !== resource.buffer.byteLength) rejectBundle()
      const held = await prepareHeld(() => validateBundleTree({ directories: [], files: [
        { relativePath: 'SKILL.md', data: new TextEncoder().encode(markdown) },
        { relativePath: 'resource.bin', data: Uint8Array.from(resource) }] }, limits), 'legacy-two-file', signal)
      return { value: input.issueLegacy(legacyVersion(held.value)), release: () => { held.release() } }
    },
    current: async (signal) => {
      const held = await bundles.observeCatalog(signal), sample = held.value.entries.find(e => e.skillId === 'sample')
      return { value: sample === undefined || held.value.revision === null ? undefined
        : { version: input.issueLegacy(legacyVersion(sample.version)), revision: held.value.revision }, release: () => { held.release() } }
    },
    commit: async (version, expected, signal) => {
      const value = issued.get(version.id)
      if (value === undefined || input.issueLegacy(legacyVersion(value)) !== version) rejectBundle()
      const held = await bundles.observeCatalog(signal)
      try {
        if (held.value.revision !== expected) stale()
        const sample = held.value.entries.find(e => e.skillId === 'sample')
        if (sample === undefined) {
          // Creation is an explicit sample update, handled below by the same catalog writer.
          return await commitSampleAbsent(held.value, value, version, signal)
        }
        const committed = await bundles.commitCatalog(held.value, { kind: 'update', skillId: sample.skillId, bundle: value }, signal)
        if (committed.value.catalog.revision === null) { committed.release(); stale() }
        return { value: { version, revision: committed.value.catalog.revision }, release: () => { committed.release() } }
      } finally { held.release() }
    },
    withSource: (version, consume, signal) => {
      const value = issued.get(version.id)
      if (value === undefined || input.issueLegacy(legacyVersion(value)) !== version) rejectBundle()
      return bundles.withBundleSource(value, (source, control) => consume({ version,
        readText: (path, child) => source.readText(path, child),
        readBytes: (path, child) => source.readBytes(path, child) }, control), signal)
    },
  }

  async function commitSampleAbsent(expected: SkillCatalog, value: SkillBundleVersion, version: SkillVersion, signal: AbortSignal) {
    return work.mutate('commit', async (client, control) => {
      const actual = await observe(client, control)
      if (actual.revision !== expected.revision || actual.entries.some(e => e.skillId === 'sample')) stale()
      if (actual.entries.length >= limits.maxInstallations) rejectBundle(true)
      await allowed(client, value, control)
      const entries = [{ skillId: 'sample', kind: 'legacy-sample', version: descriptor(value) }, ...actual.entries.map(e => ({
        skillId: e.skillId, kind: e.kind, version: descriptor(e.version) }))]
      const text = JSON.stringify({ schema: 2, entries })
      if (Buffer.byteLength(text) > limits.maxCatalogBytes) rejectBundle(true)
      const outcome = await client.writeText(work.root, 'skills/current.json', text,
        actual.revision === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: actual.revision }, work.maxReadBytes, control)
      return Object.freeze({ version, revision: FsVersion(outcome.version) })
    }, signal)
  }
}
