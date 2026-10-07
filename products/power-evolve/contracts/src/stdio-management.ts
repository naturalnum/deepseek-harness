/** Owner-scoped STDIO v2 management; requests select literal programs but grant no execution authority. */
import { z } from 'zod'
import { stdioActionRequestV2, stdioCheckRequestV2, stdioExecutionRefV2, stdioInvocationV2, stdioJsonV2,
  stdioLimitsV2, stdioReceiptRequestV2, stdioDigestV2, stdioTaskSchemasV2, type StdioLimitsV2 } from './stdio-mcp.ts'
import { stdioOutcomeV2 } from './stdio-runtime.ts'

/** Deployment budgets for connection labels, lists and each owner's live configurations. */
export const stdioManagementLimitsV2 = z.object({ maxNameBytes: z.number().int().positive().safe(),
  pageItems: z.number().int().positive().safe(), maxConnections: z.number().int().positive().safe() }).strict()
/** Validated management budgets, supplied by the operator rather than the browser. */
export type StdioManagementLimitsV2 = z.infer<typeof stdioManagementLimitsV2>

/** Browser-visible availability and parser budgets; no deployment identity, credentials or worker configuration is exposed. */
export const stdioPublicConfigV2 = z.discriminatedUnion('available', [
  z.object({ formatVersion: z.literal(2), available: z.literal(false) }).strict(),
  z.object({ formatVersion: z.literal(2), available: z.literal(true), limits: stdioLimitsV2,
    management: stdioManagementLimitsV2, maxReplyBytes: z.number().int().positive().safe() }).strict(),
])
/** Exact public availability response, used to select complete browser parser budgets. */
export type StdioPublicConfigV2 = z.infer<typeof stdioPublicConfigV2>

/** Build bounded public action replies without importing Platform readers or private executor observations.
 * @param limits Trusted complete SDK limits from the public configuration, including JSON depth and node ceilings.
 * @param maxReplyBytes Trusted whole reply budget, including task/outcome and all enclosing metadata.
 * @param pageItems Explicit action page ceiling from management.pageItems.
 * @returns Summary, detail, page request and page validators; raw task/outcome JSON is retained without truncation.
 */
export function stdioActionSchemasV2(limits: StdioLimitsV2, maxReplyBytes: number,
  pageItems: number): ReturnType<typeof actionSchemas> {
  return actionSchemas(limits, maxReplyBytes, pageItems)
}

function actionSchemas(limits: StdioLimitsV2, maxReplyBytes: number, pageItems: number) {
  const execution = stdioLimitsV2.parse(limits), bytes = z.number().int().positive().safe().parse(maxReplyBytes)
  const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).parse(pageItems)
  const budget = { maxDepth: execution.maxJsonDepth, maxNodes: execution.maxJsonNodes }
  const bounded = (maxBytes: number) => {
    const json = stdioJsonV2({ ...budget, maxBytes })
    return z.unknown().superRefine((input, ctx) => {
      if (!json.safeParse(input).success) ctx.addIssue({ code: 'custom', message: 'stdio_v2_action_json_invalid' })
    })
  }
  const reply = bounded(bytes), request = bounded(execution.maxInputBytes)
  const integer = z.number().int().nonnegative().safe()
  const fields = {
    formatVersion: z.literal(2), actionId: stdioActionRequestV2.shape.actionId,
    executionRef: stdioExecutionRefV2.options[0], sessionId: stdioCheckRequestV2.shape.sessionId,
    connectionId: stdioCheckRequestV2.shape.connectionId, configRevision: stdioCheckRequestV2.shape.expectedRevision,
    phase: z.enum(['discover', 'call']), taskDigest: stdioDigestV2,
    state: z.enum(['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping',
      'blocked', 'succeeded', 'failed', 'cancelled', 'rejected', 'expired']),
    executionState: z.enum(['queued', 'starting', 'running', 'cancelling', 'uncertain', 'succeeded', 'failed', 'cancelled']),
    cancelRequested: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  }
  const value = z.object(fields).strict(), summary = reply.pipe(value)
  const detail = reply.pipe(value.extend({ task: stdioTaskSchemasV2(execution).task,
    outcome: stdioOutcomeV2(execution, bytes).nullable(),
    noStart: z.object({ kind: z.literal('unstarted_closed'), startNeverAuthorized: z.literal(true),
      resourceDisposition: z.enum(['unallocated', 'ready_retained', 'creation_stopped']) }).strict().nullable(),
  }).strict().superRefine((item, ctx) => {
    const task = item.task, outcome = item.outcome, terminal = ['succeeded', 'failed', 'cancelled'].includes(item.state)
    if (task.actionId !== item.actionId || task.sessionId !== item.sessionId || task.connectionId !== item.connectionId
      || task.configRevision !== item.configRevision || task.phase !== item.phase || task.scopeBinding.kind !== 'cloud'
      || outcome !== null && item.noStart !== null || terminal && outcome === null && item.noStart === null
      || (outcome !== null && (!terminal || item.executionState !== item.state
        || outcome.state === 'completed' && outcome.phase !== task.phase))
      || item.noStart !== null && (item.state !== 'cancelled' || item.executionState !== 'cancelled' || !item.cancelRequested)) {
      ctx.addIssue({ code: 'custom', message: 'stdio_v2_action_detail_invalid' })
    }
  }))
  const listRequest = request.pipe(z.object({ offset: integer, limit: z.number().int().positive().max(count),
    sessionId: stdioCheckRequestV2.shape.sessionId.optional() }).strict()
    .refine(item => Number.isSafeInteger(item.offset + item.limit)))
  const list = reply.pipe(z.object({ items: z.array(summary).max(count), nextOffset: integer.nullable() }).strict())
  return { summary, detail, listRequest, list }
}

/** Persisted logical status; it is neither an approval nor a new physical executor observation. */
export type StdioActionSummaryV2 = Readonly<z.infer<ReturnType<typeof stdioActionSchemasV2>['summary']>>
/** Complete original logical task and formal result; private capture, permits and stop evidence are excluded. */
export type StdioActionDetailV2 = Readonly<z.infer<ReturnType<typeof stdioActionSchemasV2>['detail']>>
/** Explicit bounded page and optional owned Session; identity and placement remain with the authenticated service. */
export type StdioActionListRequestV2 = z.infer<ReturnType<typeof stdioActionSchemasV2>['listRequest']>
/** Bounded persisted summaries; selecting an approval candidate requires the separate authorization reader. */
export type StdioActionListV2 = Readonly<Omit<z.infer<ReturnType<typeof stdioActionSchemasV2>['list']>, 'items'>>
  & { readonly items: readonly StdioActionSummaryV2[] }

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
