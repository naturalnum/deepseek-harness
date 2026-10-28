/** Native permission catalog, human command and initial seeding through real Loader/Gateway services; no kernel execution. */
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresets, { type PermissionCatalog } from '@deepseek-ai/dsh-permission-presets'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { createNativeCommands } from '../src/native-commands.ts'
import { createNativePermissions, type NativePermissions } from '../src/native-permissions.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

async function fixture(id: string, initiallyReady = true) {
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-permissions', lifetime: lifetime.signal })
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: [
      ...['list', 'execute'].map(method => ({ endpoint: 'commands/' + method, handlerId: 'native:commands', guard: 'account-session' as const })),
      { endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'authenticated-account' as const },
    ], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let owner: Context | undefined, native: NativePermissions | undefined, current = initiallyReady, enforcing = true, busy = false
  const events: SessionEvent[] = []
  onTestFinished(async () => { await owner?.fiber.dispose() })
  const assertCurrent = (): void => {
    if (!current || lifetime.signal.aborted) throw new CloudApiError('cloud/stale-generation', 'The account generation has ended.')
    owner?.fiber.assertActive()
  }
  const assertActiveScope = (agent: Agent): void => {
    assertCurrent()
    if (agent.ctx.get('peAccount') !== binding || owner?.agents.get(agent.id) !== agent || agent.session.header.cwd !== '/account-project') {
      throw new CloudApiError('cloud/forbidden', 'The project is outside this account.')
    }
  }
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536, assertSessionRead() {} },
    assertHandlerEnabled() {}, resolveCreate: async request => request, assertSessionProject: async () => {}, assertActiveScope,
  }
  const assertSwitch = vi.fn(() => {
    if (busy) throw new CloudApiError('cloud/account-unavailable', 'An original command, service or owned child is still live.')
  })
  const ctx = await boot('native-permissions', fileURLToPath(new URL('./fixtures/native-permissions.cordis.yml', import.meta.url)), [], async (ctx) => {
    owner = ctx
    ctx.on('session/event', (_session, event) => { events.push(event) })
    ctx.provide('peAccount', binding)
    // The native service requires a confining Shell capability. This fixture does not execute that external capability.
    ctx.provide('shell', { sandboxMode: 'workspace-write', resolve() { throw new Error('No command execution in this fixture') },
      run() { throw new Error('No command execution in this fixture') }, start() { throw new Error('No command execution in this fixture') } })
    await ctx.plugin(Typert)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(UserApproval, { policy: 'never' })
    await mountAgentLoopTestHarness(ctx)
    Object.assign(ctx.loader.builtins, {
      'account-permissions': { inject: PermissionPresets.inject, Config: PermissionPresets.Config,
        apply(scope: Context, config: ConstructorParameters<typeof PermissionPresets>[1]) {
          native = createNativePermissions(scope, binding, assertCurrent, policy, 128, config, 65536,
            () => { if (!enforcing) throw new CloudApiError('cloud/account-unavailable', 'The original enforcing provider is unavailable.') }, assertSwitch)
        } },
      'permission-command-registry': { inject: ['agents'], apply(scope: Context) {
        createNativeCommands(scope, binding, assertCurrent, policy, guards, 128)
      } },
    })
  })
  if (native === undefined) throw new Error('The guarded original permission service did not mount')
  const service = native
  const agent = (await ctx.agents.create({ sessionId: SessionId('permission-session-' + id), meta: { cwd: '/account-project' } })).agent
  const peer: PeerScope = { id: brandString<PeerId>('permissions-' + id), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: lifetime.signal, dispose: async () => {} }
  const catalog = () => ctx.typertGateway.invoke({ namespace: 'permissionPresets', method: 'catalog', args: {}, peer }) as Promise<PermissionCatalog>
  const execute = (line: string) => ctx.typertGateway.invoke({ namespace: 'commands', method: 'execute',
    args: { agentId: agent.id, line, submittedAttachments: [] }, peer })
  return { ctx, service, agent, events, lifetime, policy, catalog, execute, assertSwitch,
    setBusy: (value: boolean) => { busy = value }, revoke: () => { current = false }, publish: () => { current = true },
    loseEnforcement: () => { enforcing = false } }
}

const permissionEvents = (events: readonly SessionEvent[]) => events.filter(event =>
  event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')

it('pins initial native defaults using installation checks before business-ready, while public writes and catalog stay closed', async () => {
  const f = await fixture('pre-ready', false)
  expect(f.service.value.current(f.agent.session)).toBe('workspace-write')
  expect(permissionEvents(f.events)).toHaveLength(3)
  const before = permissionEvents(f.events).length
  await expect(f.catalog()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(() => { f.service.value.set(f.agent.session, 'read-only') }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  await expect(f.execute('/permission read-only')).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(permissionEvents(f.events)).toHaveLength(before)
  f.publish()
  expect(await f.catalog()).toMatchObject({ defaultPreset: 'workspace-write' })
  f.service.value.set(f.agent.session, 'read-only')
  expect(f.service.value.current(f.agent.session)).toBe('read-only')
})

it('uses the original catalog and /permission handler with durable Session state and the same guarded registry', async () => {
  const f = await fixture('catalog')
  expect(await f.catalog()).toEqual({ options: [expect.objectContaining({ value: 'read-only' }), expect.objectContaining({ value: 'workspace-write' })],
    defaultOptions: [expect.objectContaining({ value: 'read-only' }), expect.objectContaining({ value: 'workspace-write' })], defaultPreset: 'workspace-write' })
  expect(f.service.inspect().rpcEndpoints).toEqual([{ endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'authenticated-account' }])
  expect(f.service.value.current(f.agent.session)).toBe('workspace-write')
  const before = f.assertSwitch.mock.calls.length
  expect(await f.execute('/permission read-only')).toMatchObject({ result: { kind: 'success' } })
  expect(f.assertSwitch.mock.calls.length).toBe(before + 1)
  expect(f.service.value.current(f.agent.session)).toBe('read-only')
  expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'permissions')).toMatchObject({ preset: 'read-only', sandbox: 'read-only', approval: 'never' })
})

it('blocks native private command apply and direct set before permission events while previous work remains live', async () => {
  const f = await fixture('busy'), before = permissionEvents(f.events).length
  f.setBusy(true)
  await expect(f.execute('/permission read-only')).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(() =>{  f.service.value.set(f.agent.session, 'read-only') }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(permissionEvents(f.events)).toHaveLength(before)
  expect(f.service.value.current(f.agent.session)).toBe('workspace-write')
  f.setBusy(false)
  expect(await f.execute('/permission read-only')).toMatchObject({ result: { kind: 'success' } })
  expect(f.service.value.current(f.agent.session)).toBe('read-only')
})

it.each([false, true])('runs the same synchronous guard before fresh or partial permission seeding (partial=%s)', async (partial) => {
  const f = await fixture('seed-' + String(partial)), before = permissionEvents(f.events).length
  f.setBusy(true)
  const id = SessionId('blocked-seed-' + String(partial))
  expect(() => f.ctx.sessions.create(id, partial ? { seed: [] } : {})).toThrow()
  expect(f.ctx.sessions.get(id)).toBeUndefined()
  expect(permissionEvents(f.events)).toHaveLength(before)
})

it('rejects foreign Session objects, automatic/full access and unknown selections without durable changes', async () => {
  const a = await fixture('a'), b = await fixture('b'), beforeA = permissionEvents(a.events).length, beforeB = permissionEvents(b.events).length
  expect(() =>{  a.service.value.set(b.agent.session, 'read-only') }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  for (const name of ['danger-full-access', 'auto', 'custom', 'other']) {
    expect(() =>{  a.service.value.set(a.agent.session, name) }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    expect(await a.execute('/permission ' + name)).toMatchObject({ result: { kind: 'error' } })
  }
  expect(() => a.service.value.registerAuto(() => {})).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(permissionEvents(a.events)).toHaveLength(beforeA)
  expect(permissionEvents(b.events)).toHaveLength(beforeB)
})

it.each(['lifetime', 'admission', 'enforcement', 'exposure'] as const)('keeps %s closure ahead of catalog and permission writes', async (ended) => {
  const f = await fixture(ended), before = permissionEvents(f.events).length
  if (ended === 'lifetime') f.lifetime.abort()
  else if (ended === 'admission') f.revoke()
  else if (ended === 'enforcement') f.loseEnforcement()
  else f.policy.invalidate()
  await expect(f.catalog()).rejects.toBeDefined()
  expect(() =>{  f.service.value.set(f.agent.session, 'read-only') }).toThrow()
  expect(permissionEvents(f.events)).toHaveLength(before)
})
