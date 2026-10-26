/** Account-owned presentation data; approval alone never implies installation or activation. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PreparedAccountPluginEdit, AccountPluginEditOutcome, AccountPluginEditState } from './plugin-edit.ts'

/** Identity admitted by the current account's approved plugin catalog owner. */
export type AccountPluginId = Branded<'CloudAccountPluginId'>
/** Stable purpose categories, independent of translated names. */
export type PluginCategory = 'execution' | 'agents' | 'search' | 'integrations' | 'other'
/** A current-account control's availability, supplied by the operation owner. */
export type PluginControl = 'available' | 'not-connected' | 'not-approved' | 'not-installed' | 'read-only' | 'pending' | 'busy' | 'unknown'
/** One localized account catalog entry, without Profile objects or transport handles. */
export interface AccountPluginCard {
  readonly id: AccountPluginId
  readonly title: string
  readonly description: string
  readonly packageName: string
  readonly moduleName: string | null
  readonly version: string | null
  readonly category: PluginCategory
  readonly approved: boolean
  /** Original bootstrap capability for preinstalled bundle selection or a separately approved installation flow. */
  readonly installable?: boolean
  /** Actual current operation metadata; entry activation never establishes bundle selection. */
  readonly selectionTarget?: AccountPluginEditState['selectionTarget']
  readonly operations?: AccountPluginEditState['operations']
  readonly maxImpact?: AccountPluginEditState['maxImpact']
  /** Actual native bundle manifest selection; entry activation does not establish this fact. */
  readonly selected?: boolean | null
  /** Native readable-file source, independent of profile dependency and selection. */
  readonly availability?: NonNullable<AccountPluginEditState['bundle']>['availability']
  /** Native profile dependency for a bundle; observed package presence for an entry. Null means unknown. */
  readonly installed: boolean | null
  /** Native entry activation; a bundle without an entry leaves this null. */
  readonly enabled: boolean | null
  readonly toggle: PluginControl
  readonly configuration: PluginControl
}
/** Current account's authoritative display projection; error may retain the last readable rows. */
export interface AccountPluginCatalog {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'error'
  readonly plugins: readonly AccountPluginCard[]
  readonly refreshing: boolean
  readonly editor?: AccountPluginEditor
}
/** The existing approved DTO supplies every mode and configuration choice. */
export type AccountPluginMode = Parameters<PreparedAccountPluginEdit['submit']>[1]
/** Ordinary field metadata published by the original approved current read. */
export type AccountPluginField = AccountPluginEditState['configuration']['fields'][number]
/** One view-only interaction; the original edit closure and version remain private to its account owner. */
export interface AccountPluginEditor {
  readonly phase: 'opening' | 'editing' | 'submitting' | 'result'
  readonly action: 'enabled' | 'selected' | 'configure'
  readonly enabled?: boolean
  readonly selected?: boolean
  readonly fields?: readonly AccountPluginField[]
  readonly path?: readonly string[]
  readonly valueText?: string
  readonly invalid?: boolean
  readonly outcome?: AccountPluginEditOutcome['kind'] | 'unavailable'
  readonly chooseField: (path: readonly string[]) => void
  readonly editValue: (text: string) => void
  readonly submit: (mode: AccountPluginMode) => void
  readonly close: () => void
}
/**
 * Injection captured by the existing Cloud page's dependency fiber.
 * The provider owns current-account checks, pending/unknown outcomes, snapshot publication and shell toasts.
 * A callback is omitted until that operation has a real authorized implementation; it must never use the global Profile manager.
 */
export interface PluginManagementInjected {
  readonly hooks: { readonly accountPluginCatalog: ObservableSnapshot<AccountPluginCatalog> }
  /** Request native entry activation; publish confirmed state through the same catalog source. */
  readonly requestPluginEnabled?: (id: AccountPluginId, enabled: boolean) => void
  /** Request selection of an approved preinstalled bundle; no package installation is exposed. */
  readonly requestPluginSelected?: (id: AccountPluginId, selected: boolean) => void
  /** Open only this approved plugin's registered account configuration surface. */
  readonly openPluginConfiguration?: (id: AccountPluginId) => void
  /** Refresh through the existing account data owner, without a second UI fetch/cache path. */
  readonly refreshPluginCatalog?: () => void
}
