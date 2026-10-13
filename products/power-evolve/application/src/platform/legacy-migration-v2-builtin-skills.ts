/** Original built-in Skill install receipts require their original catalog, release manifest and archive-derived package facts. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { extractSkillPackage } from './skill-package-extraction.ts'
import { skillPackageManifest, skillPackageVersion } from './skill-package-manifest.ts'
import { readNativeSkillMetadata } from './skill-metadata.ts'

/** Retained original built-in install ledger, separate from generic user package metadata. */
export const LEGACY_MIGRATION_BUILTIN_SKILL_TABLES: ReadonlySet<string> = new Set(['pe_builtin_skill_install_requests'])
const digest = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().regex(/^builtin\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)
const version = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
const targets = z.union([z.tuple([z.literal('cloud')]), z.tuple([z.literal('cloud'), z.literal('desktop')])])
const catalog = z.object({ schemaVersion: z.literal(1), items: z.array(z.object({
  extension: z.object({ id, name: z.string().min(1).max(200), summary: z.string().min(1).max(500),
    description: z.string().min(1).max(10000), category: z.string().min(1).max(100), publisher: z.string().min(1).max(200) }).strict(),
  release: z.object({ version, state: z.literal('PUBLISHED'), manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    targets, componentKinds: z.tuple([z.literal('skill')]), permissions: z.tuple([]), artifactDigest: digest,
    artifactSize: z.number().int().min(1).max(1048576), artifactDownloadUrl: z.string(), artifactPath: z.string() }).strict(),
}).strict()).length(9) }).strict()
const releaseManifest = z.object({ schemaVersion: z.literal(1), extensionId: id, version, targets,
  componentKinds: z.tuple([z.literal('skill')]), artifact: z.object({ sha256: digest,
    size: z.number().int().min(1).max(1048576) }).strict() }).strict()
/** Protected original catalog and selected archive witnesses, with exact original install-row identities. */
export const legacyMigrationBuiltinEvidence = z.object({ format: z.literal('power-evolve-legacy-builtin-skills'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), catalogText: z.string(), catalogSha256: digest,
  releases: z.array(z.object({ catalogId: id, version, manifestText: z.string(), archiveBase64: z.string() }).strict()),
  requests: z.array(z.object({ userId: z.uuid(), requestId: z.uuid(), sourceRowSha256: digest }).strict()) }).strict()
/** Process-issued original release context; only its authenticated digest is exposed to the signed file cut. */
export interface LegacyMigrationBuiltinContext { readonly evidenceSha256: string }
type Evidence = z.infer<typeof legacyMigrationBuiltinEvidence>
type Release = {
  catalogId: string
  version: string
  archiveDigest: string
  archiveSize: number
  packageManifest: string
  name: string
  description: string
  instructionDigest: string
}
const contexts = new WeakMap<LegacyMigrationBuiltinContext, { evidence: Evidence; releases: readonly Release[] }>()
function fail(code: string): never { throw new LegacyImportError(code) }

/** Verify original release bytes with the maintained package extractor; package scripts are never invoked.
 * @param evidence Protected original catalog, manifests, archive bytes and retained-row digests.
 * @param sourceCodeId Original source identity from the authenticated capture.
 * @param limits Explicit evidence and extraction inventory budgets.
 * @returns Immutable context with exact original archive-derived package metadata and its evidence digest.
 */
export async function createLegacyMigrationBuiltinContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): Promise<LegacyMigrationBuiltinContext> {
  const original = legacyMigrationBuiltinEvidence.parse(evidence)
  if (original.sourceCodeId !== sourceCodeId || original.requests.length > limits.maxRows
    || original.releases.length > limits.maxRows || legacyDigest(original.catalogText) !== original.catalogSha256) {
    fail('migration_builtin_original_evidence_identity')
  }
  const parsed = catalog.parse(legacyJson(original.catalogText, limits))
  if (new Set(parsed.items.map(item => item.extension.id)).size !== parsed.items.length) fail('migration_builtin_original_catalog_duplicate')
  const releases: Release[] = []
  for (const witness of original.releases) {
    const item = parsed.items.find(entry => entry.extension.id === witness.catalogId && entry.release.version === witness.version)
    if (!item || releases.some(entry => entry.catalogId === witness.catalogId && entry.version === witness.version)) {
      fail('migration_builtin_original_release_missing')
    }
    const manifest = releaseManifest.parse(legacyJson(witness.manifestText, limits)), selected = item.release
    const bytes = Buffer.from(witness.archiveBase64, 'base64')
    if (bytes.toString('base64') !== witness.archiveBase64 || bytes.byteLength !== selected.artifactSize || bytes.byteLength > limits.maxBundleBytes
      || legacyDigest(bytes) !== selected.artifactDigest || `sha256:${legacyDigest(witness.manifestText)}` !== selected.manifestDigest
      || manifest.extensionId !== witness.catalogId || manifest.version !== witness.version
      || manifest.artifact.sha256 !== selected.artifactDigest || manifest.artifact.size !== selected.artifactSize
      || JSON.stringify(manifest.targets) !== JSON.stringify(selected.targets)
      || selected.artifactPath !== `extensions/${witness.catalogId}/${witness.version}.zip`
      || selected.artifactDownloadUrl !== `/api/v1/catalog/extensions/${witness.catalogId}/releases/${witness.version}/artifact`) {
      fail('migration_builtin_original_archive_identity')
    }
    const root = await mkdtemp(join(tmpdir(), 'legacy-migration-builtin-'))
    try {
      const archive = join(root, 'archive.zip'), unpacked = join(root, 'unpacked')
      await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' }); await mkdir(unpacked, { mode: 0o700 })
      const files = await extractSkillPackage(archive, unpacked), metadata = await readNativeSkillMetadata(join(unpacked, 'skill'))
      const authored = await skillPackageVersion(join(unpacked, 'skill'), selected.artifactDigest, files)
      const instructions = files.find(file => file.path === 'skill/SKILL.md')
      if (!instructions || files.length + 3 > limits.maxFiles || files.some(file => file.size > limits.maxFileBytes)
        || files.reduce((sum, file) => sum + file.size, 0) > limits.maxStorageBytes
        || authored !== `sha256:${selected.artifactDigest}` && authored !== witness.version) fail('migration_builtin_original_package_invalid')
      releases.push({ catalogId: witness.catalogId, version: witness.version, archiveDigest: selected.artifactDigest,
        archiveSize: selected.artifactSize, packageManifest: skillPackageManifest(selected.artifactDigest, files),
        name: metadata.name, description: metadata.description, instructionDigest: instructions.sha256 })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, { evidence: structuredClone(original), releases })
  return context
}

/** Validate original built-in install requests against the exact original release and imported immutable package history.
 * @param row Original retained install ledger row.
 * @param rows Complete source-preserving user/package/request inventory.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued original catalog/archive context.
 * @returns Whether this module owns the table; absent original release facts reject before publication.
 */
export function validateLegacyMigrationBuiltinSkill(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  cut: string, context?: LegacyMigrationBuiltinContext): boolean {
  if (!LEGACY_MIGRATION_BUILTIN_SKILL_TABLES.has(row.table)) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_builtin_original_evidence_missing')
  const requests = rows.filter(item => item.table === 'pe_builtin_skill_install_requests')
  const proof = original.evidence.requests.find(item => item.userId === row.values.user_id && item.requestId === row.values.request_id)
  if (!proof || proof.sourceRowSha256 !== row.sourceSha256 || requests.length !== original.evidence.requests.length
    || new Set(original.evidence.requests.map(item => `${item.userId}/${item.requestId}`)).size !== requests.length
    || original.evidence.requests.some(item => requests.filter(entry => entry.values.user_id === item.userId
      && entry.values.request_id === item.requestId && entry.sourceSha256 === item.sourceRowSha256).length !== 1)
    || original.releases.some(item => !requests.some(entry => entry.values.catalog_id === item.catalogId
      && entry.values.version === item.version))) {
    fail('migration_builtin_original_input_inventory')
  }
  const value = row.values, release = original.releases.find(item => item.catalogId === value.catalog_id && item.version === value.version)
  const packageRow = rows.find(item => item.table === 'pe_skill_package_versions' && item.values.id === value.package_version_id
    && item.values.user_id === value.user_id)
  if (!release || !packageRow || release.archiveDigest !== value.archive_digest
    || packageRow.values.archive_digest !== release.archiveDigest || packageRow.values.archive_size !== String(release.archiveSize)
    || packageRow.values.version !== release.version || packageRow.values.name !== release.name
    || packageRow.values.description !== release.description || packageRow.values.manifest !== release.packageManifest
    || packageRow.values.instruction_digest !== release.instructionDigest
    || legacyTimestamp(value.created_at ?? '') < legacyTimestamp(packageRow.values.created_at ?? '')
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) fail('migration_builtin_original_install_binding')
  return true
}
