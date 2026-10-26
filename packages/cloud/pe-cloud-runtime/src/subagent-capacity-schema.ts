/** Trusted deployment limits, separate from account volatile subagent preferences. */
import z from '@deepseek-ai/schemastery'
import type { SubagentCapacityLimits } from './types.ts'
import { AccountRuntimeError } from './errors.ts'

const fields: z<SubagentCapacityLimits> = z.object({
  maxActivePerAccount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxActiveTotal: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxDepth: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
}).required()

/** Exactly three explicit positive safe integers; no field is volatile or defaulted. */
export const SubagentCapacityLimitsSchema: z<SubagentCapacityLimits> = z.transform(fields, (limits) => {
  const names = ['maxActivePerAccount', 'maxActiveTotal', 'maxDepth']
  if (Object.keys(limits).some(key => !names.includes(key))) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Subagent deployment limits contain an unsupported field')
  }
  return limits
}).required()

/** Resolve the optional native parser value before constructing a capacity owner.
 * @param limits Selected deployment limits; undefined keeps child reservations closed.
 * @returns The validated selected limits, or undefined without creating defaults.
 */
export function resolveSubagentCapacity(limits: SubagentCapacityLimits | undefined): SubagentCapacityLimits | undefined {
  return limits === undefined ? undefined : SubagentCapacityLimitsSchema(limits, { path: ['subagentCapacity'] })
}
