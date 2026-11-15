/** Embeddings authorize the actual queued task and candidate immediately before the original durable mutation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScheduleService from '../src/index.ts'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { gatedScheduleBackend, harness, seededTask, seedTasks } from './harness.ts'

const active: Awaited<ReturnType<typeof harness>>[] = []
const SESSION = SessionId('original-session'), OTHER = SessionId('changed-session')
type Prepare = (before: ScheduleTask | undefined, after: ScheduleTask | undefined,
  actorSessionId: SessionId | undefined) => Promise<(() => void) | undefined>
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(prepare: Prepare, options: Parameters<typeof harness>[0] = {}) {
  class GuardedSchedule extends ScheduleService {
    protected override async prepareMutation(before: ScheduleTask | undefined, after: ScheduleTask | undefined,
      actorSessionId: SessionId | undefined): Promise<(() => void) | undefined> {
      return prepare(before, after, actorSessionId)
    }
  }
  const test = await harness({ ...options, serviceClass: GuardedSchedule })
  active.push(test)
  return test
}

function request() {
  return { title: 'Reminder', prompt: 'Do work', timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'session', sessionId: SESSION } } as const
}

it('rechecks creation after asynchronous admission and writes no row or change notice on refusal', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let current = true
  const check = () => { if (!current) throw new Error('Original account ended') }
  const prepare = vi.fn<Prepare>(async () => { entered.resolve(undefined); await release.promise; return check })
  const test = await setup(prepare)
  const changed = vi.fn<() => void>()
  test.ctx.on('schedule/changed', changed)
  const writing = test.service.create(request(), SESSION)
  try {
    await entered.promise
    expect(test.service.isDispatchIdle()).toBe(false)
    current = false
    release.resolve(undefined)
    await expect(writing).rejects.toThrow('Original account ended')
    expect(prepare.mock.calls[0]?.[0]).toBeUndefined()
    expect(prepare.mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'session', sessionId: SESSION } })
    expect(prepare.mock.calls[0]?.[2]).toBe(SESSION)
    expect(await test.service.catalog()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await writing.catch(() => undefined)
  }
})

it('checks the actual target written by an earlier queued edit before a later metadata update', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let block = false
  const pool = new MemoryMediaPool()
  const put = vi.fn(async () => { if (block) { block = false; entered.resolve(undefined); await release.promise } })
  const backend = gatedScheduleBackend(pool, { putRecord: put })
  const prepare = vi.fn<Prepare>(async (before) => {
    if (before?.target.kind === 'session' && before.target.sessionId === OTHER) throw new Error('Changed target is unavailable')
    return undefined
  })
  const test = await setup(prepare, { pool, backend })
  const initial = await test.service.create(request(), SESSION)
  block = true
  const first = test.service.edit({ id: initial.id, action: 'update', patch: { target: { kind: 'session', sessionId: OTHER } } }, SESSION)
  let second: ReturnType<ScheduleService['edit']> | undefined
  try {
    await entered.promise
    second = test.service.edit({ id: initial.id, action: 'update', patch: { title: 'Must not persist' } }, SESSION)
    release.resolve(undefined)
    await expect(first).resolves.toMatchObject({ target: { kind: 'session', sessionId: OTHER } })
    await expect(second).rejects.toThrow('Changed target is unavailable')
    expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ target: { kind: 'session', sessionId: OTHER } })
    expect(await test.service.catalog()).toMatchObject([{ id: initial.id, title: 'Reminder', target: { kind: 'session', sessionId: OTHER } }])
    expect(put).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve(undefined)
    await first.catch(() => undefined)
    await second?.catch(() => undefined)
  }
})

it('refuses single deletion after its admission await without reporting a durable change', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let current = true
  const test = await setup(async (before, after) => {
    if (before === undefined || after !== undefined) return undefined
    entered.resolve(undefined)
    await release.promise
    return () => { if (!current) throw new Error('Original account ended') }
  })
  const initial = await test.service.create(request(), SESSION)
  await vi.advanceTimersByTimeAsync(0)
  const changed = vi.fn<() => void>()
  test.ctx.on('schedule/changed', changed)
  const deleting = test.service.edit({ id: initial.id, action: 'delete' }, SESSION)
  try {
    await entered.promise
    current = false
    release.resolve(undefined)
    await expect(deleting).rejects.toThrow('Original account ended')
    expect(await test.service.catalog()).toMatchObject([{ id: initial.id }])
    expect(changed).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await deleting.catch(() => undefined)
  }
})

it('rechecks every ended task after all batch admission awaits and before the original batch write', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let current = true
  const ids = [ScheduleId('first'), ScheduleId('second')]
  const rows = ids.map(id => seededTask(createAfterScheduleRecord(id, 'Ended', 1, Date.now() - 2_000, 'Do work'),
    { kind: 'session', sessionId: SESSION }, { status: 'ended' }))
  const pool = new MemoryMediaPool(), deleting = vi.fn(async () => {})
  const backend = gatedScheduleBackend(pool, { deleteRecords: deleting })
  const test = await setup(async (before) => {
    if (before?.record.id === ids[1]) { entered.resolve(undefined); await release.promise }
    return () => { if (!current) throw new Error('Original account ended') }
  }, { pool, backend, beforeService: async (_ctx, facility) => { await seedTasks(facility, rows) } })
  const changed = vi.fn<() => void>()
  test.ctx.on('schedule/changed', changed)
  const removing = test.service.deleteInactive()
  try {
    await entered.promise
    current = false
    release.resolve(undefined)
    await expect(removing).rejects.toThrow('Original account ended')
    expect(deleting).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect((await test.service.catalog()).map(row => row.id).sort()).toEqual([...ids].sort())
  } finally {
    release.resolve(undefined)
    await removing.catch(() => undefined)
  }
})

it('honors cancellation during preparation before the original put starts', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const cancel = new AbortController()
  const test = await setup(async () => { entered.resolve(undefined); await release.promise; return undefined })
  const writing = test.service.create(request(), SESSION, cancel.signal)
  try {
    await entered.promise
    cancel.abort(new Error('Cancelled during admission'))
    release.resolve(undefined)
    await expect(writing).rejects.toThrow('Cancelled during admission')
    expect(await test.service.catalog()).toEqual([])
  } finally {
    release.resolve(undefined)
    await writing.catch(() => undefined)
  }
})
