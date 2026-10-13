/** Original business upload receipts and Skill metadata require their complete selected physical inventories. */
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { fileDownloadPath } from '@power-evolve/contracts/file-download'
import { skillSelection } from '../contracts.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyFileEntry, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { MAX_ARCHIVE_BYTES } from './skill-package-extraction.ts'
import { skillPackageVersion, verifyPublishedSkillPackage } from './skill-package-manifest.ts'
import { readNativeSkillMetadata } from './skill-metadata.ts'

/** Retained upload and Skill owners; built-in catalog receipts and Office jobs remain separately owned. */
export const LEGACY_MIGRATION_STORAGE_OWNER_TABLES: ReadonlySet<string> = new Set([
  'pe_file_uploads', 'pe_user_skills', 'pe_skill_package_versions', 'pe_skill_upload_intents',
])
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
function owner(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[]): void {
  if (!rows.some(user => user.table === 'pe_users' && user.values.id === row.values.user_id)) {
    throw new LegacyImportError('migration_storage_metadata_owner')
  }
}

/** Validate accepted Skill snapshots against original owner, immutable text or package metadata and retained revision bounds.
 * @param operation Original settled parent or continuation with its frozen selection.
 * @param rows Complete original Skill, package and Session inventory.
 * @param limits Explicit selection JSON budgets.
 * @returns Nothing after every selection has an original metadata owner; later disablement or revocation is preserved.
 */
export function validateLegacyMigrationSkillOperation(operation: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): void {
  const selected = z.array(skillSelection).max(256).parse(legacyJson(operation.values.skill_selection ?? '', limits))
  if (!selected.length) return
  const session = rows.find(row => row.table === 'pe_sessions' && row.values.id === operation.values.session_id)
  if (!session || new Set(selected.map(item => item.skillId)).size !== selected.length) {
    throw new LegacyImportError('migration_skill_operation_owner_missing')
  }
  for (const item of selected) {
    const skill = rows.find(row => row.table === 'pe_user_skills' && row.values.id === item.skillId
      && row.values.user_id === session.values.user_id)
    if (!skill || skill.values.kind !== item.kind || item.revision > Number(skill.values.revision)
      || legacyTimestamp(skill.values.created_at ?? '') > legacyTimestamp(operation.values.created_at ?? '')) {
      throw new LegacyImportError('migration_skill_operation_owner_missing')
    }
    const original = item.kind === 'text' ? skill : rows.find(row => row.table === 'pe_skill_package_versions'
      && row.values.skill_id === item.skillId && row.values.user_id === session.values.user_id
      && row.values.archive_digest === item.packageDigest && row.values.manifest_digest === item.manifestDigest
      && row.values.version === item.version)
    if (!original || original.values.name !== item.name || original.values.description !== item.description
      || (item.kind === 'text' ? original.values.digest : original.values.instruction_digest) !== item.digest
      || legacyTimestamp(original.values.created_at ?? '') > legacyTimestamp(operation.values.created_at ?? '')
      || item.kind === 'text' && (item.version !== null || item.packageDigest !== null || item.manifestDigest !== null)) {
      throw new LegacyImportError('migration_skill_operation_snapshot_changed')
    }
  }
}
function packageFiles(row: LegacyPlannedRow, limits: LegacyImportLimits) {
  const manifest = z.object({ schemaVersion: z.literal(1), artifactSha256: sha256,
    files: z.array(z.object({ path: z.string().min(1).max(512),
      size: z.number().int().nonnegative().max(limits.maxFileBytes), sha256 }).strict())
      .min(1).max(Math.min(256, limits.maxFiles)) }).strict()
    .parse(legacyJson(row.values.manifest ?? '', limits))
  const paths = new Set<string>()
  for (const file of manifest.files) {
    fileDownloadPath.parse(file.path)
    if (!file.path.startsWith('skill/') || paths.has(file.path)) throw new LegacyImportError('migration_skill_manifest_path')
    paths.add(file.path)
  }
  if (manifest.artifactSha256 !== row.values.archive_digest || legacyDigest(row.values.manifest ?? '') !== row.values.manifest_digest
    || !manifest.files.some(file => file.path === 'skill/SKILL.md' && file.sha256 === row.values.instruction_digest)
    || Buffer.byteLength(row.values.manifest ?? '') > 131072) throw new LegacyImportError('migration_skill_manifest_invalid')
  return manifest.files
}
function packageInventory(row: LegacyPlannedRow, files: readonly LegacyFileEntry[], limits: LegacyImportLimits): void {
  const expected = new Map<string, { kind: 'directory' | 'file'; bytes?: string; sha256?: string }>([
    ['', { kind: 'directory' }], ['skill', { kind: 'directory' }],
    ['manifest.json', { kind: 'file', bytes: String(Buffer.byteLength(row.values.manifest ?? '')), sha256: row.values.manifest_digest ?? '' }],
  ])
  for (const file of packageFiles(row, limits)) {
    expected.set(file.path, { kind: 'file', bytes: String(file.size), sha256: file.sha256 })
    let parent = dirname(file.path)
    while (parent !== '.') { expected.set(parent, { kind: 'directory' }); parent = dirname(parent) }
  }
  const entries = files.filter(file => file.area === 'skill-package' && file.owner === row.values.user_id
    && file.resource === row.values.archive_digest)
  if (entries.length !== expected.size || entries.some((file) => {
    const match = expected.get(file.path)
    return !match || match.kind !== file.kind || match.kind === 'file' && (match.bytes !== file.bytes || match.sha256 !== file.sha256)
  })) throw new LegacyImportError('migration_skill_inventory_invalid')
}

/** Validate one retained upload or Skill row without replaying old uploads, enabling skills or replacing historical digests.
 * @param row Source-preserving target row after fixed-layout cell parsing.
 * @param rows Complete selected metadata and foreign-owner references.
 * @param files Complete original physical-file inventory.
 * @param limits Explicit JSON and selected file budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Whether this module owns the table; other retained owners remain rejected by the plan.
 */
export function validateLegacyMigrationStorageOwner(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  files: readonly LegacyFileEntry[], limits: LegacyImportLimits, cut: string): boolean {
  if (!LEGACY_MIGRATION_STORAGE_OWNER_TABLES.has(row.table)) return false
  owner(row, rows)
  const value = row.values
  if (value.created_at !== undefined && legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) {
    throw new LegacyImportError('migration_storage_metadata_future')
  }
  switch (row.table) {
    case 'pe_file_uploads': {
      fileDownloadPath.parse(value.path); sha256.parse(value.digest)
      const workspace = rows.find(item => item.table === 'pe_workspaces' && item.values.id === value.workspace_id
        && item.values.user_id === value.user_id)
      if (!workspace || BigInt(value.size ?? '') < 0n || BigInt(value.size ?? '') > BigInt(Number.MAX_SAFE_INTEGER)
        || BigInt(value.binding_generation ?? '') < 1n || BigInt(value.binding_generation ?? '') > BigInt(workspace.values.binding_generation ?? '')) {
        throw new LegacyImportError('migration_file_upload_identity')
      }
      break
    }
    case 'pe_user_skills': {
      sha256.parse(value.digest)
      if (Number(value.revision) < 1 || !value.name || !value.description
        || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
        || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)
        || value.revoked_at !== null && (value.enabled !== 'false' || legacyTimestamp(value.revoked_at ?? '') > legacyTimestamp(cut))) {
        throw new LegacyImportError('migration_skill_metadata_invalid')
      }
      if (value.kind === 'text') {
        const selected = files.filter(file => file.area === 'skill-text' && file.owner === value.user_id && file.resource === value.id)
        const file = selected[0]
        if (value.package_version_id !== null || selected.length !== 1 || !file || file.kind !== 'file' || file.path !== ''
          || file.sha256 !== value.digest || BigInt(file.bytes ?? '') < 1n || BigInt(file.bytes ?? '') > 16384n) {
          throw new LegacyImportError('migration_text_skill_inventory')
        }
      } else if (value.kind === 'package') {
        const version = rows.find(item => item.table === 'pe_skill_package_versions' && item.values.id === value.package_version_id
          && item.values.user_id === value.user_id && item.values.skill_id === value.id)
        if (!version || version.values.name !== value.name || version.values.description !== value.description
          || version.values.instruction_digest !== value.digest) throw new LegacyImportError('migration_skill_current_version')
      } else throw new LegacyImportError('migration_skill_kind')
      break
    }
    case 'pe_skill_package_versions': {
      sha256.parse(value.archive_digest); sha256.parse(value.instruction_digest); sha256.parse(value.manifest_digest)
      const skill = rows.find(item => item.table === 'pe_user_skills' && item.values.id === value.skill_id && item.values.user_id === value.user_id)
      if (!skill || skill.values.kind !== 'package' || skill.values.name !== value.name
        || Number(value.archive_size) < 1 || Number(value.archive_size) > MAX_ARCHIVE_BYTES) {
        throw new LegacyImportError('migration_skill_package_owner')
      }
      packageInventory(row, files, limits)
      break
    }
    case 'pe_skill_upload_intents': {
      sha256.parse(value.archive_digest); sha256.parse(value.token_digest)
      if (Number(value.size_bytes) < 1 || Number(value.size_bytes) > MAX_ARCHIVE_BYTES || value.expires_at === null
        || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.expires_at ?? '')) throw new LegacyImportError('migration_skill_upload_identity')
      if (value.consumed_at === null) {
        if (legacyTimestamp(value.expires_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_skill_upload_active')
      } else {
        const version = rows.find(item => item.table === 'pe_skill_package_versions' && item.values.id === value.request_id
          && item.values.user_id === value.user_id && item.values.archive_digest === value.archive_digest
          && item.values.archive_size === value.size_bytes)
        if (!version || legacyTimestamp(value.consumed_at ?? '') < legacyTimestamp(value.created_at ?? '')
          || legacyTimestamp(value.consumed_at ?? '') > legacyTimestamp(value.expires_at ?? '')
          || legacyTimestamp(value.consumed_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_skill_upload_receipt')
      }
      break
    }
    default: throw new LegacyImportError('migration_storage_metadata_dispatch')
  }
  return true
}

/** Verify published package bytes and native metadata before target SQL may commit.
 * @param skillLibraryRoot Newly staged owned Skill root.
 * @param rows Complete source-preserving target metadata.
 * @param limits Explicit manifest budgets.
 * @returns Completion only for exact complete published trees, native metadata and authored or qualified original built-in versions.
 */
export async function verifyLegacyMigrationSkillPackages(skillLibraryRoot: string, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits): Promise<void> {
  for (const row of rows) if (row.table === 'pe_skill_package_versions') {
    const root = join(skillLibraryRoot, 'skill-packages', row.values.user_id ?? '', 'sha256', row.values.archive_digest ?? '')
    const files = packageFiles(row, limits)
    await verifyPublishedSkillPackage(root, row.values.manifest ?? '', files)
    const metadata = await readNativeSkillMetadata(join(root, 'skill'))
    const version = await skillPackageVersion(join(root, 'skill'), row.values.archive_digest ?? '', files)
    const pinnedBuiltin = version === `sha256:${row.values.archive_digest}` && rows.some(item =>
      item.table === 'pe_builtin_skill_install_requests' && item.values.package_version_id === row.values.id
      && item.values.user_id === row.values.user_id && item.values.archive_digest === row.values.archive_digest
      && item.values.version === row.values.version)
    if (metadata.name !== row.values.name || metadata.description !== row.values.description
      || version !== row.values.version && !pinnedBuiltin) {
      throw new LegacyImportError('migration_skill_authored_metadata')
    }
  }
}
