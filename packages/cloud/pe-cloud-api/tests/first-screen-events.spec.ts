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
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { SessionId as createSessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
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

async function fixture(schedule = false, approval = false) {
  const home = mkdtempSync(join(tmpdir(), 'cloud-first-screen-events-')), profileDir = join(home, 'profile')
  mkdirSync(profileDir); initProfile(profileDir, [])
  const configPath = join(profileDir, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([{ id: 'dependencies', name: 'cordis:event-dependencies' },
    { id: 'skills', name: 'cordis:event-skills' }]))
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>('events'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'events-proxy', lifetime: lifetime.signal })
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion, allowedSettings: [], rpcEndpoints: approval
    ? [{ endpoint: '$events/result', handlerId: 'native:typertGateway', guard: 'authenticated-account' }] : [],
  exactFetchRoutes: [], streamEndpoints: [{ endpoint: '$events', handlerId: 'native:typertGateway', guard: 'authenticated-account' }] })
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 4, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 1, maxWaitersPerAccount: 2 })
  let context: Context | undefined, api: CloudAccountApi | undefined, barrier: ConfigSaveBarrier | undefined
  let capability: SkillsCapability | undefined, skillFiber: Fiber | undefined
  const registration: { events?: FirstScreenEvents } = {}
  const controls: {
    pending: Promise<void> | undefined
    expectedFailure: unknown
    assertSession: ReturnType<typeof vi.fn<(id: SessionId) => void>>
  } = {
    pending: undefined, expectedFailure: undefined, assertSession: vi.fn<(id: SessionId) => void>(),
  }
  const streams: Array<{ abort: AbortController; iterator: AsyncIterator<unknown> }> = []
  const approvalSignals: AbortController[] = [], approvalResults: Promise<unknown>[] = []
  onTestFinished(async () => {
    try {
      for (const control of approvalSignals) control.abort()
      await Promise.allSettled(approvalResults)
      for (const stream of streams) { stream.abort.abort(); await stream.iterator.return?.() }
      try { await registration.events?.dispose() } catch (error) {
        if (error !== controls.expectedFailure) throw error
      }
      if (api !== undefined && barrier !== undefined) {
        const receipt = await api.stopConfigSaves(Date.now() + 1000)
        expect(receipt.status).toBe('confirmed')
        try { await api.withdraw() } catch (error) { if (error !== controls.expectedFailure) throw error }
        saves.releaseAccount(barrier)
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
        if (approval) {
          const credentials = join(home, 'credentials.yaml')
          writeFileSync(credentials, 'version: 1\nrefs: {}\n', { mode: 0o600 })
          await scope.plugin(Credentials, { path: credentials, watch: false })
          await scope.plugin({ inject: [...connectionInject], apply: applyConnection })
          await mountAgentLoopTestDependencies(scope)
          await scope.plugin(ApprovalService)
          await mountAgentLoopTestHarness(scope)
        }
      } },
      'event-skills': { apply(scope: Context) { skillFiber = scope.fiber; capability = new SkillsCapability(scope) } },
    })
  })
  if (api === undefined || capability === undefined || skillFiber === undefined) throw new Error('Fixture services absent')
  const installedApi = api, installedSkillFiber = skillFiber
  const native: NativeFirstScreen = { binding, workspaceController: WorkspaceController, settingsController: SettingsController,
    pendingSettingsSave: () => controls.pending,
    assertCurrent: () => { installedApi.assertInstalled(ctx) }, assertSessionRead: controls.assertSession,
    inspect: () => ({ recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] }) }
  const scheduleAdmission = schedule ? vi.spyOn(api, 'requireRpc').mockReturnValue({ endpoint: 'schedule/catalog',
    handlerId: 'native:schedule', guard: 'authenticated-account' }) : undefined
  // This transport fixture supplies only the selected original Gateway result guard,
  // not a complete ready account. Native account inventory has separate composition coverage.
  const approvalAdmission = approval ? vi.spyOn(api, 'requireRpc').mockImplementation((endpoint) => {
    installedApi.assertInstalled(ctx)
    if (endpoint !== '$events/result') throw new CloudApiError('cloud/forbidden', 'This fixture exposes no question answer RPC.')
    return { endpoint, handlerId: 'native:typertGateway', guard: 'authenticated-account' }
  }) : undefined
  if (approval) vi.spyOn(api, 'requireStream').mockImplementation((endpoint) => {
    installedApi.assertInstalled(ctx)
    if (endpoint !== '$events') throw new CloudApiError('cloud/forbidden', 'This fixture exposes no other stream.')
    return { endpoint, handlerId: 'native:typertGateway', guard: 'authenticated-account' }
  })
  const events = registerFirstScreenEvents(ctx, { api, native, settingsNamespaces: ['locale', 'subagent'], home, maxHomeBytes: 4096, maxInventoryEntries: 512,
    maxQueuedEvents: 8, maxQueuedBytes: 16384, maxFrameBytes: 4096,
    ...schedule || approval ? { controls: { commands: false, goals: false, permissions: false, schedule, approval } } : {} })
  registration.events = events
  const peer = (abort: AbortController): PeerScope => ({ id: brandString<PeerId>('events-peer'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: abort.signal, dispose: () => Promise.resolve() })
  return { ctx, capability, events, scheduleAdmission, approvalAdmission, controls, peer,
    async approvalAgent() {
      const agent = (await ctx.agents.create({ sessionId: createSessionId('approval-session') })).agent
      agent.session.append('turn/start', { turn: 1 })
      return agent
    },
    approve(agent: Parameters<ApprovalService['request']>[0]['agent']) {
      const control = new AbortController(); approvalSignals.push(control)
      const value = ctx.approval.request({ agent, toolName: 'Bash', reason: 'One reviewed operation.', signal: control.signal })
      approvalResults.push(value)
      return { value, control }
    },
    withdraw: () => installedSkillFiber.dispose(),
    async open() {
      const abort = new AbortController()
      const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer(abort), abort.signal)
      const iterator = stream[Symbol.asyncIterator](); streams.push({ abort, iterator }); return iterator
    },
    async openApproval() {
      const abort = new AbortController(), originalPeer = peer(abort)
      const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), originalPeer, abort.signal)
      const iterator = stream[Symbol.asyncIterator](); streams.push({ abort, iterator })
      const ready = await iterator.next()
      expect(ready).toMatchObject({ value: { type: 'ready' } })
      const frame: unknown = ready.value
      if (frame === null || typeof frame !== 'object' || typeof Reflect.get(frame, 'clientId') !== 'string') throw new Error('No native client identity')
      const clientId = String(Reflect.get(frame, 'clientId'))
      return { iterator, abort, peer: originalPeer, result: async (eventId: string, value: unknown, caller = originalPeer) => {
        const route = ctx.connection.createSharedFetchHandler('/api', (target) => {
          if (target.kind !== 'rpc') throw new Error('An approval result must use original native RPC')
          installedApi.requireRpc(target.endpoint)
        })
        const response = await route.fetch(new Request('http://account.invalid/api/$events/result', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
            rpcId: 'approval-result', method: '$events/result', payload: { args: { clientId, eventId,
              outcome: { kind: 'result', value } } } }),
        }), caller)
        const result: unknown = await response.json()
        return result
      } }
    } }
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw new Error('Original Remote frame is not an object')
  return Reflect.get(value, key)
}

async function nextApproval(iterator: AsyncIterator<unknown>): Promise<{ frame: unknown; eventId: string }> {
  for (let index = 0; index < 8; index++) {
    const next = await iterator.next()
    if (next.done) throw new Error('Original event stream ended before its approval')
    if (field(next.value, 'type') !== 'waterfall') continue
    expect(field(next.value, 'event')).toBe('approval/request')
    const eventId = field(next.value, 'eventId')
    if (typeof eventId !== 'string') throw new Error('Original approval omitted its event identity')
    return { frame: next.value, eventId }
  }
  throw new Error('Original approval did not arrive inside its finite event window')
}

it.each(['allowed-once', 'rejected'] as const)('round-trips native approval %s without requiring the question-answer endpoint', async (outcome) => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  expect(f.events.inspect()).toMatchObject({ resultEndpoint: '$events/result' })
  const waiting = f.approve(agent), request = await nextApproval(client.iterator)
  expect(request.frame).toMatchObject({ type: 'waterfall', event: 'approval/request', agentId: agent.id,
    request: { toolName: 'Bash', reason: 'One reviewed operation.' } })
  expect(field(request.frame, 'request')).not.toHaveProperty('agent')
  expect(field(request.frame, 'request')).not.toHaveProperty('signal')
  await expect(client.result(request.eventId, outcome)).resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting.value).resolves.toBe(outcome)
  const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
  expect(audit).toHaveLength(2)
  expect(audit[0]).toMatchObject({ type: 'approval/asked', data: { toolName: 'Bash' } })
  expect(audit[1]).toMatchObject({ type: 'approval/decided', data: { outcome } })
  expect(field(audit[1]?.data, 'id')).toBe(field(audit[0]?.data, 'id'))
  expect(f.events.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('does not accept a question answer as a native approval decision', async () => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  const waiting = f.approve(agent), request = await nextApproval(client.iterator)
  await expect(client.result(request.eventId, { answers: [{ id: 'approval', selected: ['Approve'] }] }))
    .resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting.value).resolves.toBe('unavailable')
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome: 'unavailable' } })
})

it('rejects another Peer answering the pending approval even when its visible identity is copied', async () => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  const waiting = f.approve(agent), request = await nextApproval(client.iterator)
  const copiedPeer: PeerScope = { ...client.peer }
  await expect(client.result(request.eventId, 'allowed-once', copiedPeer)).resolves.toMatchObject({
    result: { ok: false, error: { code: 'gateway/interactions-forbidden' } },
  })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(0)
  await expect(client.result(request.eventId, 'rejected')).resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting.value).resolves.toBe('rejected')
})

it('rechecks the original Session before accepting a delivered approval decision', async () => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  const waiting = f.approve(agent), request = await nextApproval(client.iterator)
  f.controls.assertSession.mockImplementation(() => {
    throw new CloudApiError('cloud/account-unavailable', 'The original Session ended after dialog delivery.')
  })
  await expect(client.result(request.eventId, 'allowed-once')).resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting.value).resolves.toBe('unavailable')
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome: 'unavailable' } })
  expect(f.events.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('settles original approval cancellation and makes a late grant an idempotent no-op', async () => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  const waiting = f.approve(agent), request = await nextApproval(client.iterator)
  waiting.control.abort()
  await expect(waiting.value).resolves.toBe('cancelled')
  // Native Gateway acknowledges stale results as no-ops after the decision has settled.
  await expect(client.result(request.eventId, 'allowed-once')).resolves.toMatchObject({ result: { ok: true } })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided'))
    .toMatchObject([{ data: { outcome: 'cancelled' } }])
  expect(f.events.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('retains a disconnected native approval for the replacement Client without granting the operation', async () => {
  const f = await fixture(false, true), client = await f.openApproval(), agent = await f.approvalAgent()
  const waiting = f.approve(agent)
  const original = await nextApproval(client.iterator)
  client.abort.abort()
  await client.iterator.return?.()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(0)
  expect(f.events.inspect()).toMatchObject({ queuedEvents: 1 })
  await expect(client.result(original.eventId, 'allowed-once')).resolves.toMatchObject({ result: { ok: false } })
  const replacement = await f.openApproval(), replay = await nextApproval(replacement.iterator)
  expect(replay.eventId).toBe(original.eventId)
  await expect(replacement.result(replay.eventId, 'rejected')).resolves.toMatchObject({ result: { ok: true } })
  await expect(waiting.value).resolves.toBe('rejected')
  expect(f.events.inspect()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 })
})

it('rejects an approval from an Agent outside this exact account generation', async () => {
  const f = await fixture(false, true), other = await fixture(false, true), agent = await other.approvalAgent()
  const waiting = f.approve(agent)
  await expect(waiting.value).resolves.toBe('unavailable')
  expect(f.controls.assertSession).not.toHaveBeenCalled()
  const failure: unknown = await f.events.dispose().then(() => undefined, (error: unknown) => error)
  f.controls.expectedFailure = failure
  expect(failure).toMatchObject({ code: 'cloud/account-unavailable' })
})

it('does not deliver a buffered session event if its original guard is revoked before delivery', async () => {
  const f = await fixture(), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const pending = Promise.withResolvers<undefined>()
  f.controls.pending = pending.promise
  const denied = new CloudApiError('cloud/account-unavailable', 'Session was revoked while the save was pending.')
  f.controls.assertSession.mockImplementation(() => { throw denied })
  f.controls.expectedFailure = denied
  const id = brandString<SessionId>('revoked-session')
  f.ctx.emit('api-session/activity', id, 42)
  expect(f.controls.assertSession).not.toHaveBeenCalled()
  f.controls.pending = undefined
  pending.resolve(undefined)
  await expect(stream.next()).resolves.toMatchObject({ done: true })
  expect(f.controls.assertSession).toHaveBeenCalledWith(id)
  await expect(f.events.dispose()).rejects.toBe(denied)
})

it('keeps the original queue limit while settings remain pending', async () => {
  const f = await fixture(), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const pending = Promise.withResolvers<undefined>()
  f.controls.pending = pending.promise
  const ns = brandString<import('@deepseek-ai/dsh-settings/types').SettingsNamespace>('locale')
  for (let revision = 0; revision < 9; revision++) f.ctx.emit('settings/document-updated', ns, revision)
  await expect(stream.next()).resolves.toMatchObject({ done: true })
  const failure: unknown = await f.events.dispose().then(() => undefined, (error: unknown) => error)
  f.controls.expectedFailure = failure
  expect(failure).toMatchObject({ code: 'cloud/account-unavailable' })
  f.controls.pending = undefined
  pending.resolve(undefined)
})

it('rechecks the original endpoint guard before delivering a pending control event', async () => {
  const f = await fixture(true), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const pending = Promise.withResolvers<undefined>()
  f.controls.pending = pending.promise
  f.ctx.emit('schedule/changed')
  expect(f.scheduleAdmission).not.toHaveBeenCalled()
  f.controls.pending = undefined
  pending.resolve(undefined)
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'schedule/changed' } })
  expect(f.scheduleAdmission).toHaveBeenCalledWith('schedule/catalog')
})

it('buffers a skills notification and rechecks its original capability after settings settle', async () => {
  const f = await fixture(), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const pending = Promise.withResolvers<undefined>(), checks = f.capability.checks
  f.controls.pending = pending.promise
  f.ctx.emit('skills/change')
  expect(f.capability.checks).toBe(checks)
  f.controls.pending = undefined
  pending.resolve(undefined)
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'skills/change' } })
  expect(f.capability.checks).toBeGreaterThan(checks)
})

it('forwards a selected Schedule invalidation only through the account event source and its catalog guard', async () => {
  const f = await fixture(true), stream = await f.open()
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  f.ctx.emit('schedule/changed')
  await expect(stream.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'schedule/changed', args: [] } })
  expect(f.scheduleAdmission).toHaveBeenCalledWith('schedule/catalog')
})

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
