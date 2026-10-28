/** The command uses a supplied native feedback owner without accepting a substituted service. */
import { Context, symbols } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import * as CommandFeedback from '../src/index.ts'

async function mount() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  return ctx
}

async function fixture() {
  const ctx = await mount()
  class SuppliedFeedback extends CommandFeedback.SessionFeedbackService {}
  await ctx.plugin(SuppliedFeedback)
  const supplied = ctx.get('sessionFeedback')
  if (supplied === undefined) throw new Error('Native supplied service did not mount')
  const original: unknown = Reflect.get(supplied, symbols.original) ?? supplied
  return { ctx, supplied, original }
}

it('reuses the supplied native subclass and its original Typert binding', async () => {
  const f = await fixture()
  await f.ctx.plugin(CommandFeedback)
  const actual = f.ctx.get('sessionFeedback')
  expect(actual?.typertRemote.service).toBe(f.original)
  expect(actual?.typertRemote.namespace).toBe('sessionFeedback')
})

it('rejects a nonnative replacement before the command can register', async () => {
  const ctx = await mount()
  ctx.provide('sessionFeedback', { record: () => Promise.resolve({ ok: true }) })
  expect(() => { CommandFeedback.apply(ctx) }).toThrow('the existing sessionFeedback must be the original native service')
})

it('rejects a native-shaped object whose Typert binding points at another object', async () => {
  const ctx = await mount()
  const replacement = Object.create(CommandFeedback.SessionFeedbackService.prototype) as object
  Object.defineProperty(replacement, 'typertRemote', { value: { service: {}, serviceKey: 'sessionFeedback', namespace: 'sessionFeedback' } })
  ctx.provide('sessionFeedback', replacement)
  expect(() => { CommandFeedback.apply(ctx) }).toThrow('the existing sessionFeedback must be the original native service')
})
