import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const recorded = new WeakMap<Agent, SessionEvent[]>()

async function harness(script = [textResponse('one'), textResponse('two'), textResponse('three')]) {
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    const fiber = await ctx.plugin(plugin)
    onTestFinished(async () => { await fiber.dispose() })
  }
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  onTestFinished(async () => { await loop.dispose() })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const id = SessionId('employee6-before-turn')
  const log: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === id) log.push(event) })
  const handle = await ctx.agents.create({
    sessionId: id, agentOptions: { provider: 'mock', model: 'mock' },
  })
  recorded.set(handle.agent, log)
  onTestFinished(async () => { await handle.dispose() })
  return { ctx, agent: handle.agent, adapter, handle }
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function boundaries(agent: Agent) {
  return events(agent).filter(event => event.type === 'turn/start' || event.type === 'turn/end')
}

function events(agent: Agent): readonly SessionEvent[] {
  const log = recorded.get(agent)
  if (log === undefined) throw new Error('Agent is not owned by this harness')
  return log
}

function admitted(agent: Agent) {
  let turn = 0
  return events(agent).flatMap((event) => {
    if (event.type === 'turn/start') turn = event.data.turn
    return event.type === 'user/message' ? [[turn, event.data.id]] : []
  })
}

describe('public before-turn preparation and pending wake', () => {
  it('opens and claims synchronously without hooks, before immediate cancellation', async () => {
    const { agent } = await harness()
    const input = message('original')
    agent.followup(input)
    expect(boundaries(agent).map(event => event.type)).toEqual(['turn/start'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.remove(input.id)).toBe(false)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
    expect(boundaries(agent)).toHaveLength(2)
    expect(events(agent).filter(event => event.type === 'user/message')).toHaveLength(0)
  })

  it('wakes three queued messages as distinct native turns without another input', async () => {
    const { agent, adapter } = await harness()
    const inputs = ['A', 'B', 'C'].map(message)
    for (const input of inputs) agent.send(input, 'next-turn', false)
    expect(boundaries(agent)).toHaveLength(0)
    const queuedEvents = events(agent).length
    agent.wakePending()
    expect(events(agent).slice(queuedEvents).map(event => event.type))
      .toEqual(['turn/start', 'agent/inbox/spliced'])
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(admitted(agent)).toEqual(inputs.map((input, index) => [index + 1, input.id]))
    expect(boundaries(agent).filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2, 3])
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('awaits ordered hooks before claim and records no boundary during preparation', async () => {
    const { agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const order: string[] = []
    agent.onBeforeTurn(async (turn) => {
      order.push(`first:${turn}`)
      entered.resolve(undefined)
      await release.promise
      order.push('ready')
    })
    agent.onBeforeTurn((turn) => { order.push(`second:${turn}`) })
    const input = message('held')
    agent.followup(input)
    await entered.promise
    expect(agent.status).toBe('running')
    expect(boundaries(agent)).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(value => value.id)).toEqual([input.id])
    expect(adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    await agent.whenIdle()
    expect(order).toEqual(['first:1', 'ready', 'second:1'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('reports failed preparation, preserves original identity, and retries with no new input', async () => {
    const { ctx, agent, adapter } = await harness()
    const failure = new Error('preparation failed')
    const failures: { turn: number; step: number; error: unknown }[] = []
    ctx.on('agent/error', ({ turn, step, error }) => { failures.push({ turn, step, error }) })
    let later = 0
    const remove = agent.onBeforeTurn(() => { throw failure })
    agent.onBeforeTurn(() => { later++ })
    const input = message('survives')
    agent.followup(input)
    await agent.whenIdle()
    expect(failures).toEqual([{ turn: 1, step: 0, error: failure }])
    expect(later).toBe(0)
    expect(boundaries(agent)).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(value => value.id)).toEqual([input.id])
    expect(adapter.requests).toHaveLength(0)
    remove()
    agent.wakePending()
    await agent.whenIdle()
    expect(later).toBe(1)
    expect(events(agent).filter(event => event.type === 'user/message')
      .map(event => event.data.id)).toEqual([input.id])
    expect(boundaries(agent).filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
  })

  it.each(['user', 'disposed'] as const)('preserves input canceled during preparation with cause %s', async (kind) => {
    const { ctx, agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    let visits = 0
    let errors = 0
    ctx.on('agent/error', () => { errors++ })
    agent.onBeforeTurn(async (_turn, signal) => {
      if (++visits !== 1) return
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const input = message('pending')
    agent.followup(input)
    await entered.promise
    agent.cancel({ kind }, { keepInbox: true })
    agent.wakePending()
    await agent.whenIdle()
    expect(errors).toBe(0)
    if (kind === 'disposed') {
      expect(boundaries(agent)).toHaveLength(0)
      expect(agent.inbox.nextTurn.map(value => value.id)).toEqual([input.id])
      expect(adapter.requests).toHaveLength(0)
      agent.wakePending()
      await agent.whenIdle()
    }
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).filter(event => event.type === 'user/message')
      .map(event => event.data.id)).toEqual([input.id])
    expect(boundaries(agent).filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
  })

  it('keeps default cancel clearing semantics during preparation', async () => {
    const { agent, adapter } = await harness()
    agent.onBeforeTurn(async (_turn, signal) => {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    agent.followup(message('discard'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(boundaries(agent)).toHaveLength(0)
    agent.wakePending()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('checks cancellation again after asynchronous preparation settles', async () => {
    const { agent } = await harness()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    agent.onBeforeTurn(() => release.promise)
    const input = message('still pending')
    agent.followup(input)
    const cancellation = release.promise.then(() => { agent.cancel({ kind: 'user' }, { keepInbox: true }) })
    release.resolve(undefined)
    await cancellation
    await agent.whenIdle()
    expect(boundaries(agent)).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(value => value.id)).toEqual([input.id])
  })

  it('latches pending wake behind maintenance without inserting another input', async () => {
    const { agent, adapter } = await harness()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const input = message('after maintenance')
    agent.send(input, 'next-turn', false)
    const maintenance = agent.runMaintenance(() => release.promise)
    agent.wakePending()
    expect(boundaries(agent)).toHaveLength(0)
    expect(agent.status).toBe('idle')
    release.resolve(undefined)
    await maintenance
    await agent.whenIdle()
    expect(admitted(agent)).toEqual([[1, input.id]])
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps next-step and next-turn identities and targets while waking', async () => {
    const { agent, adapter } = await harness()
    const steering = message('steering')
    const first = message('queued one')
    const second = message('queued two')
    agent.inject(steering)
    agent.send(first, 'next-turn', false)
    agent.send(second, 'next-turn', false)
    agent.wakePending()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(admitted(agent)).toEqual([[1, steering.id], [1, first.id], [2, second.id]])
    expect(events(agent).filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted.map(input => input.id))).toEqual([steering.id, first.id, second.id])
  })

  it('unwinds a caller-owned registration and restores synchronous default entry', async () => {
    const { ctx, agent, adapter } = await harness()
    let calls = 0
    const owner = await ctx.plugin((owned) => {
      owned.effect(() => agent.onBeforeTurn(() => { calls++ }))
    })
    agent.followup(message('first'))
    await agent.whenIdle()
    expect(calls).toBe(1)
    await owner.dispose()
    agent.followup(message('second'))
    expect(boundaries(agent).filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    await agent.whenIdle()
    expect(calls).toBe(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('gives repeated callback registrations independent idempotent disposers', async () => {
    const { agent } = await harness()
    let calls = 0
    const callback = () => { calls++ }
    const first = agent.onBeforeTurn(callback)
    const second = agent.onBeforeTurn(callback)
    first()
    first()
    agent.followup(message('remaining'))
    await agent.whenIdle()
    expect(calls).toBe(1)
    second()
    agent.followup(message('none'))
    expect(agent.inbox.nextTurn).toHaveLength(0)
    await agent.whenIdle()
    expect(calls).toBe(1)
  })

  it('skips removed hooks and defers newly registered hooks until a later turn', async () => {
    const { agent } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const order: string[] = []
    agent.onBeforeTurn(async (turn) => {
      order.push(`first:${turn}`)
      if (turn === 1) { entered.resolve(undefined); await release.promise }
    })
    const remove = agent.onBeforeTurn(() => { order.push('removed') })
    agent.followup(message('one'))
    await entered.promise
    remove()
    agent.onBeforeTurn(() => { order.push('new') })
    agent.followup(message('two'))
    release.resolve(undefined)
    await agent.whenIdle()
    expect(order).toEqual(['first:1', 'first:2', 'new'])
  })

  it('awaits each turn handoff before assembling its model request', async () => {
    const { agent, adapter } = await harness()
    let prepared = 0
    const assembled: number[] = []
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'employee6-prepared', order: 0, text: () => { assembled.push(prepared); return `prepared ${prepared}` },
    }))
    agent.onBeforeTurn(async (turn) => { await Promise.resolve(); prepared = turn })
    for (const value of ['one', 'two', 'three']) agent.send(message(value), 'next-turn', false)
    agent.wakePending()
    await agent.whenIdle()
    expect(assembled).toEqual([1, 2, 3])
    expect(adapter.requests).toHaveLength(3)
  })

  it('does nothing for an empty inbox and rejects registration after owner disposal', async () => {
    const { agent, handle, adapter } = await harness()
    let calls = 0
    agent.onBeforeTurn(() => { calls++ })
    agent.wakePending()
    await agent.whenIdle()
    expect(calls).toBe(0)
    expect(boundaries(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    await handle.dispose()
    expect(() => agent.onBeforeTurn(() => {})).toThrow()
  })
})
