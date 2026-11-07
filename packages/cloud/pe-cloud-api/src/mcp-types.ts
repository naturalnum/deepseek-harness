/** Account-local MCP management DTOs; headers are accepted only as explicit credential input. */
import type { McpConnectionId, McpConnectionInput, McpConnectionRecord } from '@deepseek-ai/dsh-pe-cloud-files'

/** One visible connection; configured reports only whether a private credential record exists. */
export interface CloudMcpConnectionView extends McpConnectionRecord {
  readonly configured: boolean
  readonly toolCount: number
}
/** Closed account-local operations; neither package/module names nor account selectors are accepted. */
export type CloudMcpConnectionRequest =
  | { readonly action: 'list' }
  | { readonly action: 'save'; readonly id?: McpConnectionId | undefined; readonly version: string; readonly connection: McpConnectionInput }
  | { readonly action: 'enabled'; readonly id: McpConnectionId; readonly version: string; readonly enabled: boolean }
  | { readonly action: 'remove'; readonly id: McpConnectionId; readonly version: string }
  | { readonly action: 'test'; readonly id?: McpConnectionId | undefined; readonly connection: McpConnectionInput }
/** Actual current list plus an opaque account-generation revision. */
export interface CloudMcpConnectionReply {
  readonly connections: readonly CloudMcpConnectionView[]
  readonly version: string
  readonly limits: Readonly<{ maxConnections: number; maxToolCallTimeoutMs: number }>
  readonly test?: Readonly<{ reachable: boolean; toolCount: number; failure?: 'connection-failed' }>
}
