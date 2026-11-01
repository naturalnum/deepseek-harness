/** Optional page-owned, version-bound credential editing for the native web-search card. */

/** One original credential edit intent. No reference or secret is returned to the card. */
export interface PreparedWebSearchCredential {
  /** Whether the original account's approved key was configured when read. */
  readonly configured: boolean
  /** Store exactly once with the original captured edit version. */
  readonly store: (value: string) => Promise<boolean>
}

/** Optional account-owned integration. Presence closes the generic credentials path. */
export interface WebSearchSettingsIntegration {
  /** Whether the page shares this credential with its model provider. */
  readonly sharedModelCredential?: boolean
  /** Prepare one account-bound edit; null or rejection leaves the credential control unavailable. */
  readonly prepare: (signal: AbortSignal) => Promise<PreparedWebSearchCredential | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional page-owned web-search key integration. */
    webSearchSettingsIntegration: WebSearchSettingsIntegration
  }
}
