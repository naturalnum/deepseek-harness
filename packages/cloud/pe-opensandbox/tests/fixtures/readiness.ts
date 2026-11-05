/** Explicit component-test remainder; production receives the original lifecycle prepare budget. */
import type { AgentReadinessBudget } from '../../src/lifecycle-types.ts'

/** @returns Finite synthetic budget without requests, timers or backend authority. */
export function readinessBudget(): AgentReadinessBudget {
  return { remainingPolls: 2, intervalMs: 1, deadlineAtMs: Date.now() + 10000, chargeReplyBytes() {} }
}
