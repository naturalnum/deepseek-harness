import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { afterEach, expect, it, vi } from 'vitest'
import { createFileReadTiming } from '../src/file-read-timing.ts'
import { PeAccountRuntime } from '../src/root.ts'
import { RuntimeRootConfigSchema } from '../src/root-config.ts'
import { rootConfig } from './root-control-fixture.ts'

const reporters: ReturnType<typeof createFileReadTiming>[] = []
type TimingSink = Parameters<typeof createFileReadTiming>[0]
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.close()
  vi.useRealTimers()
})

function reporter(sink = vi.fn<TimingSink>()) {
  const value = createFileReadTiming(sink)
  reporters.push(value)
  return { value, sink }
}

it('aggregates synchronous guards without retaining their result or exposing inputs', () => {
  vi.useFakeTimers()
  const { value, sink } = reporter()
  const result = { privateValue: 'not a diagnostic field' }
  expect(value.measure('root-full', () => result)).toBe(result)
  value.measure('root-full', () => undefined)
  expect(sink).not.toHaveBeenCalled()
  vi.advanceTimersByTime(5000)
  expect(sink).toHaveBeenCalledTimes(1)
  const observed = sink.mock.calls[0]?.[0], row = observed?.rows[0]
  expect(observed?.nominalIntervalMs).toBe(5000)
  expect(observed?.rows).toHaveLength(1)
  expect(row).toMatchObject({ stage: 'root-full', calls: 2 })
  expect(row?.totalUs).toBeGreaterThanOrEqual(0)
  expect(row?.maxUs).toBeGreaterThanOrEqual(0)
  expect(Object.keys(row ?? {}).sort()).toEqual(['calls', 'maxUs', 'stage', 'totalUs'])
  expect(JSON.stringify(sink.mock.calls)).not.toContain(result.privateValue)
  vi.advanceTimersByTime(5000)
  expect(sink).toHaveBeenCalledTimes(1)
})

it('preserves original guard failures even when reporting also fails', () => {
  vi.useFakeTimers()
  const fault = new Error('original guard refusal')
  const { value } = reporter(vi.fn<TimingSink>(() => { throw new Error('observation failed') }))
  expect(() => value.measure('account-current', () => { throw fault })).toThrow(fault)
  expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
  expect(value.measure('account-current', () => 42)).toBe(42)
  expect(() => { value.close() }).not.toThrow()
})

it('keeps two Root reporters independent and flushes each tail only once', () => {
  vi.useFakeTimers()
  const first = reporter(), second = reporter()
  first.value.measure('account-plan', () => undefined)
  second.value.measure('file-inventory', () => undefined)
  first.value.close()
  first.value.close()
  expect(first.sink).toHaveBeenCalledTimes(1)
  expect(second.sink).not.toHaveBeenCalled()
  second.value.close()
  expect(second.sink.mock.calls[0]?.[0].rows.map(row => [row.stage, row.calls])).toEqual([['file-inventory', 1]])
  expect(vi.getTimerCount()).toBe(0)
})

it('executes later guards after closure without collecting or reporting again', () => {
  vi.useFakeTimers()
  const { value, sink } = reporter()
  value.measure('root-captured', () => undefined)
  value.close()
  expect(value.measure('root-captured', () => 17)).toBe(17)
  const fault = new Error('late guard failure')
  expect(() => value.measure('root-captured', () => { throw fault })).toThrow(fault)
  value.close()
  vi.advanceTimersByTime(10000)
  expect(sink).toHaveBeenCalledTimes(1)
})

it('keeps collection off by default and disposes only the owning Root timer', async () => {
  vi.useFakeTimers()
  const plain = new Context(), first = new Context(), second = new Context()
  const config = { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 }
  try {
    new PeAccountRuntime(plain, config)
    expect(vi.getTimerCount()).toBe(0)
    new PeAccountRuntime(first, config, true)
    new PeAccountRuntime(second, config, true)
    expect(vi.getTimerCount()).toBe(2)
    await first.fiber.dispose()
    expect(vi.getTimerCount()).toBe(1)
    await second.fiber.dispose()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await plain.fiber.dispose()
    await first.fiber.dispose()
    await second.fiber.dispose()
  }
})

it('requires an explicit boolean in trusted Root deployment configuration', () => {
  const config = rootConfig('/tmp/file-read-timing-fixture')
  expect(RuntimeRootConfigSchema(config).fileReadTiming).toBeUndefined()
  expect(RuntimeRootConfigSchema({ ...config, fileReadTiming: false }).fileReadTiming).toBe(false)
  expect(RuntimeRootConfigSchema({ ...config, fileReadTiming: true }).fileReadTiming).toBe(true)
  expect(() => z.resolve({ ...config, fileReadTiming: 'true' }, RuntimeRootConfigSchema, {})).toThrow()
})
