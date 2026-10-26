/** Strict, bounded JSON for the Root-approved credential edits; no plaintext result codec. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { CloudApiError } from './errors.ts'
import type { CredentialEditToken, CredentialEditVersion } from './save-hooks.ts'

/** Exact unary endpoints of the independently selected native key service. */
export const MODEL_KEY_RPC_ENDPOINTS: readonly string[] = Object.freeze([
  'cloudModelKey/metadata', 'cloudModelKey/describe', 'cloudModelKey/set', 'cloudModelKey/unset',
])

export type { ModelKeyLimits, ModelKeyReference, ModelKeyUnset, ModelKeySet, ModelKeyState, ModelKeySaved } from './types.ts'
import type { ModelKeyLimits, ModelKeyReference, ModelKeyUnset, ModelKeySet, ModelKeyState, ModelKeySaved } from './types.ts'

function invalid(): never {
  throw new CloudApiError('cloud/forbidden', 'The model key request or response has invalid fields or exceeds its limits.')
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}

/** Validate and detach deployment limits before retaining them in a request adapter.
 * @param limits Trusted deployment values, never request JSON.
 * @param references Finite Root-approved native references; the longest encoded name bounds replies.
 * @returns Frozen finite positive byte bounds.
 */
export function modelKeyLimits(limits: ModelKeyLimits, references: readonly CredentialRef[]): Readonly<ModelKeyLimits> {
  for (const size of [limits.maxKeyBytes, limits.maxVersionBytes, limits.maxReplyBytes]) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new CloudApiError('cloud/invalid-config', 'Model key operations require explicit finite positive byte limits.')
    }
  }
  if (references.length === 0) throw new CloudApiError('cloud/invalid-config', 'Model key policy requires an approved reference.')
  let wrapperBytes = 0
  for (const ref of references) wrapperBytes = Math.max(wrapperBytes, Buffer.byteLength(JSON.stringify({ ref, configured: false,
    writable: false, source: 'file', version: { epoch: '', editToken: '' } }), 'utf8'))
  // JSON escapes can expand each byte of both opaque version strings to six bytes.
  const maximumStateBytes = wrapperBytes + 12 * limits.maxVersionBytes
  if (!Number.isSafeInteger(maximumStateBytes) || limits.maxReplyBytes < maximumStateBytes) {
    throw new CloudApiError('cloud/invalid-config', 'The model key reply budget cannot contain its bounded version metadata.')
  }
  return Object.freeze({ ...limits })
}

/** Materialize strict native Typert codecs without registering or opening a Remote endpoint.
 * @param input Required deployment byte limits.
 * @param references Finite Root-approved native references; request JSON cannot add another ref.
 * @returns Closed input and result codecs; extra fields reject with a fixed nonsecret error.
 */
export function modelKeyCodecs(input: ModelKeyLimits, references: readonly CredentialRef[]): Readonly<{
  describe: Extract<TypertCodec<ModelKeyReference>, { mode: 'strict' }>
  set: Extract<TypertCodec<ModelKeySet>, { mode: 'strict' }>
  unset: Extract<TypertCodec<ModelKeyUnset>, { mode: 'strict' }>
  state: Extract<TypertCodec<ModelKeyState>, { mode: 'strict' }>
  saved: Extract<TypertCodec<ModelKeySaved>, { mode: 'strict' }>
}> {
  const approved = [...new Set(references)]
  const limits = modelKeyLimits(input, approved)
  const text = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum
      || Buffer.byteLength(value, 'utf8') > maximum) invalid()
    return value
  }
  const version = (value: unknown): CredentialEditVersion => {
    const row = record(value, ['epoch', 'editToken'])
    return { epoch: brandString<OwnerEpoch>(text(row.epoch, limits.maxVersionBytes)),
      editToken: brandString<CredentialEditToken>(text(row.editToken, limits.maxVersionBytes)) }
  }
  const reference = (row: Record<string, unknown>): ModelKeyReference => {
    const ref = approved.find(value => value === row.ref)
    if (ref === undefined) invalid()
    return { ref }
  }
  const codec = <T>(name: string, parse: (value: unknown) => T): Extract<TypertCodec<T>, { mode: 'strict' }> => ({
    mode: 'strict', typeSymbol: '@deepseek-ai/dsh-pe-cloud-api/' + name, create: () => ({ parse }),
    decode: parse, encode: value => parse(value),
  })
  const reply = <T>(value: T): T => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.maxReplyBytes) invalid()
    return value
  }
  return Object.freeze({
    describe: codec<ModelKeyReference>('ModelKeyReference', value => reference(record(value, ['ref']))),
    set: codec<ModelKeySet>('ModelKeySet', (value) => {
      const row = record(value, ['ref', 'version', 'value'])
      return { ...reference(row), version: version(row.version), value: text(row.value, limits.maxKeyBytes) }
    }),
    unset: codec<ModelKeyUnset>('ModelKeyUnset', (value) => {
      const row = record(value, ['ref', 'version'])
      return { ...reference(row), version: version(row.version) }
    }),
    state: codec<ModelKeyState>('ModelKeyState', (value) => {
      const row = record(value, ['ref', 'version', 'configured', 'writable', 'source'])
      if (typeof row.configured !== 'boolean' || typeof row.writable !== 'boolean'
        || (row.source !== undefined && row.source !== 'file')
        || row.configured !== (row.source === 'file')) invalid()
      return reply({ ...reference(row), configured: row.configured, writable: row.writable,
        ...row.source === undefined ? {} : { source: 'file' as const }, version: version(row.version) })
    }),
    saved: codec<ModelKeySaved>('ModelKeySaved', (value) => {
      const row = record(value, ['version', 'persisted'])
      if (row.persisted !== true) invalid()
      return reply({ version: version(row.version), persisted: true })
    }),
  })
}
