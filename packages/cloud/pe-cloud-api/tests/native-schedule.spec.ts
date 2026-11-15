/** Account Schedule guard over the original native service and in-memory domain; not a browser or deployment test. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService, { createAfterScheduleRecord, ScheduleId, type ScheduleCreateRequest, type ScheduleTask } from '@deepseek-ai/dsh-schedule'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { agentFor, boundTask, gatedScheduleBackend, seedTasks } from '../../../schedule/schedule/tests/harness.ts'
import { createNativeSchedule, type NativeSchedule } from '../src/native-schedule.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'
import { nativeMethodInventoryTests } from './native-method-inventory-fixture.ts'

function request(sessionId: SessionId, title: string, prompt: string, after_seconds: number): ScheduleCreateRequest {
  return { title, prompt, timing: { kind: 'after', after_seconds }, target: { kind: 'session', sessionId } }
}

function storedForeignTask(): ScheduleTask {
  return boundTask(SessionId('foreign-session'),
    createAfterScheduleRecord(ScheduleId('foreign-task'), 'Foreign secret', 3600, Date.now(), 'not visible'))
}

async function fixture(pool = new MemoryMediaPool(), initiallyActive = true, stored: readonly ScheduleTask[] = []) {
  const ctx = new Context(), lifetime = new AbortController(), id = SessionId('own-session')
  const binding: AccountBinding = { accountId: brandString<AccountId>('own-account'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-schedule', lifetime: lifetime.signal }
  ctx.provide('peAccount', binding)
  await ctx.plugin(Typert)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  let putHook: () => Promise<void> | undefined = () => undefined
  const backend = gatedScheduleBackend(pool, { putRecord: () => putHook() })
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount(); await backend.close() }
  })
  if (stored.length > 0) await seedTasks(facility, stored)
  const live = agentFor(ctx, id), session = live.session, followup = live.followup
  let active = initiallyActive
  const current = () => { if (!active) throw new CloudApiError('cloud/stale-generation', 'Original account ended') }
  ctx.effect(() => ctx.agents.enter(live, undefined))
  const actual = new ApiSessionAgentController(ctx, async () => { throw new Error('No cold resume in fixture') })
  const resolveAgent = vi.fn(actual.resolveAgent.bind(actual))
  ctx.provide('sessionController', { resolveAgent } as never)
  ctx.provide('sessionPersistence', {} as never)
  let flush: () => Promise<void> = async () => {}
  ctx.on('session/flush', async () => { await flush() })
  const rows = ['list', 'catalog', 'history', 'edit'].map(method => ({ endpoint: 'schedule/' + method,
    handlerId: 'native:schedule', guard: method === 'catalog' ? 'authenticated-account' as const : 'account-session' as const }))
  const manifest = { recipeVersion: binding.recipeVersion, rpcEndpoints: rows, streamEndpoints: [],
    exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest); policy.audit(manifest)
  const check = (value: SessionId) => { if (value !== id) throw new CloudApiError('cloud/forbidden', 'Outside account') }
  const guards: NativeSessionGuards = { projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536, assertSessionRead: check },
    assertHandlerEnabled() {}, resolveCreate: async request => request,
    assertSessionProject: async (value) => { check(value) }, assertActiveScope() {} }
  let native: NativeSchedule | undefined
  await ctx.plugin({ name: 'test-account-schedule', inject: ScheduleService.inject,
    apply(scope: Context) { native = createNativeSchedule(scope, binding, current, policy, guards, 128, {}) } })
  if (native === undefined) throw new Error('Schedule not mounted')
  const service = native
  await service.value[Service.init]()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { vi.useRealTimers() } })
  const peer: PeerScope = { id: brandString<PeerId>('schedule-peer'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  const invoke = (method: string, args: Readonly<Record<string, unknown>>) => ctx.typertGateway.invoke({ namespace: 'schedule', method, args, peer })
  return { ctx, service, id, invoke, session, followup, resolveAgent, policy,
    setFlush: (work: () => Promise<void>) => { flush = work },
    setPutHook: (work: () => Promise<void> | undefined) => { putHook = work },
    revoke: () => { active = false }, ready: () => { active = true } }
}

nativeMethodInventoryTests('schedule', [
  ['remoteList', 'list'], ['catalog', 'catalog'], ['remoteHistory', 'history'], ['remoteEdit', 'edit'],
], async () => {
  const f = await fixture()
  return { native: f.service, upstreamPrototype: ScheduleService.prototype, policy: f.policy, maximum: 128,
    async invokeOriginal() { await expect(f.invoke('catalog', {})).resolves.toEqual([]) } }
})

it('keeps the real native Schedule domain and rejects foreign Sessions across create/read/delete', async () => {
  const f = await fixture(), foreign = SessionId('foreign-session'), foreignTask = storedForeignTask()
  const legacy = await fixture(new MemoryMediaPool(), true, [foreignTask])
  expect(f.service.inspect().rpcEndpoints.map(row => row.endpoint).sort())
    .toEqual(['schedule/catalog', 'schedule/edit', 'schedule/history', 'schedule/list'])
  const task = await f.service.value.create(request(f.id, 'Account task', 'Check results', 3600), f.id)
  expect((await f.service.value.list({ targetSessionId: f.id })).items.map(row => row.id)).toEqual([task.id])
  expect((await f.service.value.catalog()).map(row => row.target)).toEqual([{ kind: 'session', sessionId: f.id }])
  expect(await f.invoke('list', { request: { targetSessionId: f.id } })).toMatchObject({ items: [task], total: 1, shown: 1 })
  await expect(f.service.value.create(request(foreign, 'Foreign', 'not allowed', 3600), foreign)).rejects.toThrow('Outside account')
  await expect(f.service.value.list({ targetSessionId: foreign })).rejects.toThrow('Outside account')
  await expect(legacy.service.value.history({ id: foreignTask.record.id, limit: 1 })).rejects.toThrow('Outside account')
  await expect(legacy.service.value.edit({ id: foreignTask.record.id, action: 'update', patch: { title: 'foreign edit' } }, legacy.id))
    .rejects.toThrow('Outside account')
  await expect(legacy.service.value.edit({ id: foreignTask.record.id, action: 'delete' }, legacy.id)).rejects.toThrow('Outside account')
  await expect(f.service.value.edit({ id: task.id, action: 'update', patch: { target: { kind: 'session', sessionId: foreign } } }, f.id))
    .rejects.toThrow('Outside account')
  expect((await f.service.value.list({ targetSessionId: f.id })).items.map(row => row.id)).toEqual([task.id])
  f.revoke()
  await expect(f.service.value.catalog()).rejects.toThrow('Original account ended')
})

it('preserves native compare/update, due inbox delivery, history and delete semantics', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const initial = await f.service.value.create(request(f.id, 'Before', 'Run report', 10), f.id)
  const edited = await f.service.value.edit({ id: initial.id, action: 'update',
    expectedUpdatedAt: initial.updatedAt ?? null, patch: { title: 'After' } }, f.id)
  if (!('target' in edited)) throw new Error('Native update not acknowledged')
  expect(edited.title).toBe('After')
  expect(await f.service.value.edit({ id: initial.id, action: 'update',
    expectedUpdatedAt: initial.updatedAt ?? null, patch: { title: 'Stale' } }, f.id))
    .toEqual({ id: initial.id, code: 'schedule_conflict' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.resolveAgent).toHaveBeenCalledWith(f.id)
  expect(f.followup).toHaveBeenCalledTimes(1)
  expect(f.followup.mock.calls[0]![0]).toMatchObject({ source: { kind: 'schedule' } })
  expect(await f.service.value.list({ targetSessionId: f.id })).toMatchObject({ items: [], total: 0, shown: 0 })
  expect(await f.service.value.catalog()).toMatchObject([{ id: initial.id, status: 'ended' }])
  expect(await f.service.value.history({ id: initial.id, limit: 10 })).toMatchObject({ id: initial.id,
    records: [expect.objectContaining({ scheduledAt: initial.scheduledAt })] })
  expect(await f.service.value.edit({ id: initial.id, action: 'delete' }, f.id)).toMatchObject({ deleted: true })
  expect(await f.service.value.catalog()).toEqual([])
})

it('uses the native edit Remote for guarded updates and deletion while keeping Remote creation closed', async () => {
  const f = await fixture()
  const task = await f.service.value.create(request(f.id, 'Before', 'Do work', 3600), f.id)
  await expect(f.invoke('edit', { request: { id: task.id, action: 'update',
    expectedUpdatedAt: task.updatedAt ?? null, patch: { title: 'After' } } }))
    .resolves.toMatchObject({ id: task.id, title: 'After', target: { kind: 'session', sessionId: f.id } })
  await expect(f.invoke('edit', { request: { id: task.id, action: 'update',
    patch: { target: { kind: 'session', sessionId: SessionId('foreign-session') } } } }))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, title: 'After' }])
  await expect(f.invoke('edit', { request: { id: task.id, action: 'delete' } }))
    .resolves.toEqual({ id: task.id, deleted: true })
  expect(await f.service.value.catalog()).toEqual([])
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
})

it('drains an accepted native delivery before disposal instead of treating observer cancellation as completion', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.setFlush(async () => { entered.resolve(undefined); await release.promise })
  await f.service.value.create(request(f.id, 'Pending', 'Run report', 1), f.id)
  await vi.advanceTimersByTimeAsync(1000)
  await entered.promise
  expect(f.service.isIdle()).toBe(false)
  let closed = false
  const closing = Promise.resolve(f.ctx.fiber.dispose()).then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(f.followup).toHaveBeenCalledTimes(1)
  release.resolve(undefined)
  await closing
  expect(closed).toBe(true)
})

it('leaves a delivery active when native Session flush fails and does not invent a retry acknowledgement', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  f.setFlush(async () => { throw new Error('synthetic persistence failure') })
  const task = await f.service.value.create(request(f.id, 'Failure', 'Run report', 1), f.id)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.followup).toHaveBeenCalledTimes(1)
  expect((await f.service.value.list({ targetSessionId: f.id })).items).toMatchObject([{ id: task.id }])
  expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, status: 'active' }])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.followup).toHaveBeenCalledTimes(1)
})

it('keeps the original native task across a confirmed stop and reopens the same domain', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const pool = new MemoryMediaPool(), first = await fixture(pool)
  const task = await first.service.value.create(request(first.id, 'Persisted', 'Run report', 3600), first.id)
  await first.ctx.fiber.dispose()
  const reopened = await fixture(pool)
  expect((await reopened.service.value.list({ targetSessionId: reopened.id })).items).toMatchObject([{ id: task.id, title: 'Persisted' }])
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(reopened.followup).toHaveBeenCalledTimes(1)
  expect(await reopened.service.value.catalog()).toMatchObject([{ id: task.id, status: 'ended' }])
})

it('rescans the original overdue task after account readiness and refuses before readiness', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const pool = new MemoryMediaPool(), first = await fixture(pool)
  const task = await first.service.value.create(request(first.id, 'Overdue', 'Run report', 1), first.id)
  await first.ctx.fiber.dispose()
  vi.setSystemTime(new Date('2026-11-01T01:00:02.000Z'))
  const reopened = await fixture(pool, false)
  await vi.advanceTimersByTimeAsync(0)
  expect(reopened.resolveAgent).not.toHaveBeenCalled()
  await expect(reopened.service.resumeAfterReady()).rejects.toThrow('Original account ended')
  expect(reopened.followup).not.toHaveBeenCalled()
  reopened.ready()
  await reopened.service.resumeAfterReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(reopened.followup).toHaveBeenCalledTimes(1)
  expect(await reopened.service.value.list({ targetSessionId: reopened.id })).toMatchObject({ items: [], total: 0, shown: 0 })
  expect(await reopened.service.value.catalog()).toMatchObject([{ id: task.id, status: 'ended' }])
  await reopened.service.resumeAfterReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(reopened.followup).toHaveBeenCalledTimes(1)
})

it('blocks the actual native live-Agent fast path while account admission is revoked', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const task = await f.service.value.create(request(f.id, 'Due', 'Must wait', 1), f.id)
  f.revoke()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
  f.ready()
  expect((await f.service.value.list({ targetSessionId: f.id })).items).toMatchObject([{ id: task.id }])
  await f.service.resumeAfterReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.resolveAgent).toHaveBeenCalledOnce()
  expect(f.followup).toHaveBeenCalledOnce()
})

it('retains native dispatch ownership and rechecks admission after the real live-Agent resolve', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = f.resolveAgent.getMockImplementation()
  if (original === undefined) throw new Error('Original native resolver is absent')
  f.resolveAgent.mockImplementationOnce(async (id) => {
    const value = await original(id)
    entered.resolve(undefined)
    await release.promise
    return value
  })
  await f.service.value.create(request(f.id, 'Due', 'Must wait', 1), f.id)
  await vi.advanceTimersByTimeAsync(1000)
  await entered.promise
  expect(f.service.isIdle()).toBe(false)
  f.revoke()
  release.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.followup).not.toHaveBeenCalled()
  f.ready()
  await f.service.resumeAfterReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.followup).toHaveBeenCalledOnce()
})

it('keeps the native Schedule owner busy through an accepted management write', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.setPutHook(() => { entered.resolve(undefined); return release.promise })
  const writing = f.service.value.create(request(f.id, 'Pending write', 'Save first', 3600), f.id)
  try {
    await entered.promise
    expect(f.service.isIdle()).toBe(false)
  } finally { release.resolve(undefined) }
  await writing
  await vi.waitFor(() => { expect(f.service.isIdle()).toBe(true) })
})

it('retains an already delivered message through revocation until its original flush settles', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.setFlush(async () => { entered.resolve(undefined); await release.promise })
  const task = await f.service.value.create(request(f.id, 'Accepted', 'Persist message', 1), f.id)
  await vi.advanceTimersByTimeAsync(1000)
  await entered.promise
  expect(f.followup).toHaveBeenCalledOnce()
  f.revoke()
  expect(f.service.isIdle()).toBe(false)
  release.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, status: 'ended' }])
  expect(f.followup).toHaveBeenCalledOnce()
})

it('refuses the entire catalog when a stored record names a foreign Session', async () => {
  // Store unexpected legacy content before the guarded owner opens its original domain.
  const f = await fixture(new MemoryMediaPool(), true, [storedForeignTask()])
  await f.service.value.create(request(f.id, 'Own', 'own task', 3600), f.id)
  await expect(f.service.value.catalog()).rejects.toThrow('Outside account')
  expect((await f.service.value.list({ targetSessionId: f.id })).items).toHaveLength(1)
})

it('refuses ready notification when the original native rescan implementation changes', async () => {
  const f = await fixture(), replacement = vi.spyOn(ScheduleService.prototype, 'resumeDispatch')
    .mockImplementation(async () => {})
  try { await expect(f.service.resumeAfterReady()).rejects.toThrow('Schedule service is unavailable') }
  finally { replacement.mockRestore() }
})

it.each(['create', 'view', 'run', 'deleteInactive', 'deliveryLimits'])(
  'keeps the unapproved inherited schedule/%s Remote closed', async (method) => {
    const f = await fixture()
    const args = method === 'create'
      ? { request: request(f.id, 'Unapproved', 'Must not run', 1) }
      : method === 'view' || method === 'run' ? { request: { id: ScheduleId('absent') } } : {}
    await expect(f.invoke(method, args)).rejects.toMatchObject({ code: 'cloud/forbidden' })
    expect(await f.service.value.catalog()).toEqual([])
    expect(f.resolveAgent).not.toHaveBeenCalled()
    expect(f.followup).not.toHaveBeenCalled()
  },
)

it('requires the actual existing Session filter and keeps the original active-only and collection limits', async () => {
  const f = await fixture()
  await expect(f.service.value.list({})).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.service.value.list({ targetSessionId: f.id, active: false })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(f.service.value.list({ targetSessionId: f.id, limit: 17 })).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(await f.service.value.catalog()).toEqual([])
})

it('bounds the original whole Session collection even when the requested page is smaller', async () => {
  const own = SessionId('own-session')
  const rows = Array.from({ length: 17 }, (_, index) => boundTask(own,
    createAfterScheduleRecord(ScheduleId(`stored-${index}`), `Stored ${index}`, 3600, Date.now(), 'Do work')))
  const f = await fixture(new MemoryMediaPool(), true, rows)
  await expect(f.service.value.list({ targetSessionId: f.id, limit: 1 })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(f.service.value.catalog()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.resolveAgent).not.toHaveBeenCalled()
})

it.each(['new', 'new_once'] as const)('refuses a %s target before creating or dispatching', async (kind) => {
  const f = await fixture()
  await expect(f.service.value.create({ title: 'Unapproved target', prompt: 'Must not run',
    timing: { kind: 'after', after_seconds: 1 }, target: { kind } }, f.id)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(await f.service.value.catalog()).toEqual([])
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
})

it('rechecks queued mutations while retaining the earlier write that already entered persistence', async () => {
  const f = await fixture()
  const task = await f.service.value.create(request(f.id, 'Before', 'Do work', 3600), f.id)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let writes = 0
  f.setPutHook(async () => { writes += 1; entered.resolve(undefined); await release.promise })
  const originalEdit = vi.spyOn(ScheduleService.prototype, 'edit')
  const first = f.service.value.edit({ id: task.id, action: 'update', patch: { title: 'Accepted first' } }, f.id)
  let second: ReturnType<ScheduleService['edit']> | undefined
  try {
    await entered.promise
    second = f.service.value.edit({ id: task.id, action: 'update', patch: { title: 'Must not persist' } }, f.id)
    const results = Promise.allSettled([first, second])
    await vi.waitFor(() => { expect(originalEdit).toHaveBeenCalledTimes(2) })
    f.revoke()
    release.resolve(undefined)
    expect(await results).toMatchObject([
      { status: 'rejected', reason: { code: 'cloud/stale-generation' } },
      { status: 'rejected', reason: { code: 'cloud/stale-generation' } },
    ])
    expect(writes).toBe(1)
    f.ready()
    expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, title: 'Accepted first' }])
  } finally {
    release.resolve(undefined)
    originalEdit.mockRestore()
    await Promise.allSettled([first, ...second === undefined ? [] : [second]])
  }
})
