/** Fixed Platform-only MCP projection paths and exact operator destination metadata. */
import { isIP } from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const ipaddr = require('ipaddr.js')
const root = '/run/power-evolve/private/remote-mcp'
const name = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u
const caKey = /^[a-z0-9][a-z0-9_-]{0,62}\.pem$/u

/** Operator JSON path projected only into the Platform. */
export const remoteMcpConfigPath = `${root}/config.json`
/** Platform credential encryption key path, never an environment value. */
export const remoteMcpKeyPath = `${root}/credential-key`

function refuse() { throw new Error('Invalid remote MCP deployment metadata') }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) refuse()
}
function address(value) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) refuse()
  return ipaddr.process(value).toString()
}

/** Restrict CA filenames to the fixed projected directory.
 * @param key Operator-selected ConfigMap key with a safe .pem filename.
 * @returns The absolute Platform-only projection path.
 */
export function remoteMcpCaPath(key) {
  if (typeof key !== 'string' || !caKey.test(key)) refuse()
  return `${root}/ca/${key}`
}

function destinations(input) {
  if (!Array.isArray(input)) refuse()
  const origins = new Set()
  return input.map(item => {
    exact(item, ['origin', 'addresses', 'allowHttp', 'caKey'])
    let url
    try { url = new URL(item.origin) } catch { refuse() }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (typeof item.origin !== 'string' || url.origin !== item.origin || url.hostname.includes('*')
      || !['http:', 'https:'].includes(url.protocol) || origins.has(item.origin)
      || item.allowHttp !== undefined && typeof item.allowHttp !== 'boolean'
      || url.protocol === 'http:' && item.allowHttp !== true || port < 1 || port > 65535) refuse()
    origins.add(item.origin)
    if (!Array.isArray(item.addresses) || !item.addresses.length) refuse()
    const addresses = item.addresses.map(address).sort()
    if (new Set(addresses).size !== addresses.length) refuse()
    if (item.caKey !== undefined) remoteMcpCaPath(item.caKey)
    return { origin: item.origin, addresses, port, allowHttp: item.allowHttp === true,
      ...(item.caKey === undefined ? {} : { caKey: item.caKey }) }
  }).sort((left, right) => left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0)
}

/** Resolve the optional deployment switch without admitting arbitrary paths or mount definitions.
 * @param input Optional remoteMcp values; omission disables the feature.
 * @param sharedSecret Secret mounted by the Host, which cannot hold the MCP material.
 * @returns Detached, normalized destinations and explicit Secret/CA names, or null.
 */
export function remoteMcpValues(input, sharedSecret) {
  if (input === undefined) return null
  exact(input, ['secretName', 'caConfigMapName', 'destinations'])
  if (typeof input.secretName !== 'string' || !name.test(input.secretName) || input.secretName === sharedSecret
    || input.caConfigMapName !== undefined
      && (typeof input.caConfigMapName !== 'string' || !name.test(input.caConfigMapName))) refuse()
  const selected = destinations(input.destinations)
  const needsCa = selected.some(item => item.caKey !== undefined)
  if (needsCa !== (input.caConfigMapName !== undefined)) refuse()
  return { secretName: input.secretName, destinations: selected,
    ...(input.caConfigMapName === undefined ? {} : { caConfigMapName: input.caConfigMapName }) }
}

/** Project only declared operator JSON, key and CA entries into the existing Platform private volume.
 * @param selected Normalized optional MCP deployment metadata.
 * @returns Additional projected-volume sources; an omitted feature has no sources.
 */
export function remoteMcpSources(selected) {
  if (selected === null) return []
  const sources = [{ secret: { name: selected.secretName, items: [
    { key: 'remote-mcp.json', path: 'remote-mcp/config.json' },
    { key: 'remote-mcp-key', path: 'remote-mcp/credential-key' },
  ] } }]
  if (selected.caConfigMapName) sources.push({ configMap: { name: selected.caConfigMapName,
    items: [...new Set(selected.destinations.flatMap(item => item.caKey === undefined ? [] : [item.caKey]))]
      .sort().map(key => ({ key, path: `remote-mcp/ca/${key}` })) } })
  return sources
}

/** Pair exact destination addresses with only the port of their operator origin.
 * @param selected Normalized optional MCP deployment metadata.
 * @returns Platform-only TCP NetworkPolicy rules with /32 or /128 peers.
 */
export function remoteMcpEgress(selected) {
  return (selected?.destinations ?? []).map(item => ({
    to: item.addresses.map(ip => ({ ipBlock: { cidr: `${ip}/${isIP(ip) === 4 ? 32 : 128}` } })),
    ports: [{ protocol: 'TCP', port: item.port }],
  }))
}

/** Check mounted metadata before any credential read; runtime parsing still owns all budget validation.
 * @param settings Parsed operator JSON from the fixed config projection.
 * @returns Normalized origin permissions and the exact paths a deployment reader may access.
 */
export function remoteMcpMountedMetadata(settings) {
  if (!settings || settings.requireOriginException !== true || settings.credentialKeyFile !== remoteMcpKeyPath
    || !Array.isArray(settings.internalExceptions)) refuse()
  const permissions = destinations(settings.internalExceptions.map(item => {
    exact(item, ['origin', 'addresses', 'allowHttp', 'caFile'])
    if (item.caFile !== undefined && typeof item.caFile !== 'string') refuse()
    const key = item.caFile === undefined ? undefined : item.caFile.slice(`${root}/ca/`.length)
    if (key !== undefined && remoteMcpCaPath(key) !== item.caFile) refuse()
    return { origin: item.origin, addresses: item.addresses, allowHttp: item.allowHttp,
      ...(key === undefined ? {} : { caKey: key }) }
  }))
  return { destinations: permissions, paths: [remoteMcpConfigPath, remoteMcpKeyPath,
    ...new Set(permissions.flatMap(item => item.caKey === undefined ? [] : [remoteMcpCaPath(item.caKey)]))] }
}
