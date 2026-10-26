/** Host-only metadata classification; no result grants account or network admission. */
import type {
  AccountId, AccountOwner, InstanceId, RuntimeInstanceRecord,
} from '@deepseek-ai/dsh-pe-cloud-runtime/types'

/** Validated Root deployment selection, independently supplied from request and PG metadata. */
export interface TrustedOwnerTarget {
  readonly internalAddress: string
  /** Reference to the identity the forwarding provider must actually authenticate. */
  readonly serviceIdentityRef: string
}

/** Existing decoded metadata and the calling process's actual startup identity. */
export interface OwnerDestinationInput {
  readonly accountId: AccountId
  readonly localInstanceId: InstanceId
  readonly recipeVersion: string
  readonly owner: AccountOwner | undefined
  readonly instance: RuntimeInstanceRecord | undefined
  readonly trustedTargets: ReadonlyMap<InstanceId, TrustedOwnerTarget>
}

/** A detached hint for a future owner, never a wire response, capability or readiness receipt. */
export type OwnerDestination =
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{
    kind: 'local-candidate'
    owner: AccountOwner
    instance: RuntimeInstanceRecord
  }>
  | Readonly<{
    kind: 'remote-candidate'
    owner: AccountOwner
    instance: RuntimeInstanceRecord
    target: TrustedOwnerTarget
  }>

/**
 * Classify one already decoded owner/instance pair without claiming or creating anything.
 * @param input Trusted authentication, startup and deployment facts plus one metadata read.
 * @returns A frozen candidate requiring original owner/epoch/login checks and actual transport identity.
 */
export function selectOwnerDestination(input: OwnerDestinationInput): OwnerDestination {
  const { owner, instance } = input
  if (owner === undefined || owner.accountId !== input.accountId || owner.phase !== 'ready'
    || owner.ownerInstanceId === null || owner.recipeVersion !== input.recipeVersion
    || instance === undefined || instance.instanceId !== owner.ownerInstanceId
    || instance.phase !== 'registered' || instance.recipeVersion !== input.recipeVersion) {
    return Object.freeze({ kind: 'unavailable' })
  }
  const snapshot = { owner: Object.freeze({ ...owner }), instance: Object.freeze({ ...instance }) }
  if (owner.ownerInstanceId === input.localInstanceId) {
    return Object.freeze({ kind: 'local-candidate', ...snapshot })
  }
  const target = input.trustedTargets.get(owner.ownerInstanceId)
  if (target === undefined || target.internalAddress !== instance.internalAddress) {
    return Object.freeze({ kind: 'unavailable' })
  }
  return Object.freeze({ kind: 'remote-candidate', ...snapshot, target: Object.freeze({ ...target }) })
}
