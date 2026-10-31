import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import ExposureService from '../src/root.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { ExposureManifestSchema } from '../src/schema.ts'
import type { ExposureManifest } from '../src/types.ts'
import { apply as mountAccount } from '../src/account.ts'

function manifest(): ExposureManifest {
  return {
    recipeVersion: 'd08-m0',
    rpcEndpoints: [{ endpoint: 'session/prompt', handlerId: 'native/session.prompt', guard: 'account-session' }],
    streamEndpoints: [{ endpoint: 'session/follow', handlerId: 'native/session.follow', guard: 'account-session' }],
    exactFetchRoutes: [{ method: 'POST', path: '/api/session/uploadFileBinary', handlerId: 'native/file-upload', guard: 'account-session' }],
    allowedSettings: [{ namespace: 'subagent', fields: ['maxActiveSubagents'] }],
  }
}

describe('reviewed exposure', () => {
  it('rejects even listed operations until actual inventory is audited', () => {
    const policy = new ExposurePolicy(manifest())
    expect(() => policy.requireRpc('session/prompt')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    policy.audit(manifest())
    expect(policy.requireRpc('session/prompt').guard).toBe('account-session')
    expect(policy.requireStream('session/follow').endpoint).toBe('session/follow')
  })

  it('denies unknown, wrong-transport, prefix, case and method variants', () => {
    const policy = new ExposurePolicy(manifest())
    policy.audit(manifest())
    for (const name of ['session/newNativeMethod', 'session/prompt/extra', 'session/Prompt', 'session/follow']) {
      expect(() => policy.requireRpc(name)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    }
    expect(() => policy.requireStream('session/prompt')).toThrow()
    expect(policy.requireFetch('POST', '/api/session/uploadFileBinary').handlerId).toBe('native/file-upload')
    for (const path of ['/api/session/uploadFileBinary/', '/api/session/uploadFileBinary?x=1', '/api/session/%75ploadFileBinary']) {
      expect(() => policy.requireFetch('POST', path)).toThrow()
    }
    expect(() => policy.requireFetch('GET', '/api/session/uploadFileBinary')).toThrow()
    expect(() => policy.requireFetch('post', '/api/session/uploadFileBinary')).toThrow()
  })

  it('keeps newly mounted native endpoints closed', () => {
    const input = manifest()
    const policy = new ExposurePolicy(input)
    policy.audit({ ...input, rpcEndpoints: [...input.rpcEndpoints, {
      endpoint: 'session/newNativeMethod', handlerId: 'native/new', guard: 'authenticated-account',
    }] })
    expect(() => policy.requireRpc('session/newNativeMethod')).toThrow()
  })

  it('revokes a previous audit when the recipe, handler or guard changes', () => {
    const input = manifest()
    const policy = new ExposurePolicy(input)
    for (const changed of [
      { ...input, recipeVersion: 'other' },
      { ...input, rpcEndpoints: [] },
      { ...input, rpcEndpoints: [{ ...input.rpcEndpoints[0]!, handlerId: 'native/other' }] },
      { ...input, rpcEndpoints: [{ ...input.rpcEndpoints[0]!, guard: 'authenticated-account' as const }] },
    ]) {
      policy.audit(input)
      expect(() =>{  policy.audit(changed) }).toThrow()
      expect(() => policy.requireStream('session/follow')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }
  })

  it('detaches grants from mutable config and freezes returned entries', () => {
    const input = { ...manifest(), rpcEndpoints: [...manifest().rpcEndpoints] }
    const policy = new ExposurePolicy(input)
    input.rpcEndpoints.push({ endpoint: 'unsafe/run', handlerId: 'native/unsafe', guard: 'authenticated-account' })
    policy.audit(manifest())
    expect(() => policy.requireRpc('unsafe/run')).toThrow()
    expect(Object.isFrozen(policy.requireRpc('session/prompt'))).toBe(true)
    expect(Object.isFrozen(policy.manifest.rpcEndpoints)).toBe(true)
  })

  it('requires every exact settings field and namespace', () => {
    const policy = new ExposurePolicy(manifest())
    policy.audit(manifest())
    policy.assertSettingsFields('subagent', ['maxActiveSubagents'])
    expect(() =>{  policy.assertSettingsFields('subagent', ['maxActiveSubagents', 'maxDepth']) }).toThrow()
    expect(() =>{  policy.assertSettingsFields('subagent', ['maxActiveSubagents.child']) }).toThrow()
    expect(() =>{  policy.assertSettingsFields('other', []) }).toThrow()
  })

  it.each(['session/*', 'session/../prompt', '/session/prompt', 'session/prompt?x=1', 'session//prompt'])(
    'rejects non-exact endpoint config %s', (endpoint) => {
      expect(() => new ExposurePolicy({ ...manifest(), rpcEndpoints: [{ endpoint, handlerId: 'native/prompt', guard: 'account-session' }] })).toThrow()
    },
  )

  it.each(['/connect', '/api/*', '/api/../connect', '/api/%2f', '/api/x?query=1', '/api//x'])(
    'rejects aliased Fetch config %s', (path) => {
      expect(() => new ExposurePolicy({ ...manifest(), exactFetchRoutes: [{ method: 'POST', path, handlerId: 'native/upload', guard: 'account-session' }] })).toThrow()
    },
  )

  it('rejects duplicate declarations and missing required schema fields', () => {
    const input = manifest()
    expect(() => new ExposurePolicy({ ...input, rpcEndpoints: [...input.rpcEndpoints, ...input.rpcEndpoints] })).toThrow()
    expect(() => new ExposurePolicy({ ...input, streamEndpoints: input.rpcEndpoints })).toThrow()
    expect(() => new ExposurePolicy({ ...input, exactFetchRoutes: [{
      method: 'POST', path: '/api/session/prompt', handlerId: 'native/other', guard: 'authenticated-account',
    }] })).toThrow('shadow')
    expect(() => z.resolve({ recipeVersion: 'd08-m0' }, ExposureManifestSchema, {})).toThrow()
  })

  it('revokes a root policy when its fiber is disposed and refuses incomplete account mount', async () => {
    const ctx = new Context()
    const input = { ...manifest(), rpcEndpoints: [...manifest().rpcEndpoints,
      { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' as const }] }
    const fiber = await ctx.plugin(ExposureService, {
      recipeVersion: input.recipeVersion,
      rpcEndpoints: input.rpcEndpoints.map(row => ({ ...row })),
      streamEndpoints: input.streamEndpoints.map(row => ({ ...row })),
      exactFetchRoutes: input.exactFetchRoutes.map(row => ({ ...row })),
      allowedSettings: input.allowedSettings.map(row => ({ ...row, fields: [...row.fields] })),
      approvedConfiguration: {
        recipeVersion: input.recipeVersion, catalogVersion: 'exposure-disposal-component',
        maxEntries: 4, maxStringBytes: 128, maxCatalogBytes: 4096,
        plugins: [{ id: 'subagents', entryId: 'subagents', moduleName: '@deepseek-ai/dsh-subagent',
          packageName: '@deepseek-ai/dsh-subagent', packageVersion: '0.2.1-rc.2', installable: false, toggleable: false }],
        skills: { mode: 'closed' }, credentials: { mode: 'read-only' },
        fields: input.allowedSettings.flatMap(row => row.fields.map(field => ({ namespace: row.namespace, field }))),
      },
    })
    const policy = ctx.peExposure.policy
    policy.audit(input)
    await fiber.dispose()
    expect(() => policy.requireRpc('session/prompt')).toThrow()
    expect(() => { mountAccount(ctx, {}) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    await ctx.fiber.dispose()
  })
})
