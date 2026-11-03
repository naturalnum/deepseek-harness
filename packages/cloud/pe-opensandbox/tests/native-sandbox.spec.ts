/** Native invocation/policy handoff checks only; no subprocess, filesystem confinement or live backend proof. */
import { expect, it } from 'vitest'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { fixture } from './native-sandbox-fixture.ts'

it('binds an independent argv reference once to the original Native scope and immutable prepare policy', async () => {
  const f = await fixture()
  await f.run('candidate_confinement', async (signal) => {
    const argv = ['/guest/node', '/guest/worker.js'], policy = f.policy()
    const confined = await f.sandbox.confine(argv, policy, signal)
    expect(confined.argv).not.toBe(argv)
    expect(confined.argv).toEqual(argv)
    expect(() => f.sandbox.consume(f.graph.ctx, [...confined.argv], signal)).toThrow()
    const consumed = f.sandbox.consume(f.graph.ctx, confined.argv, signal)
    expect(consumed.scope.agent).toBe(f.agent)
    expect(consumed.scope.project).toBe(f.workspace)
    expect(consumed.filePolicy).toEqual({ mode: 'workspace-write' })
    expect(Object.isFrozen(consumed.filePolicy)).toBe(true)
    expect(Object.isFrozen(consumed.argv)).toBe(true)
    expect(() => f.sandbox.consume(f.graph.ctx, confined.argv, signal)).toThrow()
  })
  expect(f.calls.inspect()).toBe(0)
})

it('rejects another invocation even for the same actual Native Agent', async () => {
  const f = await fixture()
  let held: string[] | undefined
  await f.run('candidate_confinement', async (signal) => { held = (await f.sandbox.confine(['/guest/node'], f.policy(), signal)).argv })
  await f.run('candidate_confinement', async (signal) => {
    expect(() => f.sandbox.consume(f.graph.ctx, held!, signal)).toThrow()
  })
  expect(f.calls.inspect()).toBe(0)
})

it('rejects argv mutations and cancelled handoffs before any signed prepare', async () => {
  const f = await fixture()
  await f.run('candidate_confinement', async (signal) => {
    const confined = await f.sandbox.confine(['/guest/node'], f.policy(), signal)
    confined.argv[0] = '/other/node'
    expect(() => f.sandbox.consume(f.graph.ctx, confined.argv, signal)).toThrow()
    const cancelled = new AbortController()
    const next = await f.sandbox.confine(['/guest/node'], f.policy(), cancelled.signal)
    cancelled.abort(new Error('Native confinement cancelled'))
    expect(() => f.sandbox.consume(f.graph.ctx, next.argv, signal)).toThrow('Native confinement cancelled')
  })
})

it('keeps the candidate closed without an actual qualified Root profile and preserves Native policy identity', async () => {
  const f = await fixture()
  await f.run('candidate_confinement', async (signal) => {
    f.state.fixtureProfile = false
    await expect(f.sandbox.confine(['/guest/node'], f.policy(), signal)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    f.state.fixtureProfile = true
    await expect(f.sandbox.confine(['/guest/node'], { ...f.policy(), sessionId: 'foreign' as typeof f.agent.id }, signal)).rejects.toThrow()
    await expect(f.sandbox.confine(['/guest/node'], { ...f.policy(), workspaceRoot: '/foreign' }, signal)).rejects.toThrow()
  })
})

it('rejects another real Agent and account without borrowing their invocation or policy', async () => {
  const a = await fixture('native-sandbox-A'), b = await fixture('native-sandbox-B')
  let held: string[] | undefined
  await a.run('candidate_confinement', async (signal) => {
    held = (await a.sandbox.confine(['/guest/node'], a.policy(), signal)).argv
    await b.run('candidate_confinement', async (foreignSignal) => {
      expect(() => b.sandbox.consume(b.graph.ctx, held!, foreignSignal)).toThrow()
    })
    expect(a.sandbox.consume(a.graph.ctx, held, signal).scope.agent).toBe(a.agent)
  })
  const created = await a.graph.ctx.sessionController.create({}), other = a.graph.ctx.agents.get(created.sessionId)!
  await a.run('candidate_confinement', async (signal) => {
    held = (await a.sandbox.confine(['/guest/node'], a.policy(), signal)).argv
    await a.run('candidate_terminal', async (foreignSignal) => {
      expect(() => a.sandbox.consume(a.graph.ctx, held!, foreignSignal)).toThrow()
    }, other)
    expect(a.sandbox.consume(a.graph.ctx, held, signal).scope.agent).toBe(a.agent)
  })
})

it('rechecks the current Native mode and revokes pending handoffs on account-provider close', async () => {
  const f = await fixture()
  await f.run('candidate_confinement', async (signal) => {
    const held = await f.sandbox.confine(['/guest/node'], f.policy(), signal)
    setSandboxMode(f.agent.session, 'read-only')
    expect(f.policy().mode).toBe('read-only')
    expect(() => f.sandbox.consume(f.graph.ctx, held.argv, signal)).toThrow()
    const next = await f.sandbox.confine(['/guest/node'], f.policy(), signal)
    f.sandbox.close()
    expect(() => f.sandbox.consume(f.graph.ctx, next.argv, signal)).toThrow()
  })
})
