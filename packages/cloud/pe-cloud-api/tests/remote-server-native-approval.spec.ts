/** Minimal native limitation reproduction. Actual Agent/Session/approval; no cloud readiness or SSH claim. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Approval from '@deepseek-ai/dsh-user-approval'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it } from 'vitest'

it('native never rejects a mandatory remote approval before the real answerer chain can receive it', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Approval, { policy: 'never' })
    const loop = await mountAgentLoopTestHarness(ctx)
    const agent = await loop.create(SessionId('remote-forced-approval-gap'))
    agent.session.append('turn/start', { turn: 1 })
    let asked = 0
    ctx.on('approval/request', async () => { asked++; return 'allowed-once' })
    const outcome = await ctx.approval.request({ agent, toolName: 'remote_exec', reason: 'server alwaysAsk', signal: new AbortController().signal })
    expect(outcome).toBe('rejected')
    expect(asked).toBe(0)
    console.info(JSON.stringify({ evidence: 'native-forced-approval-limitation', policy: 'never', outcome, answererCalls: asked, originalAgent: true }))
    expect(agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
      .map(event => ({ type: event.type, ...event.type === 'approval/decided' ? { outcome: event.data.outcome } : {} })))
      .toEqual([{ type: 'approval/asked' }, { type: 'approval/decided', outcome: 'rejected' }])
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally { await ctx.fiber.dispose() }
})

it('the same original native request reaches answerers under ask and audits the one-shot decision', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Approval, { policy: 'ask' })
    const loop = await mountAgentLoopTestHarness(ctx)
    const agent = await loop.create(SessionId('remote-approval-native-ask'))
    agent.session.append('turn/start', { turn: 1 })
    let asked = 0
    ctx.on('approval/request', async (req) => { expect(req.agent).toBe(agent); asked++; return 'allowed-once' })
    expect(await ctx.approval.request({ agent, toolName: 'remote_exec', reason: 'server alwaysAsk' })).toBe('allowed-once')
    expect(asked).toBe(1)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally { await ctx.fiber.dispose() }
})

it('the cloud adapter uses a registry-minted tool call and rejects the unchanged native never policy', async () => {
  const { brandString } = await import('@deepseek-ai/dsh-brand')
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { defineContentToolFixture } = await import('@deepseek-ai/dsh-tools')
  const { remoteServerApproval } = await import('../src/remote-server-approval.ts')
  const ctx = new Context(), lifetime = new AbortController()
  const binding = Object.freeze({ accountId: brandString<import('@deepseek-ai/dsh-pe-cloud-runtime/types').AccountId>('native-approval-fixture'),
    epoch: brandString<import('@deepseek-ai/dsh-pe-cloud-runtime/types').OwnerEpoch>('1'), recipeVersion: 'native-reproduction', lifetime: lifetime.signal })
  ctx.provide('peAccount', binding)
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Approval, { policy: 'never' })
    const loop = await mountAgentLoopTestHarness(ctx), agent = await loop.create(SessionId('remote-original-call'))
    agent.session.append('turn/start', { turn: 1 })
    let body = 0
    ctx.tools.register(defineContentToolFixture({ name: 'remote_approval_fixture', description: 'Native approval adapter reproduction', parameters: {},
      async execute(_args, exec) {
        body++
        const asker = remoteServerApproval(ctx, binding, exec, () => { lifetime.signal.throwIfAborted() })
        return [{ type: 'text', text: String(await asker?.ask('mandatory remote approval')) }]
      } }))
    const result = await ctx.tools.execute({ name: 'remote_approval_fixture', arguments: {}, agent,
      callId: ToolCallId('original-remote-approval'), signal: new AbortController().signal })
    expect(body).toBe(1)
    expect(result.content).toEqual([{ type: 'text', text: 'false' }])
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally { await ctx.fiber.dispose() }
})
