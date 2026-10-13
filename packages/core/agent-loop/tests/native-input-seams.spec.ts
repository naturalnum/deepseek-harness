/** Native public input planning and the complete post-claim durable boundary. */
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type InboxClaimBoundary, type InboxActivityCapture } from '@deepseek-ai/dsh-agent'
import AgentLoop, { planInboxCommand, inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const id = SessionId('public-native-input')
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === id) events.push(event) })
  const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  onTestFinished(async () => { await handle.dispose() })
  const agent = handle.agent
  const clone = () => Session.forPlanning(id, events, agent.session.header, agent.session.inheritedEventCount)
  return { ctx, loopCtx: loop.ctx, agent, adapter, events, handle, clone }
}
function input(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('public detached native Inbox planning', () => {
  it('admits using a protected exact cursor and emits no live Inbox notification', async () => {
    const { ctx, agent, clone } = await harness()
    let notices = 0
    ctx.on('agent/inbox/inserted', () => { notices++ })
    const message = input('A')
    await agent.runMaintenance(async (signal) => {
      const activity = agent.captureInboxActivity(signal)
      const detached = clone()
      const result = planInboxCommand(detached, ctx.sessionProjections,
        { kind: 'admit', message, target: 'next-step', wakeup: true }, activity)
      expect(result.events).toHaveLength(1)
      expect(result.events[0]?.data).toEqual({ target: 'next-step', start: 0, inserted: [message] })
      expect(ctx.sessionProjections.stateOf(detached, 'inbox')?.['next-step']).toEqual([message])
      expect(agent.inbox.nextStep).toEqual([])
      activity.assertCurrent()
    })
    expect(notices).toBe(0)
  })

  it('edits the entire content while keeping MessageId, role and source', async () => {
    const { ctx, agent, clone } = await harness()
    const message = createUserMessage({ content:[{ type:'text',text:'old' },{ type:'text',text:'old tail' }],source:{ kind:'user' } })
    agent.inbox.append('next-turn', message)
    const detached = clone()
    const result = planInboxCommand(detached, ctx.sessionProjections,
      { kind: 'edit', messageId: message.id, content: [{ type: 'text', text: 'replacement' }] })
    expect(result.found).toBe(true)
    expect(result.events[0]?.data).toEqual({ target: 'next-turn', start: 0, removedCount: 1,
      inserted: [{ ...message, content: [{ type: 'text', text: 'replacement' }] }], outcome: 'canceled' })
    expect(agent.inbox.nextTurn).toEqual([message])
    expect(planInboxCommand(detached, ctx.sessionProjections,
      { kind:'remove', messageId:message.id }).events[0]?.data).toEqual({ target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled' })
    expect(planInboxCommand(detached, ctx.sessionProjections,
      { kind:'remove', messageId:message.id })).toMatchObject({ found:false,events:[] })
  })

  it.each([false, true])('retargets with canceled removal and native aborted=%s target', async (aborted) => {
    const { ctx, agent, clone } = await harness()
    const message = input('A')
    agent.inbox.append('next-turn', message)
    await agent.runMaintenance(async (signal) => {
      if (aborted) agent.cancel({ kind:'user' },{ keepInbox:true })
      const capture = agent.captureInboxActivity(signal)
      const detached = clone()
      const result = planInboxCommand(detached,ctx.sessionProjections,
        { kind:'retarget',messageId:message.id,target:'next-step',wakeup:true },capture)
      expect(result.events.map(event => event.data)).toEqual([
        { target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled' },
        { target:aborted?'next-turn':'next-step',start:0,inserted:[message] },
      ])
      capture.assertCurrent()
    })
  })

  it('claims B/C/A as two complete non-canceled removals with native order', async () => {
    const { ctx, agent, clone } = await harness()
    const [b,c,a,d] = [input('B'),input('C'),input('A'),input('D')]
    if (!a || !b || !c || !d) throw new Error('Missing fixture input')
    agent.inbox.append('next-step',b); agent.inbox.append('next-step',c)
    agent.inbox.append('next-turn',a); agent.inbox.append('next-turn',d)
    const detached=clone()
    const result=planInboxCommand(detached,ctx.sessionProjections,{ kind:'claim',target:'next-turn',turn:1 })
    expect(result.messages.map(message=>message.id)).toEqual([b.id,c.id,a.id])
    expect(result.events.map(event=>event.data)).toEqual([
      { target:'next-step',start:0,removedCount:2,inserted:[] },
      { target:'next-turn',start:0,removedCount:1,inserted:[] },
    ])
    expect(ctx.sessionProjections.stateOf(detached,'inbox')).toEqual({ 'next-step':[],'next-turn':[d] })
    expect(planInboxCommand(detached,ctx.sessionProjections,{ kind:'claim',target:'next-step',turn:1 })).toMatchObject({ events:[],messages:[] })
  })

  it('requires the active projection rather than substituting a queue', async () => {
    const ctx=new Context();onTestFinished(async()=>{await ctx.fiber.dispose()})
    await ctx.plugin(SessionProjectionRegistry)
    const session=Session.create(SessionId('no-inbox-projection'))
    expect(()=>planInboxCommand(session,ctx.sessionProjections,{ kind:'claim',target:'next-turn',turn:1 })).toThrow('projection registration')
    const remove=ctx.sessionProjections.register(inboxProjectionDefinition)
    expect(planInboxCommand(session,ctx.sessionProjections,{ kind:'claim',target:'next-turn',turn:1 }).events).toEqual([])
    remove()
  })

  it('refuses missing capture, wrong signal and capture outside maintenance', async () => {
    const { ctx,agent,clone }=await harness()
    expect(()=>agent.captureInboxActivity(new AbortController().signal)).toThrow('maintenance signal')
    expect(()=>planInboxCommand(clone(),ctx.sessionProjections,{ kind:'admit',message:input('A'),target:'next-turn',wakeup:true })).toThrow('native activity capture')
    await agent.runMaintenance(async()=>{
      expect(()=>agent.captureInboxActivity(new AbortController().signal)).toThrow('maintenance signal')
    })
  })

  it.each(['cancel','append','retire'] as const)('invalidates a capture after %s',async (change)=>{
    const { ctx,agent,clone }=await harness()
    let saved: InboxActivityCapture | undefined
    let detached: Session | undefined
    await agent.runMaintenance(async (signal)=>{
      saved=agent.captureInboxActivity(signal);detached=clone()
      if(change==='cancel')agent.cancel({ kind:'user' },{ keepInbox:true })
      if(change==='append')agent.inbox.append('next-turn',input('changed'))
      if(change!=='retire')expect(()=>saved?.assertCurrent()).toThrow('stale')
    })
    if(!saved||!detached)throw new Error('Missing capture fixture')
    const captured=saved, snapshot=detached
    expect(()=>{ captured.assertCurrent() }).toThrow('stale')
    expect(()=>planInboxCommand(snapshot,ctx.sessionProjections,{ kind:'admit',message:input('A'),target:'next-step',wakeup:true },captured)).toThrow('stale')
  })
})

describe('public post-claim durable barrier',()=>{
  it.each(['next-step', 'next-turn', 'earlier-hook'] as const)('settles a full consumed claim after cancellation from %s', async (origin) => {
    const { ctx, agent, adapter, events } = await harness()
    const b = input('B'), c = input('C'), a = input('A')
    agent.inbox.append('next-step', b)
    agent.inbox.append('next-step', c)
    agent.inbox.append('next-turn', a)
    if (origin === 'earlier-hook') {
      agent.onAfterClaim(() => { agent.cancel({ kind: 'user' }, { keepInbox: true }) })
    } else {
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'agent/inbox/spliced' && event.data.target === origin
          && event.data.outcome === undefined && (event.data.removedCount ?? 0) > 0) {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
      })
    }
    const settled: InboxClaimBoundary[] = []
    agent.onAfterClaim(async (boundary) => { await Promise.resolve(); settled.push(boundary) })
    agent.wakePending()
    await agent.whenIdle()
    expect(settled).toHaveLength(1)
    expect(settled[0]?.signal.aborted).toBe(true)
    expect(settled[0]?.messages.map(message => message.id)).toEqual([b.id, c.id, a.id])
    expect(settled[0]?.events).toHaveLength(2)
    expect(adapter.requests).toEqual([])
    expect(events.filter(event => event.type === 'step/start' || event.type === 'user/message')).toEqual([])
  })

  it('awaits later settlement after a preceding listener fails and retains its first error', async () => {
    const { ctx, agent, adapter } = await harness()
    const failure = new Error('earlier settlement failed')
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.onAfterClaim(() => { throw failure })
    const completed: string[] = []
    agent.onAfterClaim(async (boundary) => { await Promise.resolve(); completed.push(boundary.messages[0]?.id ?? '') })
    const a = input('A')
    agent.followup(a)
    await agent.whenIdle()
    expect(completed).toEqual([a.id])
    expect(errors).toEqual([failure])
    expect(adapter.requests).toEqual([])
  })

  it('publishes deeply frozen detached messages from a legal unfrozen restore', async () => {
    const { ctx, loopCtx, adapter } = await harness()
    const id = SessionId('restored-pending-claim')
    const seed = Session.create(id)
    const a = input('A')
    seed.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [a] })
    const owned = structuredClone(seed.snapshotEvents())
    const insertion = owned.find(event => event.type === 'agent/inbox/spliced')
    if (insertion?.type !== 'agent/inbox/spliced') throw new Error('Missing restored input')
    const historical = insertion.data.inserted[0]
    if (!historical) throw new Error('Missing restored message')
    expect(Object.isFrozen(historical.content)).toBe(false)
    const restored = Session.fromRestore(id, owned, seed.header, seed.inheritedEventCount, 'detached')
    ctx.effect(() => ctx.sessions.enter(restored))
    const agent = new ReactLoopAgent(loopCtx, id, { provider: 'mock', model: 'mock' }, restored)
    onTestFinished(async () => {
      agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      await agent.whenIdle()
      await agent.scope.dispose()
    })
    let checked = false
    agent.onAfterClaim((boundary) => {
      const message = boundary.messages[0]
      if (!message) throw new Error('Missing claimed restore')
      expect(message).not.toBe(historical)
      expect(Object.isFrozen(message)).toBe(true)
      expect(Object.isFrozen(message.source)).toBe(true)
      expect(Object.isFrozen(message.content)).toBe(true)
      expect(Object.isFrozen(message.content[0])).toBe(true)
      expect(Reflect.set(message.content[0] ?? {}, 'text', 'changed')).toBe(false)
      expect(historical.content).toEqual([{ type: 'text', text: 'A' }])
      checked = true
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    agent.wakePending()
    await agent.whenIdle()
    expect(checked).toBe(true)
    expect(adapter.requests).toEqual([])
  })

  it('waits on the complete B/C/A claim before assembly, hooks, notifications and requests',async()=>{
    const { ctx,agent,adapter,events }=await harness()
    const b=input('B'),c=input('C'),a=input('A')
    agent.inbox.append('next-step',b);agent.inbox.append('next-step',c);agent.inbox.append('next-turn',a)
    const started=Promise.withResolvers<InboxClaimBoundary>()
    const gate=Promise.withResolvers<undefined>()
    const seen:string[]=[]
    ctx.on('agent/inbox/claimed',()=>{seen.push('claimed')})
    ctx.on('agent/pre-step',(_data,next)=>{seen.push('pre-step');return next()})
    const assemble=ctx.systemPrompt.assemble.bind(ctx.systemPrompt)
    ctx.effect(()=>{ctx.systemPrompt.assemble=async (args)=>{seen.push('assembly');return assemble(args)};return()=>{ctx.systemPrompt.assemble=assemble}})
    agent.onAfterClaim(async (boundary)=>{started.resolve(boundary);await gate.promise;seen.push('commit')})
    agent.wakePending()
    const boundary=await started.promise
    expect(boundary).toMatchObject({ turn:1,step:1,target:'next-turn',to:boundary.from+2 })
    expect(boundary.messages.map(message=>message.id)).toEqual([b.id,c.id,a.id])
    expect(boundary.events).toHaveLength(2)
    expect(Object.isFrozen(boundary)).toBe(true);expect(Object.isFrozen(boundary.events)).toBe(true)
    expect(boundary.signal.aborted).toBe(false)
    expect(seen).toEqual([]);expect(adapter.requests).toHaveLength(0)
    expect(events.filter(event=>event.type==='step/start'||event.type==='user/message')).toEqual([])
    expect(agent.inbox.nextStep).toEqual([]);expect(agent.inbox.nextTurn).toEqual([])
    gate.resolve(undefined);await agent.whenIdle()
    expect(seen.slice(0,6)).toEqual(['commit','claimed','claimed','claimed','assembly','pre-step'])
    expect(adapter.requests).toHaveLength(1)
  })

  it.each(['failure','cancel','reject','empty'] as const)('permanently consumes claim after %s without user/message',async (outcome)=>{
    const { ctx,agent,adapter,events }=await harness()
    const a=input('A');agent.inbox.append('next-turn',a)
    const error=new Error('claim settlement failed')
    const errors:unknown[]=[];ctx.on('agent/error',({ error:failure })=>{errors.push(failure)})
    agent.onAfterClaim(()=>{
      if(outcome==='failure')throw error
      if(outcome==='cancel')agent.cancel({ kind:'user' },{ keepInbox:true })
    })
    if(outcome==='reject'||outcome==='empty')ctx.on('agent/pre-step',async()=>outcome==='reject'?{ kind:'reject' }:{ kind:'enter',messages:[] })
    agent.wakePending();await agent.whenIdle();agent.wakePending();await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([]);expect(adapter.requests).toHaveLength(0)
    expect(events.filter(event=>event.type==='user/message'||event.type==='step/start')).toEqual([])
    expect(events.filter(event=>event.type==='turn/start')).toHaveLength(1)
    expect(events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.removedCount===1&&event.data.outcome===undefined)).toHaveLength(1)
    expect(errors).toEqual(outcome==='failure'?[error]:[])
  })

  it('applies listener changes to later boundaries and skips removed registrations',async()=>{
    const { agent }=await harness();const order:string[]=[]
    let remove=()=>{}
    agent.onAfterClaim(()=>{order.push('first');remove();agent.onAfterClaim(()=>{order.push('added')})})
    remove=agent.onAfterClaim(()=>{order.push('removed')})
    agent.followup(input('one'));await agent.whenIdle()
    agent.followup(input('two'));await agent.whenIdle()
    expect(order).toEqual(['first','first','added'])
  })

  it('keeps whenIdle and disposal pending until canceled hook cleanup settles',async()=>{
    const { agent,handle,adapter }=await harness()
    const started=Promise.withResolvers<undefined>(),cleanup=Promise.withResolvers<undefined>()
    agent.onAfterClaim(async (boundary)=>{started.resolve(undefined);await cleanup.promise;expect(boundary.signal.aborted).toBe(true)})
    agent.followup(input('A'));await started.promise
    let idle=false,disposed=false
    const idleDone=agent.whenIdle().then(()=>{idle=true})
    const disposal=handle.dispose().then(()=>{disposed=true})
    await Promise.resolve();expect(idle).toBe(false);expect(disposed).toBe(false)
    cleanup.resolve(undefined);await Promise.all([idleDone,disposal]);expect(adapter.requests).toHaveLength(0)
    expect(()=>agent.onAfterClaim(()=>{})).toThrow()
  })
})
