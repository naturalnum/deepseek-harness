/** Remote MCP route dispatch after the Platform has authenticated the required credential audience. */
import { z } from 'zod'
import { PlatformError, type Identity } from '../contracts.ts'
import { mcpActionDecision, mcpActionId, mcpPermissionId } from '../mcp-action-contracts.ts'
import { mcpManagementEndpoints, mcpManagementRequests } from '../mcp-management-rpc.ts'
import type { McpActionStore } from './mcp-actions.ts'
import type { McpConnectionService } from './mcp-connections.ts'

/** Route inputs use the same validators as the native Host RPC; no user field grants ownership.
 * @param service Configured management service; null supports a truthful unavailable list.
 * @param path Internal Platform management path.
 * @param user Independently authenticated Agent-audience identity.
 * @param input Bounded request JSON.
 * @param platformOrigin Configured trusted upload origin.
 * @returns Metadata-only connection, check, ticket or receipt response.
 */
export async function routeMcpManagement(service: McpConnectionService | null, path: string,
  user: Identity, input: unknown, platformOrigin: string): Promise<unknown> {
  const requests = mcpManagementRequests, endpoints = mcpManagementEndpoints
  if (path === endpoints.mcpConnectionsList) {
    requests.mcpConnectionsList.parse(input)
    return service ? { available: true, ...await service.list(user) } : { available: false, items: [] }
  }
  if (!service) throw new PlatformError(503, 'mcp_unavailable')
  switch (path) {
    case endpoints.mcpConnectionsCreate: return service.create(user, requests.mcpConnectionsCreate.parse(input))
    case endpoints.mcpConnectionsUpdate: return service.update(user, requests.mcpConnectionsUpdate.parse(input))
    case endpoints.mcpConnectionsToggle: return service.toggle(user, requests.mcpConnectionsToggle.parse(input))
    case endpoints.mcpConnectionsDelete: return service.remove(user, requests.mcpConnectionsDelete.parse(input))
    case endpoints.mcpConnectionsTicket: return service.issueTicket(user, requests.mcpConnectionsTicket.parse(input), platformOrigin)
    case endpoints.mcpConnectionsReceipt: return service.receipt(user, requests.mcpConnectionsReceipt.parse(input).requestId)
    case endpoints.mcpConnectionsCheck: return service.startCheck(user, requests.mcpConnectionsCheck.parse(input))
    case endpoints.mcpConnectionsDraftCheck: return service.startDraftCheck(user, requests.mcpConnectionsDraftCheck.parse(input))
    case endpoints.mcpConnectionsCheckStatus: return service.check(user, requests.mcpConnectionsCheckStatus.parse(input).checkId)
    case endpoints.mcpConnectionsCheckCancel: return service.cancelCheck(user, requests.mcpConnectionsCheckCancel.parse(input).checkId)
    default: throw new PlatformError(404, 'not_found')
  }
}

/** Approval methods belong only to the separately authenticated trusted Platform origin.
 * @param store Configured action store, or null when generic MCP is disabled.
 * @param path Approval route; never call this dispatcher for Agent-audience credentials.
 * @param user Independently authenticated approval-audience identity.
 * @param input Bounded approval JSON; all choices bind an exact action and fingerprint.
 * @returns Durable receipt or approval metadata, never a new execution grant.
 */
export async function routeMcpApproval(store: McpActionStore | null, path: string,
  user: Identity, input: unknown): Promise<unknown> {
  if (path === '/approvals/mcp/list') {
    z.object({}).strict().parse(input)
    return store ? store.approvals(user) : { items: [] }
  }
  if (!store) throw new PlatformError(503, 'mcp_unavailable')
  switch (path) {
    case '/approvals/mcp/decide': {
      const value = z.object({ actionId: mcpActionId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        decision: mcpActionDecision }).strict().parse(input)
      return store.decide(user, value.actionId, value.fingerprint, value.decision)
    }
    case '/approvals/mcp/cancel': return store.cancel(user, z.object({ actionId: mcpActionId }).strict().parse(input).actionId)
    case '/approvals/mcp/revoke': {
      await store.revoke(user, z.object({ permissionId: mcpPermissionId }).strict().parse(input).permissionId)
      return { ok: true }
    }
    default: throw new PlatformError(404, 'not_found')
  }
}
