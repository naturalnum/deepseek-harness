/** Optional account-specific binding to one actual native Settings namespace. */
export interface SubagentSettingsIntegration {
  readonly namespace: string
  /** Exact fields the account has advertised; this grants no permission. */
  readonly fields: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context { subagentSettingsIntegration?: SubagentSettingsIntegration }
}
