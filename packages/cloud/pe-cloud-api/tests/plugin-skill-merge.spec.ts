/** One real AccountSaves with independent native authority versions; external writers are explicit counters. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ConfigSaveCoordinator, ConfigSaveOutcomeUnknown, SkillEditApplyFailure } from '../src/config-saves.ts'
import { parseApprovedConfigurationCatalog } from '../src/approved-catalog.ts'
import ExposureService from '../src/root.ts'
import { APPROVED_PLUGIN_CONTROL as fixed } from '../src/plugin-json.ts'
import type { SkillEditToken, PluginEditToken } from '../src/save-hooks.ts'

const saveLimits = { maxAccounts: 2, maxRunning: 2, maxQueued: 8, maxQueuedPerAccount: 8,
  maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 16, maxNestedPerOperation: 8, maxWaitersPerAccount: 4 }
function fixture() {
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('merged-owner'),
    epoch: brandString<AccountBinding['epoch']>('one'), recipeVersion: 'merged-source165', lifetime: new AbortController().signal }
  const coordinator = new ConfigSaveCoordinator(saveLimits), ref = credentialRef('DEEPSEEK_API_KEY')
  const saves = coordinator.createAccount(binding, { references: [ref], maxReferences: 1, maxReferenceBytes: 64 })
  return { coordinator, saves, binding, ref, check: () => { binding.lifetime.throwIfAborted() } }
}
function deferred() {
  const value = Promise.withResolvers<undefined>()
  return { promise: value.promise, release: () => { value.resolve(undefined) } }
}
const describeKey = async () => ({ configured: true, writable: true, source: 'file' as const })

it('keeps credential, directory and plugin edits in one owner without confusing their authorities', async () => {
  const f = fixture(), counts = { credential: 0, skill: 0, plugin: 0 }
  let directory = FsVersion('catalog-before'), profile = 'profile-before'
  const key = await f.saves.describeCredentialEdit(f.ref, describeKey, f.check)
  const skill = await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: directory }), f.check)
  const plugin = await f.saves.describePluginEdit(async () => ({ value: 'plugin', revision: profile }), f.check)
  const skillVersion = await f.saves.commitSkillEdit(skill.version, async (expected) => {
    expect(expected).toBe(directory); counts.skill++; directory = FsVersion('catalog-after'); return { persisted: true, revision: directory }
  }, () => {}, f.check)
  expect((await f.saves.describePluginEdit(async () => ({ value: 'plugin', revision: profile }), f.check)).version).toEqual(plugin.version)
  expect((await f.saves.describeCredentialEdit(f.ref, describeKey, f.check)).version).toEqual(key.version)
  const rejectedPlugin = await f.saves.commitPluginEdit({ ...plugin.version,
    editToken: brandString<PluginEditToken>(skillVersion.editToken) }, () => profile,
  async () => { counts.plugin++; return { published: true, revision: profile, value: 'bad' } }, f.check)
  expect(rejectedPlugin.published).toBe(false); expect(counts.plugin).toBe(0)
  await expect(f.saves.commitSkillEdit({ ...skillVersion, editToken: brandString<SkillEditToken>(plugin.version.editToken) },
    async () => { counts.skill++; return { persisted: true, revision: directory } }, () => {}, f.check))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(counts.skill).toBe(1)
  expect((await f.saves.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
  const changed = await f.saves.withPausedPluginChange(() => f.saves.commitPluginEdit(plugin.version, () => profile, async () => {
    await f.saves.admit('config-editor', async () => { counts.plugin++; expect(f.saves.snapshot().pending).toHaveLength(1) })
    profile = 'profile-after'; return { published: true, revision: profile, value: 'native-applied' }
  }, f.check))
  expect(changed.published).toBe(true); f.saves.resumeAccountChanges()
  expect((await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: directory }), f.check)).version).toEqual(skillVersion)
  const savedKey = await f.saves.commitCredentialEdit(f.ref, key.version,
    () => f.saves.admitCredentialSave({ kind: 'set', ref: f.ref }, async () => { counts.credential++ }), f.check)
  expect(savedKey.editToken).not.toBe(key.version.editToken)
  expect((await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: directory }), f.check)).version).toEqual(skillVersion)
  expect(counts).toEqual({ credential: 1, skill: 1, plugin: 1 })
  expect(f.coordinator.snapshot()).toMatchObject({ accounts: 1, tracked: 0, running: 0, queued: 0 })
})

it('waits for required skill apply and resident release before permitting the paused plugin turn', async () => {
  const f = fixture(), applied = deferred(), entered = deferred()
  const skill = await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: FsVersion('before') }), f.check)
  const plugin = await f.saves.describePluginEdit(async () => ({ value: 'plugin', revision: 'profile' }), f.check)
  let prepareHeld = 0, skillWrites = 0, pluginWrites = 0
  const first = f.saves.commitSkillEdit(skill.version, async () => {
    prepareHeld++; skillWrites++; return { persisted: true, revision: FsVersion('after') }
  }, async () => { try { entered.release(); await applied.promise } finally { prepareHeld-- } }, f.check)
  await entered.promise
  expect(prepareHeld).toBe(1); expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
  expect(() => f.saves.withPausedPluginChange(async () => { pluginWrites++ })).toThrow(expect.objectContaining({ code: 'cloud/config-busy' }))
  await expect(f.saves.commitSkillEdit(skill.version, async () => { skillWrites++; return { persisted: true, revision: FsVersion('illegal') } },
    () => {}, f.check)).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(skillWrites).toBe(1); expect(pluginWrites).toBe(0)
  const other = f.coordinator.createAccount({ ...f.binding, accountId: brandString<AccountBinding['accountId']>('other') })
  expect(await other.admit('settings', async () => 'independent')).toBe('independent')
  applied.release(); await first; expect(prepareHeld).toBe(0)
  const change = await f.saves.withPausedPluginChange(() => f.saves.commitPluginEdit(plugin.version, () => 'profile', async () => {
    expect(prepareHeld).toBe(0); pluginWrites++; return { published: true, revision: 'changed', value: true }
  }, f.check))
  expect(change.published).toBe(true); expect(pluginWrites).toBe(1)
})

it('joins required plugin writer work in one paused turn and keeps top-level skill admission live-only', async () => {
  const f = fixture(), inner = deferred(), entered = deferred(), order: string[] = []
  const skill = await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: FsVersion('catalog') }), f.check)
  expect(() => f.saves.withPausedPluginChange(async () => {})).toThrow(expect.objectContaining({ code: 'cloud/config-busy' }))
  await f.saves.pauseAccountChanges(Date.now() + 1000)
  const plugin = f.saves.withPausedPluginChange(async () => {
    await f.saves.admit('plugin-selection', async () => {
      order.push('manager'); expect(f.saves.snapshot().pending).toHaveLength(1)
      await f.saves.admit('config-editor', async () => { order.push('editor'); entered.release(); await inner.promise })
    })
    order.push('applied')
  })
  await entered.promise
  await expect(f.saves.commitSkillEdit(skill.version, async () => {
    order.push('forbidden-skill'); return { persisted: true, revision: FsVersion('bad') }
  }, () => {}, f.check)).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect((await f.saves.pauseAccountChanges(Date.now())).status).toBe('unknown')
  expect(order).toEqual(['manager', 'editor']); inner.release(); await plugin
  expect(order).toEqual(['manager', 'editor', 'applied'])
  f.saves.resumeAccountChanges()
  await f.saves.commitSkillEdit(skill.version, async () => ({ persisted: true, revision: FsVersion('after') }), () => {}, f.check)
})

it.each(['skill-unknown', 'skill-apply', 'plugin-unknown'] as const)('retains %s in the common failure gate without reopening another authority', async (kind) => {
  const f = fixture(), skill = await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: FsVersion('before') }), f.check)
  const plugin = await f.saves.describePluginEdit(async () => ({ value: 'plugin', revision: 'profile' }), f.check)
  if (kind === 'skill-unknown') await expect(f.saves.commitSkillEdit(skill.version, async () => {
    throw new ConfigSaveOutcomeUnknown()
  }, () => {}, f.check)).rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
  else if (kind === 'skill-apply') await expect(f.saves.commitSkillEdit(skill.version,
    async () => ({ persisted: true, revision: FsVersion('after') }), async () => { throw Error('Required apply failed') }, f.check))
    .rejects.toBeInstanceOf(SkillEditApplyFailure)
  else {
    await f.saves.pauseAccountChanges(Date.now() + 1000)
    await expect(f.saves.withPausedPluginChange(() => f.saves.commitPluginEdit(plugin.version, () => 'profile', async () => {
      throw new ConfigSaveOutcomeUnknown()
    }, f.check))).rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
  }
  let submitted = 0
  await expect(f.saves.describeCredentialEdit(f.ref, async () => { submitted++; return describeKey() }, f.check)).rejects.toBeDefined()
  expect(() => f.saves.withPausedPluginChange(async () => { submitted++ })).toThrow()
  expect(submitted).toBe(0); expect((await f.saves.stopConfigSaves(Date.now())).status).toBe('unknown')
  expect(() => { f.saves.resumeAccountChanges() }).toThrow()
  expect(f.saves.snapshot().failures).toMatchObject([{ outcome: kind === 'skill-apply' ? 'failed' : 'unknown' }])
})

it('keeps terminal stop terminal for both plugin and skill submissions', async () => {
  const f = fixture(), skill = await f.saves.describeSkillEdit(async () => ({ value: 'catalog', revision: null }), f.check)
  expect((await f.saves.stopConfigSaves(Date.now() + 1000)).status).toBe('confirmed')
  let writes = 0
  expect(() => f.saves.withPausedPluginChange(async () => { writes++ })).toThrow()
  await expect(f.saves.commitSkillEdit(skill.version, async () => { writes++; return { persisted: true, revision: FsVersion('bad') } }, () => {}, f.check)).rejects.toBeDefined()
  expect(() => { f.saves.resumeAccountChanges() }).toThrow(); expect(writes).toBe(0)
})

it('requires both complete native groups while preserving managed DTO configuration and closed raw writers', async () => {
  const input = { recipeVersion: 'merged-source165', catalogVersion: 'both', maxEntries: 8, maxStringBytes: 256, maxCatalogBytes: 8192,
    plugins: [{ ...fixed, installable: false, toggleable: true }],
    pluginControl: { maxProfileBytes: 32768, maxRequestBytes: 2048, maxReplyBytes: 16384, maxVersionBytes: 128 },
    skills: { mode: 'managed', limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 8192, maxRetainedVersions: 8 },
      management: { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 } },
    credentials: { mode: 'read-only' }, fields: [] }
  const skillRows = ['current','publish','installed','details','install','update','uninstall','download'].map(method => ({
    endpoint: 'cloudSkills/'+method, handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const }))
  const pluginRows = ['current','change'].map(method => ({ endpoint: 'cloudPlugins/'+method,
    handlerId: 'native:cloudPlugins', guard: 'authenticated-account' as const }))
  const manifest = { recipeVersion: input.recipeVersion, rpcEndpoints: [...skillRows, ...pluginRows],
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [], approvedConfiguration: input }
  const approved = parseApprovedConfigurationCatalog(input, input.recipeVersion, true)
  expect(approved?.skills).toEqual(input.skills); expect(approved?.pluginControl).toEqual(input.pluginControl)
  for (const rpcEndpoints of [skillRows, pluginRows, [...skillRows.slice(1), ...pluginRows], [...skillRows, ...pluginRows.slice(1)],
    [...skillRows, ...pluginRows, { endpoint: 'pluginManager/setPluginEnabled', handlerId: 'native:pluginManager', guard: 'authenticated-account' as const }]]) {
    const ctx = new Context()
    try { expect(() => new ExposureService(ctx, ExposureService.Config({ ...manifest, rpcEndpoints }))).toThrow() }
    finally { await ctx.fiber.dispose() }
  }
  expect(() => parseApprovedConfigurationCatalog({ ...input, fields: [{ id: 'locale' }] }, input.recipeVersion, true)).toThrow()
  const ctx = new Context()
  try { expect(new ExposureService(ctx, ExposureService.Config(manifest)).approvedConfiguration?.skills).toEqual(input.skills) }
  finally { await ctx.fiber.dispose() }
})
