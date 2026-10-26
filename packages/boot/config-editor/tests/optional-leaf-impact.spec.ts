/** Actual native preflight/manager rejection points; no cloud mutation capability is granted. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import {
  assertProfileConfigUpdate, boot, initProfile, prepareProfileConfigUpdate, prepareProfilePluginUpdate,
  reconcileProfilePatches, withProfileConfigUpdate, readProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import * as Reminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import { expect, it, onTestFinished } from 'vitest'

function nativeValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The actual native fixture value is missing')
  return value
}

async function fixture(enabled = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-prerequisites-')))
  const dir = join(home, 'profile')
  mkdirSync(dir)
  writeFileSync(join(home, 'package.json'), '{"name":"owned-plugin-prerequisites","dependencies":{}}\n')
  initProfile(dir, [])
  const profile: ProfileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const base = Array.from({ length: 5 }, (_, i) => ({ id: `base-${i}`, name: 'cordis:empty' }))
  writeFileSync(join(dir, 'cordis.yml'), JSON.stringify(base) + '\n')
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:editor' }, { id: 'manager', name: 'cordis:manager' },
    { id: 'repeat-tool-reminder', name: 'cordis:reminder', config: { thresholds: [3, 5, 8] }, ...enabled ? {} : { disabled: true } },
  ] }]) + '\n')
  let ctx: Context | undefined = undefined
  onTestFinished(async () => {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), (owner) => {
    owner.provide('profileContext', profile)
    Object.assign(owner.loader.builtins, {
      empty: { apply() {} }, editor: ConfigEditor, manager: PluginManager, reminder: Reminder,
    })
  })
  const target = nativeValue([...ctx.loader.entries()].find(entry => entry.options.id === 'repeat-tool-reminder'))
  if (enabled) {
    expect(target.moduleNamespace).toBe(Reminder)
    expect(target.fiber?.state).toBe(FiberState.ACTIVE)
  } else expect(target.fiber).toBeUndefined()
  const patch = () => readFileSync(profile.patchPath, 'utf8')
  return { ctx, target, profile, patch }
}

it('refuses the actual ordinary reminder config before writing because native remount has no stop closure', async () => {
  const f = await fixture()
  const before = f.patch(), fiber = f.target.fiber
  let actualImpact: string | undefined, actualStops: readonly unknown[] | undefined
  onTestFinished(f.ctx.configEditor.registerImpactGuard({ check(plan) {
    actualImpact = plan.impact
    actualStops = plan.entries.find(row => row.entry === f.target)?.stopped
    assertProfileConfigUpdate(plan)
  } }))
  const error: unknown = await f.ctx.configEditor.edit(f.target, raw => ({ ...raw, thresholds: [2, 4] }))
    .catch((cause: unknown) => cause)
  expect(actualImpact).toBe('remount')
  expect(actualStops).toBeUndefined()
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain('Profile config impact is unproven')
  expect(f.ctx.configEditor.editFailureOutcome(error)).toBe('not-published')
  expect(f.patch()).toBe(before)
  expect(f.target.fiber).toBe(fiber)
  expect(fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.target.options.config).toEqual({ thresholds: [3, 5, 8] })
})

it('refuses the actual disabled option during native preparation before any persistence or stop', async () => {
  const f = await fixture()
  const before = f.patch(), fiber = f.target.fiber
  const patches = readProfilePatches('dsh', f.profile)
  expect(() => prepareProfileConfigUpdate(f.ctx, f.target, patches,
    [...patches, { id: 'repeat-tool-reminder', disabled: true }])).toThrow('unproven structural change')
  expect(f.patch()).toBe(before)
  expect(f.target.fiber).toBe(fiber)
  expect(fiber?.state).toBe(FiberState.ACTIVE)
})

it('preserves the native no-HMR restart outcome instead of treating a saved selection as applied', async () => {
  const f = await fixture()
  const before = f.patch(), fiber = f.target.fiber
  const row = nativeValue((await f.ctx.pluginManager.listPlugins()).find(item => item.patchId === 'repeat-tool-reminder'))
  expect(row.readOnlyReason).toBeUndefined()
  const value = await f.ctx.pluginManager.setPluginEnabled(row.entryId, false)
  expect(value).toMatchObject({ changed: true, application: 'restart-required', restartReason: 'no-hmr',
    stage: 'enable', target: row.entryId, enabled: false })
  expect(f.patch()).not.toBe(before)
  expect(f.target.fiber).toBe(fiber)
  expect(fiber?.state).toBe(FiberState.ACTIVE)
})

it('keeps all native manager writers closed before their profile lock when no reviewed update owner exists', async () => {
  const f = await fixture()
  const before = f.patch(), fiber = f.target.fiber
  const row = nativeValue((await f.ctx.pluginManager.listPlugins()).find(item => item.patchId === 'repeat-tool-reminder'))
  const missingOwner = Object.freeze(new Error('Required native remount plan and runtime idle owner are absent'))
  let submissions = 0
  onTestFinished(f.ctx.pluginManager.registerSaveHook({ submit() { submissions++; throw missingOwner } }))
  await expect(f.ctx.pluginManager.setPluginEnabled(row.entryId, false)).rejects.toBe(missingOwner)
  await expect(f.ctx.pluginManager.setBundleEnabled('not-an-approved-package', true)).rejects.toBe(missingOwner)
  await expect(f.ctx.pluginManager.installBundle('not-an-approved-package')).rejects.toBe(missingOwner)
  expect(submissions).toBe(3)
  expect(f.patch()).toBe(before)
  expect(f.target.fiber).toBe(fiber)
  expect(fiber?.state).toBe(FiberState.ACTIVE)
})

async function nativeLeafUpdate(f: Awaited<ReturnType<typeof fixture>>, change: Record<string, unknown>) {
  const before = readProfilePatches('dsh', f.profile)
  const after = [...before, { id: 'repeat-tool-reminder', ...change }]
  const plan = await prepareProfilePluginUpdate(f.ctx, f.target, before, after, 256)
  await withProfileConfigUpdate(plan, async () => {
    await writeFileAtomic(f.profile.patchPath, JSON.stringify(after) + '\n', { mode: 0o600 })
    assertProfileConfigUpdate(plan, true)
    await reconcileProfilePatches(f.ctx, after, 'dsh', ['repeat-tool-reminder'])
    await f.ctx.loader.await()
  })
  return plan
}

it('commits a bounded native leaf config remount and disable/enable with the same root', async () => {
  const f = await fixture()
  const root = f.ctx.root, old = nativeValue(f.target.fiber)
  const untouched = [...f.ctx.loader.entries()].filter(row => row !== f.target).map(row => [row, row.fiber] as const)
  const plan = await nativeLeafUpdate(f, { config: { thresholds: [2, 4] } })
  expect(plan.impact).toBe('remount')
  expect(plan.entries.find(row => row.entry === f.target)?.stopped).toEqual([old])
  expect(old.uid).toBeNull()
  expect(old.state).toBe(FiberState.DISPOSED)
  expect(f.target.fiber).not.toBe(old)
  expect(f.target.fiber?.config).toMatchObject({ thresholds: [2, 4] })
  const configured = nativeValue(f.target.fiber)
  await nativeLeafUpdate(f, { disabled: true })
  expect(configured.uid).toBeNull()
  expect(configured.state).toBe(FiberState.DISPOSED)
  await nativeLeafUpdate(f, { disabled: false })
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.target.fiber?.config).toMatchObject({ thresholds: [2, 4] })
  expect(f.ctx.root).toBe(root)
  for (const [entry, fiber] of untouched) expect(entry.fiber).toBe(fiber)
})

it('refuses a stale native leaf plan before persistence', async () => {
  const f = await fixture()
  const before = readProfilePatches('dsh', f.profile)
  const plan = await prepareProfilePluginUpdate(f.ctx, f.target, before,
    [...before, { id: 'repeat-tool-reminder', disabled: true }], 256)
  await nativeLeafUpdate(f, { config: { thresholds: [2, 4] } })
  const text = f.patch()
  let wrote = false
  await expect(withProfileConfigUpdate(plan, async () => { wrote = true })).rejects.toThrow('stale')
  expect(wrote).toBe(false)
  expect(f.patch()).toBe(text)
})

it('refuses a native leaf with a child stop closure before persistence', async () => {
  const f = await fixture()
  const child = nativeValue(f.target.fiber).ctx.plugin({ apply() {} })
  await child.await()
  const before = readProfilePatches('dsh', f.profile)
  const plan = await prepareProfilePluginUpdate(f.ctx, f.target, before,
    [...before, { id: 'repeat-tool-reminder', disabled: true }], 256)
  expect(plan.impact).toBe('unknown')
  let wrote = false
  await expect(withProfileConfigUpdate(plan, async () => { wrote = true })).rejects.toThrow('unproven')
  expect(wrote).toBe(false)
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
})

it('configures and enables a never-active preinstalled disabled leaf through the original importer and schema', async () => {
  const f = await fixture(false)
  const base = readFileSync(join(f.profile.dir, 'cordis.yml'), 'utf8')
  await nativeLeafUpdate(f, { config: { thresholds: [2, 4, 8] } })
  expect(f.target.fiber).toBeUndefined()
  expect(f.target.disabled).toBe(true)
  const plan = await nativeLeafUpdate(f, { disabled: false })
  expect(plan.entries.find(row => row.entry === f.target)?.stopped).toEqual([])
  expect(f.target.fiber?.state).toBe(FiberState.ACTIVE)
  expect(f.target.moduleNamespace).toBe(Reminder)
  expect(f.target.fiber?.config).toMatchObject({ thresholds: [2, 4, 8] })
  expect(readFileSync(join(f.profile.dir, 'cordis.yml'), 'utf8')).toBe(base)
})
