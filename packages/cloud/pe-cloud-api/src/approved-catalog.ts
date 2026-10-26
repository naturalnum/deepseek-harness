import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { managedSkillApiLimits } from './managed-skill-json.ts'
/** Validate the finite deployment catalog; it describes approval and never establishes actual installation. */
import { pluginControlLimits } from './plugin-json.ts'
import { modelKeyLimits } from './model-key-json.ts'
import { skillPublicationLimits } from './skill-json.ts'
import { CloudApiError } from './errors.ts'
import type { ApprovedConfigurationBundle, ApprovedConfigurationCatalog, ApprovedConfigurationPlugin } from './types.ts'

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
  const optionalBundles = input !== null && typeof input === 'object' && Object.hasOwn(input, 'bundles')
  const optionalKey = input !== null && typeof input === 'object' && Object.hasOwn(input, 'modelKey')
  const optionalPlugin = input !== null && typeof input === 'object' && Object.hasOwn(input, 'pluginControl')
  const row = record(input, ['recipeVersion', 'catalogVersion', 'maxEntries', 'maxStringBytes', 'maxCatalogBytes',
    'plugins', 'skills', 'credentials', 'fields', ...optionalKey ? ['modelKey'] : [], ...optionalPlugin ? ['pluginControl'] : [], ...optionalBundles ? ['bundles'] : []])
  const maxEntries = positive(row.maxEntries), maxStringBytes = positive(row.maxStringBytes)
  const maxCatalogBytes = positive(row.maxCatalogBytes)
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxStringBytes
      || Buffer.byteLength(value, 'utf8') > maxStringBytes || /[\u0000-\u0020\u007f]/.test(value)) return invalid()
    return value
  }
  const version = text(row.recipeVersion), catalogVersion = text(row.catalogVersion)
  if (version !== recipeVersion || !Array.isArray(row.plugins) || row.plugins.length === 0 && !optionalBundles
    || row.plugins.length > maxEntries || !Array.isArray(row.fields) || row.fields.length > maxEntries
    || settingsClosed !== (row.fields.length === 0)) return invalid()
  const seenFields = new Set<string>()
  const fields: ApprovedConfigurationCatalog['fields'] = Object.freeze(row.fields.map((value: unknown) => {
    const optionalValues = value !== null && typeof value === 'object' && Object.hasOwn(value, 'values')
    const field = record(value, ['namespace', 'field', ...optionalValues ? ['values'] : []])
    const namespace = text(field.namespace), name = text(field.field)
    if (!/^[A-Za-z0-9_$.-]+$/.test(namespace) || namespace === '.' || namespace === '..' || !/^[A-Za-z0-9_$-]+$/.test(name)
      || ['__proto__', 'constructor', 'prototype'].includes(name)) invalid()
    const key = namespace + '/' + name
    if (seenFields.has(key)) invalid()
    seenFields.add(key)
    const values = optionalValues ? (() => {
      if (!Array.isArray(field.values) || field.values.length === 0 || field.values.length > maxEntries) return invalid()
      const distinct = new Set<string>()
      return Object.freeze(field.values.map((value: unknown) => {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return invalid()
        if (typeof value === 'string' && (value.length > maxStringBytes || Buffer.byteLength(value, 'utf8') > maxStringBytes)) invalid()
        if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return invalid()
        const key = JSON.stringify(value)
        if (distinct.has(key)) invalid()
        distinct.add(key)
        return value
      }))
    })() : undefined
    if (namespace === 'locale' && (name !== 'preference' || values?.length !== 2
      || values[0] !== 'zh' || values[1] !== 'en')) invalid()
    return Object.freeze({ namespace, field: name, ...values === undefined ? {} : { values } })
  }))
  const credentials = record(row.credentials, ['mode'])
  if (credentials.mode !== 'read-only') return invalid()
  const skills: ApprovedConfigurationCatalog['skills'] = (() => {
    if (row.skills !== null && typeof row.skills === 'object' && 'mode' in row.skills && (row.skills.mode === 'sample' || row.skills.mode === 'managed')) {
      const managed = row.skills.mode === 'managed'
      const selected = record(row.skills, managed ? ['mode', 'limits', 'management'] : ['mode', 'limits'])
      const limits = record(selected.limits, ['maxFileBytes', 'maxRequestBytes', 'maxReplyBytes', 'maxRetainedVersions'])
      const publication = skillPublicationLimits({ maxFileBytes: positive(limits.maxFileBytes),
        maxRequestBytes: positive(limits.maxRequestBytes), maxReplyBytes: positive(limits.maxReplyBytes),
        maxRetainedVersions: positive(limits.maxRetainedVersions) })
      if (!managed) return Object.freeze({ mode: 'sample', limits: publication })
      const management = record(selected.management, ['maxRequestBytes', 'maxReplyBytes', 'maxMetadataBytes', 'maxRetainedProviders'])
      return Object.freeze({ mode: 'managed', limits: publication, management: managedSkillApiLimits({
        maxRequestBytes: positive(management.maxRequestBytes), maxReplyBytes: positive(management.maxReplyBytes),
        maxMetadataBytes: positive(management.maxMetadataBytes), maxRetainedProviders: positive(management.maxRetainedProviders) }) })
    }
    if (record(row.skills, ['mode']).mode !== 'closed') return invalid()
    return Object.freeze({ mode: 'closed' })
  })()
  const modelKey = row.modelKey === undefined ? undefined : (() => {
    const key = record(row.modelKey, ['bindings', 'maxKeyBytes', 'maxVersionBytes', 'maxReplyBytes', 'maxMetadataBytes'])
    if (!Array.isArray(key.bindings) || key.bindings.length === 0 || key.bindings.length > maxEntries) invalid()
    const providers = new Set<string>(), entries = new Map<string, string>()
    const bindings = key.bindings.map((value) => {
      const binding = record(value, ['provider', 'providerEntryId', 'moduleName', 'ref'])
      const provider = text(binding.provider), providerEntryId = text(binding.providerEntryId), moduleName = text(binding.moduleName)
      if (providers.has(provider) || entries.has(providerEntryId) && entries.get(providerEntryId) !== moduleName) invalid()
      providers.add(provider); entries.set(providerEntryId, moduleName)
      let ref: ReturnType<typeof credentialRef>
      try { ref = credentialRef(text(binding.ref)) } catch (_invalidReference) { return invalid() }
      return Object.freeze({ provider, providerEntryId, moduleName, ref })
    })
    return Object.freeze({ bindings: Object.freeze(bindings), ...modelKeyLimits({
      maxKeyBytes: positive(key.maxKeyBytes), maxVersionBytes: positive(key.maxVersionBytes), maxReplyBytes: positive(key.maxReplyBytes),
    }, bindings.map(binding => binding.ref)), maxMetadataBytes: positive(key.maxMetadataBytes) })
  })()
  const pluginControl = row.pluginControl === undefined ? undefined : (() => {
    const limits = record(row.pluginControl, ['maxProfileBytes', 'maxRequestBytes', 'maxReplyBytes', 'maxVersionBytes'])
    return pluginControlLimits({ maxProfileBytes: positive(limits.maxProfileBytes), maxRequestBytes: positive(limits.maxRequestBytes),
      maxReplyBytes: positive(limits.maxReplyBytes), maxVersionBytes: positive(limits.maxVersionBytes) })
  })()
  const ids = new Set<string>(), entries = new Set<string>()
  const plugins: ApprovedConfigurationPlugin[] = []
  let encodedBytes = 0
  const charge = (value: unknown): void => {
    encodedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (encodedBytes > maxCatalogBytes) invalid()
  }
  // Charge the complete wrapper first; each inserted row adds its exact encoded bytes and comma.
  charge({ recipeVersion: version, catalogVersion, maxEntries, maxStringBytes, maxCatalogBytes,
    ...modelKey === undefined ? {} : { modelKey }, ...pluginControl === undefined ? {} : { pluginControl }, plugins: [], ...optionalBundles ? { bundles: [] } : {}, skills, credentials: { mode: 'read-only' }, fields })
  for (const value of row.plugins as unknown[]) {
    const hasControl = value !== null && typeof value === 'object' && Object.hasOwn(value, 'control')
    const item = record(value, ['id', 'entryId', 'moduleName', 'packageName', 'packageVersion', 'installable', 'toggleable',
      ...hasControl ? ['control'] : []])
    const id = text(item.id), entryId = text(item.entryId), moduleName = text(item.moduleName)
    const packageName = text(item.packageName), packageVersion = text(item.packageVersion)
    // The initial recipe uses pinned published DSH modules. Builtin mappings need a separately reviewed original owner.
    if (!/^[A-Za-z0-9_.:-]+$/.test(id) || !/^[A-Za-z0-9_.:-]+$/.test(entryId)
      || !/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(packageName)
      || (moduleName !== packageName && !moduleName.startsWith(packageName + '/'))
      || moduleName.split('/').some(part => part === '.' || part === '..')
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageVersion)
      || item.installable !== false || typeof item.toggleable !== 'boolean'
      || ids.has(id) || entries.has(entryId)) return invalid()
    const control: ApprovedConfigurationPlugin['control'] = !hasControl ? undefined : (() => {
      if (pluginControl === undefined) return invalid()
      const policy = record(item.control, ['selectionTarget', 'operations', 'maxImpact', 'fields'])
      const rawTarget = policy.selectionTarget
      if (rawTarget === null || typeof rawTarget !== 'object' || !('kind' in rawTarget)) return invalid()
      const selectionTarget = rawTarget.kind === 'entry'
        ? Object.freeze({ kind: 'entry' as const, id: text(record(rawTarget, ['kind', 'id']).id) })
        : Object.freeze({ kind: 'bundle' as const, name: text(record(rawTarget, ['kind', 'name']).name) })
      if (rawTarget.kind !== selectionTarget.kind || selectionTarget.kind === 'entry' && selectionTarget.id !== entryId
        || selectionTarget.kind === 'bundle' && selectionTarget.name !== packageName
        || policy.maxImpact !== 'live' && policy.maxImpact !== 'local' && policy.maxImpact !== 'graph'
        || !Array.isArray(policy.operations) || policy.operations.length === 0 || policy.operations.length > 3
        || new Set(policy.operations).size !== policy.operations.length
        || policy.operations.some((operation: unknown) => typeof operation !== 'string'
          || !['enabled', 'configure', 'selected'].includes(operation))
        || policy.operations.includes('selected') && selectionTarget.kind !== 'bundle'
        || !Array.isArray(policy.fields) || policy.fields.length > maxEntries) return invalid()
      const operations = Object.freeze(policy.operations.slice()) as NonNullable<ApprovedConfigurationPlugin['control']>['operations']
      const fields: readonly (readonly string[])[] = Object.freeze(policy.fields.map((value: unknown) => {
        if (!Array.isArray(value) || value.length === 0 || value.length > maxEntries) return invalid()
        const path = value.map(text)
        if (path.some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment))) return invalid()
        return Object.freeze(path)
      }))
      if (fields.some((path, index) => fields.slice(0, index).some(other =>
        path.slice(0, other.length).every((segment, offset) => segment === other[offset])
        || other.slice(0, path.length).every((segment, offset) => segment === path[offset])))
        || operations.includes('configure') !== (fields.length > 0)) return invalid()
      return Object.freeze({ selectionTarget, operations, maxImpact: policy.maxImpact, fields })
    })()
    if (item.toggleable !== (control?.operations.includes('enabled') === true)) return invalid()
    ids.add(id)
    entries.add(entryId)
    const plugin = Object.freeze({ id, entryId, moduleName, packageName, packageVersion,
      installable: false as const, toggleable: item.toggleable, ...control === undefined ? {} : { control } })
    charge(plugin)
    if (plugins.length > 0 && ++encodedBytes > maxCatalogBytes) invalid()
    plugins.push(plugin)
  }
  const bundles: ApprovedConfigurationBundle[] = []
  if (optionalBundles) {
    if (pluginControl === undefined || !Array.isArray(row.bundles) || row.bundles.length === 0
      || row.bundles.length + plugins.length > maxEntries) invalid()
    for (const value of row.bundles as unknown[]) {
      const item = record(value, ['id', 'packageName', 'packageVersion', 'control', 'members'])
      const id = text(item.id), packageName = text(item.packageName), packageVersion = text(item.packageVersion)
      if (ids.has(id) || !/^[A-Za-z0-9_.:-]+$/.test(id) || !/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(packageName)
        || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageVersion)) invalid()
      const policy = record(item.control, ['selectionTarget', 'operations', 'maxImpact', 'fields'])
      const target = record(policy.selectionTarget, ['kind', 'name'])
      if (target.kind !== 'bundle' || target.name !== packageName || policy.maxImpact !== 'graph'
        || !Array.isArray(policy.operations) || policy.operations.length !== 1 || policy.operations[0] !== 'selected'
        || !Array.isArray(policy.fields) || policy.fields.length !== 0
        || !Array.isArray(item.members) || item.members.length === 0 || item.members.length > maxEntries) invalid()
      const memberIds = new Set<string>()
      const members = (item.members as unknown[]).map((value) => {
        const member = record(value, ['entryId', 'moduleName', 'packageName', 'packageVersion'])
        const entryId = text(member.entryId), moduleName = text(member.moduleName)
        const name = text(member.packageName), version = text(member.packageVersion)
        if (memberIds.has(entryId) || !/^[A-Za-z0-9_.:-]+$/.test(entryId) || !/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(name)
          || (moduleName !== name && !moduleName.startsWith(name + '/'))
          || moduleName.split('/').some(part => part === '.' || part === '..')
          || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) invalid()
        memberIds.add(entryId)
        return Object.freeze({ entryId, moduleName, packageName: name, packageVersion: version })
      })
      const bundle: ApprovedConfigurationBundle = Object.freeze({ id, packageName, packageVersion,
        control: Object.freeze({ selectionTarget: Object.freeze({ kind: 'bundle' as const, name: packageName }),
          operations: Object.freeze(['selected'] as const), maxImpact: 'graph' as const, fields: Object.freeze([]) }), members: Object.freeze(members) })
      ids.add(id); charge(bundle)
      if (bundles.length > 0 && ++encodedBytes > maxCatalogBytes) invalid()
      bundles.push(bundle)
    }
  }
  if (pluginControl !== undefined && !plugins.some(plugin => plugin.control !== undefined) && bundles.length === 0) return invalid()
  return Object.freeze({ recipeVersion: version, catalogVersion, maxEntries, maxStringBytes, maxCatalogBytes,
    ...modelKey === undefined ? {} : { modelKey }, ...pluginControl === undefined ? {} : { pluginControl },
    plugins: Object.freeze(plugins), ...optionalBundles ? { bundles: Object.freeze(bundles) } : {}, skills,
    credentials: Object.freeze({ mode: 'read-only' }), fields })
}
