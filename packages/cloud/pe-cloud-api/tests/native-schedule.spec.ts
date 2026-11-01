/** Account Schedule guard over the original native service and in-memory domain; not a browser or deployment test. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { gatedScheduleBackend } from '../../../schedule/schedule/tests/harness.ts'
import { createNativeSchedule, type NativeSchedule } from '../src/native-schedule.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

async function fixture(pool = new MemoryMediaPool(), initiallyActive = true) {
  const ctx = new Context(), lifetime = new AbortController(), id = SessionId('own-session')
  const binding: AccountBinding = { accountId: brandString<AccountId>('own-account'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-schedule', lifetime: lifetime.signal }
  ctx.provide('peAccount', binding)
  await ctx.plugin(Typert)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(SessionStore)
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
  const session = ctx.sessions.create(id), followup = vi.fn()
  let active = initiallyActive
  const current = () => { if (!active) throw new CloudApiError('cloud/stale-generation', 'Original account ended') }
  const live = { id, session, ctx: ctx.extend(), followup, options: {}, status: 'idle' }
  ctx.effect(() => ctx.agents.enter(live as never, undefined))
  const actual = new ApiSessionAgentController(ctx, async () => { throw new Error('No cold resume in fixture') })
  const resolveAgent = vi.fn(actual.resolveAgent.bind(actual))
  ctx.provide('sessionController', { resolveAgent } as never)
  ctx.provide('sessionPersistence', {} as never)
  let flush: () => Promise<void> = async () => {}
  ctx.on('session/flush', async () => { await flush() })
  const rows = ['list', 'catalog', 'history', 'delete', 'update'].map(method => ({ endpoint: 'schedule/' + method,
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
  return { ctx, service, id, invoke, session, followup, resolveAgent,
    setFlush: (work: () => Promise<void>) => { flush = work },
    setPutHook: (work: () => Promise<void> | undefined) => { putHook = work },
    revoke: () => { active = false }, ready: () => { active = true } }
}

it('keeps the real native Schedule domain and rejects foreign Sessions across create/read/delete', async () => {
  const f = await fixture(), foreign = SessionId('foreign-session')
  expect(f.service.inspect().rpcEndpoints.map(row => row.endpoint).sort())
    .toEqual(['schedule/catalog', 'schedule/delete', 'schedule/history', 'schedule/list', 'schedule/update'])
  const task = await f.service.value.create(f.id, { title: 'Account task', prompt: 'Check results', after_seconds: 3600 })
  expect((await f.service.value.list({ sessionId: f.id })).map(row => row.id)).toEqual([task.id])
  expect((await f.service.value.catalog()).map(row => row.sessionId)).toEqual([f.id])
  expect(await f.invoke('list', { request: { sessionId: f.id } })).toEqual([task])
  await expect(f.service.value.create(foreign, { title: 'Foreign', prompt: 'not allowed', after_seconds: 3600 })).rejects.toThrow('Outside account')
  await expect(f.service.value.list({ sessionId: foreign })).rejects.toThrow('Outside account')
  await expect(f.service.value.history({ sessionId: foreign, id: task.id, limit: 1 })).rejects.toThrow('Outside account')
  await expect(f.service.value.update({ sessionId: foreign, id: task.id, expected: task, title: 'foreign edit' }))
    .rejects.toThrow('Outside account')
  await expect(f.service.value.delete({ sessionId: foreign, id: task.id })).rejects.toThrow('Outside account')
  expect((await f.service.value.list({ sessionId: f.id })).map(row => row.id)).toEqual([task.id])
  f.revoke()
  await expect(f.service.value.catalog()).rejects.toThrow('Original account ended')
})

it('preserves native compare/update, due inbox delivery, history and delete semantics', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const initial = await f.service.value.create(f.id, { title: 'Before', prompt: 'Run report', after_seconds: 10 })
  const edited = await f.service.value.update({ sessionId: f.id, id: initial.id, expected: initial, title: 'After' })
  if (!('record' in edited)) throw new Error('Native update not acknowledged')
  expect(edited.record.title).toBe('After')
  expect(await f.service.value.update({ sessionId: f.id, id: initial.id, expected: initial, title: 'Stale' }))
    .toMatchObject({ updated: false, code: 'schedule_conflict' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.resolveAgent).toHaveBeenCalledWith(f.id)
  expect(f.followup).toHaveBeenCalledTimes(1)
  expect(f.followup.mock.calls[0]![0]).toMatchObject({ source: { kind: 'schedule' } })
  expect(await f.service.value.list({ sessionId: f.id })).toEqual([])
  expect(await f.service.value.catalog()).toMatchObject([{ id: initial.id, status: 'inactive' }])
  expect(await f.service.value.history({ sessionId: f.id, id: initial.id, limit: 10 })).toMatchObject({ id: initial.id,
    records: [expect.objectContaining({ scheduledAt: initial.scheduledAt })] })
  expect(await f.service.value.delete({ sessionId: f.id, id: initial.id })).toMatchObject({ deleted: true })
  expect(await f.service.value.catalog()).toEqual([])
})

it('drains an accepted native delivery before disposal instead of treating observer cancellation as completion', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.setFlush(async () => { entered.resolve(undefined); await release.promise })
  await f.service.value.create(f.id, { title: 'Pending', prompt: 'Run report', after_seconds: 1 })
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
  const task = await f.service.value.create(f.id, { title: 'Failure', prompt: 'Run report', after_seconds: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.followup).toHaveBeenCalledTimes(1)
  expect(await f.service.value.list({ sessionId: f.id })).toMatchObject([{ id: task.id }])
  expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, status: 'active' }])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.followup).toHaveBeenCalledTimes(1)
})

it('keeps the original native task across a confirmed stop and reopens the same domain', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const pool = new MemoryMediaPool(), first = await fixture(pool)
  const task = await first.service.value.create(first.id, { title: 'Persisted', prompt: 'Run report', after_seconds: 3600 })
  await first.ctx.fiber.dispose()
  const reopened = await fixture(pool)
  expect(await reopened.service.value.list({ sessionId: reopened.id })).toMatchObject([{ id: task.id, title: 'Persisted' }])
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(reopened.followup).toHaveBeenCalledTimes(1)
  expect(await reopened.service.value.catalog()).toMatchObject([{ id: task.id, status: 'inactive' }])
})

it('rescans the original overdue task after account readiness and refuses before readiness', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const pool = new MemoryMediaPool(), first = await fixture(pool)
  const task = await first.service.value.create(first.id, { title: 'Overdue', prompt: 'Run report', after_seconds: 1 })
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
  expect(await reopened.service.value.list({ sessionId: reopened.id })).toEqual([])
  expect(await reopened.service.value.catalog()).toMatchObject([{ id: task.id, status: 'inactive' }])
  await reopened.service.resumeAfterReady()
  await vi.advanceTimersByTimeAsync(0)
  expect(reopened.followup).toHaveBeenCalledTimes(1)
})

it('blocks the actual native live-Agent fast path while account admission is revoked', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await fixture()
  const task = await f.service.value.create(f.id, { title: 'Due', prompt: 'Must wait', after_seconds: 1 })
  f.revoke()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
  f.ready()
  expect(await f.service.value.list({ sessionId: f.id })).toMatchObject([{ id: task.id }])
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
  await f.service.value.create(f.id, { title: 'Due', prompt: 'Must wait', after_seconds: 1 })
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
  const writing = f.service.value.create(f.id, { title: 'Pending write', prompt: 'Save first', after_seconds: 3600 })
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
  const task = await f.service.value.create(f.id, { title: 'Accepted', prompt: 'Persist message', after_seconds: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  await entered.promise
  expect(f.followup).toHaveBeenCalledOnce()
  f.revoke()
  expect(f.service.isIdle()).toBe(false)
  release.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  expect(await f.service.value.catalog()).toMatchObject([{ id: task.id, status: 'inactive' }])
  expect(f.followup).toHaveBeenCalledOnce()
})

it('refuses the entire catalog when a stored record names a foreign Session', async () => {
  const f = await fixture(), foreign = SessionId('foreign-session')
  await f.service.value.create(f.id, { title: 'Own', prompt: 'own task', after_seconds: 3600 })
  // Simulate unexpected preexisting domain content without claiming it can be created through the guarded service.
  await ScheduleService.prototype.create.call(f.service.value, foreign,
    { title: 'Foreign secret', prompt: 'not visible', after_seconds: 3600 })
  await expect(f.service.value.catalog()).rejects.toThrow('Outside account')
  expect(await f.service.value.list({ sessionId: f.id })).toHaveLength(1)
})

it('refuses ready notification when the original native rescan implementation changes', async () => {
  const f = await fixture(), replacement = vi.spyOn(ScheduleService.prototype, 'resumeDispatch')
    .mockImplementation(async () => {})
  try { await expect(f.service.resumeAfterReady()).rejects.toThrow('Schedule service is unavailable') }
  finally { replacement.mockRestore() }
})
