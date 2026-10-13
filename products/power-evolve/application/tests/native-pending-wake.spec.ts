/** Public AgentLoop driver, real inbox and native events; only the external model adapter is scripted. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, test, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { NativePendingWake } from '../src/host/native-pending-wake.ts'

async function harness(maxAttempts = 3, retryDelayMs = 1) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const id = SessionId(randomUUID()), log: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === id) log.push(event) })
  const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  let alive = true
  const pump = new NativePendingWake(handle.agent, () => alive, { maxAttempts, retryDelayMs })
  onTestFinished(async () => { await pump.close(); alive = false; await handle.dispose() })
  const message = createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } })
  return { ctx, agent: handle.agent, handle, adapter, log, pump, message, retire: () => { alive = false } }
}

test('a notification during a healthy before-turn await survives hook failure and wakes the original input after settle', async () => {
  const f = await harness(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let attempts = 0
  f.agent.onBeforeTurn(async () => {
    attempts++
    if (attempts === 1) { entered.resolve(undefined); await release.promise; throw new Error('preparation unavailable') }
    f.pump.acknowledge(f.pump.pendingRevision)
  })
  f.agent.followup(f.message)
  await entered.promise
  f.agent.wakePending()
  f.pump.notify(10)
  f.pump.notify(10)
  expect(f.agent.inbox.nextTurn.map(input => input.id)).toEqual([f.message.id])
  release.resolve(undefined)
  await f.pump.whenSettled()
  expect(attempts).toBe(2)
  expect(f.adapter.requests).toHaveLength(1)
  expect(f.log.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([f.message.id])
  expect(f.log.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(f.pump.failure).toBeUndefined()
})

test('notifications directly wake a waiting hook without the hook awaiting its own driver or pump', async () => {
  const f = await harness(), entered = Promise.withResolvers<undefined>(), driver = new AbortController()
  f.agent.onBeforeTurn(async (_turn, signal) => {
    entered.resolve(undefined)
    const revision = await f.pump.waitForChange(0, signal)
    f.pump.acknowledge(revision)
  })
  f.agent.followup(f.message)
  await entered.promise
  f.pump.notify(2)
  expect(await f.pump.waitForChange(0, driver.signal)).toBe(2)
  await f.pump.whenSettled()
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(1)
  f.pump.notify(1)
  expect(f.pump.pendingRevision).toBe(2)
  await f.pump.whenSettled()
})

test('a bounded failed preparation retains revision and input, and a repeat notification can retry without reinsert', async () => {
  const f = await harness(2)
  let fail = true, attempts = 0
  f.agent.onBeforeTurn(() => { attempts++; if (fail) throw new Error('prepare failed'); f.pump.acknowledge(3) })
  f.agent.send(f.message, 'next-turn', false)
  f.pump.notify(3)
  await f.pump.whenSettled()
  expect(attempts).toBe(2)
  expect(f.pump.pendingRevision).toBe(3)
  expect(f.pump.failure).toMatchObject({ code: 'native_wake_retry_limit' })
  expect(f.agent.inbox.nextTurn.map(input => input.id)).toEqual([f.message.id])
  expect(f.log.filter(event => event.type === 'turn/start')).toHaveLength(0)
  fail = false
  f.pump.notify(3)
  await f.pump.whenSettled()
  expect(f.adapter.requests).toHaveLength(1)
  expect(f.log.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([f.message.id])
  expect(f.pump.failure).toBeUndefined()
})

test('a consumed input that failed assembly is never reinserted by retrying pending wake', async () => {
  const f = await harness(2)
  f.ctx.on('agent/pre-step', () => { throw new Error('after native claim') })
  f.agent.send(f.message, 'next-turn', false)
  f.pump.notify(4)
  await f.pump.whenSettled()
  expect(f.agent.inbox.nextTurn).toHaveLength(0)
  expect(f.adapter.requests).toHaveLength(0)
  expect(f.log.filter(event => event.type === 'user/message')).toHaveLength(0)
  expect(f.log.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(f.pump.failure).toMatchObject({ code: 'native_wake_retry_limit' })
})

test('closing directly rejects a waiting hook and cancels the pump idle observation', async () => {
  const f = await harness(), entered = Promise.withResolvers<undefined>()
  f.agent.onBeforeTurn(async (_turn, signal) => { entered.resolve(undefined); await f.pump.waitForChange(5, signal) })
  f.agent.followup(f.message)
  await entered.promise
  f.pump.notify(5)
  await setImmediate()
  await f.pump.close()
  await f.agent.whenIdle()
  expect(f.agent.inbox.nextTurn.map(input => input.id)).toEqual([f.message.id])
  f.pump.notify(6)
  await f.pump.whenSettled()
  expect(f.pump.pendingRevision).toBe(5)
  expect(f.adapter.requests).toHaveLength(0)
  await expect(async () => f.pump.waitForChange(5, new AbortController().signal)).rejects.toThrow('native_wake_closed')
})

test('closing an idle wait does not cancel or dispose an unrelated running Agent driver', async () => {
  const f = await harness(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.agent.onBeforeTurn(async () => { entered.resolve(undefined); await release.promise })
  f.agent.followup(f.message)
  await entered.promise
  f.pump.notify(6)
  await setImmediate()
  await f.pump.close()
  expect(f.agent.status).toBe('running')
  release.resolve(undefined)
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(1)
})

test('closing a retry delay settles promptly without another wake', async () => {
  const f = await harness(3, 60_000)
  let attempts = 0
  f.agent.onBeforeTurn(() => { attempts++; throw new Error('prepare failed') })
  f.agent.send(f.message, 'next-turn', false)
  f.pump.notify(7)
  await expect.poll(() => attempts).toBe(1)
  await f.pump.close()
  expect(attempts).toBe(1)
  expect(f.pump.failure).toBeUndefined()
})

test('caller cancellation removes only its own revision waiter', async () => {
  const f = await harness(), signal = new AbortController(), error = new Error('caller cancelled')
  const aborted = f.pump.waitForChange(2, signal.signal).catch((value: unknown) => value)
  signal.abort(error)
  expect(await aborted).toBe(error)
  expect(() => f.pump.waitForChange(2, signal.signal)).toThrow('caller cancelled')
  const wait = f.pump.waitForChange(2, new AbortController().signal)
  f.pump.notify(2)
  await setImmediate()
  f.pump.notify(3)
  expect(await wait).toBe(3)
  f.pump.acknowledge(3)
  await f.pump.whenSettled()
})

test('a retired Session never wakes or revives its Agent, including retirement while awaiting the driver', async () => {
  const f = await harness(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.agent.onBeforeTurn(async () => { entered.resolve(undefined); await release.promise; throw new Error('retired') })
  f.agent.followup(f.message)
  await entered.promise
  f.pump.notify(8)
  await setImmediate()
  f.retire(); release.resolve(undefined)
  await f.pump.whenSettled()
  await f.handle.dispose()
  f.pump.notify(9)
  await f.pump.whenSettled()
  expect(f.adapter.requests).toHaveLength(0)
})

test('closing synchronously from a hook cancels the following idle observation without awaiting itself', async () => {
  const f = await harness()
  let closing: Promise<void> | undefined
  f.agent.onBeforeTurn(() => { closing = f.pump.close() })
  f.agent.send(f.message, 'next-turn', false)
  f.pump.notify(10)
  await f.pump.whenSettled()
  await closing
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(1)
  expect(f.pump.failure).toBeUndefined()
})

test('revision acknowledgement cannot exceed observed input, and invalid deployment limits fail at construction', async () => {
  const f = await harness()
  expect(() =>{  f.pump.acknowledge(1) }).toThrow('native_wake_unobserved_revision')
  expect(() =>{  f.pump.notify(-2) }).toThrow()
  expect(() => new NativePendingWake(f.agent, () => true, { maxAttempts: 0, retryDelayMs: 1 })).toThrow('positive safe integers')
  expect(() => new NativePendingWake(f.agent, () => true, { maxAttempts: 1, retryDelayMs: 0 })).toThrow('positive safe integers')
  await f.pump.whenSettled()
})
