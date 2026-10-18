/** Preparation limits stay explicit; a real Loader entry requires its pre-Cordis owner. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parseCloudClientConfig, parseCloudWebManifest } from '../src/config.ts'
import { apply, ClientFailure } from '../src/client/index.ts'
import { ClientFailure as OriginalFailure } from '../src/client/errors.ts'

const valid = {
  bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 1024,
  maxErrorResponseBytes: 256, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000,
}

describe('public browser configuration', () => {
  it('requires explicit finite limits', () => {
    expect(parseCloudClientConfig(valid)).toEqual(valid)
    expect(() => parseCloudClientConfig({ ...valid, maxPendingFetches: Infinity })).toThrow()
    expect(() => parseCloudClientConfig({ ...valid, bootstrapTimeoutMs: 0 })).toThrow()
    expect(() => parseCloudClientConfig({ bootstrapPath: 'cloud/bootstrap' })).toThrow()
  })

  it.each(['https://elsewhere.test/bootstrap', '/cloud/bootstrap', '../bootstrap', 'cloud/bootstrap?x=1'])('rejects non-relative/static bootstrap entry %s', (bootstrapPath) => {
    expect(() => parseCloudClientConfig({ ...valid, bootstrapPath })).toThrow()
  })

  it('rejects Loader activation without its prepared owner', async () => {
    const ctx = new Context()
    try {
      expect(() => { apply(ctx, {}) }).toThrow('pre-Cordis prepared page owner')
      expect(ctx.get('connection')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

const web = {
  client: valid,
  decodeLimits: { maxBodyBytes: 4096, maxStringBytes: 256, maxListItems: 32 },
  persistenceLimits: { maxKeys: 16, maxKeyBytes: 128, maxValueBytes: 4096, maxTotalBytes: 16384, maxNamespaceBytes: 256 },
  fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  auth: { requestTimeoutMs: 500, maxRequestBytes: 4096, maxResponseBytes: 8192 },
}

describe('explicit public Web deployment inputs', () => {
  it('detaches and freezes complete budgets without providing identity', () => {
    const parsed = parseCloudWebManifest(web)
    expect(parsed).toEqual(web)
    expect(parsed.fields).not.toBe(web.fields)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.values(parsed).every(Object.isFrozen)).toBe(true)
    expect(ClientFailure).toBe(OriginalFailure)
  })

  it.each(['account', 'connectionGeneration', 'token', 'current', 'secret'])('rejects unsupported identity/config field %s', (key) => {
    expect(() => parseCloudWebManifest({ ...web, [key]: 'unsupported' })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, auth: { ...web.auth, [key]: 'unsupported' } })).toThrow()
  })

  it('requires every nested finite input and the actual fixed ingress path', () => {
    expect(() => parseCloudWebManifest({ ...web, auth: {} })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, auth: { ...web.auth, requestTimeoutMs: Infinity } })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, persistenceLimits: { ...web.persistenceLimits, maxKeys: 0 } })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, client: { ...valid, bootstrapPath: 'other/bootstrap' } })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, fields: { ...web.fields, accountQuery: web.fields.generationQuery } })).toThrow()
    expect(() => parseCloudWebManifest(null)).toThrow()
    expect(() => parseCloudWebManifest({ ...web, decodeLimits: [] })).toThrow()
  })
})
