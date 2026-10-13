/** Real PG commit and mirror import under the native model-streaming reservation; no production ledger or Profile is exercised. */
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Client } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type InboxActivityCapture } from '@deepseek-ai/dsh-agent'
import AgentLoop, { planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

class NativeHoldModel extends MockAdapter {
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
  const model = new NativeHoldModel()
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
  h.agent.followup(message('A'))
  await h.model.entered.promise
  return h
}

describe('native running input PG transaction', () => {
  it('commits canonical B in PG and imports the exact mirror before model settlement and phase progress', async () => {
    const { ctx, agent, model, events, clone } = await start()
    const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
    if (!urlFile) throw new Error('Cloud tests require PE_TEST_DATABASE_URL_FILE')
    const url = (await readFile(urlFile, 'utf8')).trim()
    const db = new Client({ connectionString: url })
    await db.connect()
    onTestFinished(async () => { await db.end() })
    await db.query('CREATE TEMP TABLE native_hold_events (seq INTEGER PRIMARY KEY, event JSONB NOT NULL)')
    const commit = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<InboxActivityCapture>()
    onTestFinished(() => { commit.resolve(undefined) })
    const b = message('B')
    const operation = agent.runMaintenance(async (signal) => {
      const capture = agent.captureInboxActivity(signal)
      const plan = planInboxCommand(clone(), ctx.sessionProjections,
        { kind: 'admit', target: 'next-turn', wakeup: true, message: b }, capture)
      expect(capture).toMatchObject({ phase: 'running', position: { turn: 1, step: 1 }, aborted: false })
      await db.query('BEGIN')
      await db.query('INSERT INTO native_hold_events VALUES ($1, $2)', [plan.events[0]?.seq, JSON.stringify(plan.events[0])])
      held.resolve(capture)
      await commit.promise
      capture.assertCurrent()
      await db.query('COMMIT')
      const row = await db.query<{ event: SessionEvent }>('SELECT event FROM native_hold_events ORDER BY seq')
      expect(row.rows.map(item => item.event)).toEqual(plan.events)
      capture.synchronize(() => { agent.session.synchronizeCommitted(plan.events); return undefined })
      events.push(...plan.events)
      expect(agent.inbox.nextTurn).toEqual([b])
      expect(() =>{  capture.assertCurrent() }).toThrow('stale')
      agent.wakePending()
    }, { scope: 'inbox' })
    const capture = await held.promise
    expect(agent.status).toBe('running')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(() =>{  agent.inbox.append('next-turn', message('foreign')) }).toThrow('reserved')
    expect(() => agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow('reserved')
    expect(() => agent.runMaintenance(async () => undefined, { scope: 'inbox' })).toThrow('owner')
    expect(agent.session.seq).toBe(capture.cursor)
    model.complete.resolve(undefined)
    await model.finished.promise
    await setImmediate()
    expect(agent.session.seq).toBe(capture.cursor)
    expect(events.filter(event => event.type === 'assistant/message' || event.type === 'turn/end')).toEqual([])
    let idle = false
    const done = agent.whenIdle().then(() => { idle = true })
    await Promise.resolve(); expect(idle).toBe(false)
    commit.resolve(undefined)
    await operation; await done
    expect(model.requests).toHaveLength(2)
    expect(events.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([
      events.find(event => event.type === 'user/message')?.data.id, b.id,
    ])
    expect(() =>{  capture.assertCurrent() }).toThrow('stale')
    agent.inbox.append('next-turn', message('unlocked'))
  })

})
