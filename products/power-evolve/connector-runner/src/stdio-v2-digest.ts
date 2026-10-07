/** Node-only STDIO v2 SHA/HMAC over the shared browser-safe codec; this module starts no process. */
import { createHash, createHmac } from 'node:crypto'
import { stdioCanonicalJsonV2, type StdioV2JsonLimits } from '@power-evolve/contracts/stdio-mcp-json'
import { stdioCatalogV2, stdioDigestV2, type StdioDigestV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'

/** Distinct original data domains; later observations never alter a task digest. */
export type StdioDigestDomainV2 = 'management' | 'configuration' | 'task' | 'catalog' | 'prepared' | 'scope' | 'spec' | 'dispatch' | 'result'
const domains: ReadonlySet<StdioDigestDomainV2> = new Set(['management', 'configuration', 'task', 'catalog',
  'prepared', 'scope', 'spec', 'dispatch', 'result'])

function encoded(domain: StdioDigestDomainV2 | 'approval', value: unknown, limits: StdioV2JsonLimits): string {
  return stdioCanonicalJsonV2({ domain: `power-evolve-stdio-${domain}-v2`, value }, limits)
}

/** Hash one complete original value with a fixed domain and supplied encoding budget.
 * @param domain The data purpose; unknown queued or wire values are refused.
 * @param value Complete original JSON, never a partial projection.
 * @param limits Explicit depth, node and UTF-8 budgets including the domain envelope.
 * @returns The lowercase SHA-256 of the canonical UTF-8 envelope.
 */
export function stdioSha256V2(domain: StdioDigestDomainV2, value: unknown, limits: StdioV2JsonLimits): StdioDigestV2 {
  if (!domains.has(domain)) throw new TypeError('stdio_v2_digest_domain_invalid')
  return stdioDigestV2.parse(createHash('sha256').update(encoded(domain, value, limits), 'utf8').digest('hex'))
}

/** Fingerprint the entire ordered directory after validating raw descriptors and frozen budgets.
 * @param tools Complete tools array with every original schema, annotation and extension field.
 * @param limits Required SDK limits; encoding the domain envelope uses the input-byte budget.
 * @returns The same whole-catalog digest used at selection and immediately before tools/call.
 */
export function stdioCatalogFingerprintV2(tools: unknown, limits: StdioLimitsV2): StdioDigestV2 {
  const catalog = stdioCatalogV2(limits).parse(tools)
  return stdioSha256V2('catalog', catalog, { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes,
    maxBytes: limits.maxInputBytes })
}

/** Create the independent approval fingerprint without exporting the backend key.
 * @param key The existing Platform-owned 32-byte HMAC key; executors never receive it.
 * @param value Original action, task/prepared digests, fixed approval epoch and expiry.
 * @param limits Explicit complete-envelope encoding budgets.
 * @returns Domain-separated lowercase HMAC-SHA-256; this value alone grants no execution permission.
 */
export function stdioApprovalFingerprintV2(key: Uint8Array, value: unknown, limits: StdioV2JsonLimits): StdioDigestV2 {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new TypeError('stdio_v2_approval_key_invalid')
  return stdioDigestV2.parse(createHmac('sha256', key).update(encoded('approval', value, limits), 'utf8').digest('hex'))
}
