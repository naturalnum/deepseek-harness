/** Optional page-owned read and credential inputs; the native Models controller remains the only page store. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CredentialInfo, LlmConfigurableProvider, LlmProviderInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeView } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelsCredentialEditing } from './operations.ts'

/** Original native provider and settings views, supplied by an admitted readonly reader. */
export interface ModelsSettingsMetadata {
  readonly providers: readonly LlmProviderInfo[]
  readonly configurableProviders: readonly LlmConfigurableProvider[]
  readonly settings: SettingsDescribeView
}

/** Read callbacks bound to the same immutable page as its credential editing source. */
export interface ModelsSettingsReads {
  /** @returns Whether this original page still admits reads; never resolves a replacement page. */
  readonly isCurrent: () => boolean
  /** @returns Actual native provider/schema views; rejection never falls back to native unrestricted reads. */
  readonly metadata: () => Promise<ModelsSettingsMetadata>
  /**
   * Read nonsecret state only; edit versions must not become a latest-token cache.
   * @param refs Named references from the actual native metadata.
   * @returns Native redacted facts for admitted references.
   */
  readonly credentials: (refs: readonly string[]) => Promise<Readonly<Record<string, CredentialInfo>>>
}

/** Prepared before Models activation; null closes Cloud editing while an omitted integration preserves native behavior. */
export interface ModelsSettingsIntegration {
  /** Omit both onboarding registrations when this page uses manual Models setup; omission preserves native behavior. */
  readonly onboarding?: false
  readonly editing: ObservableSnapshot<ModelsCredentialEditing | null>
  readonly reads: ModelsSettingsReads
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Original page-owned Models integration, absent in ordinary native applications. */
    modelsSettingsIntegration: ModelsSettingsIntegration
  }
}
