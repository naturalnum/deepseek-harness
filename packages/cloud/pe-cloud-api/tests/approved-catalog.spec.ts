import { modelKeyBinding } from './model-key-policy-data.ts'
/** The deployment catalog is immutable approval metadata; actual graph inventory remains independently required. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ExposureService from '../src/root.ts'
import { parseApprovedConfigurationCatalog } from '../src/approved-catalog.ts'

function catalog() {
  return {
    recipeVersion: 'trial-one', catalogVersion: 'reviewed-catalog-one', maxEntries: 4, maxStringBytes: 128, maxCatalogBytes: 4096,
    plugins: [{ id: 'fixed-preset', entryId: 'preset-main', moduleName: '@deepseek-ai/dsh-agent-preset',
      packageName: '@deepseek-ai/dsh-agent-preset', packageVersion: '0.2.1-rc.2', installable: false, toggleable: false }],
    skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [],
  }
}
const manifest = { recipeVersion: 'trial-one', rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }

describe('explicit Root bootstrap catalog', () => {
  it('requires the complete fixed sample policy and its exact original handlers while preserving closed defaults', async () => {
    const limits = { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 4096, maxRetainedVersions: 4 }
    const input = { ...catalog(), skills: { mode: 'sample', limits } }
    const rows = ['cloudSkills/current', 'cloudSkills/publish'].map(endpoint =>
      ({ endpoint, handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const }))
    expect(parseApprovedConfigurationCatalog(input, manifest.recipeVersion, true)?.skills).toEqual(input.skills)
    const ctx = new Context()
    try {
      expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, approvedConfiguration: input }))).toThrow()
      expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, rpcEndpoints: rows.slice(1),
        approvedConfiguration: input }))).toThrow()
      expect(() => parseApprovedConfigurationCatalog({ ...input, skills: { mode: 'sample', limits: { ...limits, extra: 1 } } },
        manifest.recipeVersion, true)).toThrow()
      expect(new ExposureService(ctx, ExposureService.Config({ ...manifest, rpcEndpoints: rows,
        approvedConfiguration: input })).approvedConfiguration?.skills).toEqual(input.skills)
    } finally { await ctx.fiber.dispose() }
  })
  it('retains a detached immutable catalog without auditing or approving a business endpoint', async () => {
    const ctx = new Context(), input = catalog()
    try {
      // The actual native schema accepts the wire input before original service construction.
      const config = ExposureService.Config({ ...manifest, approvedConfiguration: input })
      const owner = new ExposureService(ctx, config)
      const approved = owner.approvedConfiguration
      expect(approved?.catalogVersion).toBe(input.catalogVersion)
      expect(approved).not.toBe(input)
      expect(Object.isFrozen(approved)).toBe(true)
      expect(Object.isFrozen(approved?.plugins)).toBe(true)
      expect(Object.isFrozen(approved?.plugins[0])).toBe(true)
      input.plugins[0]!.id = 'changed'
      expect(approved?.plugins[0]?.id).toBe('fixed-preset')
      expect(() => owner.policy.requireRpc('session/create')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves exposure-only native composition without inventing a catalog version or empty successful catalog', async () => {
    const ctx = new Context()
    try {
      const owner = new ExposureService(ctx, ExposureService.Config(manifest))
      expect(owner.approvedConfiguration).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    ['wrong-recipe', () => ({ ...catalog(), recipeVersion: 'other' })],
    ['duplicate-id', () => { const c = catalog(); c.plugins.push({ ...c.plugins[0]!, entryId: 'other' }); return c }],
    ['duplicate-entry', () => { const c = catalog(); c.plugins.push({ ...c.plugins[0]!, id: 'other' }); return c }],
    ['too-many', () => ({ ...catalog(), maxEntries: 1, plugins: [catalog().plugins[0], { ...catalog().plugins[0], id: 'other', entryId: 'other' }] })],
    ['missing-budget', () => { const { maxEntries: _omitted, ...rest } = catalog(); return rest }],
    ['unknown-field', () => ({ ...catalog(), rawConfig: 'must-not-be-retained' })],
    ['empty-plugins', () => ({ ...catalog(), plugins: [] })],
    ['install-enabled', () => ({ ...catalog(), plugins: [{ ...catalog().plugins[0], installable: true }] })],
    ['toggle-enabled', () => ({ ...catalog(), plugins: [{ ...catalog().plugins[0], toggleable: true }] })],
    ['arbitrary-code', () => ({ ...catalog(), plugins: [{ ...catalog().plugins[0], moduleName: '/tmp/plugin.js' }] })],
    ['raw-field', () => ({ ...catalog(), fields: [{ path: 'raw', apply: 'hot' }] })],
    ['skill-writer', () => ({ ...catalog(), skills: { mode: 'open' } })],
    ['credential-writer', () => ({ ...catalog(), credentials: { mode: 'write' } })],
    ['string-bytes', () => ({ ...catalog(), catalogVersion: '界'.repeat(60) })],
    ['tiny-total', () => ({ ...catalog(), maxCatalogBytes: 1 })],
  ] as const)('rejects %s before registering a Root policy service', async (_label, input) => {
    const ctx = new Context()
    try {
      expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, approvedConfiguration: input() })))
        .toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
      expect(ctx.get('peExposure')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('charges the complete encoded catalog, including wrappers, commas, escaped strings and budget digits', () => {
    const input = catalog()
    input.catalogVersion = 'reviewed-"catalog"\\revision'
    input.plugins.push({ ...input.plugins[0]!, id: 'second', entryId: 'second' })
    let exact = Buffer.byteLength(JSON.stringify(input), 'utf8')
    for (;;) {
      input.maxCatalogBytes = exact
      const updated = Buffer.byteLength(JSON.stringify(input), 'utf8')
      if (updated === exact) break
      exact = updated
    }
    expect(parseApprovedConfigurationCatalog(input, manifest.recipeVersion, true)).toBeDefined()
    expect(() => parseApprovedConfigurationCatalog({ ...input, maxCatalogBytes: exact - 1 }, manifest.recipeVersion, true)).toThrow()
    expect(() => parseApprovedConfigurationCatalog(input, manifest.recipeVersion, false)).toThrow()
  })
})


it('requires all eight exact native endpoints and explicit management limits for managed mode', async () => {
  const limits = { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 8192, maxRetainedVersions: 8 }
  const management = { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 }
  const input = { ...catalog(), skills: { mode: 'managed', limits, management } }
  const methods = ['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download']
  const rows = methods.map(method => ({ endpoint: 'cloudSkills/' + method, handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const }))
  for (const rpcEndpoints of [[], rows.slice(0, 2), rows.slice(1), [...rows, { ...rows[0]!, endpoint: 'cloudSkills/extra' }]]) {
    const ctx = new Context()
    try {
      expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, approvedConfiguration: input, rpcEndpoints }))).toThrow()
    }
    finally { await ctx.fiber.dispose() }
  }
  expect(() => parseApprovedConfigurationCatalog({ ...input, skills: { mode: 'managed', limits } }, manifest.recipeVersion, true)).toThrow()
  const ctx = new Context()
  try { expect(new ExposureService(ctx, ExposureService.Config({ ...manifest, approvedConfiguration: input, rpcEndpoints: rows }))
    .approvedConfiguration?.skills).toEqual(input.skills) }
  finally { await ctx.fiber.dispose() }
})

it('opts into only the exact frozen locale field and native mutation writer while preserving model-key ownership', async () => {
  const input = { ...catalog(), fields: [{ namespace: 'locale', field: 'preference', values: ['zh', 'en'] }] }
  const allowedSettings = [{ namespace: 'locale', fields: ['preference'] }]
  const mutate = { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' as const }
  const modelKey = { bindings: [modelKeyBinding('provider')], maxKeyBytes: 8192, maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 }
  const keyRows = ['metadata', 'describe', 'set', 'unset'].map(method =>
    ({ endpoint: 'cloudModelKey/' + method, handlerId: 'native:cloudModelKey', guard: 'authenticated-account' as const }))
  const ctx = new Context()
  try {
    for (const row of [
      { ...manifest, allowedSettings, rpcEndpoints: [] },
      { ...manifest, allowedSettings: [], rpcEndpoints: [mutate] },
      { ...manifest, allowedSettings: [{ namespace: 'locale', fields: ['preference', 'extra'] }], rpcEndpoints: [mutate] },
      { ...manifest, allowedSettings, rpcEndpoints: [{ ...mutate, handlerId: 'other' }] },
      { ...manifest, allowedSettings, rpcEndpoints: [mutate, { ...mutate, endpoint: 'settings/update' }] },
    ]) expect(() => new ExposureService(ctx, ExposureService.Config({ ...row, approvedConfiguration: input }))).toThrow()
    const owner = new ExposureService(ctx, ExposureService.Config({ ...manifest, allowedSettings,
      rpcEndpoints: [mutate, ...keyRows], approvedConfiguration: { ...input, modelKey } }))
    expect(owner.approvedConfiguration?.fields).toEqual(input.fields)
    expect(Object.isFrozen(owner.approvedConfiguration?.fields[0]?.values)).toBe(true)
    expect(owner.approvedConfiguration?.modelKey).toEqual(modelKey)
  } finally { await ctx.fiber.dispose() }
})

it.each([
  [{ namespace: 'locale', field: 'preference', values: ['en', 'zh'] }],
  [{ namespace: 'locale', field: 'preference', values: ['zh', 'en', 'fr'] }],
  [{ namespace: 'locale', field: 'preference', values: ['zh', 'en'], extra: true }],
  [{ namespace: 'locale', field: 'other', values: ['zh', 'en'] }],
  [{ namespace: 'locale', field: 'preference', values: ['zh', 'en'] }, { namespace: 'locale', field: 'preference', values: ['zh', 'en'] }],
])('rejects unapproved field metadata before Root registration', (...fields) => {
  expect(() => parseApprovedConfigurationCatalog({ ...catalog(), fields }, manifest.recipeVersion, false)).toThrow()
})


it('retains generic plugin controls and multiple key bindings in one bounded Root catalog', () => {
  const base = catalog(), entry = base.plugins[0]!
  const control = { selectionTarget: { kind: 'entry', id: entry.entryId }, operations: ['enabled', 'configure'],
    maxImpact: 'local', fields: [['thresholds']] }
  const input = { ...base, plugins: [{ ...entry, toggleable: true, control }],
    pluginControl: { maxProfileBytes: 65536, maxRequestBytes: 4096, maxReplyBytes: 65536, maxVersionBytes: 128 },
    modelKey: { bindings: [modelKeyBinding('provider-one'), { ...modelKeyBinding('provider-two'),
      provider: 'another-route', ref: 'SECOND_NATIVE_KEY' }],
    maxKeyBytes: 8192, maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 } }
  const result = parseApprovedConfigurationCatalog(input, base.recipeVersion, true)
  expect(result?.plugins[0]?.control).toEqual(control)
  expect(result?.modelKey?.bindings).toEqual(input.modelKey.bindings)
  expect(Object.isFrozen(result?.plugins[0]?.control?.fields)).toBe(true)
  expect(Object.isFrozen(result?.modelKey?.bindings)).toBe(true)
  expect(() => parseApprovedConfigurationCatalog({ ...input, plugins: [{ ...input.plugins[0],
    control: { ...control, fields: [['__proto__']] } }] }, base.recipeVersion, true)).toThrow()
  expect(() => parseApprovedConfigurationCatalog({ ...input, modelKey: { ...input.modelKey,
    bindings: [input.modelKey.bindings[0], input.modelKey.bindings[0]] } }, base.recipeVersion, true)).toThrow()
})


it('preserves complete bundle approval and inventory-only rows alongside the existing Key bindings delta', () => {
  const base = catalog(), entry = base.plugins[0]!
  const bundle = { id: 'reviewed-bundle', packageName: '@deepseek-ai/dsh-reviewed-bundle', packageVersion: '0.2.1-rc.2',
    control: { selectionTarget: { kind: 'bundle', name: '@deepseek-ai/dsh-reviewed-bundle' },
      operations: ['selected'], maxImpact: 'graph', fields: [] },
    members: [{ entryId: 'bundle-member', moduleName: entry.moduleName, packageName: entry.packageName,
      packageVersion: entry.packageVersion }] }
  const input = { ...base, bundles: [bundle],
    pluginControl: { maxProfileBytes: 65536, maxRequestBytes: 4096, maxReplyBytes: 65536, maxVersionBytes: 128 },
    modelKey: { bindings: [modelKeyBinding('provider-one'), { ...modelKeyBinding('provider-two'),
      provider: 'another-route', ref: 'SECOND_NATIVE_KEY' }],
    maxKeyBytes: 8192, maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 } }
  const result = parseApprovedConfigurationCatalog(input, base.recipeVersion, true)
  expect(result?.bundles).toEqual(input.bundles)
  expect(Object.isFrozen(result?.bundles?.[0]?.members)).toBe(true)
  expect(result?.plugins[0]?.control).toBeUndefined()
  expect(result?.plugins[0]?.toggleable).toBe(false)
  expect(result?.modelKey?.bindings).toEqual(input.modelKey.bindings)
  expect(() => parseApprovedConfigurationCatalog({ ...input, bundles: [{ ...bundle,
    control: { ...bundle.control, maxImpact: 'local' } }] }, base.recipeVersion, true)).toThrow()
  expect(() => parseApprovedConfigurationCatalog({ ...input, modelKey: { ...input.modelKey,
    bindings: [input.modelKey.bindings[0], input.modelKey.bindings[0]] } }, base.recipeVersion, true)).toThrow()
})


it('admits finite generic fields only with the exact native writer and namespace field manifest', async () => {
  const fields = [{ namespace: 'subagent', field: 'maxActiveSubagents' }, { namespace: 'subagent', field: 'maxDepth' }]
  const input = { ...catalog(), fields }
  const allowedSettings = [{ namespace: 'subagent', fields: ['maxDepth', 'maxActiveSubagents'] }]
  const mutate = { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' as const }
  const ctx = new Context()
  try {
    const owner = new ExposureService(ctx, ExposureService.Config({
      ...manifest, allowedSettings, rpcEndpoints: [mutate], approvedConfiguration: input,
    }))
    expect(owner.approvedConfiguration?.fields).toEqual(fields)
    for (const wrong of [[], [{ namespace: 'subagent', fields: ['maxDepth'] }], [{ namespace: 'subagent', fields: ['maxDepth', 'other'] }]]) {
      expect(() => new ExposureService(ctx, ExposureService.Config({
        ...manifest, allowedSettings: wrong, rpcEndpoints: [mutate], approvedConfiguration: input,
      }))).toThrow()
    }
    expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, allowedSettings, rpcEndpoints: [mutate] }))).toThrow()
  } finally { await ctx.fiber.dispose() }
})

it.each([
  [{ namespace: '../subagent', field: 'maxDepth' }],
  [{ namespace: 'subagent', field: 'nested.value' }],
  [{ namespace: 'subagent', field: '__proto__' }],
  [{ namespace: 'subagent', field: 'maxDepth', values: [] }],
  [{ namespace: 'subagent', field: 'maxDepth', values: [1, 1] }],
  [{ namespace: 'subagent', field: 'maxDepth', values: [Number.POSITIVE_INFINITY] }],
  [{ namespace: 'subagent', field: 'maxDepth' }, { namespace: 'subagent', field: 'maxDepth' }],
])('rejects ambiguous or unbounded generic approval rows', (...fields) => {
  expect(() => parseApprovedConfigurationCatalog({ ...catalog(), fields }, manifest.recipeVersion, false)).toThrow()
})
