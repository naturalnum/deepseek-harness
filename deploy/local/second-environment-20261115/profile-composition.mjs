/** Public declaration hashing and shared-base rendering used by the normal Root profile generator. */
import { createHash } from 'node:crypto'

const need = (value, message) => { if (!value) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  need(value === null || ['string', 'boolean', 'number'].includes(typeof value)
    && (typeof value !== 'number' || Number.isFinite(value)), 'Only public finite JSON declaration values are accepted')
  return JSON.stringify(value)
}

/** @param value Public Native declaration. @returns Original canonical SHA256 used by preset approvals. */
export const declarationHash = value => hash(canonical(value))

/**
 * Render the original public shared account base with its new credential reference name.
 * @param bytes Pinned public JSON bytes, never a running profile.
 * @param modelReference Original Root's reference name, never a credential value.
 * @returns Completed deterministic base bytes; unresolved placeholders reject.
 */
export function renderAccountBase(bytes, modelReference) {
  need(typeof modelReference === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(modelReference)
    && !modelReference.includes('REQUIRED_NEW'), 'A completed new model credential reference name is required')
  const value = JSON.parse(bytes.toString('utf8').replaceAll('REQUIRED_NEW_MODEL_API_KEY_REF', modelReference))
  need(Array.isArray(value), 'Public shared account base must be an entry array')
  const result = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  need(!/REQUIRED_NEW|__PUBLIC_BASELINE__|@@|ROOT_TO_/.test(result.toString('utf8')), 'Unresolved shared account base placeholder')
  return result
}
