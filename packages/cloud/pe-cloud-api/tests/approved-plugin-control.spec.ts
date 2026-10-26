/** Actual native Include/Manager/Editor/save-owner composition;
 * runtime/M1 and installed module resolution are explicit fixture boundaries. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boot, initProfile, readProfilePatches, PluginPackages, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { pluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory'
import * as Reminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AccountPluginControl } from '../src/plugin-control.ts'
import { ConfigSaveCoordinator, ConfigSaveOutcomeUnknown } from '../src/config-saves.ts'
import { CloudApiError } from '../src/errors.ts'
import { bindNativeConfigSaveHook } from '../src/native-save-hook.ts'
import type { ApprovedConfigurationCatalog, ApprovedConfigurationPlugin } from '../src/types.ts'
import { APPROVED_PLUGIN_CONTROL as fixed, pluginRequests } from '../src/plugin-json.ts'
import type { PluginEditVersion } from '../src/save-hooks.ts'
const limits = { maxProfileBytes: 32768, maxRequestBytes: 2048, maxReplyBytes: 16384, maxVersionBytes: 128 }
const saveLimits = { maxAccounts: 2, maxRunning: 2, maxQueued: 4, maxQueuedPerAccount: 4,
  maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 4 }
function binding(): AccountBinding { return Object.freeze({ accountId: brandString<AccountId>('plugin-fixture'),
  epoch: brandString<OwnerEpoch>('epoch-one'), recipeVersion: 'plugin-component', lifetime: new AbortController().signal }) }

const second = { id: 'host-data-fixture', entryId: 'include:host-data-fixture',
  moduleName: '@deepseek-ai/dsh-host-data-fixture', packageName: '@deepseek-ai/dsh-host-data-fixture', packageVersion: '1.0.0',
  control: { selectionTarget: { kind: 'entry' as const, id: 'include:host-data-fixture' },
    operations: ['enabled', 'configure'] as const, maxImpact: 'local' as const, fields: [['limit']] } }
function catalog(fields = second.control.fields, readOnly = false): ApprovedConfigurationCatalog {
  const plugins = [fixed, { ...second, control: { ...second.control, fields } }]
    .map<ApprovedConfigurationPlugin>(row => ({ ...row, installable: false, toggleable: true }))
  if (readOnly) plugins.push({ id: 'read-only-core', entryId: 'include:read-only-core', moduleName: second.moduleName,
    packageName: second.packageName, packageVersion: second.packageVersion, installable: false, toggleable: false })
  return {
    recipeVersion: 'plugin-component', catalogVersion: 'generic-two',
    maxEntries: 16, maxStringBytes: 256, maxCatalogBytes: 8192, pluginControl: limits,
    plugins,
    fields: [], skills: { mode: 'closed' }, credentials: { mode: 'read-only' },
  }
}
async function fixture(disabled = false,
  custom?: { schema: string; config: Record<string, unknown> | null; fields: string[][]; disabled?: boolean }, readOnly = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'approved-plugin-native-'))), dir = join(home, 'profile')
  mkdirSync(dir); mkdirSync(join(home, 'node_modules/@deepseek-ai'), { recursive: true })
  mkdirSync(join(home, 'node_modules', fixed.moduleName))
  copyFileSync(fileURLToPath(new URL('../../../guard/repeat-tool-reminder/package.json', import.meta.url)),
    join(home, 'node_modules', fixed.moduleName, 'package.json'))
  const secondDir = join(home, 'node_modules', second.moduleName)
  mkdirSync(secondDir)
  writeFileSync(join(secondDir, 'package.json'), JSON.stringify({ name: second.packageName, version: second.packageVersion, type: 'module', main: './index.mjs' }))
  writeFileSync(join(secondDir, 'index.mjs'), `import z from ${JSON.stringify(new URL('../../../../vendor/schemastery/lib/index.mjs', import.meta.url).href)}
export const name = 'host-data-fixture'
export const Config = ${custom?.schema ?? 'z.object({ limit: z.number().min(1).default(10) })'}
export function apply() {}
`)
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'owned-plugin-component', dependencies: {} }))
  initProfile(dir, [])
  const profile: ProfileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const basePath = join(dir, 'cordis.yml'), base = JSON.stringify([
    { id: 'editor', name: 'cordis:editor' }, { id: 'manager', name: 'cordis:manager' },
    { id: 'unchanged', name: 'cordis:empty' },
    { id: second.id, name: second.moduleName, disabled: custom?.disabled, config: custom === undefined ? { limit: 10 } : custom.config },
    ...readOnly ? [{ id: 'read-only-core', name: second.moduleName, inject: [], config: { limit: 7 } }] : [],
    { id: 'repeat-tool-reminder', name: fixed.moduleName, disabled, config: { thresholds: [3, 5, 8] } },
  ]) + '\n'
  writeFileSync(basePath, base); writeFileSync(profile.patchPath, '[]\n')
  const saves = new ConfigSaveCoordinator(saveLimits), account = binding(), barrier = saves.createAccount(account)
  let ctx: Context | undefined = undefined, control: AccountPluginControl | undefined
  onTestFinished(async () => {
    await barrier.stopConfigSaves(Date.now() + 1000)
    try { await ctx?.fiber.dispose() } finally { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) }
  })
  ctx = await boot('dsh', basePath, readProfilePatches('dsh', profile), async (owner) => {
    owner.provide('profileContext', profile); owner.provide('peAccount', account)
    await owner.plugin(PluginPackages)
    const check = (): void => { owner.fiber.assertActive(); if (owner.get('peAccount') !== account) throw new Error('Original fixture binding changed') }
    control = new AccountPluginControl(owner, barrier, {
      limits, catalog: catalog(custom?.fields, readOnly), maxNativeInventoryEntries: 64, requiredEntryIds: ['include:editor'], resolvePackages: () => owner.get('pluginPackages'),
      async withModelKeyPeerUse() { throw new Error('M1 fixture is not a production Peer') },
      async withConfigurationPeer() { throw new Error('M1 fixture is not a production Peer') },
      async withIdleConfiguration() { throw new Error('No production idle authority in this native-only fixture') },
      scheduleRebuild() { throw new Error('No production terminal factory in this native-only fixture') },
    }, check)
    class Editor extends ConfigEditor {
      constructor(scope: Context) { super(scope); bindNativeConfigSaveHook(scope, barrier, this) }
    }
    Object.assign(owner.loader.builtins, { empty: { apply() {} }, editor: Editor, manager: control.provider })
    const importer = owner.loader.internal
    // Multiple native graphs in one test share this external module loader and its original import mock.
    if (importer !== undefined && !vi.isMockFunction(importer.import)) {
      const nativeModule = importer.import.bind(importer)
      vi.spyOn(importer, 'import').mockImplementation(async (name: string, parent: string, attributes: ImportAttributes) => {
        const result: unknown = name === fixed.moduleName ? Reminder : await nativeModule(name, parent, attributes)
        return result
      })
    }
    const nativeImport = owner.loader.import.bind(owner.loader)
    // Source-plane test loader supplies the unchanged real module namespace; all native config/disposal/save work is original.
    vi.spyOn(owner.loader, 'import').mockImplementation(async (name, stack) => {
      const result: unknown = name === fixed.moduleName ? Reminder : await nativeImport(name, stack)
      return result
    })
  })
  if (control === undefined) throw new Error('Original native preparation did not run')
  await control.restore()
  const target = [...ctx.loader.entries()].find(row => row.id === fixed.entryId)!
  const check = (): void => { ctx.fiber.assertActive() }
  const change = async (version: PluginEditVersion, operation: Parameters<AccountPluginControl['change']>[2]) => {
    expect((await barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
    const result = await barrier.withPausedPluginChange(() => control!.change(fixed.id, version, operation, check))
    barrier.resumeAccountChanges()
    return result
  }
  return { ctx, target, profile, barrier, control, check, change, saves,
    base: () => readFileSync(basePath, 'utf8'), patch: () => readFileSync(profile.patchPath, 'utf8') }
}

it('reads approved native entries without mutation controls alongside editable rows and refuses their writes', async () => {
  const f = await fixture(false, undefined, true), before = f.patch()
  expect(f.control.requests.current({ id: 'read-only-core' })).toEqual({ id: 'read-only-core' })
  const state = await f.control.current('read-only-core', f.check)
  expect(state).toMatchObject({ id: 'read-only-core', plugin: { moduleName: second.moduleName, enabled: true },
    operations: [], configuration: { fields: [] } })
  expect(state).not.toHaveProperty('maxImpact')
  expect(() => f.control.requests.change({ id: state.id, version: state.version, mode: 'if-idle',
    operation: { kind: 'enabled', enabled: false } })).toThrow(CloudApiError)
  expect(() => f.control.change(state.id, state.version, { kind: 'configure', path: ['limit'], value: 99 }, f.check))
    .toThrow(CloudApiError)
  expect(await f.control.current(fixed.id, f.check)).toMatchObject({ id: fixed.id, operations: ['enabled', 'configure'] })
  expect(f.patch()).toBe(before); expect(f.barrier.snapshot().failures).toEqual([])
})

it('configures, disables and re-enables the original base-only optional row while preserving base and unrelated native fibers', async () => {
  const f = await fixture(), before = f.base(), root = f.ctx.root
  const unchanged = [...f.ctx.loader.entries()].find(row => row.id === 'include:unchanged')!.fiber
  const initial = await f.control.current(fixed.id, f.check), first = f.target.fiber
  expect(initial.plugin).toMatchObject({ entryId: fixed.entryId, enabled: true, patchId: 'repeat-tool-reminder' })
  const configured = await f.change(initial.version, { kind: 'configure', path: ['thresholds'], value: [2, 4, 8] })
  expect(configured.published).toBe(true)
  if (!configured.published) throw configured.error
  expect(configured.value.value.configuration.fields[0]?.value).toEqual([2, 4, 8])
  expect(f.target.fiber).not.toBe(first); expect(first?.state).toBe(FiberState.DISPOSED)
  const disabled = await f.change(configured.value.value.version, { kind: 'enabled', enabled: false })
  if (!disabled.published) throw disabled.error
  expect(disabled.value.value.plugin?.enabled).toBe(false)
  expect(disabled.value.native).toMatchObject({ application: 'restart-required', restartReason: 'no-hmr' })
  const enabled = await f.change(disabled.value.value.version, { kind: 'enabled', enabled: true })
  if (!enabled.published) throw enabled.error
  expect(enabled.value.value.plugin?.enabled).toBe(true)
  expect(f.target.options.config).toEqual({ thresholds: [2, 4, 8] })
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.base()).toBe(before); expect(f.ctx.root).toBe(root)
  expect([...f.ctx.loader.entries()].find(row => row.id === 'include:unchanged')!.fiber).toBe(unchanged)
  expect(f.barrier.snapshot().failures).toEqual([])
})

it('configures and enables a never-active base-only disabled row through the actual native importer and schema', async () => {
  const f = await fixture(true), before = f.base()
  expect(f.target.fiber).toBeUndefined()
  const initial = await f.control.current(fixed.id, f.check)
  const configured = await f.change(initial.version, { kind: 'configure', path: ['thresholds'], value: [2, 4, 8] })
  if (!configured.published) throw configured.error
  expect(f.target.disabled).toBe(true); expect(f.target.fiber).toBeUndefined()
  const enabled = await f.change(configured.value.value.version, { kind: 'enabled', enabled: true })
  if (!enabled.published) throw enabled.error
  expect(f.target.moduleNamespace).toBe(await f.target.parent.tree.import(fixed.moduleName))
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.target.options.config).toEqual({ thresholds: [2, 4, 8] }); expect(f.base()).toBe(before)
})

it('rejects stale token, stale epoch and changed disk with zero native writes and no retained no-write failure', async () => {
  const f = await fixture(), initial = await f.control.current(fixed.id, f.check), before = f.patch(), fiber = f.target.fiber
  for (const version of [{ ...initial.version, editToken: brandString<typeof initial.version.editToken>('stale') },
    { ...initial.version, epoch: brandString<OwnerEpoch>('another-epoch') }]) {
    const result = await f.change(version, { kind: 'enabled', enabled: false })
    expect(result.published).toBe(false)
  }
  expect(f.patch()).toBe(before); expect(f.target.fiber).toBe(fiber)
  writeFileSync(f.profile.patchPath, before + '\n')
  const result = await f.change(initial.version, { kind: 'enabled', enabled: false })
  expect(result.published).toBe(false); expect(f.patch()).toBe(before + '\n')
  expect(f.target.fiber).toBe(fiber); expect(f.barrier.snapshot().failures).toEqual([])
})

it('keeps arbitrary manager bundle/package/version and enable writers closed outside the approved scope', async () => {
  const f = await fixture(), before = f.patch()
  await expect(f.ctx.pluginManager.setPluginEnabled(pluginEntryId(f.target.id), false)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.ctx.pluginManager.setBundleEnabled('unapproved', true)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.ctx.pluginManager.setVersionExemption('unapproved@1', '1', true, true)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.patch()).toBe(before); expect(f.barrier.snapshot().failures).toEqual([])
})

it('retains an unknown native publication in the original save owner and refuses reopening', async () => {
  const root = new ConfigSaveCoordinator(saveLimits), saves = root.createAccount(binding())
  const described = await saves.describePluginEdit(async () => ({ value: 'actual-metadata', revision: 'before' }), () => {})
  await saves.pauseAccountChanges(Date.now() + 1000)
  await expect(saves.withPausedPluginChange(() => saves.commitPluginEdit(described.version, () => 'before',
    async () => { throw new ConfigSaveOutcomeUnknown() }, () => {}))).rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
  expect(saves.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
  expect(() =>{  saves.resumeAccountChanges() }).toThrow(CloudApiError)
})

it.each([
  { id: '' }, { id: fixed.id, install: 'npm' },
  { id: fixed.id, version: { epoch: 'e', editToken: 't' }, mode: 'if-idle', operation: { kind: 'enabled', enabled: true, module: 'other' } },
  { id: fixed.id, version: { epoch: 'e', editToken: 't' }, mode: 'if-idle', operation: { kind: 'configure', thresholds: [2, 4, 8] } },
  { id: fixed.id, version: { epoch: 'e', editToken: 't', revision: 'caller-hash' }, mode: 'if-idle', operation: { kind: 'enabled', enabled: true } },
])('rejects original carrier extra/unapproved fields before any native owner', (request) => {
  const parse = pluginRequests(limits)
  expect(() => Object.hasOwn(request, 'version') ? parse.change(request) : parse.current(request)).toThrow()
})

it('admits exact catalog controls as immutable data in the original Root catalog and requires its full authenticated unary exposure', async () => {
  const { parseApprovedConfigurationCatalog } = await import('../src/approved-catalog.ts')
  const { ExposureService } = await import('../src/root.ts')
  const input = { recipeVersion: 'plugin-policy', catalogVersion: 'fixed-optional-one', maxEntries: 16,
    maxStringBytes: 256, maxCatalogBytes: 8192, plugins: [{ ...fixed, installable: false, toggleable: true }],
    pluginControl: limits, fields: [], skills: { mode: 'closed' }, credentials: { mode: 'read-only' } }
  const approved = parseApprovedConfigurationCatalog(input, 'plugin-policy', true)
  expect(approved?.plugins[0]?.toggleable).toBe(true)
  expect(Object.isFrozen(approved?.pluginControl)).toBe(true)
  for (const changed of [{ ...input, pluginControl: undefined }, { ...input, plugins: [{ ...input.plugins[0], installable: true }] },
    { ...input, plugins: [{ ...input.plugins[0], moduleName: '@deepseek-ai/dsh-client-locale' }] },
    { ...input, plugins: [{ ...input.plugins[0], packageVersion: 'another-version' }] },
    { ...input, pluginControl: { ...limits, maxProfileBytes: 0 } }]) {
    expect(() => parseApprovedConfigurationCatalog(changed, 'plugin-policy', true)).toThrow()
  }
  const { Context } = await import('@deepseek-ai/cordis'), ctx = new Context()
  const policy = { recipeVersion: 'plugin-policy', approvedConfiguration: input, allowedSettings: [], exactFetchRoutes: [], streamEndpoints: [],
    rpcEndpoints: ['cloudPlugins/current', 'cloudPlugins/change'].map(endpoint => ({ endpoint, handlerId: 'native:cloudPlugins', guard: 'authenticated-account' as const })) }
  try {
    expect(() => new ExposureService(ctx, ExposureService.Config({ ...policy, rpcEndpoints: policy.rpcEndpoints.slice(1) }))).toThrow()
    expect(() => new ExposureService(ctx, ExposureService.Config({ ...policy,
      streamEndpoints: policy.rpcEndpoints.slice(0, 1) }))).toThrow()
    expect(() => new ExposureService(ctx, ExposureService.Config({ ...policy,
      rpcEndpoints: [...policy.rpcEndpoints, { endpoint: 'pluginManager/installPlugin',
        handlerId: 'native:pluginManager', guard: 'authenticated-account' as const }] }))).toThrow()
    const installed = new ExposureService(ctx, ExposureService.Config(policy))
    expect(installed.approvedConfiguration?.plugins[0]?.id).toBe(fixed.id)
    expect(() => installed.policy.requireRpc('cloudPlugins/current')).toThrow() // Policy metadata does not publish an account.
  } finally { await ctx.fiber.dispose() }
})

it('commits the checked intent on its original stopped native graph before that graph is disposed', async () => {
  const f = await fixture(), root = f.ctx.root, original = f.target.fiber, base = f.base()
  const initial = await f.control.current(fixed.id, f.check)
  await f.barrier.pauseAccountChanges(Date.now() + 1000)
  const prepared = await f.barrier.withPausedPluginChange(() =>
    f.control.prepareRebuild(fixed.id, initial.version, { kind: 'configure', path: ['thresholds'], value: [2, 4, 8] }, f.check))
  if (!prepared.accepted) throw prepared.error
  expect(await f.barrier.stopConfigSaves(Date.now() + 1000)).toMatchObject({ status: 'confirmed', admission: 'stopped' })
  await f.saves.commitStoppedConfiguration(f.barrier, () => f.control.applyRebuild(prepared.intent, f.check))
  expect(f.ctx.root).toBe(root); root.fiber.assertActive()
  expect(f.base()).toBe(base); expect(f.patch()).toContain('thresholds:')
  expect(f.target.options.config).toEqual({ thresholds: [2, 4, 8] })
  expect(original?.state).toBe(FiberState.DISPOSED)
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.barrier.snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
  expect(() => { f.barrier.resumeAccountChanges() }).toThrow(CloudApiError)
  expect(() => f.barrier.admit('config-editor', async () => {})).toThrow(CloudApiError)
})

it('uses the same original control for a second module with a different native Config field by adding catalog data only', async () => {
  const f = await fixture(), before = f.patch(), first = f.target.fiber
  const current = await f.control.current(second.id, f.check)
  expect(current.configuration.fields).toMatchObject([{ path: ['limit'], value: 10 }])
  expect(JSON.stringify(current.configuration.fields[0]?.schema)).toContain('minimum')
  expect((await f.barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
  const result = await f.barrier.withPausedPluginChange(() => f.control.change(second.id, current.version,
    { kind: 'configure', path: ['limit'], value: 12 }, f.check)).catch((error: unknown) => {
    // Preserve the actual native refusal while proving the persisted/runtime/save-owner disposition of this blocker.
    expect(f.patch()).toContain('limit: 12')
    expect([...f.ctx.loader.entries()].find(row => row.id === second.entryId)?.fiber?.state).toBe(FiberState.ACTIVE)
    expect(f.barrier.snapshot().failures).toMatchObject([{ outcome: 'unknown' }])
    throw error
  })
  f.barrier.resumeAccountChanges()
  if (!result.published) throw result.error
  expect(result.value.value.configuration.fields[0]?.value).toBe(12)
  expect(f.target.fiber).toBe(first)
  expect(f.patch()).not.toBe(before)
  expect(f.barrier.snapshot().failures).toEqual([])
})

it('rejects an unapproved id, ordinary path, expression, invalid native value and manifest CAS with zero writes', async () => {
  const f = await fixture(), before = f.patch(), fiber = f.target.fiber
  await expect(f.control.current('unapproved', f.check)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  const initial = await f.control.current(fixed.id, f.check)
  expect(() => f.control.change(fixed.id, initial.version, { kind: 'configure', path: ['include'], value: [] }, f.check))
    .toThrow(CloudApiError)
  expect(() => pluginRequests(limits).change({ id: fixed.id, version: initial.version, mode: 'if-idle',
    operation: { kind: 'configure', path: ['thresholds'], value: { __jsExpr: 'process.exit()' } } })).toThrow(CloudApiError)
  const invalid = await f.change(initial.version, { kind: 'configure', path: ['thresholds'], value: ['invalid'] })
  expect(invalid.published).toBe(false)
  expect(f.patch()).toBe(before); expect(f.target.fiber).toBe(fiber)
  const next = await f.control.current(fixed.id, f.check)
  writeFileSync(join(f.profile.dir, 'package.json'), readFileSync(join(f.profile.dir, 'package.json'), 'utf8') + '\n')
  expect((await f.change(next.version, { kind: 'enabled', enabled: false })).published).toBe(false)
  expect(f.patch()).toBe(before); expect(f.target.fiber).toBe(fiber)
  expect(f.barrier.snapshot().failures).toEqual([])
})

const protectedFixture = {
  schema: `z.object({
    scalar: z.string().role('secret').default('secret-default-scalar'),
    ancestor: z.object({ child: z.string().default('secret-default-ancestor') }).role('secret'),
    object: z.object({ label: z.string(), token: z.string().role('secret').default('secret-default-child') })
      .default({ label: 'default', token: 'secret-default-object' }),
    rows: z.array(z.object({ label: z.string(), token: z.string().role('secret').default('secret-default-row') }))
      .default([{ label: 'default', token: 'secret-default-array' }]),
    dictionary: z.dict(z.object({ token: z.string().role('secret') })).default({ first: { token: 'secret-default-dict' } }),
    secretKey: z.dict(z.string(), z.string().role('secret')).default({ 'secret-default-key': 'public' }),
    tuple: z.tuple([z.string(), z.string().role('secret')]).default(['public', 'secret-default-tuple']),
    union: z.union([z.object({ token: z.string().role('secret') }), z.object({ token: z.string() })])
      .default({ token: 'secret-default-union' }),
    empty: z.array(z.string().role('secret')),
    ordinary: z.object({ label: z.string(), values: z.array(z.number()), ref: z.string().role('credential-ref') }),
  })`,
  config: { scalar: 'secret-value-scalar', ancestor: { child: 'secret-value-ancestor' },
    object: { label: 'public', token: 'secret-value-object' }, rows: [{ label: 'public', token: 'secret-value-array' }],
    dictionary: { first: { token: 'secret-value-dict' } }, secretKey: { 'secret-value-key': 'public' }, tuple: ['public', 'secret-value-tuple'],
    union: { token: 'secret-value-union' }, empty: [], ordinary: { label: 'old', values: [1], ref: 'public-ref' } },
  fields: ['scalar', 'object', 'rows', 'dictionary', 'secretKey', 'tuple', 'union', 'empty', 'ordinary'].map(key => [key]).concat([['ancestor', 'child']]),
}

it('redacts real ESM secret values and all container defaults while keeping ordinary object replacement available', async () => {
  const f = await fixture(false, protectedFixture), current = await f.control.current(second.id, f.check)
  const wire = JSON.stringify(current)
  expect(wire).not.toContain('secret-value-'); expect(wire).not.toContain('secret-default-')
  const fields = current.configuration.fields
  expect(fields.find(field => field.path[0] === 'scalar')).toMatchObject({ schema: {}, writable: false,
    readOnlyReason: 'secret', secrets: [{ path: [], set: true }] })
  expect(fields.find(field => field.path[0] === 'ancestor')?.value).toBeUndefined()
  expect(fields.find(field => field.path[0] === 'rows')).toMatchObject({ writable: false, secrets: [{ path: ['0', 'token'], set: true }] })
  expect(fields.find(field => field.path[0] === 'tuple')).toMatchObject({ secrets: [{ path: ['1'], set: true }] })
  expect(fields.find(field => field.path[0] === 'tuple')?.value).toBeUndefined()
  expect(fields.find(field => field.path[0] === 'union')?.value).toBeUndefined()
  expect(fields.find(field => field.path[0] === 'empty')).toMatchObject({ writable: false, readOnlyReason: 'protected' })
  const ordinary = { label: 'new', values: [2, 3], ref: 'new-public-ref' }
  expect(fields.find(field => field.path[0] === 'ordinary')?.writable).toBe(true)
  expect((await f.barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
  const changed = await f.barrier.withPausedPluginChange(() => f.control.change(second.id, current.version,
    { kind: 'configure', path: ['ordinary'], value: ordinary }, f.check))
  f.barrier.resumeAccountChanges()
  if (!changed.published) throw changed.error
  expect(changed.value.value.configuration.fields.find(field => field.path[0] === 'ordinary')?.value).toEqual(ordinary)
  const entry = [...f.ctx.loader.entries()].find(row => row.id === second.entryId)!
  expect(entry.options.config).toMatchObject({ scalar: 'secret-value-scalar', object: { token: 'secret-value-object' }, ordinary })
  expect(f.barrier.snapshot().failures).toEqual([])
})

it('refuses protected complete-leaf writes before native publication or terminal acceptance without retaining a failed save', async () => {
  const f = await fixture(false, protectedFixture), before = f.patch()
  const entry = [...f.ctx.loader.entries()].find(row => row.id === second.entryId)!, fiber = entry.fiber
  for (const path of protectedFixture.fields.filter(path => path[0] !== 'ordinary')) {
    const current = await f.control.current(second.id, f.check), operation = { kind: 'configure' as const, path, value: {} }
    expect(await f.control.prepareRebuild(second.id, current.version, operation, f.check)).toMatchObject({ accepted: false, error: { code: 'cloud/forbidden' } })
    expect((await f.barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
    const result = await f.barrier.withPausedPluginChange(() => f.control.change(second.id, current.version, operation, f.check))
    expect(result).toMatchObject({ published: false, error: { code: 'cloud/forbidden' } })
    f.barrier.resumeAccountChanges()
    expect(f.patch()).toBe(before); expect(entry.fiber).toBe(fiber)
    expect(f.barrier.snapshot().failures).toEqual([])
  }
})

it('keeps mixed ordinary/live containers read-only and permits an approved ordinary child without modifying the live sibling', async () => {
  const schema = 'z.object({ mixed: z.object({ ordinary: z.number().default(1), live: z.number().default(2).volatile() }) })'
  for (const fields of [[['mixed']], [['mixed', 'ordinary']]]) {
    const f = await fixture(false, { schema, config: { mixed: { ordinary: 1, live: 2 } }, fields })
    const initial = await f.control.current(second.id, f.check), field = initial.configuration.fields[0]!
    const broad = fields[0]!.length === 1, before = f.patch()
    expect(field.writable).toBe(!broad)
    if (broad) { expect(field.value).toBeUndefined(); expect(field.schema).toEqual({}) }
    const operation = broad ? { kind: 'configure' as const, path: ['mixed'], value: { ordinary: 3, live: 99 } }
      : { kind: 'configure' as const, path: ['mixed', 'ordinary'], value: 3 }
    const terminal = await f.control.prepareRebuild(second.id, initial.version, operation, f.check)
    expect(terminal.accepted).toBe(!broad)
    expect((await f.barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
    const result = await f.barrier.withPausedPluginChange(() => f.control.change(second.id, initial.version, operation, f.check))
    f.barrier.resumeAccountChanges()
    expect(result.published).toBe(!broad)
    if (broad) expect(f.patch()).toBe(before)
    expect([...f.ctx.loader.entries()].find(row => row.id === second.entryId)!.options.config)
      .toEqual({ mixed: { ordinary: broad ? 1 : 3, live: 2 } })
    expect(f.barrier.snapshot().failures).toEqual([])
  }
})

it('never serializes defaults from omitted protected raw fields of a never-active real ESM row', async () => {
  const f = await fixture(false, { ...protectedFixture, config: {}, disabled: true })
  const current = await f.control.current(second.id, f.check)
  expect(JSON.stringify(current)).not.toContain('secret-default-')
  expect(current.configuration.fields.find(field => field.path[0] === 'scalar')).toMatchObject({ secrets: [{ path: [], set: false }] })
  expect([...f.ctx.loader.entries()].find(row => row.id === second.entryId)!.fiber).toBeUndefined()
})

it('keeps malformed protected raw containers and secret constants opaque for a disabled real ESM entry', async () => {
  const f = await fixture(false, { schema: `z.object({
    protected: z.object({ token: z.string().role('secret') }),
    rows: z.array(z.string().role('secret')),
    constant: z.const('secret-constant-value').role('secret'),
  })`, config: { protected: 'secret-malformed-object', rows: 'secret-malformed-array', constant: 'secret-constant-value' },
  fields: [['protected'], ['rows'], ['constant']], disabled: true })
  const current = await f.control.current(second.id, f.check)
  expect(JSON.stringify(current)).not.toContain('secret-malformed-')
  expect(JSON.stringify(current)).not.toContain('secret-constant-value')
  expect(current.configuration.fields.every(field => field.value === undefined && !field.writable)).toBe(true)
})

it('preserves secret and live siblings from omitted or null object defaults when editing an approved ordinary child', async () => {
  const child = `z.object({ ordinary: z.number(), token: z.string().role('secret'), live: z.number().volatile() })
    .default({ ordinary: 1, token: 'protected-ancestor-default', live: 2 })`
  const cases = [
    { schema: `z.object({ mixed: ${child} })`, config: {}, path: ['mixed', 'ordinary'], root: false },
    { schema: `z.object({ mixed: ${child} })`, config: { mixed: null }, path: ['mixed', 'ordinary'], root: false },
    { schema: child, config: null, path: ['ordinary'], root: true },
  ]
  for (const row of cases) {
    const f = await fixture(false, { schema: row.schema, config: row.config, fields: [row.path] })
    const initial = await f.control.current(second.id, f.check)
    expect(initial.configuration.fields[0]?.writable).toBe(true)
    expect(JSON.stringify(initial)).not.toContain('protected-ancestor-default')
    expect((await f.barrier.pauseAccountChanges(Date.now() + 1000)).status).toBe('confirmed')
    const changed = await f.barrier.withPausedPluginChange(() => f.control.change(second.id, initial.version,
      { kind: 'configure', path: row.path, value: 3 }, f.check))
    f.barrier.resumeAccountChanges()
    if (!changed.published) throw changed.error
    const raw: unknown = [...f.ctx.loader.entries()].find(entry => entry.id === second.entryId)!.options.config
    expect(row.root ? raw : (raw as { mixed: unknown }).mixed).toEqual({ ordinary: 3, token: 'protected-ancestor-default', live: 2 })
    expect(f.barrier.snapshot().failures).toEqual([])
  }
})
