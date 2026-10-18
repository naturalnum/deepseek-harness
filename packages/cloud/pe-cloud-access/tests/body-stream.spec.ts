/** Public ReadableStream behavior, including actual delayed source cancellation; no authentication success fixture. */
import { describe, expect, it, vi } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { trackBody } from '../src/body-stream.ts'

const id = 'body-stream-test' as Branded<'pe-request-id'>

describe('library bridge body ownership', () => {
  it('does not pull before the library consumer and forwards exact-limit multibyte bytes', async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('界'))
      controller.close()
    })
    const body = trackBody(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), 3, id)
    await Promise.resolve()
    expect(pull).not.toHaveBeenCalled()
    const reader = body.stream.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('界')
    expect(await reader.read()).toMatchObject({ done: true })
    await body.settled
    expect(body.failure).toBeUndefined()
  })

  it('rejects one oversized chunk and accumulated raw bytes before forwarding the exceeding chunk', async () => {
    for (const chunks of [[new Uint8Array(4)], [new Uint8Array(2), new Uint8Array(2)]]) {
      let index = 0
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index++]
          if (chunk === undefined) controller.close()
          else controller.enqueue(chunk)
        },
      }, { highWaterMark: 0 })
      const body = trackBody(source, 3, id)
      const reader = body.stream.getReader()
      if (chunks.length > 1) expect((await reader.read()).value?.byteLength).toBe(2)
      await expect(reader.read()).rejects.toMatchObject({ code: 'cloud/capacity' })
      await body.settled
      expect(body.failure?.code).toBe('cloud/capacity')
    }
  })

  it('retains cancellation until the original source cancel Promise settles', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const source = new ReadableStream<Uint8Array>({
      cancel() { entered.resolve(undefined); return gate.promise },
    }, { highWaterMark: 0 })
    const body = trackBody(source, undefined, id)
    let settled = false
    const done = body.settled.then(() => { settled = true })
    const cancelled = body.cancel()
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect(body.cancel()).toBe(cancelled)
    } finally { gate.resolve(undefined) }
    await cancelled
    await done
    expect(settled).toBe(true)
  })

  it('does not expose a source cancellation error or certify its cleanup as successful', async () => {
    const body = trackBody(new ReadableStream<Uint8Array>({
      cancel() { return Promise.reject(new Error('private credential and body')) },
    }, { highWaterMark: 0 }), 10, id)
    const failure = await body.cancel().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(JSON.stringify(failure)).not.toContain('private credential')
    await expect(body.settled).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  })

  it('does not misclassify an errored input as an unconfirmed source cancellation', async () => {
    const cancelled = vi.fn()
    const body = trackBody(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('disconnected input')) }, cancel: cancelled,
    }, { highWaterMark: 0 }), 10, id)
    await expect(body.stream.getReader().read()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await body.cancel()
    await expect(body.settled).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(cancelled).not.toHaveBeenCalled()
  })
})
