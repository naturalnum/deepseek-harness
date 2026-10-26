/** Real Cordis services and Gateway event delivery; unrelated native handlers grant no business readiness. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished } from 'vitest'
import { CloudAccountApi } from '../src/account-service.ts'
import { CloudApiError } from '../src/errors.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'
import type { NativeFirstScreen } from '../src/native-first-screen.ts'
import { registerFirstScreenEvents, type FirstScreenEvents } from '../src/first-screen-events.ts'

// The event source consumes only this public guard; real Service tracing supplies the proxy behavior.
class SkillsCapability extends Service {
  checks = 0
  blocked = false
  constructor(ctx: Context) { super(ctx, 'cloudSkills') }
  assertCurrent(): void {
    this.checks++
    if (this.blocked) throw new CloudApiError('cloud/account-unavailable', 'Fixture skill capability revoked.')
  }
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cloud-first-screen-events-')), profileDir = join(home, 'profile')
  mkdirSync(profileDir); initProfile(profileDir, [])
  const configPath = join(profileDir, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([{ id: 'dependencies', name: 'cordis:event-dependencies' },
    { id: 'skills', name: 'cordis:event-skills' }]))
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>('events'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'events-proxy', lifetime: lifetime.signal })
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion, allowedSettings: [], rpcEndpoints: [],
    exactFetchRoutes: [], streamEndpoints: [{ endpoint: '$events', handlerId: 'native:typertGateway', guard: 'authenticated-account' }] })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  let context: Context | undefined, api: CloudAccountApi | undefined, barrier: ConfigSaveBarrier | undefined
  let capability: SkillsCapability | undefined, skillFiber: Fiber | undefined
  const registration: { events?: FirstScreenEvents } = {}
  const streams: Array<{ abort: AbortController; iterator: AsyncIterator<unknown> }> = []
  onTestFinished(async () => {
    try {
      for (const stream of streams) { stream.abort.abort(); await stream.iterator.return?.() }
      await registration.events?.dispose()
      if (api !== undefined && barrier !== undefined) {
        const receipt = await api.stopConfigSaves(Date.now() + 1000)
        expect(receipt.status).toBe('confirmed')
        await api.withdraw(); saves.releaseAccount(barrier)
      }
      await context?.fiber.dispose(); saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const ctx = await boot('first-screen-events-fixture', configPath, [], (owner) => {
    context = owner
    const profile: ProfileContext = { name: 'events', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
      home, cwd: home, installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    owner.provide('profileContext', profile); owner.provide('peAccount', binding)
    barrier = saves.createAccount(binding)
    const current = (actual: AccountBinding): void => {
      if (actual !== binding || owner.get('peAccount') !== binding) throw new Error('Foreign fixture binding')
      lifetime.signal.throwIfAborted()
    }
    api = new CloudAccountApi(owner, { binding, rootExposure: policy, selected: policy.manifest, saves: barrier,
      assertMountCurrent: current, assertBusinessCurrent: current })
    Object.assign(owner.loader.builtins, {
      'event-dependencies': { async apply(scope: Context) {
        await scope.plugin(Typert); await scope.plugin(RemoteAccess); await scope.plugin(Gateway)
      } },
      'event-skills': { apply(scope: Context) { skillFiber = scope.fiber; capability = new SkillsCapability(scope) } },
    })
  })
  if (api === undefined || capability === undefined || skillFiber === undefined) throw new Error('Fixture services absent')
  const installedApi = api, installedSkillFiber = skillFiber
  const native: NativeFirstScreen = { binding, workspaceController: WorkspaceController, settingsController: SettingsController,
    assertCurrent: () => { installedApi.assertInstalled(ctx) }, assertSessionRead: () => {},
    inspect: () => ({ recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] }) }
  const events = registerFirstScreenEvents(ctx, { api, native, settingsNamespaces: ['locale', 'subagent'], home, maxHomeBytes: 4096, maxInventoryEntries: 512,
    maxQueuedEvents: 8, maxQueuedBytes: 16384, maxFrameBytes: 4096 })
  registration.events = events
  return { ctx, capability, events,
    withdraw: () => installedSkillFiber.dispose(),
    async open() {
      const abort = new AbortController()
      const peer: PeerScope = { id: brandString<PeerId>('events-peer'), ctx, principal: { kind: 'owner' },
        interactions: 'answer', signal: abort.signal, dispose: () => Promise.resolve() }
      const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal)
      const iterator = stream[Symbol.asyncIterator](); streams.push({ abort, iterator }); return iterator
    } }
}

it('registers, inspects and forwards skills/change through distinct Cordis proxies for the same skill owner', async () => {
  const f = await fixture(), one = f.ctx.get('cloudSkills'), two = f.ctx.get('cloudSkills')
  if (one === undefined || two === undefined) throw new Error('Fixture capability absent')
  expect(one).not.toBe(two)
  expect(Reflect.get(one, symbols.original)).toBe(f.capability)
  expect(Reflect.get(two, symbols.original)).toBe(f.capability)
  expect(f.events.inspect()).toMatchObject({ endpoint: '$events', home: f.ctx.profileContext.home })
  const stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  f.ctx.emit('skills/change')
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'skills/change', args: [] } })
  expect(f.capability.checks).toBeGreaterThan(0)
})

it.each(['withdraw', 'replace'] as const)('rejects the captured skill owner after %s', async (action) => {
  const f = await fixture(); f.events.inspect(); await f.withdraw()
  if (action === 'replace') await f.ctx.plugin((owner) => { new SkillsCapability(owner) })
  expect(() => { f.events.inspect() }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('still calls the captured skill capability guard when its original service identity remains installed', async () => {
  const f = await fixture(), before = f.capability.checks
  f.capability.blocked = true
  expect(() => { f.events.inspect() }).toThrow('Fixture skill capability revoked.')
  expect(f.capability.checks).toBe(before + 1)
})


it('forwards approved generic form revisions and omits unrelated namespaces on the original event source', async () => {
  const f = await fixture(), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  f.ctx.emit('settings/document-updated', brandString<import('@deepseek-ai/dsh-settings/types').SettingsNamespace>('unapproved'), 1)
  f.ctx.emit('settings/document-updated', brandString<import('@deepseek-ai/dsh-settings/types').SettingsNamespace>('subagent'), 2)
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'settings/document-updated', args: ['subagent', 2] } })
})
