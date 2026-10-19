import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { auditRows } from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import * as instructions from '../src/session.ts'
import { Reader, identity, limits } from './harness.ts'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('activates through the native Loader with a prepared source owner and logs its bounded snapshot', async () => {
  const ctx = new Context()
  const released = vi.fn()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const binding: AccountBinding = { accountId: identity.accountId, epoch: identity.epoch,
      recipeVersion: 'prepared-source-test', lifetime: new AbortController().signal }
    ctx.provide('peAccount', binding)
    const reader = new Reader('/project')
    reader.files.set('/project/AGENTS.md', { chunks: ['source owner content'] })
    const reserve = vi.fn()
    new instructions.AccountInstructionSources(ctx, {
      binding,
      assertInstalled(owner) { expect(owner.root).toBe(ctx.root) },
      assertCurrent(agent) {
        expect(ctx.agents.get(agent.id)).toBe(agent)
        expect(ctx.sessions.get(agent.id)).toBe(agent.session)
      },
      async withSources(_agent, bytes, build, signal) {
        reserve(bytes)
        const value = await build(identity.workspaceId, { project: reader }, signal)
        return { value, release: released }
      },
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.instructions = instructions
    await ctx.loader.create({ name: 'cordis:include',
      config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
    await ctx.loader.await()
    expect((await auditRows(ctx.loader)).failed).toEqual([])
    const agent = await harness.create(SessionId('prepared-source-owner'), { provider: 'test', model: 'test' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(reserve).toHaveBeenCalledWith(400000)
    expect(reader.reads).toEqual(['/project/AGENTS.md'])
    const message = agent.session.deriveMessages().find(value => value.source.kind === 'pe-account-instructions')
    if (message?.source.kind !== 'pe-account-instructions') throw new Error('Missing native instruction context')
    expect(message.source.snapshot).toMatchObject(identity)
    expect(message.source.snapshot.sources[0]?.text).toBe('source owner content')
    expect(released).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
  }
  expect(released).toHaveBeenCalledTimes(1)
})

it('rejects duplicate preparation and a withdrawn binding before installing Session effects', async () => {
  const ctx = new Context()
  try {
    const lifetime = new AbortController()
    const binding: AccountBinding = { accountId: identity.accountId, epoch: identity.epoch,
      recipeVersion: 'prepared-source-test', lifetime: lifetime.signal }
    ctx.provide('peAccount', binding)
    const input: instructions.AccountInstructionPreparation = {
      binding, assertInstalled() {}, assertCurrent() {},
      async withSources() { throw new Error('No source work may start') },
    }
    new instructions.AccountInstructionSources(ctx, input)
    expect(() => { new instructions.AccountInstructionSources(ctx, input) }).toThrow('unique installed account graph')
    lifetime.abort()
    expect(() => { instructions.apply(ctx, limits) }).toThrow('withdrawn or different account graph')
  } finally {
    await ctx.fiber.dispose()
  }
})
