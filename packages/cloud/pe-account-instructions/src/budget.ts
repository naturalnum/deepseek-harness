/** Allocation-free JSON sizing and conservative snapshot text-copy accounting. */
import type { Config } from './config.ts'
import { InstructionConfigurationError } from './error.ts'

/**
 * Count UTF-8 JSON string bytes without allocating an escaped copy.
 * @param text - source or metadata string.
 * @returns the exact JSON.stringify string size, including quotes.
 */
export function jsonStringBytes(text: string): number {
  let extra = 0
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) extra++
    else if (unit < 32) extra += 5
    else if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) index++
      else extra += 3
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) extra += 3
  }
  return Buffer.byteLength(text, 'utf8') + extra + 2
}

/**
 * Size producer-owned JSON data without serializing a complete envelope.
 * @param value - finite primitives, dense arrays and plain owned data objects.
 * @returns exact UTF-8 JSON bytes.
 * @throws for a non-JSON value, which is an internal producer defect.
 */
export function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return jsonStringBytes(value)
  if (value === null) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).length
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value
    return 2 + Math.max(0, entries.length - 1) + entries.reduce<number>((size, entry) => size + jsonBytes(entry), 0)
  }
  if (typeof value === 'object') {
    const entries: [string, unknown][] = Object.entries(value)
    return 2 + Math.max(0, entries.length - 1)
      + entries.reduce((size, [key, entry]) => size + jsonStringBytes(key) + 1 + jsonBytes(entry), 0)
  }
  throw new Error('pe-account-instructions: snapshot producer supplied non-JSON metadata')
}

/**
 * Calculate text storage for source chunk/join/hash work and complete message copies.
 * Sixteen simultaneous message equivalents, each at the UTF-16 upper bound of
 * twice its encoded bytes, cover preparation, native freeze, log/request handoff
 * and serialization scratch. Source chunk/concat and hash buffers are additional.
 * This covers byte/text storage, not V8 object overhead or whole-process RSS.
 * @param config - declared source and encoded-message maxima.
 * @returns the conservative per-snapshot reservation required before I/O.
 * @throws when the arithmetic cannot be represented as a safe integer.
 */
export function requiredResidentBytes(config: Pick<Config, 'maxSnapshotBytes' | 'maxTotalBytes' | 'maxFileBytes'>): number {
  const bytes = 32 * config.maxSnapshotBytes + 4 * config.maxTotalBytes + 2 * config.maxFileBytes
  if (!Number.isSafeInteger(bytes)) throw new InstructionConfigurationError('Instruction byte reservations exceed the safe integer range.')
  return bytes
}
