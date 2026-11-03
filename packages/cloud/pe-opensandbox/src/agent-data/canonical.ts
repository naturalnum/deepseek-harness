/** Canonical ASCII encoding and finite request validation shared by the private data carrier. */
import { skillWorld as normalizeSkillWorld, type SkillWorld } from './skill-world.ts'
import { filePolicy as normalizeFilePolicy, type NativeFilePolicy } from './file-policy.ts'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { LocalRefusal } from './errors.ts'
import type { CollectOperationSpec, OperationSpec, PipesOperationSpec, UnsignedPreparedRequest } from './types.ts'
import { STREAM_LIMITS } from './role-protocol.ts'

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
  need(value !== null && typeof value === 'object' && !Array.isArray(value))
  const raw = value as Record<string, unknown>, pipes = raw.executionKind === 'pipes'
  record(raw, pipes ? ['executionKind', 'argv', 'cwd', 'stdin', 'env', 'stream'] : ['argv', 'cwd', 'stdin'])
  absolute(raw.cwd)
  if (project) need(raw.cwd === project || raw.cwd.startsWith(project + '/'), 'cwd_outside_project')
  need(Array.isArray(raw.argv) && raw.argv.length >= 1 && raw.argv.length <= 16, 'argv_budget')
  const inputArgv: unknown[] = raw.argv, argv: string[] = []
  let size = 0
  for (const arg of inputArgv) {
    text(arg); need(!arg.includes('\0'), 'invalid_argv')
    size += Buffer.byteLength(arg, 'utf8') + 1; argv.push(arg)
  }
  const executable = argv[0]
  need(executable !== undefined && executable.startsWith('/') && size <= 4096, 'argv_budget')
  need(raw.stdin !== null && typeof raw.stdin === 'object')
  const input = raw.stdin as Record<string, unknown>
  let stdin: PipesOperationSpec['stdin']
  if (input.mode === 'ignore' || (pipes && input.mode === 'pipe')) {
    record(input, ['mode']); stdin = { mode: input.mode }
  } else {
    record(input, ['mode', 'base64']); need(input.mode === 'batch', 'unsupported_stdin'); base64(input.base64, 4096)
    text(input.base64); stdin = { mode: 'batch', base64: input.base64 }
  }
  if (!pipes) {
    need(stdin.mode !== 'pipe', 'unsupported_stdin')
    return { argv, cwd: raw.cwd, stdin } satisfies CollectOperationSpec
  }
  need(raw.env !== null && typeof raw.env === 'object' && !Array.isArray(raw.env), 'invalid_environment')
  const original = raw.env as Record<string, unknown>, env = Object.create(null) as Record<string, string | null>
  need(Object.keys(original).length <= 128, 'environment_budget')
  for (const [key, entry] of Object.entries(original)) {
    need(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && key !== 'DSH_SUBPROCESS_CONTROL', 'invalid_environment')
    if (entry !== null) { text(entry); need(!entry.includes('\0'), 'invalid_environment') }
    env[key] = entry
  }
  need(Buffer.byteLength(asciiJSON(env), 'ascii') <= 4096, 'environment_budget')
  const stream = raw.stream
  record(stream, ['version', 'stdout', 'stderr', 'control', 'limits', ...typeof stream === 'object' && stream !== null && Object.hasOwn(stream, 'terminal') ? ['terminal'] : []])
  let terminal: Readonly<{ rows: number; cols: number }> | undefined
  if (stream.terminal !== undefined) {
    record(stream.terminal, ['rows', 'cols'])
    const dimension = (v: unknown): number => { need(typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 65535, 'terminal_dimensions'); return v }
    terminal = Object.freeze({ rows: dimension(stream.terminal.rows), cols: dimension(stream.terminal.cols) })
    need(stream.control === 'pipe' && stream.stdout === 'pipe' && stream.stderr === 'pipe', 'terminal_pipes')
  }
  need(stream.version === STREAM_LIMITS.version, 'stream_version')
  for (const key of ['stdout', 'stderr', 'control'] as const) need(stream[key] === 'pipe' || stream[key] === 'ignore', 'stream_disposition')
  record(stream.limits, ['controlInputBytes', 'controlOutputBytes'])
  const limit = (v: unknown): number => {
    need(typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= STREAM_LIMITS.controlInputBytes, 'stream_budget')
    return v
  }
  need(stream.stdout === 'pipe' || stream.stdout === 'ignore')
  need(stream.stderr === 'pipe' || stream.stderr === 'ignore')
  need(stream.control === 'pipe' || stream.control === 'ignore')
  return { executionKind: 'pipes', argv, cwd: raw.cwd, stdin, env: Object.freeze(env), stream: Object.freeze({
    ...terminal === undefined ? {} : { terminal }, version: STREAM_LIMITS.version,
    stdout: stream.stdout, stderr: stream.stderr, control: stream.control,
    limits: Object.freeze({ controlInputBytes: limit(stream.limits.controlInputBytes),
      controlOutputBytes: limit(stream.limits.controlOutputBytes) }),
  }) }
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
 * @param workingCopies - Optional original-files facts, kept outside the public command specification.
 * @param operationPolicy Optional Root-selected Session file policy included in the private frame.
 * @returns The original reference and normalized spec; does not register or execute a remote operation.
 */
export function makePrepared(runtimeIdentity: string, operationId: string, value: OperationSpec,
  workingCopies?: SkillWorld, operationPolicy?: NativeFilePolicy): UnsignedPreparedRequest {
  hex(runtimeIdentity); need(typeof operationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(operationId), 'invalid_operation_id')
  const normalized = spec(value)
  const fixed = workingCopies === undefined ? undefined : normalizeSkillWorld(workingCopies)
  const policy = operationPolicy === undefined ? undefined : normalizeFilePolicy(operationPolicy)
  return { ref: { runtimeIdentity, operationId, specHash: preparedDigest(normalized, fixed, policy) }, spec: normalized,
    ...fixed === undefined ? {} : { skillWorld: fixed }, ...policy === undefined ? {} : { filePolicy: policy } }
}

/**
 * Hash the normalized command and optional fixed skill-copy facts as one operation input.
 * @param value Original normalized three-field command.
 * @param workingCopies Optional Root-private fixed facts.
 * @param operationPolicy Optional Root-selected Session file policy included in the same hash.
 * @returns Hash binding both inputs to the original operation.
 */
export function preparedDigest(value: OperationSpec, workingCopies?: SkillWorld, operationPolicy?: NativeFilePolicy): string {
  const policy = operationPolicy === undefined ? undefined : normalizeFilePolicy(operationPolicy)
  return digest(workingCopies === undefined && policy === undefined ? value : { spec: value,
    ...workingCopies === undefined ? {} : { skillWorld: workingCopies }, ...policy === undefined ? {} : { filePolicy: policy } })
}
