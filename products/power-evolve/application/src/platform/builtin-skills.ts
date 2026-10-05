/** Read the pinned built-in Skill releases without granting callers filesystem paths. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const CATALOG_SHA256 = '7e55e404c9d073d372d9648a1e5286b09558dc31b4edce5b90d735b4c8775f6d'
const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^builtin\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const MAX_CATALOG_BYTES = 256 * 1024
const MAX_MANIFEST_BYTES = 4096
const MAX_ARCHIVE_BYTES = 1024 * 1024
const extension = z.object({ id: z.string().regex(ID), name: z.string().min(1).max(200),
  summary: z.string().min(1).max(500), description: z.string().min(1).max(10_000),
  category: z.string().min(1).max(100), publisher: z.string().min(1).max(200) }).strict()
const targets = z.union([z.tuple([z.literal('cloud')]), z.tuple([z.literal('cloud'), z.literal('desktop')])])
const release = z.object({ version: z.string().regex(VERSION), state: z.literal('PUBLISHED'),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  targets, componentKinds: z.tuple([z.literal('skill')]),
  permissions: z.tuple([]), artifactDigest: z.string().regex(SHA256),
  artifactSize: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
  artifactDownloadUrl: z.string(), artifactPath: z.string() }).strict()
const catalog = z.object({ schemaVersion: z.literal(1),
  items: z.array(z.object({ extension, release }).strict()).length(9) }).strict()
const manifest = z.object({ schemaVersion: z.literal(1), extensionId: z.string().regex(ID),
  version: z.string().regex(VERSION), targets,
  componentKinds: z.tuple([z.literal('skill')]), artifact: z.object({ sha256: z.string().regex(SHA256),
    size: z.number().int().min(1).max(MAX_ARCHIVE_BYTES) }).strict() }).strict()

/** Metadata needed by a later installation service; no artifact URL or local path is exposed. */
export interface BuiltinSkillRelease {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly description: string
  readonly category: string
  readonly publisher: string
  readonly version: string
  readonly manifestDigest: string
  readonly archiveDigest: string
  readonly archiveSize: number
}

/** Integrity failure in the committed catalog, release manifest, directory or ZIP bytes. */
export class BuiltinSkillCatalogUnavailable extends Error {
  constructor() { super('Bundled Skill catalog is unavailable') }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function unavailable(): never { throw new BuiltinSkillCatalogUnavailable() }

async function directory(path: string, names?: readonly string[]): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable()
  if (names !== undefined) {
    const actual = (await readdir(path)).sort()
    const expected = [...names].sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) unavailable()
  }
}

async function file(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) unavailable()
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size) unavailable()
    return bytes
  } finally { await handle.close() }
}

/**
 * Fixed asset root relative to the built Platform module.
 * @returns The committed built-in Skill asset directory.
 */
export function builtinSkillAssetRoot(): string {
  return fileURLToPath(new URL('../../assets/builtin-skills/generated/', import.meta.url))
}

/** Verify catalog metadata and manifests; verify only the selected ZIP on get. */
export class BuiltinSkillCatalog {
  private readonly root: string

  constructor(root = builtinSkillAssetRoot()) { this.root = resolve(root) }

  private async loadMetadata(): Promise<readonly BuiltinSkillRelease[]> {
    try {
      await directory(this.root, ['catalog.json', 'extensions'])
      const bytes = await file(join(this.root, 'catalog.json'), MAX_CATALOG_BYTES)
      if (sha256(bytes) !== CATALOG_SHA256) unavailable()
      const parsed = catalog.parse(JSON.parse(bytes.toString('utf8')))
      const ids = parsed.items.map(item => item.extension.id)
      if (new Set(ids).size !== 9) unavailable()
      const extensions = join(this.root, 'extensions')
      await directory(extensions, ids)
      const items: BuiltinSkillRelease[] = []
      for (const { extension: identity, release: version } of parsed.items) {
        const { id } = identity
        const archiveName = `${version.version}.zip`
        const manifestName = `${version.version}.manifest.json`
        if (version.artifactPath !== `extensions/${id}/${archiveName}`
          || version.artifactDownloadUrl !== `/api/v1/catalog/extensions/${id}/releases/${version.version}/artifact`) unavailable()
        const folder = join(extensions, id)
        await directory(folder, [archiveName, manifestName])
        const manifestBytes = await file(join(folder, manifestName), MAX_MANIFEST_BYTES)
        if (`sha256:${sha256(manifestBytes)}` !== version.manifestDigest) unavailable()
        const details = manifest.parse(JSON.parse(manifestBytes.toString('utf8')))
        if (details.extensionId !== id || details.version !== version.version
          || details.targets.length !== version.targets.length
          || details.targets.some((target, index) => target !== version.targets[index])
          || details.artifact.sha256 !== version.artifactDigest
          || details.artifact.size !== version.artifactSize) unavailable()
        items.push(Object.freeze({ id, name: identity.name, summary: identity.summary,
          description: identity.description, category: identity.category, publisher: identity.publisher,
          version: version.version, manifestDigest: version.manifestDigest,
          archiveDigest: version.artifactDigest, archiveSize: version.artifactSize }))
      }
      return items
    } catch (_error) { unavailable() }
  }

  private load(): Promise<readonly BuiltinSkillRelease[]> {
    return this.loadMetadata()
  }

  /**
   * List pinned releases without exposing paths or archive bytes.
   * @returns Verified release metadata.
   */
  async list(): Promise<readonly BuiltinSkillRelease[]> {
    return this.load()
  }

  /**
   * Return one verified ZIP by catalog identity, or null for an unknown ID/version.
   * @param id - The built-in Skill catalog identity.
   * @param version - The exact published version.
   * @returns Verified release metadata and ZIP bytes, or null for an unknown release.
   */
  async get(id: string, version: string): Promise<{ readonly release: BuiltinSkillRelease; readonly archive: Buffer } | null> {
    if (!ID.test(id) || !VERSION.test(version)) return null
    const release = (await this.load()).find(item => item.id === id && item.version === version)
    if (!release) return null
    try {
      const archive = await file(join(this.root, 'extensions', id, `${version}.zip`), MAX_ARCHIVE_BYTES)
      if (archive.length !== release.archiveSize || sha256(archive) !== release.archiveDigest) unavailable()
      return { release, archive }
    } catch (_error) { unavailable() }
  }
}
