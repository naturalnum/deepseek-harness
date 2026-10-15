/** Native management RPC enforces deployment availability before changing the owned Profile. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages,
  readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import * as packageOperations from '@deepseek-ai/dsh-plugin-manager/operations'

const developerTools = '@deepseek-ai/dsh-experimental-inspector-profile'
const inspector = '@deepseek-ai/dsh-experimental-inspector'
const sessionInspector = '@deepseek-ai/dsh-experimental-session-inspector'
const groups = [
  [developerTools, [inspector, sessionInspector]],
  ['@deepseek-ai/dsh-experimental-agent-team-profile', ['@deepseek-ai/dsh-experimental-agent-team',
    '@deepseek-ai/dsh-experimental-tool-agent-team', '@deepseek-ai/dsh-experimental-client-ui-agent-team']],
  ['@deepseek-ai/dsh-experimental-auto-review', ['@deepseek-ai/dsh-experimental-auto-review']],
  ['@deepseek-ai/dsh-experimental-voice-input-bundle', ['@deepseek-ai/dsh-experimental-speech-to-text',
    '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice', '@deepseek-ai/dsh-experimental-api-speech-to-text',
    '@deepseek-ai/dsh-experimental-client-ui-voice-input']],
] as const
const aliases = new Map<string, string>(groups.map(([name], index) => [name, `owned-optional-${index}`]))
const patches = z.array(z.object({ id: z.string().optional(), config: z.unknown().optional() }).loose())
const reply = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() })
const change = z.object({ application: z.string(), changed: z.boolean(), error: z.object({ code: z.string() }).optional() }).loose()

test('cloud native RPC refuses unavailable bundles, rows and install activation without changing Profile or Settings revisions', async (lifecycle) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-plugin-availability-'))
  let owner: Context | undefined
  lifecycle.onTestFinished(async () => { await owner?.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const dir = join(root, 'profile'), anchor = join(root, 'package.json')
  const yamlSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: (value: unknown): unknown => value,
  })])
  const patch = patches.parse(load(await readFile(new URL('../../native-runtime/cordis.patch.yml', import.meta.url), 'utf8'), { schema: yamlSchema }))
  const config = PluginManager.Config(patch.find(row => row.id === 'plugin-manager')?.config)
  expect(config.unavailablePackages).toEqual(expect.arrayContaining(groups.flatMap(([name, modules]) => [name, ...modules])))
  expect(config.unavailablePackages).toHaveLength(13)
  initProfile(dir, ['core', ...aliases.values()])
  await writeFile(anchor, JSON.stringify({ name: 'owned-installation', dependencies: {} }))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const bundle = async (name: string, entries: object[]) => {
    const directory = join(dir, 'node_modules', aliases.get(name) ?? name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './plugin.mjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]))
    await writeFile(join(directory, 'plugin.mjs'), 'export function apply() {}\n')
  }
  const core = (unavailablePackages: readonly string[]) => [
    { id: 'plugin-manager', name: 'cordis:manager', config: { ...config, unavailablePackages } },
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'settings-controller', name: 'cordis:settingsController' },
    { id: 'typert', name: 'cordis:typert' }, { id: 'gateway', name: 'cordis:gateway' },
    { id: 'retained', name: 'cordis:retained' },
  ]
  await bundle('core', core([]))
  for (const [name, modules] of groups) {
    for (const module of modules) {
      const directory = join(dir, 'node_modules', module)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: module, version: '1.0.0',
        type: 'module', exports: './plugin.mjs' }))
      await writeFile(join(directory, 'plugin.mjs'), 'export function apply() {}\n')
    }
    await bundle(name, modules.map(module => ({ id: module.split('/').at(-1), name: module, disabled: true })))
    if (name.includes('agent-team-profile')) {
      await writeFile(join(dir, 'node_modules', aliases.get(name)!, 'cordis.patch.yml'), JSON.stringify([
        { id: 'retained', disabled: true }, { insert: modules.map(module => ({ id: module.split('/').at(-1), name: module, disabled: true })) },
      ]))
    }
  }
  await bundle('supported', [])
  const packageFile = join(dir, 'package.json')
  const manifest = readProfileManifest('owned', dir)
  manifest.dependencies = { supported: '1.0.0', ...Object.fromEntries([...aliases.values()].map(name => [name, '1.0.0'] as const)) }
  await writeFile(packageFile, JSON.stringify(manifest))
  const profile: ProfileContext = { name: 'owned', dir, home: root, cwd: root, installAnchor: anchor,
    patchPath: join(dir, 'cordis.patch.yml'), overlays: [], telemetryDisabledEnv: undefined,
    startedBundles: loadProfileDirectory('owned', dir, anchor).layers.map(layer => layer.packageName) }
  const open = async () => {
    const resolution = await createRuntimeResolution({ installAnchor: anchor,
      profile: loadProfileDirectory('owned', dir, anchor), home: root })
    return boot('owned', join(dir, 'cordis.yml'), readProfilePatches('owned', profile), async (ctx) => {
      owner = ctx
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { manager: PluginManager, editor: ConfigEditor, settings: Settings,
        settingsController: SettingsController, typert: TypertRegistry, gateway: Gateway,
        retained: { apply(ctx: Context) { ctx.provide('ownedRetained', true) } } })
      await ctx.plugin(PluginPackages, { resolution })
    })
  }
  const previous = await open()
  const oldRows = (await previous.pluginManager.listPlugins()).filter(row => config.unavailablePackages?.includes(row.moduleName))
  expect(oldRows).toHaveLength(10)
  expect(previous.get('ownedRetained')).toBeUndefined()
  await previous.fiber.dispose()
  for (const [, modules] of groups) for (const module of modules) await rm(join(dir, 'node_modules', module, 'plugin.mjs'))
  await bundle('core', core(config.unavailablePackages ?? []))
  const userBytes = await readFile(packageFile)
  const userPatch = await readFile(profile.patchPath)
  const ctx = await open()
  expect(ctx.get('ownedRetained')).toBe(true)
  expect([...ctx.loader.entries()].filter(row => config.unavailablePackages?.includes(row.options.name))).toHaveLength(0)
  expect(await readFile(packageFile)).toEqual(userBytes)
  expect(await readFile(profile.patchPath)).toEqual(userPatch)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  const rpc = async (method: string, args: object) => reply.parse(
    await ctx.typertGateway.wireRpc.invoke(method, { args }, undefined, new AbortController().signal))
  const state = async () => {
    const files: Record<string, string> = {}
    for (const name of await readdir(dir)) if (!['node_modules', 'logs'].includes(name)) {
      try { files[name] = (await readFile(join(dir, name))).toString('base64') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EISDIR')) throw error }
    }
    return { files, settings: ctx.settings.describe() }
  }
  const baseline = await state()
  const bundles = await ctx.pluginManager.listBundles()
  expect(bundles.find(row => row.name === aliases.get(developerTools))).toMatchObject({ enabled: true, enableError: { code: 'runtime-unavailable' },
    rows: [{ enableError: { code: 'runtime-unavailable' } }, { enableError: { code: 'runtime-unavailable' } }] })
  for (const [name] of groups) {
    const denied = change.parse((await rpc('pluginManager/setBundleEnabled', { name, enabled: true })).value)
    expect(denied).toMatchObject({ changed: false, application: 'failed', error: { code: 'runtime-unavailable' } })
    expect(await state()).toEqual(baseline)
  }
  for (const row of oldRows) {
    expect(change.parse((await rpc('pluginManager/setPluginEnabled', { id: row.entryId, enabled: true })).value))
      .toMatchObject({ changed: false, application: 'failed', error: { code: 'unknown-plugin' } })
    expect(await state()).toEqual(baseline)
  }
  const registry = vi.spyOn(packageOperations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  let importedModule: string = inspector
  let importedName = 'owned-import'
  const install = vi.spyOn(packageOperations, 'runProfilePnpm').mockImplementation(async () => {
    await bundle('owned-import', importedName === 'owned-import' ? [{ id: 'imported-row', name: importedModule + '/client' }] : [])
    if (importedName !== 'owned-import') {
      const path = join(dir, 'node_modules', 'owned-import', 'package.json')
      const installed = readProfileManifest('owned', join(dir, 'node_modules', 'owned-import'))
      installed.name = importedName
      await writeFile(path, JSON.stringify(installed))
    }
    const next = readProfileManifest('owned', dir)
    next.dependencies = { ...next.dependencies, 'owned-import': 'file:./owned-import' }
    await writeFile(packageFile, JSON.stringify(next))
    return { exitCode: 0, output: '', truncated: false, logPath: join(root, 'owned-pnpm.log') }
  })
  try {
    for (const [name, modules] of groups) for (const alias of [false, true]) {
      importedModule = modules[0]
      importedName = alias ? name : 'owned-import'
      expect(change.parse((await rpc('pluginManager/installBundle', { spec: 'file:./owned-import' })).value))
        .toMatchObject({ changed: false, application: 'failed', error: { code: 'runtime-unavailable' } })
      expect(await state()).toEqual(baseline)
    }
  } finally { install.mockRestore(); registry.mockRestore() }
  for (const [method, args] of [
    ['settings/update', { ns: 'plugin-manager', patch: { unavailablePackages: [] } }],
    ['settings/replace', { ns: 'plugin-manager', section: { unavailablePackages: [] } }],
    ['settings/mutate', { ns: 'plugin-manager', ops: [{ op: 'set', path: ['unavailablePackages'], value: [] }] }],
  ] as const) {
    expect(await rpc(method, args)).toMatchObject({ ok: false, error: { code: 'settings/rejected' } })
    expect(await state()).toEqual(baseline)
  }
  expect(change.parse((await rpc('pluginManager/setBundleEnabled', { name: aliases.get(developerTools), enabled: false })).value))
    .toMatchObject({ changed: true, application: 'applied' })
  expect(change.parse((await rpc('pluginManager/setBundleEnabled', { name: 'supported', enabled: true })).value))
    .toMatchObject({ changed: true, application: 'applied' })
  expect(change.parse((await rpc('pluginManager/setBundleEnabled', { name: 'supported', enabled: false })).value))
    .toMatchObject({ changed: true, application: 'applied' })
  expect(ctx.get('ownedRetained')).toBe(true)
  expect([...ctx.loader.entries()].filter(row => config.unavailablePackages?.includes(row.options.name))).toHaveLength(0)
  const afterReload = await ctx.pluginManager.listBundles()
  for (const [name] of groups.filter(([name]) => name !== developerTools)) {
    expect(afterReload.find(row => row.name === aliases.get(name)))
      .toMatchObject({ enabled: true, enableError: { code: 'runtime-unavailable' } })
  }
})
