/** Root-private role issuance; neither the carrier nor command JSON chooses a service role. */
import { skillWorld } from './skill-world.ts'
import { filePolicy } from './file-policy.ts'
import { createHmac } from 'node:crypto'
import { asciiJSON, preparedDigest, hex, need, spec } from './canonical.ts'
import { ROLE_DOMAIN, ROLE_PROTOCOL } from './role-protocol.ts'
import type { PreparedRequest, RangeAuthorization, UnsignedPreparedRequest } from './types.ts'

/** Fixed-role authorizer captured by the original Root operation owner before any HTTP mutation. */
export type RoleIssuer = (request: UnsignedPreparedRequest) => PreparedRequest

function issuer(token: string, runtimeIdentity: string, role: RangeAuthorization['role'],
  registration: () => string | null): RoleIssuer {
  hex(token); hex(runtimeIdentity)
  const key = createHmac('sha256', Buffer.from(token, 'hex')).update(ROLE_DOMAIN, 'ascii').digest()
  return (request) => {
    const registrationId = registration()
    const { ref } = request
    need(ref.runtimeIdentity === runtimeIdentity && /^[A-Za-z0-9_-]{1,64}$/.test(ref.operationId), 'operation_binding')
    hex(ref.specHash)
    const normalized = spec(request.spec)
    const fixed = request.skillWorld === undefined ? undefined : skillWorld(request.skillWorld)
    const policy = request.filePolicy === undefined ? undefined : filePolicy(request.filePolicy)
    need(preparedDigest(normalized, fixed, policy) === ref.specHash, 'spec_hash_mismatch')
    const signature = createHmac('sha256', key).update(asciiJSON({ protocolVersion: ROLE_PROTOCOL, runtimeIdentity,
      operationId: ref.operationId, specHash: ref.specHash, role, registrationId }), 'ascii').digest('hex')
    return Object.freeze({ ref: Object.freeze({ ...ref, authorization: Object.freeze({ role, registrationId, signature }) }),
      spec: normalized, ...fixed === undefined ? {} : { skillWorld: fixed }, ...policy === undefined ? {} : { filePolicy: policy } })
  }
}

/**
 * Capture the original Root foreground authority; there is no caller-selected role argument.
 * @param token Existing protected bootstrap token, retained only by Root infrastructure.
 * @param runtimeIdentity Original physical runtime identity.
 * @param assertCurrent Original foreground operation admission check, rechecked at issuance.
 * @returns An authorizer that can sign only foreground operations.
 */
export function createForegroundIssuer(token: string, runtimeIdentity: string, assertCurrent: () => void): RoleIssuer {
  return issuer(token, runtimeIdentity, 'foreground', () => { assertCurrent(); return null })
}

/**
 * Capture an already registered service capability in the original Root owner.
 * @param token Existing protected bootstrap token; never delivered to the service consumer.
 * @param runtimeIdentity Original physical runtime identity.
 * @param service Original Root-registered service capability; command JSON cannot supply it.
 * @param assertRegistered Root's current registry lookup, returning its original stable registration ID.
 * @returns A service-only authorizer that rechecks the captured registration at every issuance.
 */
export function createRegisteredServiceIssuer<Service>(token: string, runtimeIdentity: string,
  service: Service, assertRegistered: (service: Service) => string): RoleIssuer {
  const registrationId = assertRegistered(service)
  need(/^[A-Za-z0-9_-]{1,64}$/.test(registrationId), 'invalid_role_registration')
  return issuer(token, runtimeIdentity, 'service', () => {
    need(assertRegistered(service) === registrationId, 'stale_service_registration')
    return registrationId
  })
}
