/** Owner-scoped STDIO v2 management; requests select literal programs but grant no execution authority. */
import { z } from 'zod'
import { stdioActionRequestV2, stdioCheckRequestV2, stdioExecutionRefV2, stdioInvocationV2, stdioJsonV2,
  stdioLimitsV2, stdioReceiptRequestV2, stdioDigestV2, stdioTaskSchemasV2, type StdioLimitsV2 } from './stdio-mcp.ts'

/** Deployment budgets for connection labels, lists and each owner's live configurations. */
export const stdioManagementLimitsV2 = z.object({ maxNameBytes: z.number().int().positive().safe(),
  pageItems: z.number().int().positive().safe(), maxConnections: z.number().int().positive().safe() }).strict()
/** Validated management budgets, supplied by the operator rather than the browser. */
export type StdioManagementLimitsV2 = z.infer<typeof stdioManagementLimitsV2>

/** Build bounded browser requests and receipts without loading executors or secrets.
 * @param executionLimits Validated complete JSON and execution budgets.
 * @param managementLimits Operator-selected label and page budgets.
 * @returns Strict management validators; raw invocation arguments retain their original values.
 */
export function stdioManagementSchemasV2(executionLimits: StdioLimitsV2,
  managementLimits: StdioManagementLimitsV2): ReturnType<typeof managementSchemas> {
  return managementSchemas(executionLimits, managementLimits)
}

function managementSchemas(executionLimits: StdioLimitsV2, managementLimits: StdioManagementLimitsV2) {
  const execution = stdioLimitsV2.parse(executionLimits), management = stdioManagementLimitsV2.parse(managementLimits)
  const json = stdioJsonV2({ maxDepth: execution.maxJsonDepth, maxNodes: execution.maxJsonNodes,
    maxBytes: execution.maxInputBytes })
  const requestId = stdioReceiptRequestV2.shape.requestId, connectionId = stdioCheckRequestV2.shape.connectionId
  const revision = stdioCheckRequestV2.shape.expectedRevision
  const configuration = z.object({ name: z.string().min(1).refine(value => !value.includes('\0')
    && new TextEncoder().encode(value).byteLength <= management.maxNameBytes), invocation: stdioInvocationV2 }).strict()
  const create = json.pipe(z.object({ requestId, configuration }).strict())
  const update = json.pipe(z.object({ requestId, connectionId, expectedRevision: revision, configuration }).strict())
  const toggle = json.pipe(z.object({ requestId, connectionId, expectedRevision: revision, enabled: z.boolean() }).strict())
  const remove = json.pipe(z.object({ requestId, connectionId, expectedRevision: revision }).strict())
  const mutationReceipt = z.object({ requestId, purpose: z.enum(['create', 'update', 'toggle', 'delete']),
    connectionId, revision, enabled: z.boolean(), deleted: z.boolean() }).strict()
  const checkReceipt = z.object({ requestId, purpose: z.literal('check'), connectionId, revision,
    actionId: stdioActionRequestV2.shape.actionId,
    executionRef: stdioExecutionRefV2 }).strict()
  const receipt = z.union([mutationReceipt, checkReceipt])
  const connection = z.object({ connectionId, revision, enabled: z.boolean(), configuration,
    catalogId: stdioTaskSchemasV2(execution).selection.shape.catalogId.nullable(), catalogDigest: stdioDigestV2.nullable(),
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict()
  const listRequest = z.object({ after: connectionId.optional() }).strict()
  const list = z.object({ items: z.array(connection).max(management.pageItems), next: connectionId.nullable() }).strict()
  return { configuration: json.pipe(configuration), create, update, toggle, remove, mutationReceipt,
    checkReceipt, receipt, connection, listRequest, list }
}

/** Literal saved program and label; the configured target is chosen separately for each check. */
export type StdioConfigurationV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['configuration']>
/** Owner-scoped creation with an immutable request identity. */
export type StdioCreateRequestV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['create']>
/** Replacement configuration uses optimistic revision comparison. */
export type StdioUpdateRequestV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['update']>
/** Enabling a connection requires its current successful catalog. */
export type StdioToggleRequestV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['toggle']>
/** Soft deletion retains configuration, approval and execution history. */
export type StdioDeleteRequestV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['remove']>
/** Persistent mutation result; replay returns this original receipt. */
export type StdioMutationReceiptV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['mutationReceipt']>
/** Discovery acceptance identifies the original action and its sole execution. */
export type StdioCheckReceiptV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['checkReceipt']>
/** Read-only management receipt, including discovery admission. */
export type StdioManagementReceiptV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['receipt']>
/** Owned connection view containing no credentials, physical paths or execution authority. */
export type StdioConnectionV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['connection']>
/** Stable UUID cursor within one owner's connections. */
export type StdioListRequestV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['listRequest']>
/** Bounded owner-scoped connection page. */
export type StdioConnectionListV2 = z.infer<ReturnType<typeof stdioManagementSchemasV2>['list']>
