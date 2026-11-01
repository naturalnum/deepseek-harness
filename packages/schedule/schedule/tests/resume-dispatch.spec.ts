/** Public Host-ready nudge uses the original native scheduler; no model completion is implied. */
import { expect, it, vi } from 'vitest'
import { agentFor, harness } from './harness.ts'

it('reconsiders an overdue stored task after native resolution becomes available', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await harness()
  try {
    const agent = agentFor(f.ctx, 'ready-later')
    const task = await f.service.create(agent.session.id, { title: 'Due', prompt: 'Check report', after_seconds: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.resolve).toHaveBeenCalledOnce()
    expect(await f.service.list({ sessionId: agent.session.id })).toMatchObject([{ id: task.id }])
    f.resolve.mockResolvedValue({ agent })
    await f.service.resumeDispatch()
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.followup.mock.calls[0]![0]).toMatchObject({ source: { kind: 'schedule' } })
    expect(await f.service.list({ sessionId: agent.session.id })).toEqual([])
    await f.service.resumeDispatch()
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.followup).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose(); vi.useRealTimers() }
  await expect(f.service.resumeDispatch()).rejects.toThrow('Schedule service is stopping')
})

it('retains the ready rescan when the original first resolution is still settling', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T01:00:00.000Z'))
  const f = await harness(), pending = Promise.withResolvers<never>()
  try {
    const agent = agentFor(f.ctx, 'ready-during-resolution')
    f.resolve.mockImplementationOnce(() => pending.promise)
    await f.service.create(agent.session.id, { title: 'Due', prompt: 'Check report', after_seconds: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.resolve).toHaveBeenCalledTimes(1)
    f.resolve.mockResolvedValue({ agent })
    await f.service.resumeDispatch()
    pending.reject(new Error('Original preparation refused before ready'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.resolve).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledOnce()
  } finally { pending.reject(new Error('test finished')); await f.ctx.fiber.dispose(); vi.useRealTimers() }
})

it('refuses to install or replace delivery admission after native initialization', async () => {
  const f = await harness()
  try {
    expect(() => { f.service.installDispatchAdmission(async () => () => {}) })
      .toThrow('Schedule delivery admission is unavailable')
  } finally { await f.ctx.fiber.dispose() }
})
