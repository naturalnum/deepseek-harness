/** HTTP hop handling only; application fields and RPC/mux bodies remain opaque. */
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { ForwardFailure, type ForwardLimits } from './forward-types.ts'

const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const hop = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate'])
const protectedField = (name: string): boolean =>
  ['host', 'origin', 'cookie', 'authorization', 'content-length'].includes(name) || name.startsWith('sec-websocket-')

/**
 * Validate bounded raw pairs before copying references or constructing a wire header.
 * @param raw Original alternating header names and values.
 * @param limits Input and emitted header-pair and byte limits.
 * @param upgrade Whether to require and regenerate WebSocket upgrade headers.
 * @param request Whether to require exactly one Host header.
 * @returns Validated pairs with hop headers removed and the required Connection/Upgrade fields.
 */
export function forwardHeaders(raw: readonly string[], limits: ForwardLimits, upgrade: boolean, request: boolean): string[] {
  if (raw.length % 2 !== 0 || raw.length / 2 > limits.maxHeaderPairs) throw new ForwardFailure('capacity')
  let bytes = 0, hosts = 0, upgrades = 0
  const named = new Set<string>()
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1]
    if (name === undefined || value === undefined) throw new ForwardFailure('protocol')
    const lower = name.toLowerCase()
    bytes += Buffer.byteLength(name, 'latin1') + Buffer.byteLength(value, 'latin1') + 4
    if (bytes > limits.maxHeaderBytes) throw new ForwardFailure('capacity')
    try { validateHeaderName(name); validateHeaderValue(name, value) }
    catch (error) { throw new ForwardFailure('protocol', error) }
    if (lower === 'host') hosts++
    if (lower === 'trailer' || lower === 'expect') throw new ForwardFailure('protocol')
    if (lower === 'upgrade') {
      upgrades++
      if (!upgrade || value.toLowerCase() !== 'websocket') throw new ForwardFailure('protocol')
    }
    if (lower !== 'connection') continue
    for (const part of value.split(',')) {
      const field = part.trim().toLowerCase()
      if (!token.test(field) || protectedField(field)) throw new ForwardFailure('protocol')
      named.add(field)
    }
  }
  if (request && hosts !== 1 || upgrade && (upgrades !== 1 || !named.has('upgrade'))) throw new ForwardFailure('protocol')
  const result: string[] = []
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1]
    if (name === undefined || value === undefined) throw new ForwardFailure('protocol')
    const lower = name.toLowerCase()
    if (!hop.has(lower) && !named.has(lower)) result.push(name, value)
  }
  result.push('Connection', upgrade ? 'Upgrade' : 'close')
  if (upgrade) result.push('Upgrade', 'websocket')
  const emittedBytes = result.reduce((total, value) => total + Buffer.byteLength(value, 'latin1') + 2, 0)
  if (result.length / 2 > limits.maxHeaderPairs || emittedBytes > limits.maxHeaderBytes) throw new ForwardFailure('capacity')
  return result
}

/**
 * Append Root-created bounded pairs without mutating the original request or permitting binding/hop overrides.
 * @param raw Original request header pairs.
 * @param extra Optional Root-created pairs that cannot replace original, binding, or hop fields.
 * @param limits Combined input and rebuilt header limits.
 * @param upgrade Whether this request is a WebSocket upgrade.
 * @returns The revalidated request pairs with the permitted additions.
 */
export function forwardRequestHeaders(
  raw: readonly string[], extra: readonly string[] | undefined, limits: ForwardLimits, upgrade: boolean,
): string[] {
  const original = forwardHeaders(raw, limits, upgrade, true)
  if (extra === undefined || extra.length === 0) return original
  if (extra.length % 2 !== 0 || (raw.length + extra.length) / 2 > limits.maxHeaderPairs) throw new ForwardFailure('capacity')
  const reserved = new Set<string>()
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]?.toLowerCase(), value = raw[index + 1]
    if (name === undefined || value === undefined) throw new ForwardFailure('protocol')
    reserved.add(name)
    if (name === 'connection') for (const field of value.split(',')) reserved.add(field.trim().toLowerCase())
  }
  let bytes = 0
  for (let index = 0; index < extra.length; index += 2) {
    const name = extra[index], value = extra[index + 1]
    if (name === undefined || value === undefined) throw new ForwardFailure('protocol')
    const lower = name.toLowerCase()
    if (reserved.has(lower) || hop.has(lower) || protectedField(lower) || lower === 'expect') throw new ForwardFailure('protocol')
    reserved.add(lower)
    bytes += Buffer.byteLength(name, 'latin1') + Buffer.byteLength(value, 'latin1') + 4
    if (bytes > limits.maxHeaderBytes) throw new ForwardFailure('capacity')
  }
  // Revalidate complete input and rebuilt wire headers; Connection nominations cannot erase appended names.
  return forwardHeaders([...raw, ...extra], limits, upgrade, true)
}

/**
 * Serialize only a bounded Node-parsed response line and sanitized pairs for an upgrade rejection/acceptance.
 * @param status Parsed HTTP status between 100 and 599.
 * @param message Parsed Latin-1 reason phrase without control characters.
 * @param headers Already sanitized alternating response names and values.
 * @param limits Header-byte limit, with the fixed status-line allowance.
 * @returns A Latin-1 HTTP/1.1 response head ending in an empty line.
 */
export function responseHead(status: number, message: string, headers: readonly string[], limits: ForwardLimits): Buffer {
  if (!Number.isInteger(status) || status < 100 || status > 599 || /[^\x20-\x7e\x80-\xff]/u.test(message)) {
    throw new ForwardFailure('protocol')
  }
  let text = `HTTP/1.1 ${status} ${message}\r\n`
  for (let index = 0; index < headers.length; index += 2) text += `${headers[index]}: ${headers[index + 1]}\r\n`
  text += '\r\n'
  if (Buffer.byteLength(text, 'latin1') > limits.maxHeaderBytes + 128) throw new ForwardFailure('capacity')
  return Buffer.from(text, 'latin1')
}
