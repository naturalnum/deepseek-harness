/** Validate the finite deployment catalog; it describes approval and never establishes actual installation. */
import { CloudApiError } from './errors.ts'
import type { ApprovedConfigurationCatalog, ApprovedConfigurationPlugin } from './types.ts'

function invalid(): never {
  throw new CloudApiError('cloud/invalid-config', 'The approved configuration catalog requires a finite closed deployment policy.')
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return invalid()
  return value as Record<string, unknown>
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid()
  return value
}

/**
 * Detach and freeze a closed first-trial catalog at the Root Loader configuration boundary.
 * @param input Explicit deployment value; undefined preserves exposure-only composition.
 * @param recipeVersion Original exposure policy's exact revision.
 * @param settingsClosed Whether the actual manifest keeps all configuration writers closed.
 * @returns A finite immutable catalog, or undefined when no catalog was supplied.
 */
export function parseApprovedConfigurationCatalog(
  input: unknown, recipeVersion: string, settingsClosed: boolean,
): ApprovedConfigurationCatalog | undefined {
  if (input === undefined) return undefined
  if (!settingsClosed) return invalid()
  const row = record(input, ['recipeVersion', 'catalogVersion', 'maxEntries', 'maxStringBytes', 'maxCatalogBytes',
    'plugins', 'skills', 'credentials', 'fields'])
  const maxEntries = positive(row.maxEntries), maxStringBytes = positive(row.maxStringBytes)
  const maxCatalogBytes = positive(row.maxCatalogBytes)
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxStringBytes
      || Buffer.byteLength(value, 'utf8') > maxStringBytes || /[\u0000-\u0020\u007f]/.test(value)) return invalid()
    return value
  }
  const version = text(row.recipeVersion), catalogVersion = text(row.catalogVersion)
  if (version !== recipeVersion || !Array.isArray(row.plugins) || row.plugins.length === 0
    || row.plugins.length > maxEntries || !Array.isArray(row.fields) || row.fields.length !== 0) return invalid()
  const skills = record(row.skills, ['mode']), credentials = record(row.credentials, ['mode'])
  if (skills.mode !== 'closed' || credentials.mode !== 'read-only') return invalid()
  const ids = new Set<string>(), entries = new Set<string>()
  const plugins: ApprovedConfigurationPlugin[] = []
  let encodedBytes = 0
  const charge = (value: unknown): void => {
    encodedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (encodedBytes > maxCatalogBytes) invalid()
  }
  // Charge the complete wrapper first; each inserted row adds its exact encoded bytes and comma.
  charge({ recipeVersion: version, catalogVersion, maxEntries, maxStringBytes, maxCatalogBytes,
    plugins: [], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [] })
  for (const value of row.plugins) {
    const item = record(value, ['id', 'entryId', 'moduleName', 'packageName', 'packageVersion', 'installable', 'toggleable'])
    const id = text(item.id), entryId = text(item.entryId), moduleName = text(item.moduleName)
    const packageName = text(item.packageName), packageVersion = text(item.packageVersion)
    // The initial recipe uses pinned published DSH modules. Builtin mappings need a separately reviewed original owner.
    if (!/^[A-Za-z0-9_.:-]+$/.test(id) || !/^[A-Za-z0-9_.:-]+$/.test(entryId)
      || !/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(packageName)
      || (moduleName !== packageName && !moduleName.startsWith(packageName + '/'))
      || moduleName.split('/').some(part => part === '.' || part === '..')
      || item.installable !== false || item.toggleable !== false || ids.has(id) || entries.has(entryId)) return invalid()
    ids.add(id)
    entries.add(entryId)
    const plugin = Object.freeze({ id, entryId, moduleName, packageName, packageVersion, installable: false, toggleable: false })
    charge(plugin)
    if (plugins.length > 0 && ++encodedBytes > maxCatalogBytes) invalid()
    plugins.push(plugin)
  }
  return Object.freeze({ recipeVersion: version, catalogVersion, maxEntries, maxStringBytes, maxCatalogBytes,
    plugins: Object.freeze(plugins), skills: Object.freeze({ mode: 'closed' }),
    credentials: Object.freeze({ mode: 'read-only' }), fields: Object.freeze([]) })
}
