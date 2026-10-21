/** Finite ASCII response parsing for the frozen Python encoder. */
import { need, text } from './canonical.ts'

/**
 * Parse a finite frozen-agent reply without duplicate keys or numeric precision loss.
 * @param bytes - At most 16KiB of complete ASCII JSON emitted by the frozen Python protocol.
 * @returns Parsed JSON with paired strings and safe integer numeric fields; Root uint64 quantities stay strings.
 */
export function parseReply(bytes: Uint8Array): unknown {
  need(bytes.length <= 16384 && bytes.every(n => n < 128), 'reply_encoding')
  const source = Buffer.from(bytes).toString('ascii')
  let index = 0, nodes = 0
  const whitespace = () => { while (/[ \t\r\n]/.test(source[index] ?? '') && index < source.length) index++ }
  function string(): string {
    const start = index++
    while (index < source.length) {
      const c = source[index++]
      if (c === '\\') index++
      else if (c === '"') { const result: unknown = JSON.parse(source.slice(start, index)); text(result); return result }
    }
    throw new Error('invalid_json')
  }
  function value(depth: number): unknown {
    need(depth <= 16 && ++nodes <= 4096, 'reply_complexity'); whitespace()
    const c = source[index]
    if (c === '"') return string()
    if (c === '{') {
      index++; whitespace(); const result = Object.create(null) as Record<string, unknown>
      if (source[index] === '}') { index++; return result }
      while (true) {
        whitespace(); need(source[index] === '"'); const key = string(); whitespace()
        need(source[index++] === ':' && !Object.hasOwn(result, key), 'duplicate_or_invalid_key')
        result[key] = value(depth + 1); whitespace()
        const next = source[index++]; if (next === '}') return result; need(next === ',')
      }
    }
    if (c === '[') {
      index++; whitespace(); const result: unknown[] = []
      if (source[index] === ']') { index++; return result }
      while (true) { result.push(value(depth + 1)); whitespace(); const next = source[index++]; if (next === ']') return result; need(next === ',') }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, index)) { index += token.length; return result }
    }
    const number = /^-?(?:0|[1-9][0-9]*)/.exec(source.slice(index))?.[0]
    need(number && number.length <= 17, 'invalid_json_number'); index += number.length
    const result = Number(number); need(Number.isSafeInteger(result) && !Object.is(result, -0), 'unsafe_json_number'); return result
  }
  const result = value(0); whitespace(); need(index === source.length, 'trailing_json'); return result
}
