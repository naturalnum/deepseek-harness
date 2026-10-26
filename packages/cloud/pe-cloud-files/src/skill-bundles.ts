/** Files-owned immutable bundles and the single account skill catalog; these are trusted server types, not Remote DTOs. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ResidentResult } from './work-queue.ts'
import type { SkillVersionId } from './skill-versions.ts'
import type { SkillProjectGrant, SkillWorkingCopyGrant } from './skill-projection.ts'

/** Server-issued installation identity; the legacy installation is the fixed id `sample`. */
export type SkillInstallationId = Branded<'SkillInstallationId'>

/** Complete package input; files owns decoding, archive validation and all expanded-size checks. */
export type SkillBundleInput = {
  readonly kind: 'files'
  readonly files: readonly { readonly relativePath: string; readonly dataBase64: string }[]
} | { readonly kind: 'zip'; readonly dataBase64: string }

/** One immutable source member; directories are derived from canonical relative paths. */
export interface SkillBundleFile {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

/** An object recognized only by its issuing files generation; an id/hash is never sufficient authorization. */
export interface SkillBundleVersion {
  readonly binding: AccountBinding
  readonly id: SkillVersionId
  readonly format: 'legacy-two-file' | 'bundle-tree-v1'
  readonly files: readonly SkillBundleFile[]
  readonly directories: readonly string[]
  readonly treeSha256: string
  readonly contentBytes: number
  readonly directoryCount: number
  readonly chargedBytes: number
  readonly chargedInodes: number
}

/** One installed root. Native skill name/description/invocation are parsed by the original skill provider. */
export interface SkillCatalogEntry {
  readonly skillId: SkillInstallationId
  readonly kind: 'legacy-sample' | 'managed'
  readonly version: SkillBundleVersion
}

/** Complete issued catalog observation; null revision means confirmed absence, not a parse failure. */
export interface SkillCatalog {
  readonly entries: readonly SkillCatalogEntry[]
  readonly revision: FsVersion | null
}

/** One installation change committed by CAS of the same original `skills/current.json`. */
export type SkillCatalogChange =
  | { readonly kind: 'install'; readonly bundle: SkillBundleVersion }
  | { readonly kind: 'update'; readonly skillId: SkillInstallationId; readonly bundle: SkillBundleVersion }
  | { readonly kind: 'uninstall'; readonly skillId: SkillInstallationId }

/** Confirmed catalog result; unknown durable outcomes continue to use the original mutation failure contract. */
export interface SkillCatalogCommit {
  readonly catalog: SkillCatalog
  readonly entry: SkillCatalogEntry | null
}

/** A complete borrowed source; methods expire after the callback and share the original resident reservation. */
export interface SkillBundleSource {
  readonly version: SkillBundleVersion
  readonly files: readonly SkillBundleFile[]
  readonly directories: readonly string[]
  readText(relativePath: 'SKILL.md', signal?: AbortSignal): Promise<string>
  readBytes(relativePath: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
}

/** Full-tree materialization preserves the issued project and the existing working-copy lifetime. */
export interface SkillBundleWorkingCopy extends Omit<SkillWorkingCopyGrant, 'version'> {
  readonly version: SkillBundleVersion
}

/** Original operation borrow over the complete confirmed project copy set, including legacy copies. */
export interface SkillBundleOperationCopies {
  readonly project: SkillProjectGrant
  readonly copies: readonly (SkillWorkingCopyGrant | SkillBundleWorkingCopy)[]
}

/** Explicit deployment capacities. No value is a default or an expansion of the original private hard domain. */
export interface SkillBundleLimits {
  readonly maxInstallations: number
  readonly maxFiles: number
  readonly maxDirectories: number
  readonly maxDepth: number
  readonly maxPathBytes: number
  readonly maxFileBytes: number
  readonly maxContentBytes: number
  readonly maxArchiveBytes: number
  readonly maxArchiveEntries: number
  readonly maxExpandedArchiveBytes: number
  readonly maxInputBytes: number
  readonly maxManifestBytes: number
  readonly maxCatalogBytes: number
  readonly maxDownloadBytes: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxStagingBytes: number
  readonly reservationBytes: number
}

/** Extension of the existing files port; API joins mutations inside the same AccountSaves observation. */
export interface SkillBundlePort {
  prepareBundle(input: SkillBundleInput, signal: AbortSignal): Promise<ResidentResult<SkillBundleVersion>>
  observeCatalog(signal: AbortSignal): Promise<ResidentResult<SkillCatalog>>
  commitCatalog(expected: SkillCatalog, change: SkillCatalogChange, signal: AbortSignal): Promise<ResidentResult<SkillCatalogCommit>>
  withBundleSource<T>(version: SkillBundleVersion,
    consume: (source: SkillBundleSource, control: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<ResidentResult<T>>
  exportBundle(version: SkillBundleVersion, signal: AbortSignal): Promise<ResidentResult<Uint8Array<ArrayBuffer>>>
  materializeBundleVersion(project: SkillProjectGrant, version: SkillBundleVersion,
    signal: AbortSignal): Promise<ResidentResult<SkillBundleWorkingCopy>>
}
