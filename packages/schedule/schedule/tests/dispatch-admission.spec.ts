/** Embedding admission uses the original dispatch, persistence, execution slots, and shutdown queue. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { ScheduleRuntime, type ScheduleDispatchAdmission } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { agentFor, gatedScheduleBackend, harness, seededTask, type HarnessAgent } from './harness.ts'

const active: Awaited<ReturnType<typeof harness>>[] = []
const runtimes: ScheduleRuntime[] = []
const SESSION = SessionId('admitted-session')
const LIMITS = { retention: { days: 30, records: 200 }, newSessionIntervalMs: 3_600_000 }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function task(target: ScheduleTask['target'] = { kind: 'session', sessionId: SESSION }): ScheduleTask {
  return seededTask(createAfterScheduleRecord(ScheduleId('admitted-task'), 'Reminder', 1, Date.now() - 2_000, 'Do work'), target)
}

async function setup(tasks: ScheduleTask[], admission: ScheduleDispatchAdmission) {
  const test = await harness()
  active.push(test)
  const agent = agentFor(test.ctx, SESSION)
  const agents = new Map<string, HarnessAgent>([[SESSION, agent]])
  test.resolve.mockImplementation(async (id) => {
    const found = agents.get(id)
    return found === undefined ? { error: new RemoteError('session/not-found', `missing ${id}`, { sessionId: id }) } : { agent: found }
  })
  test.createSession.mockImplementation(async (request) => {
    if (request.sessionId === undefined) throw new Error('Expected the original reserved Session id')
    agents.set(request.sessionId, agentFor(test.ctx, request.sessionId))
    return { sessionId: request.sessionId }
  })
  const commit = vi.fn(async (next: ScheduleTask) => {
    const index = tasks.findIndex(current => current.record.id === next.record.id)
    tasks[index] = next
  })
  const runtime = new ScheduleRuntime(test.ctx, () => tasks, work => work(), commit, () => {}, LIMITS, test.resolveAgent, admission)
  runtimes.push(runtime)
  return { ...test, agent, agents, runtime, commit }
}

it.each<ScheduleTask['target']>([
  { kind: 'session', sessionId: SESSION },
  { kind: 'new_once', sessionId: SessionId('reserved-session'), create: {} },
  { kind: 'new', create: {} },
])('refuses $kind before target activation, reservation, creation, or acknowledgement', async (target) => {
  const original = task(target), tasks = [original]
  const admit = vi.fn<ScheduleDispatchAdmission>(async () => { throw new Error('Embedding is unavailable') })
  const test = await setup(tasks, admit)
  vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  expect(admit).toHaveBeenCalledWith(original)
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
  expect(test.agent.followup).not.toHaveBeenCalled()
  expect(test.commit).not.toHaveBeenCalled()
  expect(tasks).toEqual([original])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(admit).toHaveBeenCalledOnce()
})

it('rechecks a manual delivery after the embedding admission await', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let current = true
  const check = () => { if (!current) throw new Error('Original account ended') }
  const tasks = [task()]
  const test = await setup(tasks, async () => { entered.resolve(undefined); await release.promise; return check })
  const running = test.runtime.runNow(tasks[0]!.record.id)
  try {
    await entered.promise
    current = false
    release.resolve(undefined)
    await expect(running).rejects.toThrow('Original account ended')
    expect(test.resolve).not.toHaveBeenCalled()
    expect(test.agent.followup).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await running.catch(() => undefined)
  }
})

it('rechecks the original target resolver and rescans only when explicitly requested again', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let current = true
  const check = () => { if (!current) throw new Error('Original account ended') }
  const tasks = [task()]
  const test = await setup(tasks, async () => check)
  vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
  test.resolve.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return { agent: test.agent } })
  try {
    test.runtime.requestDrive()
    await entered.promise
    expect(test.runtime.isDispatchIdle()).toBe(false)
    current = false
    release.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(test.agent.followup).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
    expect(tasks[0]?.status).toBe('active')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(test.resolve).toHaveBeenCalledOnce()
    current = true
    test.runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.agent.followup).toHaveBeenCalledOnce()
    expect(tasks[0]?.status).toBe('ended')
  } finally {
    release.resolve(undefined)
  }
})

it('drains an accepted enqueue through flush and receipt after admission is withdrawn', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const idle = Promise.withResolvers<undefined>()
  let current = true
  const check = () => { if (!current) throw new Error('Original account ended') }
  const tasks = [task()]
  const test = await setup(tasks, async () => check)
  vi.spyOn(test.agent, 'whenIdle').mockImplementation(async () => { await idle.promise })
  test.flush.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  try {
    test.runtime.requestDrive()
    await entered.promise
    expect(test.agent.followup).toHaveBeenCalledOnce()
    expect(test.runtime.isDispatchIdle()).toBe(false)
    current = false
    release.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { targetSessionId: SESSION } })
    expect(test.commit).toHaveBeenCalledOnce()
    expect(test.runtime.isDispatchIdle()).toBe(false)
    idle.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(test.runtime.isDispatchIdle()).toBe(true)
    expect(test.agent.followup).toHaveBeenCalledOnce()
  } finally {
    release.resolve(undefined)
    idle.resolve(undefined)
  }
})

it('keeps a committed new-target reservation when admission changes before Session creation', async () => {
  let current = true
  const check = () => { if (!current) throw new Error('Original account ended') }
  const tasks = [task({ kind: 'new', create: {} })]
  const test = await setup(tasks, async () => check)
  vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
  const original = test.commit.getMockImplementation()
  if (original === undefined) throw new Error('Missing original task persistence')
  test.commit.mockImplementationOnce(async (next) => { await original(next); current = false })
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  const reserved = tasks[0]?.pendingDelivery?.targetSessionId
  expect(reserved).toBeDefined()
  expect(tasks[0]?.status).toBe('active')
  expect(test.createSession).not.toHaveBeenCalled()
  current = true
  test.runtime.requestDrive()
  await vi.advanceTimersByTimeAsync(0)
  expect(test.createSession).toHaveBeenCalledExactlyOnceWith({ sessionId: reserved })
  expect(tasks[0]).toMatchObject({ status: 'ended', lastDelivery: { targetSessionId: reserved } })
  expect(tasks[0]?.pendingDelivery).toBeUndefined()
})

it('prevents enqueue when shutdown starts during target restoration', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const tasks = [task()]
  const test = await setup(tasks, async () => () => {})
  vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
  test.resolve.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return { agent: test.agent } })
  test.runtime.requestDrive()
  try {
    await entered.promise
    let closed = false
    const closing = test.runtime.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(undefined)
    await closing
    expect(test.agent.followup).not.toHaveBeenCalled()
    expect(test.commit).not.toHaveBeenCalled()
    expect(tasks[0]?.status).toBe('active')
    expect(test.runtime.isDispatchIdle()).toBe(true)
  } finally {
    release.resolve(undefined)
  }
})

it('installs admission once before dispatch initialization and rejects late replacement', async () => {
  const admission: ScheduleDispatchAdmission = async () => () => {}
  const test = await harness({ direct: true, beforeDirectInit(service) {
    expect(service.isDispatchIdle()).toBe(false)
    service.installDispatchAdmission(admission)
    expect(() => service.installDispatchAdmission(admission)).toThrow('installed once before initialization')
  } })
  active.push(test)
  expect(() => test.service.installDispatchAdmission(admission)).toThrow('installed once before initialization')
  await test.service.resumeDispatch()
  await vi.advanceTimersByTimeAsync(0)
  expect(test.service.isDispatchIdle()).toBe(true)
})

it('reports admitted management writes as busy and drains them before original storage closes', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const pool = new MemoryMediaPool()
  const backend = gatedScheduleBackend(pool, { putRecord: async () => { entered.resolve(undefined); await release.promise } })
  const test = await harness({ pool, backend })
  active.push(test)
  const writing = test.service.create({
    title: 'Future reminder', prompt: 'Do work', timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'session', sessionId: SESSION },
  })
  try {
    await entered.promise
    expect(test.service.isDispatchIdle()).toBe(false)
    let closed = false
    const closing = Promise.resolve(test.ctx.fiber.dispose()).then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(undefined)
    await expect(writing).resolves.toMatchObject({ target: { kind: 'session', sessionId: SESSION } })
    await closing
    expect(closed).toBe(true)
    await expect(test.service.resumeDispatch()).rejects.toThrow('Schedule service is stopping')
  } finally {
    release.resolve(undefined)
    await writing.catch(() => undefined)
  }
})
