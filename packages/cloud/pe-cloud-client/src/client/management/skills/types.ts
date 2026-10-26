/** Presentation-only Skills inputs; the original account source retains authorization and persistence. */
import type { ManagedSkillEditing } from '../../managed-skill-editing.ts'
import type { SampleSkillEditing } from '../../skill-version-editing.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Categories supplied by the account's actual catalog. */
export type SkillCategory = 'writing-office' | 'data-analysis' | 'research-knowledge' | 'development-tools' | 'imported' | 'other'
/** One confirmed catalog row; no UUID, backend path, edit token or installation ledger is synthesized here. */
export interface SkillCard {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: SkillCategory
  readonly installed: boolean
  readonly recommended: boolean
  readonly status: 'available' | 'published' | 'catalog-pending' | 'disabled' | 'unavailable'
  readonly version?: string
  readonly publisher?: string
  readonly enabled?: boolean
  readonly canToggle?: boolean
  readonly canRemove?: boolean
  readonly sourceLabel?: string
  readonly shadowed?: boolean
  readonly shadowedBy?: { readonly name: string; readonly source: string }
  readonly fileCount?: number
  readonly totalBytes?: number
  readonly canTry?: boolean
}
/** Actual read result, without assuming the publication metadata contains document bytes. */
export interface SkillDetail {
  readonly instructions: string
}
/** Viewing data published by the original account page, never mirrored into component state. */
export interface SkillManagementView {
  readonly managed?: ManagedSkillEditing
  readonly sample?: SampleSkillEditing
  readonly phase: 'unread' | 'loading' | 'ready' | 'unavailable'
  readonly items: readonly SkillCard[]
}
/** Safe operation facts reported by the injected owner; an uncertain result is never retried here. */
export type SkillActionOutcome = 'confirmed' | 'conflict' | 'unknown' | 'unavailable'
/** UI action names for the existing application feedback host. */
export type SkillAction = 'install' | 'import' | 'catalog-install' | 'toggle' | 'remove' | 'try' | 'refresh' | 'update' | 'download'
/** Text form values, with request identity and native versions retained by the injected owner. */
export interface SkillTextDraft {
  readonly name: string
  readonly description: string
  readonly instructions: string
}
/** Explicit usability limits only; account admission validates every actual submission. */
export interface SkillFormLimits {
  readonly nameCharacters: number
  readonly descriptionCharacters: number
  readonly instructionsBytes: number
  readonly archiveBytes: number
}
/** Narrow display callbacks; omission closes that action without constructing a transport. */
export interface SkillManagementActions {
  readonly refresh?: (signal: AbortSignal) => Promise<void>
  readonly readDetail?: (id: string, signal: AbortSignal) => Promise<SkillDetail>
  readonly installText?: (draft: SkillTextDraft, signal: AbortSignal) => Promise<SkillActionOutcome>
  readonly importPackage?: (file: File, signal: AbortSignal) => Promise<SkillActionOutcome>
  readonly installCatalog?: (id: string, signal: AbortSignal) => Promise<SkillActionOutcome>
  readonly toggle?: (id: string, enabled: boolean, signal: AbortSignal) => Promise<SkillActionOutcome>
  readonly remove?: (id: string, signal: AbortSignal) => Promise<SkillActionOutcome>
  /** Open only an editable draft through the existing Session/Workspace owner; never send a prompt. */
  readonly openDraft?: (id: string, signal: AbortSignal) => Promise<SkillActionOutcome>
  /** Report transient outcomes through the application feedback host, which outlives the panel. */
  readonly report: (action: SkillAction, outcome: SkillActionOutcome) => void
}
/** The existing account registration binds this source into the renderer's useSkillManagement hook. */
export interface SkillsPageInjected extends SkillManagementActions {
  readonly scope: string
  readonly limits?: SkillFormLimits
  readonly hooks: { readonly skillManagement: HostObservable<SkillManagementView> }
}
