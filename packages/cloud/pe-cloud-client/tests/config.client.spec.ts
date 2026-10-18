/** Preparation limits stay explicit; a real Loader entry requires its pre-Cordis owner. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parseCloudClientConfig } from '../src/config.ts'
import { apply } from '../src/client/index.ts'

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
