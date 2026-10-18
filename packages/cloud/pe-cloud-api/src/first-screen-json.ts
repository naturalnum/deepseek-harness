/** Finite preflight before encoding native first-screen DTOs; no native business or queue implementation. */
import { CloudApiError } from './errors.ts'

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The native first-screen frame exceeds its explicit encoding limit.')
}

/**
 * Check native DTO traversal and string input before allocating their complete JSON encoding.
 * @param value - actual native DTO; no caller-supplied serializer or toJSON implementation is admitted.
 * @param maximum - positive finite complete encoded UTF-8 byte limit supplied by trusted preparation.
 * @returns the complete JSON encoding's byte count when within the limit.
 * @throws CloudApiError for excessive, cyclic, non-plain or unencodable input.
 */
export function firstScreenJsonBytes(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || value === undefined) unavailable()
  const ancestors = new Set<object>()
  const stack: ({ readonly value: unknown } | { readonly exit: object })[] = [{ value }]
  let minimum = 0
  const charge = (count: number): void => {
    if (count > maximum - minimum) unavailable()
    minimum += count
  }
  while (stack.length !== 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if ('exit' in frame) { ancestors.delete(frame.exit); continue }
    const item = frame.value
    if (item === undefined) continue // Native optional object fields are omitted by JSON.
    charge(1)
    if (typeof item === 'string') charge(item.length)
    else if (item !== null && typeof item === 'object') {
      if (ancestors.has(item)) unavailable()
      ancestors.add(item)
      stack.push({ exit: item })
      if (Array.isArray(item)) {
        if (item.length > maximum - minimum) unavailable()
        for (let index = item.length - 1; index >= 0; index--) {
          if (stack.length >= maximum) unavailable()
          stack.push({ value: item[index] })
        }
      } else {
        const prototype: unknown = Object.getPrototypeOf(item)
        if (prototype !== Object.prototype && prototype !== null) unavailable()
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue
          const child: unknown = Reflect.get(item, key)
          if (child === undefined) continue
          if (key === 'toJSON' || stack.length >= maximum) unavailable()
          charge(key.length + 1)
          stack.push({ value: child })
        }
      }
    } else if (item !== null && typeof item !== 'boolean' && (typeof item !== 'number' || !Number.isFinite(item))) unavailable()
  }
  const encoded = JSON.stringify(value)
  const bytes = Buffer.byteLength(encoded, 'utf8')
  if (bytes > maximum) unavailable()
  return bytes
}
