import type { ManagedSkillApiLimits } from './managed-skill-types.ts'
/** API-owned exposure declarations; native Session and Remote DTOs stay in DSH. */
export type * from './save-hooks.ts'
export type * from './skill-types.ts'
export type * from './managed-skill-types.ts'
export type * from './plugin-types.ts'
import type { PluginControlLimits } from './plugin-types.ts'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmProviderInfo, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm/types'
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-settings/types'
import type { CredentialEditVersion } from './save-hooks.ts'
import type { SkillPublicationLimits } from './skill-types.ts'

/** Display metadata only; allocation paths and Workspace identity never come from the caller. */
export interface CloudProjectCreateRequest {
  readonly title?: string
}

/** Resource verifier selected by each reviewed entry. */
export type ExposureGuard = 'authenticated-account' | 'account-project' | 'account-session' | 'account-attachment'

/** One exact native RPC or logical-stream declaration. */
export interface EndpointExposure {
  readonly endpoint: string
  readonly handlerId: string
  readonly guard: ExposureGuard
}

/** One exact Fetch route; method and pathname must both match. */
export interface ExactFetchExposure {
  readonly method: string
  readonly path: string
  readonly handlerId: string
  readonly guard: ExposureGuard
}

/** Deployment-reviewed settings namespace and exact writable field paths. */
export interface SettingsExposure {
  readonly namespace: string
  readonly fields: readonly string[]
}

/** Deployment policy, distinct from any account's enabled capabilities. */
export interface ExposureManifest {
  readonly recipeVersion: string
  readonly rpcEndpoints: readonly EndpointExposure[]
  readonly streamEndpoints: readonly EndpointExposure[]
  readonly exactFetchRoutes: readonly ExactFetchExposure[]
  readonly allowedSettings: readonly SettingsExposure[]
}

/** Actual mounted declarations supplied by the native transport adapter. */
export interface ExposureInventory {
  readonly recipeVersion: string
  readonly rpcEndpoints: readonly EndpointExposure[]
  readonly streamEndpoints: readonly EndpointExposure[]
  readonly exactFetchRoutes: readonly ExactFetchExposure[]
}

/** Immutable operations and ordinary Config paths approved for one exact preinstalled code entry. */
export interface ApprovedPluginControl {
  readonly selectionTarget: Readonly<{ kind: 'entry'; id: string }> | Readonly<{ kind: 'bundle'; name: string }>
  readonly operations: readonly ('enabled' | 'configure' | 'selected')[]
  readonly maxImpact: 'live' | 'local' | 'graph'
  readonly fields: readonly (readonly string[])[]
}

/** One exact installed plugin's approved controls and server-only native mapping. */
export interface ApprovedConfigurationPlugin {
  readonly id: string
  readonly entryId: string
  readonly moduleName: string
  readonly packageName: string
  readonly packageVersion: string
  readonly installable: false
  readonly toggleable: boolean
  readonly control?: ApprovedPluginControl
}

/** One preinstalled bundle selection and its complete approved native member mapping. */
export interface ApprovedConfigurationBundle {
  readonly id: string
  readonly packageName: string
  readonly packageVersion: string
  readonly control: ApprovedPluginControl
  readonly members: readonly Pick<ApprovedConfigurationPlugin, 'entryId' | 'moduleName' | 'packageName' | 'packageVersion'>[]
}

/** Root-approved native provider identity and its declared credential reference. */
export interface ApprovedModelKeyBinding {
  readonly provider: string
  readonly providerEntryId: string
  readonly moduleName: string
  readonly ref: CredentialRef
}

/** Explicit finite native provider/reference selection for the existing key Remote. */
export interface ApprovedModelKeyConfiguration {
  readonly bindings: readonly ApprovedModelKeyBinding[]
  readonly maxKeyBytes: number
  readonly maxVersionBytes: number
  readonly maxReplyBytes: number
  readonly maxMetadataBytes: number
}

/** One approved native top-level scalar field; native schema and save planning remain authoritative. */
export interface ApprovedConfigurationField {
  readonly namespace: string
  readonly field: string
  /** Optional finite set-only write domain; omission retains the original native schema domain and unset. */
  readonly values?: readonly (string | number | boolean | null)[]
}

/** The existing locale slice keeps its exact two approved values. */
export interface ApprovedLocalePreferenceField {
  readonly namespace: 'locale'
  readonly field: 'preference'
  readonly values: readonly ['zh', 'en']
}

/** Immutable first-trial deployment catalog; actual account inventory must still be checked on every projection. */
export interface ApprovedConfigurationCatalog {
  readonly recipeVersion: string
  readonly catalogVersion: string
  readonly maxEntries: number
  readonly maxStringBytes: number
  readonly maxCatalogBytes: number
  readonly plugins: readonly ApprovedConfigurationPlugin[]
  readonly bundles?: readonly ApprovedConfigurationBundle[]
  readonly skills: Readonly<{ mode: 'closed' }> | Readonly<{ mode: 'sample'; limits: Readonly<SkillPublicationLimits> }>
    | Readonly<{ mode: 'managed'; limits: Readonly<SkillPublicationLimits>; management: Readonly<ManagedSkillApiLimits> }>
  readonly credentials: Readonly<{ mode: 'read-only' }>
  readonly modelKey?: ApprovedModelKeyConfiguration
  readonly pluginControl?: Readonly<PluginControlLimits>
  readonly fields: readonly ApprovedConfigurationField[]
}

/** Root exposure plus optional explicit catalog; omission cannot produce successful configuration metadata. */
export interface ExposureRootConfig extends ExposureManifest {
  readonly rpcEndpoints: EndpointExposure[]
  readonly streamEndpoints: EndpointExposure[]
  readonly exactFetchRoutes: ExactFetchExposure[]
  readonly allowedSettings: Array<{ readonly namespace: string; readonly fields: string[] }>
  readonly approvedConfiguration?: ApprovedConfigurationCatalog
}

/** Explicit deployment bounds for the approved model key; the carrier also bounds its complete request. */
export interface ModelKeyLimits {
  readonly maxKeyBytes: number
  readonly maxVersionBytes: number
  readonly maxReplyBytes: number
}
/** One native reference; the Host codec admits only the Root-approved finite selection. */
export interface ModelKeyReference { readonly ref: CredentialRef }
/** Native storage edit guarded by the existing save owner's captured version. */
export interface ModelKeyUnset extends ModelKeyReference { readonly version: CredentialEditVersion }
/** Secret input for exactly one checked native set operation. */
export interface ModelKeySet extends ModelKeyUnset { readonly value: string }
/** Redacted native state and opaque edit version; only the managed file configures this reference. */
export interface ModelKeyState extends ModelKeyUnset {
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: 'file'
}
/** Confirms native persistence without claiming remote model usability. */
export interface ModelKeySaved { readonly version: CredentialEditVersion; readonly persisted: true }
/** Actual readonly native metadata; edit versions are read separately for an explicit edit. */
export interface ModelKeyMetadata {
  readonly providers: LlmProviderInfo[]
  readonly configurableProviders: LlmConfigurableProvider[]
  readonly settings: SettingsDescribeValue
}

/** Exact account-local preset identity; raw YAML/configuration reads are not exposed. */
export interface CloudPresetReference { readonly id: string }
/** Native public composition summary; config values, expressions and raw diagnostics are excluded. */
export type CloudPresetComposition = import('@deepseek-ai/dsh-host-plugin-inventory/types').AgentPresetPluginGroup
