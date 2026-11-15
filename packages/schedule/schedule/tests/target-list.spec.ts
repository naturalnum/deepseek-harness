/** Target filtering precedes count and pagination without activating a Session or broadening a reservation. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { harness, seededTask, seedTasks } from './harness.ts'

const active: Awaited<ReturnType<typeof harness>>[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.useRealTimers()
})

it('counts and pages only explicit existing targets while preserving the unfiltered Native list', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-16T00:00:00Z')
  const own = SessionId('own'), other = SessionId('other')
  const record = (id: string) => createAfterScheduleRecord(ScheduleId(id), id, 3600, Date.now(), 'Do work')
  const tasks = [
    seededTask(record('own-active'), { kind: 'session', sessionId: own }),
    seededTask(record('own-ended'), { kind: 'session', sessionId: own }, { status: 'ended' }),
    seededTask(record('other-active'), { kind: 'session', sessionId: other }),
    seededTask(record('reserved-own'), { kind: 'new_once', sessionId: own, create: {} }),
    seededTask(record('involved-own'), { kind: 'new', create: {} }, { involvedSessionIds: [own] }),
  ]
  const test = await harness({ beforeService: async (_ctx, facility) => { await seedTasks(facility, tasks) } })
  active.push(test)
  expect(await test.service.list({ targetSessionId: own, limit: 1, offset: 1 })).toMatchObject({
    items: [{ id: ScheduleId('own-ended') }], shown: 1, total: 2, limit: 1, offset: 1,
  })
  expect(await test.service.list({ targetSessionId: own, active: true })).toMatchObject({
    items: [{ id: ScheduleId('own-active') }], shown: 1, total: 1,
  })
  expect(await test.service.list({ targetSessionId: SessionId('absent') })).toMatchObject({ items: [], shown: 0, total: 0 })
  expect(await test.service.list()).toMatchObject({ total: 5, shown: 5 })
  expect(test.resolve).not.toHaveBeenCalled()
  expect(test.createSession).not.toHaveBeenCalled()
})
