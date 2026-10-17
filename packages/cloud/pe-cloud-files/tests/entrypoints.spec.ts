import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'

const limits = {
  maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1,
  maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 10_000,
  workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128,
  replyOverheadBytes: 128, readyTimeoutMs: 2000, drainTimeoutMs: 50,
  helperPath: '/not-loaded/test.node', maxReadBytes: 100, maxPathBytes: 1024, maxResolveRetries: 2, readChunkBytes: 16,
} satisfies root.Config

describe('cloud files unavailable production integration', () => {
  it('requires explicit finite root budgets', () => {
    expect(() => root.Config({})).toThrow()
    expect(() => root.Config({ ...limits, waitTimeoutMs: Number.POSITIVE_INFINITY })).toThrow()
    expect(root.Config(limits)).toEqual(limits)
  })

  it('does not publish a pool or native filesystem without required root integration', async () => {
    const context = new Context()
    await expect(root.apply(context, limits)).rejects.toThrow(/requires/)
    expect(context.get('fs')).toBeUndefined()
  })

  it('does not mount a filesystem from account config identity or host defaults', () => {
    const context = new Context()
    expect(() => account.apply(context, {})).toThrow(/runtime-bound account/)
    expect(context.get('fs')).toBeUndefined()
  })
})
