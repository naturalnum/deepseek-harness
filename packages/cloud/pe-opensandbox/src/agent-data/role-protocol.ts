/** Independent role protocol; installation timing/resource constants and payload pins stay Root-owned. */
import { PROTOCOL, SLICE_LIMITS } from './constants.ts'
import { hex, need, record } from './canonical.ts'
import type { RangeAuthorization } from './types.ts'

/** Version changes before accepting either role; old single-range peers fail closed. */
export const ROLE_PROTOCOL = PROTOCOL
/** Existing lifetime/byte/time budgets, with one simultaneous range for each of the two signed roles. */
export const ROLE_LIMITS = SLICE_LIMITS
/** HMAC key derivation domain shared with the private Python wire validator. */
export const ROLE_DOMAIN = 'dsh:s4:range-role:v1'

/**
 * Parse the complete wire authorization without issuing a role or interpreting command arguments.
 * @param value Untrusted authorization from the original wire message.
 * @returns The validated immutable role, registration identifier and signature.
 */
export function authorization(value: unknown): RangeAuthorization {
  record(value, ['role', 'registrationId', 'signature']); hex(value.signature)
  need(value.role === 'foreground' || value.role === 'service', 'invalid_role')
  if (value.role === 'foreground') need(value.registrationId === null, 'invalid_role_registration')
  else need(typeof value.registrationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.registrationId), 'invalid_role_registration')
  return Object.freeze({ role: value.role, registrationId: value.registrationId, signature: value.signature })
}
