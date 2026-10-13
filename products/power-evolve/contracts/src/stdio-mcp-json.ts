/** Browser-safe STDIO v2 JSON encoding; hashing, authorization and deployment budget selection remain with consumers. */

/** Required deployment limits; root depth is zero and every emitted value occurrence counts as one node. */
export interface StdioV2JsonLimits {
  maxDepth: number
  maxNodes: number
  maxBytes: number
}

type Descriptors = Record<string, PropertyDescriptor>
type Frame = { kind: 'value'; value: unknown; depth: number }
  | { kind: 'array'; value: object; descriptors: Descriptors; length: number; next: number; depth: number }
  | { kind: 'object'; value: object; descriptors: Descriptors; keys: string[]; next: number; depth: number }

function configuration(limits: unknown): StdioV2JsonLimits {
  if (!limits || typeof limits !== 'object') throw new TypeError('stdio_v2_json_limits_invalid')
  const descriptors = Object.getOwnPropertyDescriptors(limits)
  const value = (key: keyof StdioV2JsonLimits): number => {
    const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined
    const candidate: unknown = descriptor?.value
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate) || candidate <= 0) throw new TypeError('stdio_v2_json_limits_invalid')
    return candidate
  }
  return { maxDepth: value('maxDepth'), maxNodes: value('maxNodes'), maxBytes: value('maxBytes') }
}

/** Serialize complete strict JSON with code-unit key order and no string normalization or Node APIs.
 * @param value JSON data: finite scalars, dense plain arrays, or objects with Object.prototype/null prototype and enumerable data fields.
 * @param limits Positive safe-integer deployment limits; nodes count repeated acyclic references independently.
 * @returns Canonical JSON text, never truncated. Invalid JSON/configuration throws TypeError;
 * exceeded budgets throw RangeError.
 */
export function stdioCanonicalJsonV2(value: unknown, limits: StdioV2JsonLimits): string {
  const budget = configuration(limits)
  const pending: Frame[] = [{ kind: 'value', value, depth: 0 }]
  const ancestors = new WeakSet<object>()
  const tokens: string[] = []
  let nodes = 0, bytes = 0
  const append = (token: string): void => {
    for (let index = 0; index < token.length; index++) {
      const unit = token.charCodeAt(index)
      if (unit <= 0x7f) bytes++
      else if (unit <= 0x7ff) bytes += 2
      else if (unit >= 0xd800 && unit <= 0xdbff && token.charCodeAt(index + 1) >= 0xdc00
        && token.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
      else bytes += 3
      if (bytes > budget.maxBytes) throw new RangeError('stdio_v2_json_bytes_limit')
    }
    tokens.push(token)
  }
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    if (frame.kind !== 'value') {
      const length = frame.kind === 'array' ? frame.length : frame.keys.length
      if (frame.next === length) {
        append(frame.kind === 'array' ? ']' : '}')
        ancestors.delete(frame.value)
        continue
      }
      if (frame.next) append(',')
      const key = frame.kind === 'array' ? String(frame.next) : frame.keys[frame.next]
      const descriptor = key === undefined ? undefined : frame.descriptors[key]
      if (key === undefined || !descriptor) throw new TypeError('stdio_v2_json_invalid')
      const child: unknown = descriptor.value
      if (frame.kind === 'object') { append(JSON.stringify(key)); append(':') }
      pending.push({ ...frame, next: frame.next + 1 }, {
        kind: 'value', value: child, depth: frame.depth + 1,
      })
      continue
    }
    if (++nodes > budget.maxNodes) throw new RangeError('stdio_v2_json_nodes_limit')
    if (frame.depth > budget.maxDepth) throw new RangeError('stdio_v2_json_depth_limit')
    const item = frame.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) {
      append(JSON.stringify(item))
      continue
    }
    if (!item || typeof item !== 'object') throw new TypeError('stdio_v2_json_invalid')
    const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('stdio_v2_json_invalid')
    }
    if (ancestors.has(item)) throw new TypeError('stdio_v2_json_cycle')
    const ownKeys = Reflect.ownKeys(item)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    for (const key of ownKeys) {
      if (typeof key !== 'string') throw new TypeError('stdio_v2_json_invalid')
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || !array && !descriptor.enumerable) throw new TypeError('stdio_v2_json_invalid')
    }
    ancestors.add(item)
    if (array) {
      const length: unknown = descriptors.length?.value
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError('stdio_v2_json_invalid')
      if (ownKeys.length !== length + 1) throw new TypeError('stdio_v2_json_invalid')
      if (length > budget.maxNodes - nodes) throw new RangeError('stdio_v2_json_nodes_limit')
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) throw new TypeError('stdio_v2_json_invalid')
      }
      append('[')
      pending.push({ kind: 'array', value: item, descriptors, length, next: 0, depth: frame.depth })
    } else {
      const keys = Object.keys(item).sort()
      if (keys.length > budget.maxNodes - nodes) throw new RangeError('stdio_v2_json_nodes_limit')
      append('{')
      pending.push({ kind: 'object', value: item, descriptors, keys, next: 0, depth: frame.depth })
    }
  }
  return tokens.join('')
}
