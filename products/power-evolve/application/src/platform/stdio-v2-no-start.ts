/** Immutable internal discovery closure records; none is an SDK result or a proof of runtime UID quiet. */
import { z } from 'zod'
import { accountUserId } from '@power-evolve/contracts/account'
import { stdioDigestV2, stdioExecutionRefV2, stdioJsonV2, stdioPreparedV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { storageBinding } from './workspace-binding-types.ts'

const uuid = z.uuid(), generation = z.string().regex(/^(0|[1-9][0-9]*)$/u)
const name = z.string().min(1).refine(value => !value.includes('\0'))
/** Existing durable creation-stop evidence, bound to the original Pod, parent, Session and storage generation. */
export const stdioCreationStopEvidenceV2 = z.object({
  status: z.enum(['KUBELET_STOPPED', 'UNSCHEDULED_DELETING']), podUid: uuid, sandboxUid: uuid,
  generation, sessionId: uuid, runnerInstanceId: z.null(), bindingSnapshot: storageBinding,
  observedAt: z.iso.datetime(),
}).strict()
const resource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unallocated') }).strict(),
  z.object({ kind: z.literal('ready_retained'), name, podUid: uuid, runnerInstanceId: uuid,
    mountGeneration: generation, bindingSnapshot: storageBinding }).strict(),
  z.object({ kind: z.literal('creation_stopped'), name, mountGeneration: generation,
    bindingSnapshot: storageBinding, stopEvidence: stdioCreationStopEvidenceV2 }).strict(),
])
const receipt = z.object({ formatVersion: z.literal(2), kind: z.literal('unstarted_closed'),
  actionId: stdioPreparedV2.shape.actionId, executionRef: stdioExecutionRefV2.options[0],
  taskDigest: stdioDigestV2, preparedDigest: stdioDigestV2.nullable(), userId: accountUserId,
  sessionId: uuid, phase: z.literal('discover'), state: z.literal('cancelled'),
  startNeverAuthorized: z.literal(true), resource,
}).strict()

/** Resource disposition at the first no-start closure; retained ready resources are not asserted physically quiet. */
export type StdioNoStartResourceV2 = z.infer<typeof resource>
/** Original internal discover receipt, independent from runtime observations, results and catalogs. */
export type StdioNoStartReceiptV2 = z.infer<typeof receipt>

/** Parse the complete immutable closure using the original trusted input budget.
 * @param value Stored or newly constructed internal receipt; no field is defaulted.
 * @param limits Original frozen STDIO input, depth and node limits.
 * @returns Complete receipt including its original storage and creation-stop evidence.
 */
export function parseStdioNoStartReceiptV2(value: unknown, limits: StdioLimitsV2): StdioNoStartReceiptV2 {
  return stdioJsonV2({ maxBytes: limits.maxInputBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
    .pipe(receipt).parse(value)
}
