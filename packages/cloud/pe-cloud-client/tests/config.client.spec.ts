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

it('keeps legacy seven-field inputs closed and accepts only the explicit optional download cap', () => {
  const legacy = parseCloudClientConfig(valid)
  expect(Object.keys(legacy)).toHaveLength(7)
  expect(Object.hasOwn(legacy, 'maxDownloadBytes')).toBe(false)
  expect(Object.hasOwn(parseCloudWebManifest(web).client, 'maxDownloadBytes')).toBe(false)
  for (const maxDownloadBytes of [1, 65536, Number.MAX_SAFE_INTEGER]) {
    const input = { ...valid, maxDownloadBytes }
    expect(parseCloudClientConfig(input)).toEqual(input)
    const manifest = parseCloudWebManifest({ ...web, client: input })
    expect(manifest.client).toEqual(input)
    expect(Object.isFrozen(manifest.client)).toBe(true)
    expect(Object.keys(manifest.client)).toHaveLength(8)
  }
  expect(() => parseCloudClientConfig({ ...valid, download: 65536 })).toThrow()
  expect(() => parseCloudClientConfig({ ...valid, maxDownloadBytes: 65536, token: 'extra' })).toThrow()
  expect(() => parseCloudWebManifest({ ...web, client: { ...valid, maxDownloadBytes: 65536, current: 'extra' } })).toThrow()
})

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, null, '65536'])(
  'rejects a present download cap that is not a finite positive safe integer: %s', (maxDownloadBytes) => {
    expect(() => parseCloudClientConfig({ ...valid, maxDownloadBytes })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, client: { ...valid, maxDownloadBytes } })).toThrow()
  },
)


it('requires explicit sample-editor file/deadline bounds without enabling legacy manifests', () => {
  expect(Object.hasOwn(parseCloudClientConfig(valid), 'skillSettings')).toBe(false)
  const skillSettings = { requestTimeoutMs: 1000, maxFileBytes: 4096 }
  const parsed = parseCloudClientConfig({ ...valid, skillSettings })
  expect(parsed.skillSettings).toEqual(skillSettings)
  expect(parsed.skillSettings).not.toBe(skillSettings)
  expect(Object.isFrozen(parsed.skillSettings)).toBe(true)
  for (const invalid of [{}, { requestTimeoutMs: 0, maxFileBytes: 1 }, { requestTimeoutMs: 1, maxFileBytes: Infinity },
    { ...skillSettings, account: 'forbidden' }, undefined]) {
    expect(() => parseCloudClientConfig({ ...valid, skillSettings: invalid })).toThrow()
  }
})

it('accepts only explicit finite native Session control groups and detaches the selected roster', () => {
  const groups = ['commands', 'models', 'permissions', 'goals', 'plan', 'feedback', 'export', 'attachments'] as const
  const selected = [...groups], parsed = parseCloudClientConfig({ ...valid, nativeSessionControls: selected })
  expect(parsed.nativeSessionControls).toEqual(groups)
  expect(parsed.nativeSessionControls).not.toBe(selected)
  expect(Object.isFrozen(parsed.nativeSessionControls)).toBe(true)
  selected.length = 0
  expect(parsed.nativeSessionControls).toEqual(groups)
  expect(Object.hasOwn(parseCloudClientConfig(valid), 'nativeSessionControls')).toBe(false)
  expect(parseCloudClientConfig({ ...valid, nativeSessionControls: [] }).nativeSessionControls).toEqual([])
})

it.each([undefined, null, true, 'commands', ['models'], ['permissions'], ['plan'], ['feedback'], ['export'],
  ['commands', 'commands'], ['commands', 'hostAdmin'], ['commands', { name: 'models' }]])(
  'rejects a malformed or incomplete native Session control roster: %j', (nativeSessionControls) => {
    expect(() => parseCloudClientConfig({ ...valid, nativeSessionControls })).toThrow()
    expect(() => parseCloudWebManifest({ ...web, client: { ...valid, nativeSessionControls } })).toThrow()
  },
)

it('enables the readonly native Settings pages only with an explicit deadline and the existing Models integration', () => {
  expect(parseCloudClientConfig({ ...valid, modelSettingsRequestTimeoutMs: 1000, nativeSettingsRequestTimeoutMs: 2000 }))
    .toMatchObject({ modelSettingsRequestTimeoutMs: 1000, nativeSettingsRequestTimeoutMs: 2000 })
  expect(parseCloudClientConfig(valid)).not.toHaveProperty('nativeSettingsRequestTimeoutMs')
  expect(() => parseCloudClientConfig({ ...valid, nativeSettingsRequestTimeoutMs: 1000 })).toThrow('Models integration')
})
it.each([undefined, null, 0, -1, 1.5, Infinity, '1000', 2_147_483_648])('rejects invalid readonly Settings deadline %j', (nativeSettingsRequestTimeoutMs) => {
  expect(() => parseCloudClientConfig({ ...valid, modelSettingsRequestTimeoutMs: 1000, nativeSettingsRequestTimeoutMs })).toThrow()
})
