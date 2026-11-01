/** Source-native Loader/Settings/LLM metadata only; no external model success is simulated or claimed. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as OfficialProvider from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { ModelKeyProvider } from '../src/model-key-provider.ts'
import type { ApprovedModelKeyConfiguration } from '../src/types.ts'

class DeclaredAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Declared credential metadata fixture' } }
  override async *stream(): AsyncIterable<StreamChunk> { throw new Error('No model request is supported by this metadata fixture') }
}
const Declared = {
  Config: z.object({ apiKeyEnv: z.string().role('credential-ref').volatile(),
    models: z.array(z.object({ id: z.string() })).volatile(), hidden: z.string().role('secret').volatile() }),
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.llm.registerAdapter(['declared-provider'], new DeclaredAdapter()))
    ctx.effect(() => ctx.llm.registerConfigurableProviders([{ provider: 'declared-provider', displayName: 'Declared',
      settingsNs: ctx.fiber.entry!.options.id, settingsPath: [] }]))
  },
}
async function fixture(ref: string, second = false, web = false, endpoint = 'https://api.deepseek.com/anthropic/v1',
  webRef = 'DEEPSEEK_API_KEY', literal?: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'model-key-native-metadata-'))), dir = join(home, 'profile')
  mkdirSync(dir); initProfile(dir, [])
  if (web) symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(home, 'node_modules'), 'dir')
  const anchor = join(home, 'package.json'); writeFileSync(anchor, '{"name":"source-native-key-fixture","private":true}\n')
  const path = join(dir, 'cordis.yml'); writeFileSync(path, JSON.stringify([
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' }, { id: 'llm', name: 'cordis:llm' },
    { id: 'official', name: 'cordis:official', config: { apiKeyEnv: ref, models: [{ id: 'declared-native-model' }] } },
    ...web ? [
      { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
      { id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: webRef, baseURL: endpoint, ...literal === undefined ? {} : { apiKey: literal } } },
      { id: 'web-deepseek-api', name: '@deepseek-ai/dsh-web-deepseek-api', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1/tools' } },
      { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' },
    ] : [],
    ...second ? [{ id: 'declared', name: 'cordis:declared', config: { apiKeyEnv: 'SECOND_DECLARED_KEY',
      models: [{ id: 'metadata-only' }], hidden: 'synthetic-must-be-redacted' } }] : [],
  ]))
  const profile: ProfileContext = { name: 'native', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor,
    cwd: home, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('native-key-metadata', path, [], (owner) => {
    owner.provide('profileContext', profile)
    owner.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
    Object.assign(owner.loader.builtins, {
      editor: ConfigEditor, settings: Settings, llm: LlmRuntime, official: OfficialProvider, declared: Declared,
    })
  })
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } })
  const policy: ApprovedModelKeyConfiguration = { bindings: [{ provider: 'deepseek-official', providerEntryId: 'official',
    moduleName: 'cordis:official', ref: credentialRef(ref) }, ...second ? [{ provider: 'declared-provider', providerEntryId: 'declared',
    moduleName: 'cordis:declared', ref: credentialRef('SECOND_DECLARED_KEY') }] : []],
  maxKeyBytes: 128, maxVersionBytes: 128, maxReplyBytes: 4096, maxMetadataBytes: 65536 }
  return { ctx, policy }
}
it.each(['TRIAL_DEEPSEEK_KEY', 'SECOND_DECLARED_KEY'])('retains the real native DeepSeek schema/model view with Root-selected ref %s', async (ref) => {
  const f = await fixture(ref), provider = new ModelKeyProvider(f.ctx, f.policy, 32)
  await provider.audit()
  const view = provider.metadata()
  expect(view.providers.map(row => row.id)).toEqual(['deepseek-official'])
  expect(view.settings.namespaces[0]?.value).toMatchObject({ apiKeyEnv: ref, models: [{ id: 'declared-native-model' }] })
  expect(view.settings.writable).toBe(false)
  expect(() =>{  provider.assertProvisionable('deepseek-official', 'declared-native-model') }).not.toThrow()
})
it('projects two approved native declarations and original secret redaction through the same provider implementation', async () => {
  const f = await fixture('TRIAL_DEEPSEEK_KEY', true), provider = new ModelKeyProvider(f.ctx, f.policy, 32)
  await provider.audit()
  const view = provider.metadata()
  expect(view.providers.map(row => row.id)).toEqual(['deepseek-official', 'declared-provider'])
  expect(view.settings.namespaces).toHaveLength(2)
  expect(view.settings.namespaces[1]?.value).toMatchObject({ apiKeyEnv: 'SECOND_DECLARED_KEY', models: [{ id: 'metadata-only' }] })
  expect(JSON.stringify(view)).not.toContain('synthetic-must-be-redacted')
  expect(view.settings.namespaces[1]?.secrets).toEqual([{ path: ['hidden'], set: true }])
})
it.each(['reference', 'module', 'provider'] as const)('rejects a Root binding whose actual native %s does not match', async (kind) => {
  const f = await fixture('TRIAL_DEEPSEEK_KEY'), first = f.policy.bindings[0]!
  const policy = { ...f.policy, bindings: [{ ...first,
    ...kind === 'reference' ? { ref: credentialRef('OTHER_KEY') } : kind === 'module' ? { moduleName: 'cordis:declared' } : { provider: 'other-provider' } }] }
  await expect(new ModelKeyProvider(f.ctx, policy, 32).audit()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('refuses to renew a provider plan if an unapproved config field changes during the write', async () => {
  const f = await fixture('TRIAL_DEEPSEEK_KEY'), provider = new ModelKeyProvider(f.ctx, f.policy, 32)
  await provider.audit()
  const finish = provider.beginSettingsUpdate('official', [{ op: 'set', path: ['baseURL'], value: 'test' }])
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'official')!
  const before: unknown = entry.options.config
  if (before === null || typeof before !== 'object' || Array.isArray(before)) throw new Error('Expected provider config object')
  entry.options.config = { ...before, apiKeyEnv: 'UNAPPROVED_KEY', models: [{ id: 'new' }] }
  try {
    expect(() =>{  finish.finish() }).toThrow()
    expect(() => provider.metadata()).toThrow()
  } finally { entry.options.config = before }
})


it('audits real Loader-mounted web providers and refuses an unapproved effective endpoint', async () => {
  const f = await fixture('DEEPSEEK_API_KEY', false, true)
  const provider = new ModelKeyProvider(f.ctx, f.policy, 32, true)
  await provider.audit()
  expect(() => provider.metadata()).not.toThrow()
})

it('rejects a real Loader-mounted search provider with an unapproved endpoint', async () => {
  const f = await fixture('DEEPSEEK_API_KEY', false, true, 'https://unapproved.example')
  await expect(new ModelKeyProvider(f.ctx, f.policy, 32, true).audit()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})


it('rejects a real search provider with a different credential reference or a literal key', async () => {
  for (const [reference, literal] of [['OTHER_KEY', undefined], ['DEEPSEEK_API_KEY', 'not-an-account-reference']] as const) {
    const f = await fixture('DEEPSEEK_API_KEY', false, true, 'https://api.deepseek.com/anthropic/v1', reference, literal)
    await expect(new ModelKeyProvider(f.ctx, f.policy, 32, true).audit()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  }
})


it('rejects WebSearch when the approved model key is not the same account reference', async () => {
  const f = await fixture('OTHER_KEY', false, true)
  await expect(new ModelKeyProvider(f.ctx, f.policy, 32, true).audit()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it.each(['web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http'] as const)(
  'rejects actual Loader replacement of protected %s when the provider is re-audited', async (id) => {
    const f = await fixture('DEEPSEEK_API_KEY', false, true)
    const provider = new ModelKeyProvider(f.ctx, f.policy, 32, true)
    await provider.audit()
    const entry = [...f.ctx.loader.entries()].find(row => row.options.id === id)!
    f.ctx.loader.builtins['web-replaced-fixture'] = { apply() {} }
    await entry.fiber!.dispose()
    delete entry.fiber
    await entry.update({ name: 'cordis:web-replaced-fixture' })
    await expect(new ModelKeyProvider(f.ctx, f.policy, 32, true).audit())
      .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(() => provider.metadata()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  }, 15000,
)
