/** Finite waiting records on real memory carriers; execution and physical release are outside this component. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { carrier } from './ingress-fixture.ts'
import { ServiceApplicationQueue } from '../src/application-queue.ts'

function input() {
  const value = carrier('/')
  onTestFinished(() => { value.request.destroy(); value.response.destroy(); value.socket.destroy() })
  return value
}

it('does not start the next resource until the original actual operation settles', async () => {
  const queue = new ServiceApplicationQueue(1, 1000), first = input(), second = input(), excess = input()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(), next = vi.fn(async () => {})
  const a = queue.run(first.request, first.response, async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  const b = queue.run(second.request, second.response, next)
  await queue.run(excess.request, excess.response, vi.fn(async () => {}))
  try { expect(next).not.toHaveBeenCalled(); expect(excess.request.destroyed).toBe(true) }
  finally { release.resolve(undefined); await a; await b; await queue.closeActual() }
  expect(next).toHaveBeenCalledOnce()
})

it('withdraws waiting requests on close but joins the active original operation', async () => {
  const queue = new ServiceApplicationQueue(1, 1000), first = input(), waiting = input()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(), next = vi.fn(async () => {})
  const a = queue.run(first.request, first.response, async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  const b = queue.run(waiting.request, waiting.response, next)
  const closing = queue.closeActual(), done = vi.fn()
  void closing.then(done)
  try { await b; expect(waiting.request.destroyed).toBe(true); expect(done).not.toHaveBeenCalled() }
  finally { release.resolve(undefined); await a; await closing }
  expect(next).not.toHaveBeenCalled()
})
