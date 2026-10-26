/** Account skill management JSON; client aliases are generated from CloudSkillService. */
import type { SkillBundleInput, SkillInstallationId, SkillVersionId } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillInvocationPolicy, SkillSource } from '@deepseek-ai/dsh-skill'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type { SkillEditVersion } from './save-hooks.ts'

/** Public installation identity; it conveys no files capability or source path. */
export type ManagedSkillId = SkillInstallationId
/** Exact public immutable-content label; only the installed files owner can authorize a read. */
export type ManagedSkillContentVersion = SkillVersionId

/** Explicit API limits; files owns the separate physical bundle/tree limits. */
export interface ManagedSkillApiLimits {
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxMetadataBytes: number
  readonly maxRetainedProviders: number
}

/** Actual finite upload/export limits reported by the installed capability, without deployment defaults. */
export interface ManagedSkillPublicLimits {
  readonly maxSkills: number
  readonly maxFilesPerBundle: number
  readonly maxDirectoriesPerBundle: number
  readonly maxFileBytes: number
  readonly maxBundleBytes: number
  readonly maxZipBytes: number
  readonly maxPathBytes: number
  readonly maxPathDepth: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
}

/** Native-selected source identity; rank, private locator and source paths do not cross the wire. */
export interface ManagedSkillOrigin {
  readonly name: string
  readonly source: SkillSource
  readonly provider: string
}

/** Selection is produced by the native registry inspection, never by a cloud priority algorithm. */
export type ManagedSkillSelection = Readonly<{ kind: 'effective' }>
  | Readonly<{ kind: 'shadowed'; by: ManagedSkillOrigin }>
  | Readonly<{ kind: 'incomplete' }>

/** One installed native skill root, including the preserved two-file sample entry. */
export interface ManagedSkillEntry extends ManagedSkillOrigin {
  readonly skillId: ManagedSkillId
  readonly description: string
  readonly invocation: SkillInvocationPolicy
  readonly contentVersion: ManagedSkillContentVersion
  readonly fileCount: number
  readonly contentBytes: number
  readonly legacySample: boolean
  readonly selection: ManagedSkillSelection
  readonly mutable: boolean
  readonly actions: Readonly<{ update: boolean; uninstall: boolean; download: boolean }>
}

/** One complete, canonical relative regular file; uploaded hashes never authorize stored bytes. */
export type ManagedSkillUploadFile = Extract<SkillBundleInput, { kind: 'files' }>['files'][number]

/** Complete package input is owned by files; the Remote generator consumes this alias. */
export type ManagedSkillBundleUpload = SkillBundleInput

/** Optional workspace affects native discovery only after the original workspace ownership check. */
export interface ManagedSkillsInstalledRequest { readonly workspaceId?: Workspace['id'] }
/** Complete bounded management view; the original directory object's edit covers every mutation. */
export interface ManagedSkillsInstalled {
  readonly entries: readonly ManagedSkillEntry[]
  readonly version: SkillEditVersion
  readonly complete: boolean
  readonly actions: Readonly<{ install: boolean }>
  readonly limits: ManagedSkillPublicLimits
}

/** Installation selector, not a filesystem path or native locator. */
export interface ManagedSkillDetailsRequest { readonly skillId: ManagedSkillId }
/** Complete verified regular-file metadata from one immutable version. */
export interface ManagedSkillFileMetadata {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}
/** Installed metadata and the same directory edit authority used by installed(). */
export interface ManagedSkillDetails {
  readonly entry: ManagedSkillEntry
  readonly files: readonly ManagedSkillFileMetadata[]
  readonly version: SkillEditVersion
}

/** Complete install in the existing account directory-edit turn. */
export interface ManagedSkillInstallRequest {
  readonly version: SkillEditVersion
  readonly bundle: ManagedSkillBundleUpload
}
/** Complete replacement; the installation ID remains stable and the old version is retained while borrowed. */
export interface ManagedSkillUpdateRequest extends ManagedSkillInstallRequest { readonly skillId: ManagedSkillId }
/** Remove future discovery/load admission; historical content and existing working copies remain intact. */
export interface ManagedSkillUninstallRequest extends ManagedSkillDetailsRequest { readonly version: SkillEditVersion }
/** Persistence and native application remain separate; unknown does not authorize replay. */
export type ManagedSkillMutationResult = Readonly<{
  persisted: true
  applied: boolean
  version: SkillEditVersion
  entry: ManagedSkillEntry | null
}> | Readonly<{ persisted: 'unknown'; applied: false }>

/** The owner checks both selectors against the admitted current catalog before borrowing source bytes. */
export interface ManagedSkillDownloadRequest extends ManagedSkillDetailsRequest {
  readonly contentVersion: ManagedSkillContentVersion
}
/** Complete bounded ZIP export of the exact borrowed version, without private path or source handle. */
export interface ManagedSkillDownload {
  readonly skillId: ManagedSkillId
  readonly contentVersion: ManagedSkillContentVersion
  readonly fileName: string
  readonly mediaType: 'application/zip'
  readonly bytes: number
  readonly sha256: string
  readonly dataBase64: string
}
