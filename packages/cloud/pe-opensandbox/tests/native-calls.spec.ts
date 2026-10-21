/** Private native-dispatch propagation fixtures; no account readiness, backend or public transport proof. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ToolDispatchExecution, ToolExecutionToken, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeExecutionCalls } from '../src/native-calls.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const result: ToolExecutionResult = { isError: false, value: null, content: [] }

function fixture(maxScopes = 4) {
  const ctx = new Context(), generation = new AbortController()
  contexts.push(ctx)
  const binding: AccountBinding = Object.freeze({ accountId: 'native-unit' as AccountBinding['accountId'],
    epoch: '1' as AccountBinding['epoch'], recipeVersion: 'unit-only', lifetime: generation.signal })
  ctx.provide('peAccount', binding)
  const agents = new Map<SessionId, Agent>(), projects = new Map<SessionId, object>()
  for (const id of [SessionId('A'), SessionId('B')]) {
    agents.set(id, { ctx, id, session: Session.create(id) } as Agent)
    projects.set(id, Object.freeze({ id }))
  }
  const released = vi.fn<(scope: unknown) => void>()
  const calls = new NativeExecutionCalls(ctx, { binding, maxScopes, allowedTools: ['bash'],
    getAgent: id => agents.get(id), projectForAgent: agent => projects.get(agent.id)!,
    assertCurrent(scope) { if (scope.project !== projects.get(scope.sessionId)) throw new Error('project changed') }, released })
  const exec = (id = 'A'): ToolDispatchExecution => ({ callId: id as ToolDispatchExecution['callId'],
    rootCallId: id as ToolDispatchExecution['rootCallId'], token: Symbol(id) as ToolExecutionToken,
    name: 'bash', arguments: {}, agent: agents.get(SessionId(id))!, signal: new AbortController().signal })
  return { ctx, calls, exec, agents, projects, released, generation }
}

it('keeps concurrent native invocations separate across awaits and retains them until final projection release', async () => {
  const f = fixture(), a = f.exec('A'), b = f.exec('B')
  const gateA = Promise.withResolvers<undefined>(), gateB = Promise.withResolvers<undefined>()
  const first = f.calls.run(a, async () => {
    expect(f.calls.capture(f.ctx).scope.agent).toBe(a.agent)
    await gateA.promise
    expect(f.calls.capture(f.ctx).scope.sessionId).toBe('A')
    return result
  })
  const second = f.calls.run(b, async () => {
    expect(f.calls.capture(f.ctx).scope.agent).toBe(b.agent)
    await gateB.promise
    expect(f.calls.capture(f.ctx).scope.sessionId).toBe('B')
    return result
  })
  expect(() => f.calls.capture(f.ctx)).toThrow('original live native invocation')
  expect(f.calls.inspect()).toBe(2)
  gateB.resolve(undefined); await second
  expect(f.calls.inspect()).toBe(2)
  f.calls.release(b.token)
  gateA.resolve(undefined); await first
  f.calls.release(a.token)
  expect(f.calls.inspect()).toBe(0)
  expect(f.released).toHaveBeenCalledTimes(2)
})

it('separates operation cancellation from the output-owner lifetime and uses the current native fused signal', async () => {
  const f = fixture(), exec = f.exec(), caller = new AbortController()
  await f.calls.run(exec, async () => {
    const before = f.calls.capture(f.ctx)
    exec.signal = caller.signal
    caller.abort(new Error('native operation cancelled'))
    const captured = f.calls.capture(f.ctx)
    expect(captured.signal).toBe(caller.signal)
    expect(captured.scope).toBe(before.scope)
    expect(captured.scope.lifetime.aborted).toBe(false)
    f.calls.release(exec.token)
    expect(captured.scope.lifetime.aborted).toBe(true)
    expect(() => { f.calls.assertCurrent(captured.scope) }).toThrow()
    return result
  })
})

it('refuses delayed work after native final-result release while retaining no global current Session', async () => {
  const f = fixture(), exec = f.exec(), gate = Promise.withResolvers<undefined>()
  const delayed = f.calls.run(exec, async () => {
    const scope = f.calls.capture(f.ctx).scope
    await gate.promise
    expect(() => f.calls.capture(f.ctx)).toThrow('original live native invocation')
    expect(() => { f.calls.assertCurrent(scope) }).toThrow()
    return result
  })
  f.calls.release(exec.token)
  gate.resolve(undefined)
  await delayed
  expect(f.calls.inspect()).toBe(0)
})

it('closes original generation scopes without preventing unrelated tools from delegating', async () => {
  const f = fixture(), exec = f.exec()
  await f.calls.run(exec, async () => {
    const scope = f.calls.capture(f.ctx).scope
    f.generation.abort(new Error('old account epoch'))
    expect(f.calls.inspect()).toBe(0)
    expect(() => { f.calls.assertCurrent(scope) }).toThrow()
    return result
  })
  const next = vi.fn(async () => result)
  await expect(f.calls.run({ ...exec, name: 'read_file' }, next)).resolves.toBe(result)
  expect(next).toHaveBeenCalledTimes(1)
  expect(f.released).toHaveBeenCalledTimes(1)
})

it('bounds calls and rejects missing Agent, stale registry identity and nested PTC identity before issuing a scope', async () => {
  const f = fixture(1), exec = f.exec(), gate = Promise.withResolvers<undefined>()
  const first = f.calls.run(exec, async () => { await gate.promise; return result })
  const next = vi.fn(async () => result)
  expect(() => f.calls.run(f.exec('B'), next)).toThrow('capacity')
  gate.resolve(undefined); await first; f.calls.release(exec.token)
  const { agent: _agent, ...agentless } = f.exec()
  expect(() => f.calls.run(agentless, next)).toThrow('original native foreground')
  expect(() => f.calls.run({ ...f.exec(), parent: Symbol('ptc') as ToolExecutionToken }, next)).toThrow('original native foreground')
  f.agents.set(SessionId('A'), { ...exec.agent! })
  expect(() => f.calls.run(exec, next)).toThrow('exact live account-native Agent')
  expect(next).not.toHaveBeenCalled()
  expect(f.calls.inspect()).toBe(0)
})
