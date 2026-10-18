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
