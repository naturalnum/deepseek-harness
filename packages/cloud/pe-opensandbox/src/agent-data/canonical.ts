/** Canonical ASCII encoding and finite request validation shared by the private data carrier. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { LocalRefusal } from './errors.ts'
import type { OperationSpec, UnsignedPreparedRequest } from './types.ts'

/**
 * Refuse a failed local validation without retaining raw input in the error.
 * @param ok - Condition required by the current parser or admission operation.
 * @param code - Stable secret-free local failure classification.
 * @returns Nothing; narrows the required condition on success.
 */
export function need(ok: unknown, code = 'invalid_schema'): asserts ok { if (!ok) throw new LocalRefusal(code) }
/**
 * Require a string with paired UTF-16 surrogates before Unicode encoding.
 * @param value - Parsed or caller-provided string candidate.
 * @returns Nothing; narrows value to a losslessly encodable string.
 */
export function text(value: unknown): asserts value is string {
  need(typeof value === 'string', 'invalid_string')
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i)
    if (n >= 0xd800 && n <= 0xdbff) { const low = value.charCodeAt(++i); need(low >= 0xdc00 && low <= 0xdfff, 'unpaired_surrogate') }
    else need(n < 0xdc00 || n > 0xdfff, 'unpaired_surrogate')
  }
}
/**
 * Require an object containing exactly the allowed own field names.
 * @param value - Object candidate at the current JSON or configuration parser.
 * @param fields - Complete allowed field set.
 * @returns Nothing; narrows value to a record with validated field membership.
 */
export function record(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value))
  const keys = Object.keys(value)
  need(keys.length === fields.length && fields.every(k => Object.hasOwn(value, k)))
}
/**
 * Require a canonical 256-bit lowercase hexadecimal identifier or digest.
 * @param value - Identifier or digest candidate.
 * @returns Nothing; narrows value to the validated string.
 */
export function hex(value: unknown): asserts value is string { need(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid_hash') }
/**
 * Require a lossless canonical uint64 decimal string without Number conversion.
 * @param value - Root quantity candidate.
 * @param zero - Whether the quantity is a device identifier which permits zero.
 * @returns Nothing; narrows value to the validated canonical decimal string.
 */
export function u64(value: unknown, zero = false): asserts value is string {
  need(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && (zero || value !== '0')
    && BigInt(value) <= 18446744073709551615n, 'invalid_u64')
}
function quote(value: string): string {
  text(value)
  let result = '"'
  const short: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' }
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i)
    result += short[n] ?? (n < 32 || n >= 127 ? '\\u' + n.toString(16).padStart(4, '0') : value.charAt(i))
  }
  return result + '"'
}
function compareKeys(a: string, b: string): number {
  const x = a[Symbol.iterator](), y = b[Symbol.iterator]()
  for (;;) {
    const left = x.next(), right = y.next()
    if (left.done || right.done) return left.done ? (right.done ? 0 : -1) : 1
    const first = left.value.codePointAt(0), second = right.value.codePointAt(0)
    need(first !== undefined && second !== undefined, 'invalid_string')
    if (first !== second) return first - second
  }
}
/**
 * Encode bounded-depth safe-integer JSON with Python ensure_ascii and codepoint-sorted keys.
 * @param value - JSON value whose strings must have paired surrogates.
 * @param depth - Current recursive nesting depth, starting at zero.
 * @returns Canonical ASCII JSON suitable for the frozen Python hash algorithm.
 */
export function asciiJSON(value: unknown, depth = 0): string {
  need(depth <= 16, 'json_depth')
  if (value === null) return 'null'
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') { need(Number.isSafeInteger(value) && !Object.is(value, -0), 'invalid_number'); return String(value) }
  if (Array.isArray(value)) return '[' + value.map(v => asciiJSON(v, depth + 1)).join(',') + ']'
  need(typeof value === 'object', 'invalid_object')
  const prototype: unknown = Object.getPrototypeOf(value)
  need(prototype === Object.prototype || prototype === null, 'invalid_object')
  const obj = value as Record<string, unknown>, keys = Object.keys(obj)
  keys.forEach(text)
  return '{' + keys.sort(compareKeys).map(k => quote(k) + ':' + asciiJSON(obj[k], depth + 1)).join(',') + '}'
}
/**
 * Hash the exact Python-compatible canonical ASCII bytes.
 * @param value - Valid JSON value to encode canonically.
 * @returns Lowercase SHA256 digest of those bytes.
 */
export const digest = (value: unknown): string => createHash('sha256').update(asciiJSON(value), 'ascii').digest('hex')
/**
 * Require a normalized absolute POSIX path within the frozen byte/control-character limits.
 * @param value - Project or cwd path candidate.
 * @returns Nothing; narrows value to the validated path string.
 */
export function absolute(value: unknown): asserts value is string {
  text(value)
  need(value.startsWith('/') && !value.startsWith('//') && posix.normalize(value) === value
    && Buffer.byteLength(value, 'utf8') <= 512 && !/[\x00-\x1f\x7f]/.test(value), 'invalid_path')
}
/**
 * Validate and copy literal argv, canonical cwd and finite ignore/batch input.
 * @param value - Operation specification parsed or supplied by Root.
 * @param project - Original project root for an additional lexical cwd containment check.
 * @returns A normalized independent spec; actual cwd checks remain the guardian's responsibility.
 */
export function spec(value: unknown, project?: string): OperationSpec {
  record(value, ['argv', 'cwd', 'stdin']); absolute(value.cwd)
  if (project) need(value.cwd === project || value.cwd.startsWith(project + '/'), 'cwd_outside_project')
  need(Array.isArray(value.argv) && value.argv.length >= 1 && value.argv.length <= 16, 'argv_budget')
  const inputArgv: unknown[] = value.argv, argv: string[] = []
  let size = 0
  for (const arg of inputArgv) {
    text(arg); need(!arg.includes('\0'), 'invalid_argv')
    size += Buffer.byteLength(arg, 'utf8') + 1; argv.push(arg)
  }
  const executable = argv[0]
  need(executable !== undefined && executable.startsWith('/') && size <= 4096, 'argv_budget')
  need(value.stdin !== null && typeof value.stdin === 'object')
  const input = value.stdin as Record<string, unknown>
  if (input.mode === 'ignore') {
    record(input, ['mode'])
    return { argv, cwd: value.cwd, stdin: { mode: 'ignore' } }
  }
  record(input, ['mode', 'base64']); need(input.mode === 'batch', 'unsupported_stdin'); base64(input.base64, 4096)
  // base64 validates the exact string before this independent normalized copy is built.
  text(input.base64)
  return { argv, cwd: value.cwd, stdin: { mode: 'batch', base64: input.base64 } }
}
/**
 * Decode canonical base64 without lossy text conversion or alternate padding bits.
 * @param value - Encoded bytes candidate.
 * @param maximum - Maximum allowed decoded byte count.
 * @returns Exact decoded bytes within the given bound.
 */
export function base64(value: unknown, maximum: number): Uint8Array {
  need(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'invalid_base64')
  const bytes = Buffer.from(value, 'base64')
  need(bytes.length <= maximum && bytes.toString('base64') === value, 'invalid_base64')
  return bytes
}
/**
 * Bind Root's original ID to a normalized spec hash before any request.
 * @param runtimeIdentity - Protected original runtime identity.
 * @param operationId - Root-selected operation ID retained through uncertainty.
 * @param value - Literal operation specification to normalize and hash.
 * @returns The original reference and normalized spec; does not register or execute a remote operation.
 */
export function makePrepared(runtimeIdentity: string, operationId: string, value: OperationSpec): UnsignedPreparedRequest {
  hex(runtimeIdentity); need(typeof operationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(operationId), 'invalid_operation_id')
  const normalized = spec(value)
  return { ref: { runtimeIdentity, operationId, specHash: digest(normalized) }, spec: normalized }
}
