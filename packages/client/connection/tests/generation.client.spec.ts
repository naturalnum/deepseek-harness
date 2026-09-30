import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ConnectionGenerationSource,
  type ConnectionHandle,
} from '../src/client/index.ts'

type BrowserGlobal = {
  location?: { hostname: string }
}

const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  delete (globalThis as BrowserGlobal).location
  await Promise.all([...contexts].map(async ctx => ctx.fiber.dispose()))
  contexts.clear()
})

async function mount(): Promise<ConnectionHandle> {
  ;(globalThis as BrowserGlobal).location = { hostname: 'localhost' }
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin({ apply, inject: [] })
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('plugin did not provide Connection')
  return connection
}

describe('Connection generation facts', () => {
  it('public stop aborts the active source once and stale loop controls preserve a later owner', async () => {
    const connection = await mount()
    const signals: AbortSignal[] = []
    connection.registerGenerationSource((signal, ready) => {
      signals.push(signal)
      ready({ home: '/home/fixture' })
      return new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    connection.stop()
    const first = connection.start({})
    await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(1) })
    connection.stop()
    connection.stop()
    connection.reconnect()
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(1)
    expect(connection.generation.getSnapshot()).toBeUndefined()
    expect(connection.state.getSnapshot()).toBeUndefined()
    const second = connection.start({})
    try {
      await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(2) })
      first.stop()
      expect(connection.generation.getSnapshot()?.id).toBe(2)
      expect(signals[1]?.aborted).toBe(false)
    } finally { second.stop() }
  })

  it('public stop cancels pending reconnect without disabling ordinary recovery before the stop', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const connection = await mount()
    let available = false
    let attempts = 0
    connection.registerGenerationSource((signal, ready) => {
      attempts++
      if (!available) return Promise.reject(new Error('network unavailable'))
      ready({ home: '/home/recovered' })
      return new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    const loop = connection.start({}, { backoffBaseMs: 10, backoffMaxMs: 10, generationReadyTimeoutMs: 100 })
    try {
      await vi.advanceTimersByTimeAsync(0)
      available = true
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts).toBe(2)
      expect(connection.state.getSnapshot()).toBe('connected')
      connection.reconnect()
      available = false
      await vi.advanceTimersByTimeAsync(0)
      expect(connection.state.getSnapshot()).toBe('connecting')
      connection.stop()
      const stoppedAttempts = attempts
      await vi.advanceTimersByTimeAsync(10_000)
      expect(attempts).toBe(stoppedAttempts)
      expect(connection.state.getSnapshot()).toBeUndefined()
    } finally { loop.stop(); vi.useRealTimers(); warn.mockRestore() }
  })

  it('publishes ready-frame Host facts and retracts them when the loop stops', async () => {
    const connection = await mount()
    const source: ConnectionGenerationSource = (signal, ready) => {
      ready({ home: '/home/from-ready' })
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    connection.registerGenerationSource(source)
    const seen: Array<string | undefined> = []
    const stopListening = connection.generation.subscribe(() => {
      seen.push(connection.generation.getSnapshot()?.host.home)
    })
    const loop = connection.start({}, {
      backoffBaseMs: 1,
      backoffFactor: 2,
      backoffMaxMs: 8,
      generationReadyTimeoutMs: 100,
    })

    await vi.waitFor(() => {
      expect(connection.generation.getSnapshot()).toEqual({
        id: 1,
        host: { home: '/home/from-ready' },
      })
    })
    loop.stop()
    expect(connection.generation.getSnapshot()).toBeUndefined()
    expect(seen).toEqual(['/home/from-ready', undefined])
    stopListening()
  })
})
