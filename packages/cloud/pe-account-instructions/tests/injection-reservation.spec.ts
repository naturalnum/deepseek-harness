import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, freezeMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installInstructionInjection, type PreparedInstruction } from '../src/injection.ts'
import type { InstructionMessage, InstructionMessageSource } from '../src/types.ts'
import { identity } from './harness.ts'

function instruction(): InstructionMessage {
  const text = 'bounded instruction'
  const source: InstructionMessageSource = {
    kind: 'pe-account-instructions', form: 'instructions',
    snapshot: { ...identity, sources: [], text, totalBytes: Buffer.byteLength(text) },
  }
  return freezeMessage({ ...createUserMessage({ content: [{ type: 'text', text }], source }), source })
}

function prompt() {
  return createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } })
}

class Adapter extends LlmAdapter {
  requests = 0
  constructor(private readonly received: () => void = () => {}) { super() }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    this.received()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('holds the snapshot through request preparation and releases once at native message acceptance', async () => {
  const ctx = new Context()
  let held = 0
  const released = vi.fn(() => { held-- })
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter(() => { expect(held).toBe(0) })
    ctx.llm.registerAdapter(['test'], adapter)
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {}, async () => {
        held++
        return { message: instruction(), release: released }
      })
    })
    ctx.on('agent/request', async (_input, next) => {
      expect(held).toBe(1)
      return next()
    })
    const agent = await harness.create(SessionId('reservation-accepted'), { provider: 'test', model: 'test' })
    for (let turn = 0; turn < 2; turn++) {
      agent.followup(prompt())
      await agent.whenIdle()
    }
    expect(adapter.requests).toBe(2)
    expect(released).toHaveBeenCalledTimes(2)
  } finally {
    await ctx.fiber.dispose()
  }
  expect(held).toBe(0)
  expect(released).toHaveBeenCalledTimes(2)
})

it('releases an unaccepted snapshot when the native request is cancelled', async () => {
  const ctx = new Context()
  const released = vi.fn()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test'], adapter)
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {}, async () =>
        ({ message: instruction(), release: released }))
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const result = await next()
      agent.cancel({ kind: 'user' })
      return result
    })
    const agent = await harness.create(SessionId('reservation-cancelled'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(adapter.requests).toBe(0)
    expect(agent.session.deriveMessages().some(message => message.source.kind === 'pe-account-instructions')).toBe(false)
    expect(released).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
  }
  expect(released).toHaveBeenCalledTimes(1)
})

it('retains pending preparation during disposal and releases a late result without offering it', async () => {
  const ctx = new Context()
  const released = vi.fn()
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<PreparedInstruction>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const fiber = await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {}, async (_agent, control) => {
        control.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        entered.resolve(undefined)
        return result.promise
      })
    })
    const agent = await harness.create(SessionId('reservation-late-result'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await entered.promise
    let disposed = false
    const close = fiber.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    expect(released).not.toHaveBeenCalled()
    result.resolve({ message: instruction(), release: released })
    await close
    await agent.whenIdle()
    expect(adapter.requests).toBe(0)
    expect(released).toHaveBeenCalledTimes(1)
  } finally {
    result.resolve({ message: instruction(), release: released })
    await ctx.fiber.dispose()
  }
})

it('returns a prepared reservation when the final account check rejects it', async () => {
  const ctx = new Context()
  const released = vi.fn()
  let current = true
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test'], adapter)
    await ctx.plugin((owner) => {
      installInstructionInjection(owner, new AbortController().signal, () => {
        if (!current) throw new Error('account admission closed')
      }, async () => {
        current = false
        return { message: instruction(), release: released }
      })
    })
    const agent = await harness.create(SessionId('reservation-final-check'), { provider: 'test', model: 'test' })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(adapter.requests).toBe(0)
    expect(released).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
  }
  expect(released).toHaveBeenCalledTimes(1)
})
