/** Original Settings/ConfigEditor and permission service over isolated profile patches; no execution, kernel or Target authority. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished } from 'vitest'
import { createNativePermissions, type NativePermissions } from '../src/native-permissions.ts'
import { ExposurePolicy } from '../src/exposure.ts'

async function fixture(id: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-permission-default-'))), dir = join(home, 'profile')
  mkdirSync(dir); initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"native-permission-default-fixture","private":true}\n')
  const profile: ProfileContext = { name: id, dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const path = join(dir, 'cordis.yml')
  writeFileSync(path, '[]\n')
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [{ id: 'permission', name: 'cordis:account-permissions', config: {
    defaultPreset: 'workspace-write', presets: {
      'read-only': { sandbox: 'read-only', approval: 'never' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
    },
  } }] }]) + '\n')
  const roots: Context[] = []
  onTestFinished(async () => {
    try { for (const root of roots) await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const start = async () => {
    const binding: AccountBinding = { accountId: id as AccountBinding['accountId'], epoch: '1' as AccountBinding['epoch'],
      recipeVersion: 'permission-default', lifetime: new AbortController().signal }
    const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion,
      rpcEndpoints: [{ endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'authenticated-account' }],
      streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [{ namespace: 'permission', fields: ['defaultPreset'] }] })
    policy.audit(policy.manifest)
    const owned: { native?: NativePermissions } = {}
    const ctx = await boot('native-permission-default', path, readProfilePatches('native-permission-default', profile), async (ctx) => {
      roots.push(ctx)
      ctx.provide('profileContext', profile); ctx.provide('peAccount', binding)
      ctx.provide('shell', { sandboxMode: 'workspace-write', resolve() { throw new Error('No execution in this profile fixture') },
        run() { throw new Error('No execution in this profile fixture') }, start() { throw new Error('No execution in this profile fixture') } })
      await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(UserApproval, { policy: 'never' })
      await ctx.plugin(ConfigEditor); await ctx.plugin(Settings)
      Object.assign(ctx.loader.builtins, { 'account-permissions': { inject: PermissionPresets.inject, Config: PermissionPresets.Config,
        apply(scope: Context, config: ConstructorParameters<typeof PermissionPresets>[1]) {
          owned.native = createNativePermissions(scope, binding, () => { binding.lifetime.throwIfAborted() }, policy, 128,
            config, 65536, () => {}, () => {})
        } } })
    })
    const native = owned.native
    if (native === undefined) throw new Error('The original permission service is absent')
    const view = () => {
      const row = ctx.settings.describe().find(row => row.ns === 'permission')
      if (row === undefined) throw new Error('The native permission settings namespace is absent')
      return row
    }
    return { ctx, native, view }
  }
  return { start, profile }
}

it('persists permission.defaultPreset through native Settings and reloads it without changing an existing Session', async () => {
  const f = await fixture('persist'), first = await f.start()
  expect(first.view()).toMatchObject({ ns: 'permission', autoGenerate: false, value: { defaultPreset: 'workspace-write' } })
  const existing = first.ctx.sessions.create(SessionId('existing'), { meta: { cwd: '/project' } })
  const revision = first.view().revision
  await first.ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }], revision)
  expect(readFileSync(f.profile.patchPath, 'utf8')).toContain('read-only')
  expect(first.native.value.defaultPreset).toBe('read-only')
  expect(first.native.value.current(existing)).toBe('workspace-write')
  const created = first.ctx.sessions.create(SessionId('new-default'), { meta: { cwd: '/project' } })
  expect(first.native.value.current(created)).toBe('read-only')
  await first.ctx.fiber.dispose()
  const reloaded = await f.start()
  expect(reloaded.view().value).toMatchObject({ defaultPreset: 'read-only' })
  const afterRestart = reloaded.ctx.sessions.create(SessionId('after-restart'), { meta: { cwd: '/project' } })
  expect(reloaded.native.value.current(afterRestart)).toBe('read-only')
})

it('retains original default-setting CAS and volatile-field restrictions without touching another account profile', async () => {
  const a = await fixture('a'), b = await fixture('b'), first = await a.start(), second = await b.start()
  const otherBytes = readFileSync(b.profile.patchPath), revision = first.view().revision
  await first.ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }], revision)
  const ownBytes = readFileSync(a.profile.patchPath)
  await expect(first.ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }], revision))
    .rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  await expect(first.ctx.settings.mutate('permission', [{ op: 'set', path: ['presets'], value: {} }], first.view().revision)).rejects.toBeDefined()
  expect(readFileSync(a.profile.patchPath)).toEqual(ownBytes)
  expect(readFileSync(b.profile.patchPath)).toEqual(otherBytes)
  expect(second.view().value).toMatchObject({ defaultPreset: 'workspace-write' })
})
