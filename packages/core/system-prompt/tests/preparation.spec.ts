/** Await original provider preparation before collecting a coherent scoped prompt/tool snapshot. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it, onTestFinished, vi } from 'vitest'

it('awaits preparation before reading any registered providers and includes newly registered tools in the first assembly', async () => {
  const ctx = new Context()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers(), ready: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  const variable = vi.fn(() => 'prepared variable'), tools = vi.fn(() => ({ schemas: [] }))
  ctx.systemPrompt.variable('prepared', variable); ctx.systemPrompt.tools(tools)
  ctx.on('system-prompt/prepare', async (_context, next) => {
    entered.resolve(); await ready.promise
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'prepared_tool', description: 'Prepared tool.', parameters: {} }] }))
    return next()
  })
  const assembly = ctx.systemPrompt.assemble()
  await entered.promise
  expect(variable).not.toHaveBeenCalled(); expect(tools).not.toHaveBeenCalled()
  ready.resolve()
  expect((await assembly).tools.map(tool => tool.name)).toEqual(['prepared_tool'])
  expect(variable).toHaveBeenCalledOnce(); expect(tools).toHaveBeenCalledOnce()
})

it('filters preparation by original scope, delegates to later listeners and retires it with the registering scope', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  let child: Scope | undefined, sibling: Scope | undefined
  await ctx.plugin({ inject: ['systemPrompt'], apply(owner: Context) {
    child = createScope(owner, {}); sibling = createScope(owner, {})
  } })
  if (child === undefined || sibling === undefined) throw new Error('Original scopes absent')
  const key = scopeOf(child.ctx), siblingKey = scopeOf(sibling.ctx), calls: string[] = []
  if (key === undefined || siblingKey === undefined) throw new Error('Original scope identities absent')
  child.ctx.on('system-prompt/prepare', async (_context, next) => { calls.push('child'); return next() })
  ctx.on('system-prompt/prepare', async (_context, next) => { calls.push('global'); return next() })
  await ctx.systemPrompt.assemble(); expect(calls).toEqual(['global'])
  calls.length = 0
  await ctx.systemPrompt.assemble({ scope: key }); expect(calls).toEqual(['child', 'global'])
  calls.length = 0
  await ctx.systemPrompt.assemble({ scope: siblingKey }); expect(calls).toEqual(['global'])
  await child.dispose(); calls.length = 0
  await ctx.systemPrompt.assemble({ scope: key }); expect(calls).toEqual(['global'])
})

it('rejects a failed preparation before publishing a partial provider snapshot', async () => {
  const ctx = new Context(), provider = vi.fn(() => ({ schemas: [] }))
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  ctx.systemPrompt.tools(provider)
  ctx.on('system-prompt/prepare', () => Promise.reject(new Error('synthetic discovery refusal')))
  await expect(ctx.systemPrompt.assemble()).rejects.toThrow('synthetic discovery refusal')
  expect(provider).not.toHaveBeenCalled()
})
