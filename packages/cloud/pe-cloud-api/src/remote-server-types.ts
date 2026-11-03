/** Browser-safe remote-server request/result DTOs. Credentials appear only in the explicit upload request. */
export interface RemoteServerForm {
  readonly alias: string
  readonly host: string
  readonly user: string
  readonly port: number
  readonly description: string
  readonly tags: string[]
  readonly alwaysAsk: boolean
}
/** Metadata and real observations, with no credential value or Host filesystem address. */
export interface RemoteServerView {
  readonly entry: RemoteServerForm & { readonly id: string }
  readonly reference: string
  readonly configured: boolean
  readonly factsOmitted?: boolean
  readonly connectivity?: { readonly reachable: boolean
    readonly checkedAt: string
    readonly failure?: string }
  readonly facts?: {
    readonly hostname: string | null
    readonly os: string | null
    readonly kernel: string | null
    readonly arch: string | null
    readonly cpuModel: string | null
    readonly cpuCores: number | null
    readonly memTotalKb: number | null
    readonly memAvailableKb: number | null
    readonly diskTotalKb: number | null
    readonly diskAvailableKb: number | null
    readonly uptimeSeconds: number | null
    readonly collectedAt: string
  }
}
/** Closed management operations. Actual SSH work is available only through the original native tool/Session chain. */
export type RemoteServerRequest =
  | { readonly action: 'list' }
  | { readonly action: 'add'
    readonly entry: RemoteServerForm }
  | { readonly action: 'update'
    readonly id: string
    readonly entry: RemoteServerForm }
  | { readonly action: 'remove'
    readonly id: string }
  | { readonly action: 'reorder'
    readonly ids: readonly string[] }
  | { readonly action: 'credential'
    readonly id: string
    readonly privateKey: string
    readonly knownHosts: string }
  | { readonly action: 'import'
    readonly text: string }
/** One bounded complete response; imported hosts still require account-authorized keys before execution. */
export interface RemoteServerReply {
  readonly limits: { readonly maxPrivateKeyBytes: number
    readonly maxKnownHostsBytes: number
    readonly maxImportBytes: number }
  readonly servers: readonly RemoteServerView[]
  readonly imported?: number }
