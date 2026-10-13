/** The native running model owns a protected command prefix through commit and mirror import. */
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type InboxActivityCapture } from '@deepseek-ai/dsh-agent'
import AgentLoop, { planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

class ControlledModel extends MockAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly complete = Promise.withResolvers<undefined>()
  readonly finished = Promise.withResolvers<undefined>()
  constructor() { super([]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = textResponse(this.requests.length === 1 ? 'A response' : 'B response')
    if (this.requests.length !== 1) { yield* chunks; return }
    const [start, delta, ...rest] = chunks
    if (!start || !delta) throw new Error('Missing controlled model chunks')
    yield start; yield delta
    this.entered.resolve(undefined)
    await this.complete.promise
    options.signal?.throwIfAborted()
    yield* rest
    this.finished.resolve(undefined)
  }
}
async function harness() {
  const ctx = new Context()
  const model = new ControlledModel()
  onTestFinished(async () => { model.complete.resolve(undefined); await ctx.fiber.dispose() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], model)
  const id = SessionId('native-running-hold')
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === id) events.push(event) })
  const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  onTestFinished(async () => { await handle.dispose() })
  const agent = handle.agent
  const clone = () => Session.forPlanning(id, events, agent.session.header, agent.session.inheritedEventCount)
  return { ctx, agent, model, events, handle, clone }
}
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
async function start() {
  const h = await harness()
  expect(h.agent.canMaintainInbox).toBe(true)
  h.agent.followup(message('A'))
  expect(h.agent.canMaintainInbox).toBe(false)
  await h.model.entered.promise
  expect(h.agent.canMaintainInbox).toBe(true)
  return h
}

describe('running native input maintenance', () => {
  it.each([true, false])('invalidates on cancel immediately, defers default clear=%s until committed mirror cleanup', async (keepInbox) => {
    const { ctx, agent, model, events, clone } = await start()
    const gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<InboxActivityCapture>()
    onTestFinished(() => { gate.resolve(undefined) })
    const b = message('B')
    const operation = agent.runMaintenance(async (signal) => {
      expect(agent.canMaintainInbox).toBe(false)
      const capture = agent.captureInboxActivity(signal)
      const plan = planInboxCommand(clone(), ctx.sessionProjections,
        { kind: 'admit', target: 'next-turn', wakeup: true, message: b }, capture)
      entered.resolve(capture); await gate.promise
      expect(signal.aborted).toBe(true)
      expect(() =>{  capture.assertCurrent() }).toThrow('stale')
      // A committed receipt can be reconciled after cancellation; this is not a new grant.
      capture.synchronize(() => { agent.session.synchronizeCommitted(plan.events); return undefined })
      events.push(...plan.events)
      expect(agent.inbox.nextTurn).toEqual([b])
    }, { scope: 'inbox' })
    const capture = await entered.promise
    expect(agent.canMaintainInbox).toBe(false)
    agent.cancel({ kind: 'user' }, { keepInbox })
    expect(() =>{  capture.assertCurrent() }).toThrow('stale')
    model.complete.resolve(undefined)
    await setImmediate()
    expect(agent.session.seq).toBe(capture.cursor)
    gate.resolve(undefined); await operation; await agent.whenIdle()
    expect(agent.canMaintainInbox).toBe(true)
    expect(agent.inbox.nextTurn).toEqual(keepInbox ? [b] : [])
    expect(model.requests).toHaveLength(1)
  })

  it('preserves command rejection, unlocks the native prefix and lets A finish', async () => {
    const { agent, model } = await start()
    const failure = new Error('command rollback finished')
    await expect(agent.runMaintenance(async () => { throw failure }, { scope: 'inbox' })).rejects.toBe(failure)
    expect(agent.canMaintainInbox).toBe(true)
    agent.inbox.append('next-turn', message('B'))
    model.complete.resolve(undefined); await agent.whenIdle()
    expect(model.requests).toHaveLength(2)
  })

  it('refuses a running capture outside the protected reservation and other native stages', async () => {
    const { ctx, agent, model } = await start()
    expect(() => agent.captureInboxActivity(new AbortController().signal)).toThrow('protected')
    model.complete.resolve(undefined); await agent.whenIdle()
    let rejected = false
    agent.onAfterClaim(() => {
      expect(agent.canMaintainInbox).toBe(false)
      expect(() => agent.runMaintenance(async () => undefined, { scope: 'inbox' })).toThrow('model-streaming')
      rejected = true
    })
    let preStepSeen = false
    ctx.on('agent/pre-step', (_payload, next) => {
      expect(agent.canMaintainInbox).toBe(false)
      preStepSeen = true
      return next()
    })
    agent.followup(message('next')); await agent.whenIdle()
    expect(rejected).toBe(true)
    expect(preStepSeen).toBe(true)
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })

  it('keeps disposal and native settlement behind canceled holder cleanup', async () => {
    const { agent, model, handle } = await start()
    const cleanup = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<InboxActivityCapture>()
    onTestFinished(() => { cleanup.resolve(undefined) })
    const operation = agent.runMaintenance(async (signal) => {
      entered.resolve(agent.captureInboxActivity(signal))
      await cleanup.promise
      expect(signal.aborted).toBe(true)
    }, { scope: 'inbox' })
    const capture = await entered.promise
    model.complete.resolve(undefined)
    let disposed = false
    const disposal = handle.dispose().then(() => { disposed = true })
    await setImmediate()
    expect(disposed).toBe(false)
    expect(() =>{  capture.assertCurrent() }).toThrow('stale')
    expect(() =>{  agent.inbox.append('next-turn', message('foreign')) }).toThrow('reserved')
    cleanup.resolve(undefined)
    await operation; await disposal
    expect(model.requests).toHaveLength(1)
  })

  it('retains idle maintenance behavior and obtains an owned input prefix', async () => {
    const { ctx, agent, clone } = await harness()
    const b = message('B')
    expect(agent.canMaintainInbox).toBe(true)
    await agent.runMaintenance(async (signal) => {
      expect(agent.canMaintainInbox).toBe(false)
      const capture = agent.captureInboxActivity(signal)
      expect(capture.phase).toBe('maintenance')
      const plan = planInboxCommand(clone(), ctx.sessionProjections,
        { kind: 'admit', target: 'next-turn', wakeup: false, message: b }, capture)
      capture.assertCurrent()
      capture.synchronize(() => { agent.session.synchronizeCommitted(plan.events); return undefined })
    }, { scope: 'inbox' })
    expect(agent.canMaintainInbox).toBe(true)
    expect(agent.status).toBe('idle'); expect(agent.inbox.nextTurn).toEqual([b])
    agent.inbox.remove(b.id)
  })

  it('validates a complete committed suffix before changing the original prefix', () => {
    const session = Session.create(SessionId('atomic-mirror'))
    const first = session.append('turn/start', { turn: 1 })
    const probe = Session.forPlanning(session.id, [first], session.header, session.inheritedEventCount)
    const end = probe.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() =>{  session.synchronizeCommitted([end, end]) }).toThrow('cursor')
    expect(session.seq).toBe(1)
    session.synchronizeCommitted([end])
    expect(session.seq).toBe(2)
  })
})
