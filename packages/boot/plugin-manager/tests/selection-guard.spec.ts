/** Original profile/Include/Loader proof for the common guarded selection writer; no package installer is used. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { pluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import PluginManager from '../src/index.ts'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-selection-'))), dir = join(home, 'profile')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"native-selection","dependencies":{}}\n')
  initProfile(dir, [])
  const profile: ProfileContext = { name: 'native-selection', dir, home, cwd: home, installAnchor: anchor,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  writeFileSync(join(dir, 'cordis.yml'), JSON.stringify([
    { id: 'manager', name: 'cordis:manager' }, { id: 'leaf', name: 'cordis:leaf', config: { count: 1 } },
  ]))
  writeFileSync(profile.patchPath, '[]\n')
  const bundle = (name: string, patches: unknown[]) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
    writeFileSync(join(path, 'patch.yml'), JSON.stringify(patches))
  }
  bundle('switch', [{ id: 'leaf', disabled: true }])
  bundle('insert', [{ insert: [{ id: 'new', name: 'cordis:leaf' }] }])
  let mounted: Context | undefined
  onTestFinished(async () => { try { await mounted?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) } })
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), (owner) => {
    mounted = owner
    owner.provide('profileContext', profile)
    Object.assign(owner.loader.builtins, { manager: PluginManager,
      leaf: { name: 'leaf', Config: z.object({ count: z.number().default(1) }), apply() {} } })
  })
  const leaf = [...ctx.loader.entries()].find(entry => entry.id === 'include:leaf')!
  return { ctx, leaf, profile, manager: ctx.pluginManager,
    manifest: () => readFileSync(join(dir, 'package.json'), 'utf8'), patch: () => readFileSync(profile.patchPath, 'utf8') }
}

it('guards bundle and entry selection in the same native writer while retaining the native no-HMR receipt', async () => {
  const f = await fixture(), first = f.leaf.fiber, checks: string[] = []
  f.manager.registerSelectionGuard({ maxRegistryEntries: 32, assertCurrent() { f.ctx.fiber.assertActive() },
    check(plan, target) { expect(plan.impact).toBe('remount'); checks.push(target.kind) } })
  const selected = await f.manager.setBundleEnabled('switch', true)
  expect(selected).toMatchObject({ changed: true, application: 'restart-required', restartReason: 'no-hmr' })
  expect(f.leaf.disabled).toBe(true); expect(first?.state).toBe(FiberState.DISPOSED)
  const enabled = await f.manager.setPluginEnabled(pluginEntryId(f.leaf.id), true)
  expect(enabled).toMatchObject({ application: 'restart-required', restartReason: 'no-hmr' })
  expect(f.leaf.disabled).toBe(false); expect(f.leaf.fiber?.state).toBe(FiberState.ACTIVE)
  expect(checks).toEqual(['bundle', 'entry'])
})

it('rejects policy refusal and structural bundle insertion before either original file or fiber changes', async () => {
  const f = await fixture(), before = f.manifest(), patch = f.patch(), fiber = f.leaf.fiber
  f.manager.registerSelectionGuard({ maxRegistryEntries: 32, assertCurrent() {}, check() { throw new Error('policy refused') } })
  for (const name of ['switch', 'insert']) {
    const result = await f.manager.setBundleEnabled(name, true)
    expect(result).toMatchObject({ changed: false, application: 'failed' })
    expect(f.manager.changeFailureOutcome(result)).toBe('not-published')
    expect(f.manifest()).toBe(before); expect(f.patch()).toBe(patch); expect(f.leaf.fiber).toBe(fiber)
  }
})

it('preserves the original unguarded no-HMR persistence behavior', async () => {
  const f = await fixture(), first = f.leaf.fiber
  expect(await f.manager.setBundleEnabled('switch', true)).toMatchObject({ changed: true,
    application: 'restart-required', restartReason: 'no-hmr' })
  expect(f.leaf.fiber).toBe(first); expect(f.leaf.disabled).toBe(false)
})

it('keeps native patch inspection free of retired-bundle cleanup writes', async () => {
  const f = await fixture(), manifest = JSON.parse(f.manifest()) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-schedule-bundle')
  writeFileSync(join(f.profile.dir, 'package.json'), JSON.stringify(manifest))
  const before = f.manifest()
  expect(readProfilePatches('dsh', f.profile)).toEqual([])
  await f.manager.listPlugins()
  expect(f.manifest()).toBe(before)
})


it('rejects proposed bundle-layer drift after the graph guard and before the original manifest write', async () => {
  const f = await fixture(), before = f.manifest(), fiber = f.leaf.fiber
  f.manager.registerSelectionGuard({ maxRegistryEntries: 32, application: () => 'restart', assertCurrent() {},
    check(plan) {
      expect(plan.impact).toBe('graph')
      writeFileSync(join(f.profile.dir, 'node_modules', 'insert', 'patch.yml'),
        JSON.stringify([{ insert: [{ id: 'drifted', name: 'cordis:leaf' }] }]))
    } })
  const result = await f.manager.setBundleEnabled('insert', true)
  expect(result).toMatchObject({ changed: false, application: 'failed' })
  expect(f.manager.changeFailureOutcome(result)).toBe('not-published')
  expect(f.manifest()).toBe(before)
  expect(f.leaf.fiber).toBe(fiber)
  expect([...f.ctx.loader.entries()].some(entry => entry.id.endsWith(':drifted'))).toBe(false)
})
