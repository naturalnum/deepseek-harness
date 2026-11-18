/** Explicit protected maintenance publication; opening it grants no ordinary account or execution admission. */
import { ExecutionStateError } from '../errors.ts'
import { BootstrapFailure } from './bootstrap.ts'
import { RootDeploymentLease, type RootDeploymentReference } from './deployment-reference.ts'
import { RootRecoveryWitness, type RecoveryWitnessLimits } from './recovery-witness.ts'

/** Root-only maintenance input; maxBytes/maxAgeMs are required deployment decisions. */
export interface RootRecoveryReference {
  readonly publication: RootDeploymentReference
  readonly maxBytes: number
  readonly maxAgeMs: number
  /** Host administrator's exact selection and principal reference in the protected maintenance configuration. */
  readonly target?: Readonly<{ accountId: string; oldInstanceId: string; epoch: string; operatorRef: string }>
}

function need(value: boolean): asserts value {
  if (!value) throw new ExecutionStateError('cloud/invalid-config', 'Root recovery publication requires an explicit protected reference and finite limits.')
}

/**
 * Parse only the supported Root maintenance reference.
 * @param value Root Loader input, never an account or browser configuration.
 * @returns Validated reference; the subsequent retained lease must verify actual protection and bytes.
 */
export function parseRootRecoveryReference(value: unknown): RootRecoveryReference {
  need(value !== null && typeof value === 'object' && !Array.isArray(value))
  const input = value as Record<string, unknown>
  const hasTarget = Object.hasOwn(input, 'target')
  need(Object.keys(input).length === (hasTarget ? 4 : 3)
    && ['publication', 'maxBytes', 'maxAgeMs'].every(key => Object.hasOwn(input, key)))
  need(input.publication !== null && typeof input.publication === 'object' && !Array.isArray(input.publication))
  const publication = input.publication as Record<string, unknown>
  need(Object.keys(publication).length === 2 && typeof publication.path === 'string' && publication.path.length > 0
    && typeof publication.sha256 === 'string' && /^[a-f0-9]{64}$/.test(publication.sha256))
  need(typeof input.maxBytes === 'number' && Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 && input.maxBytes <= 131072
    && typeof input.maxAgeMs === 'number' && Number.isSafeInteger(input.maxAgeMs) && input.maxAgeMs > 0 && input.maxAgeMs <= 2147483647)
  let target: RootRecoveryReference['target']
  if (hasTarget) {
    need(input.target !== null && typeof input.target === 'object' && !Array.isArray(input.target))
    const row = input.target as Record<string, unknown>
    const { accountId, oldInstanceId, epoch, operatorRef } = row
    need(Object.keys(row).length === 4 && ['accountId', 'oldInstanceId', 'epoch', 'operatorRef'].every(key => Object.hasOwn(row, key))
      && typeof accountId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(accountId)
      && typeof oldInstanceId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(oldInstanceId)
      && typeof epoch === 'string' && /^[1-9]\d{0,18}$/.test(epoch) && BigInt(epoch) <= 9_223_372_036_854_775_807n
      && typeof operatorRef === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(operatorRef))
    target = Object.freeze({ accountId, oldInstanceId, epoch, operatorRef })
  }
  return Object.freeze({ publication: Object.freeze({ path: publication.path, sha256: publication.sha256 }),
    maxBytes: input.maxBytes, maxAgeMs: input.maxAgeMs, ...(target === undefined ? {} : { target }) })
}

/** Retained maintenance selection; Root closes it only after the original recovery work actually settles. */
export interface RootRecoverySelection {
  readonly witness: RootRecoveryWitness
  /** Close the original file lease; uncertainty rejects rather than authorizing reuse. */
  close(): void
}

/**
 * Open the protected Root receipt and independently check its selected process or local terminated-kernel proof.
 * @param reference Explicit Root-selected file and byte/age limits.
 * @param capacities Existing finite account, allocation and field capacities.
 * @returns The original verifier and retained readonly selection.
 */
export function openRootRecoveryReference(reference: RootRecoveryReference,
  capacities: Omit<RecoveryWitnessLimits, 'maxBytes' | 'maxAgeMs'>): RootRecoverySelection {
  need(process.platform === 'linux' && process.getuid?.() === 2000 && process.getgid?.() === 2000)
  const publication = new RootDeploymentLease(reference.publication, reference.maxBytes, 'configuration')
  try {
    const witness = new RootRecoveryWitness(publication, { ...capacities, maxBytes: reference.maxBytes, maxAgeMs: reference.maxAgeMs })
    return Object.freeze({ witness, close: () => { publication.close() } })
  } catch (cause) {
    try { publication.close() }
    catch (closeCause) {
      throw new BootstrapFailure('wire-unknown', Object.freeze({ kind: 'recovery-publication-close', cause, closeCause, publication }))
    }
    throw cause
  }
}
