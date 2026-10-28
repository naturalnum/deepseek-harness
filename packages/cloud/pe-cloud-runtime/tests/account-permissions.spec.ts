/** Real Loader/policy projections with no file worker, process runner or deployment authority. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAccountFileMutationGuard, assertAccountPermissionAncestry } from '../src/account-permissions.ts'

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-permission-'))
  const config = join(directory, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    { id: 'sessions', name: 'cordis:test-sessions' },
    { id: 'projections', name: 'cordis:test-projections' },
    { id: 'policy', name: 'cordis:test-policy', config: { mode: 'workspace-write', workspaceRoot: '/fallback' } },
  ]))
  const owned: { graph?: Awaited<ReturnType<typeof boot>>; policyFiber?: Fiber } = {}
  onTestFinished(async () => {
    try { await owned.graph?.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const graph = await boot('account-permissions-test', config, [], (ctx) => {
    Object.assign(ctx.loader.builtins, {
      'test-sessions': SessionStore, 'test-projections': SessionProjections,
      'test-policy': { inject: SandboxPolicy.inject, Config: SandboxPolicy.Config,
        apply(scope: Context, config: ConstructorParameters<typeof SandboxPolicy>[1]) {
          new SandboxPolicy(scope, config)
          owned.policyFiber = scope.fiber
        } },
    })
  })
  owned.graph = graph
  const policyFiber = owned.policyFiber
  if (policyFiber === undefined) throw new Error('The original policy Loader fiber is absent')
  const first = graph.sessions.create(SessionId('first'), { meta: { cwd: '/projects/first' } })
  const second = graph.sessions.create(SessionId('second'), { meta: { cwd: '/projects/second' } })
  const current = vi.fn(), guard = createAccountFileMutationGuard(graph, first, '/projects/first', current)
  return { graph, first, second, guard, current, policyFiber }
}

it('uses the same Session durable mode at each mutation rather than capturing its initial value', async () => {
  const f = await fixture()
  expect(() =>{  f.guard() }).not.toThrow()
  setSandboxMode(f.first, 'read-only')
  expect(() =>{  f.guard() }).toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
  expect(() =>{  f.guard({ mode: 'workspace-write', sessionId: f.first.id, workspaceRoot: '/projects/first' }) })
    .toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
  setSandboxMode(f.first, 'workspace-write')
  expect(() =>{  f.guard() }).not.toThrow()
})

it('keeps another Session override independent of the original guard', async () => {
  const f = await fixture()
  setSandboxMode(f.second, 'read-only')
  expect(() =>{  f.guard() }).not.toThrow()
  const other = createAccountFileMutationGuard(f.graph, f.second, '/projects/second', f.current)
  expect(() =>{  other() }).toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
})

it.each(['read-only', 'danger-full-access'] as const)('rejects the unsupported mutation mode %s through direct invocation', async (mode) => {
  const f = await fixture()
  expect(() =>{  f.guard({ mode, sessionId: f.first.id, workspaceRoot: '/projects/first' }) })
    .toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
})

it.each(['workspace', 'session', 'missing-session'] as const)('rejects a mismatched %s in an explicit override', async (changed) => {
  const f = await fixture()
  const policy = { mode: 'workspace-write' as const,
    workspaceRoot: changed === 'workspace' ? '/projects/second' : '/projects/first',
    ...changed === 'missing-session' ? {} : { sessionId: changed === 'session' ? f.second.id : f.first.id } }
  expect(() =>{  f.guard(policy) }).toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
})

it('preserves the original account selection failure without permitting the mutation', async () => {
  const f = await fixture(), reason = new Error('original generation ended')
  f.current.mockImplementation(() => { throw reason })
  expect(() =>{  f.guard() }).toThrow(reason)
})

it('rejects a policy provider removed after the original selection', async () => {
  const f = await fixture()
  await f.policyFiber.dispose()
  expect(() =>{  f.guard() }).toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
})


it('checks live runtime owners through every ancestor before a child can become writable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-permission-ancestry-'))
  const config = join(directory, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const owner: { graph?: Awaited<ReturnType<typeof boot>> } = {}
  onTestFinished(async () => {
    try { await owner.graph?.fiber.dispose() }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const graph = await boot('account-permission-ancestry', config, [], async (ctx) => {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/fallback' })
  })
  owner.graph = graph
  const ctx = graph
  const root = (await ctx.agents.create({ sessionId: SessionId('root'), meta: { cwd: '/project' } })).agent
  const child = (await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: root, meta: { cwd: '/project' } })).agent
  const grandchild = (await ctx.agents.create({ sessionId: SessionId('grandchild'), parentAgent: child, meta: { cwd: '/project' } })).agent
  const unrelated = (await ctx.agents.create({ sessionId: SessionId('other'), meta: { cwd: '/other' } })).agent
  setSandboxMode(unrelated.session, 'read-only')
  expect(() => { assertAccountPermissionAncestry(ctx, grandchild.session, 'workspace-write') }).not.toThrow()
  setSandboxMode(root.session, 'read-only')
  expect(() => { assertAccountPermissionAncestry(ctx, grandchild.session, 'workspace-write') })
    .toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
  expect(() => { assertAccountPermissionAncestry(ctx, grandchild.session, 'read-only') }).not.toThrow()
  setSandboxMode(root.session, 'workspace-write')
  setSandboxMode(child.session, 'read-only')
  expect(() => { assertAccountPermissionAncestry(ctx, grandchild.session, 'workspace-write') })
    .toThrow(expect.objectContaining({ code: 'FS_SANDBOX_DENIED' }))
  setSandboxMode(child.session, 'workspace-write')
  expect(() => { assertAccountPermissionAncestry(ctx, grandchild.session, 'workspace-write') }).not.toThrow()
})
