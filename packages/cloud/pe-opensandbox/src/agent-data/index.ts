/** Internal data-carrier entry for trusted Root; operation and physical ownership remain in its broker. */
import { DataClient } from './client-internal.ts'
import { UndiciOwnedTransport } from './transport.ts'
import { checkOptions } from './validate.ts'
import type { AgentDataClient, ClientOptions } from './types.ts'
/** Type-only caller and fact declarations, documented at their defining interfaces. */
export type * from './types.ts'
/** Frozen runtime pins and slice/carrier limits, documented at each declaration. */
export * from './constants.ts'
/** The private role issuer and data carrier use the same fixed version and limits. */
export { ROLE_PROTOCOL as PROTOCOL, ROLE_LIMITS as SLICE_LIMITS } from './role-protocol.ts'
/** Secret-free typed failures, documented at each declaring error class. */
export * from './errors.ts'
/** Canonical preparation and hashing functions, with parameter/return docs in canonical.ts. */
export { makePrepared, asciiJSON, digest } from './canonical.ts'
/** Original-project world digest helper, documented in validate.ts. */
export { expectedWorldHash } from './validate.ts'
/** Complete encoded guardian-frame preallocation bound, documented in encoded-budget.ts. */
export { guardianEncodedBudget } from './encoded-budget.ts'
/**
 * Create a fixed-runtime data client with one freshly owned undici8.10 Pool.
 * @param options - Protected original Root endpoint, runtime/token, lossless grants and source/world pins.
 * @returns A finite authenticated data carrier; no allocation, Session, job or physical-stop authority is created.
 */
export function createAgentDataClient(options: ClientOptions): AgentDataClient {
  const { origin } = checkOptions(options)
  return new DataClient(options, new UndiciOwnedTransport(origin))
}
