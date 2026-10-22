/** Validate protected verifier output and durable audit rows; no physical recovery actions occur here. */
import { AccountRuntimeError } from './errors.ts'
import { ownerEpoch, readOwnerRow } from './owner-row.ts'
import type { OwnerStoreIdentity, OwnerRecoveryAuthority, OwnerRecoveryExpectation, OwnerRecoveryProof,
  OwnerRecoveryAudit, OwnerRecoveryLimits } from './owner-types.ts'

function refuse(): never {
  throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Trusted recovery evidence is missing, stale or does not cover the exact old owner')
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse()
  return value as Record<string, unknown>
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f]/.test(value)) refuse()
  return value
}

function references(value: unknown, limits: OwnerRecoveryLimits): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxEvidenceRefs) refuse()
  const refs = value.map(item => text(item, limits.maxReferenceBytes))
  if (new Set(refs).size !== refs.length) refuse()
  return Object.freeze(refs)
}

/** Capture one Root-selected callback and immutable bounds; no operation can choose another verifier.
 * @param identity Original replacement-process identity.
 * @param input Trusted constructor input, never Loader/browser JSON.
 * @returns Frozen instance-owned authority.
 */
export function bindRecoveryAuthority(identity: OwnerStoreIdentity, input: OwnerRecoveryAuthority): OwnerRecoveryAuthority {
  if (input.instanceId !== identity.instanceId) refuse()
  const limits = Object.freeze({ ...input.limits })
  for (const [key, maximum] of [['maxAllocations', 128], ['maxEvidenceRefs', 128], ['maxReferenceBytes', 4096],
    ['maxProofBytes', 131072], ['maxAuditRows', 2147483647], ['maxProofAgeMs', 2147483647]] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) refuse()
  }
  const verify = input.verify
  return Object.freeze({ instanceId: identity.instanceId, verifierId: input.verifierId, limits,
    verify: (expected: Readonly<OwnerRecoveryExpectation>) => verify(expected) })
}

/** Detach the verifier callback result before queueing SQL; rejects fake boolean-style evidence.
 * @param input Verifier output or durable audit proof.
 * @param expected Exact account/old instance/epoch/audit identity.
 * @param authority Constructor-selected callback and bounds.
 * @param fresh Whether current freshness is required; historical committed audits may be older.
 * @returns Frozen bounded proof with no credential/process handles.
 */
export function readRecoveryProof(
  input: unknown, expected: OwnerRecoveryExpectation, authority: OwnerRecoveryAuthority, fresh: boolean,
): OwnerRecoveryProof {
  const row = record(input), limits = authority.limits
  if (row.accountId !== expected.accountId || row.oldInstanceId !== expected.oldInstanceId || row.epoch !== expected.epoch
    || row.auditRef !== expected.auditRef || row.verifierId !== authority.verifierId) refuse()
  for (const value of [expected.accountId, expected.oldInstanceId, expected.auditRef]) text(value, limits.maxReferenceBytes)
  ownerEpoch(expected.epoch)
  const verifiedAt = text(row.verifiedAt, 32), at = Date.parse(verifiedAt), now = Date.now()
  if (!Number.isFinite(at) || new Date(at).toISOString() !== verifiedAt
    || (fresh && (at > now || now - at > limits.maxProofAgeMs))) refuse()
  const writersVerifiedAt = text(row.writersVerifiedAt, 32), writersAt = Date.parse(writersVerifiedAt)
  if (!Number.isFinite(writersAt) || new Date(writersAt).toISOString() !== writersVerifiedAt || writersAt > at) refuse()
  if (!Array.isArray(row.allocations) || row.allocations.length > limits.maxAllocations) refuse()
  const allocations = row.allocations.map((input) => {
    const item = record(input)
    return Object.freeze({ allocationId: text(item.allocationId, limits.maxReferenceBytes),
      evidenceRefs: references(item.evidenceRefs, limits) })
  })
  if (new Set(allocations.map(item => item.allocationId)).size !== allocations.length) refuse()
  const proof: OwnerRecoveryProof = Object.freeze({ ...expected, verifierId: authority.verifierId, verifiedAt, writersVerifiedAt,
    databaseRole: text(row.databaseRole, limits.maxReferenceBytes),
    oldProcessEvidenceRef: text(row.oldProcessEvidenceRef, limits.maxReferenceBytes),
    writerLossEvidenceRef: text(row.writerLossEvidenceRef, limits.maxReferenceBytes),
    lateCreateFenceEvidenceRef: text(row.lateCreateFenceEvidenceRef, limits.maxReferenceBytes),
    lateSpawnFenceEvidenceRef: text(row.lateSpawnFenceEvidenceRef, limits.maxReferenceBytes),
    evidenceRefs: references(row.evidenceRefs, limits), allocations: Object.freeze(allocations) })
  if (Buffer.byteLength(JSON.stringify(proof)) > limits.maxProofBytes) refuse()
  return proof
}

/** Decode exact immutable audit evidence, never treating corrupt JSON as a missing audit.
 * @param input One owned SQL result value.
 * @param expected Exact operation identity.
 * @param authority Original authority and bounds.
 * @returns Validated historical unowned postimage and proof.
 */
export function readRecoveryAudit(
  input: unknown, expected: OwnerRecoveryExpectation, authority: OwnerRecoveryAuthority,
): OwnerRecoveryAudit {
  const row = record(input), proof = readRecoveryProof(row.proof, expected, authority, false)
  const postimage = readOwnerRow({ owner: row.postimage })
  if (postimage.accountId !== expected.accountId || postimage.epoch !== expected.epoch
    || postimage.ownerInstanceId !== null || postimage.phase !== 'unowned') refuse()
  return Object.freeze({ proof, postimage })
}
