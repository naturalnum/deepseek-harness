/** Explicit policy for the cloud derivative; no local-path or host-key override. */
export interface RemoteApprovalPolicy {
  readonly alwaysAsk: boolean
  readonly readOnlyAllowlist: readonly string[]
}
