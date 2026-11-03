/** Policy selection only; kernel mount enforcement is covered by the separate native workload probe. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { expect, it, onTestFinished } from 'vitest'
import { selectNativeFilePolicy } from '../src/native-file-policy.ts'

async function fixture(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Projections)
  await ctx.plugin(Sessions)
  const policyFiber = await ctx.plugin(SandboxPolicy, { mode, workspaceRoot: '/fallback' })
  const session = ctx.sessions.create(SessionId('command-session'), { meta: { cwd: '/project' } })
  return { ctx, session, policyFiber }
}

it('captures the original Session policy for Subprocess and keeps prior operation facts immutable', async () => {
  const f = await fixture(), first = selectNativeFilePolicy(f.ctx, f.session, '/project')
  setSandboxMode(f.session, 'read-only')
  const second = selectNativeFilePolicy(f.ctx, f.session, '/project')
  expect(first).toEqual({ mode: 'workspace-write' })
  expect(second).toEqual({ mode: 'read-only' })
  expect(Object.isFrozen(first)).toBe(true)
})

it('permits a per-call narrowing only in the same Session/project', async () => {
  const f = await fixture('workspace-write')
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project', {
    mode: 'read-only', workspaceRoot: '/project', sessionId: f.session.id,
  })).toEqual({ mode: 'read-only' })
})

it('preserves a trusted Native approved override for one call in the same read-only Session', async () => {
  const f = await fixture('read-only')
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project', {
    mode: 'workspace-write', workspaceRoot: '/project', sessionId: f.session.id,
  })).toEqual({ mode: 'workspace-write' })
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project')).toEqual({ mode: 'read-only' })
})

it.each(['root', 'session', 'no-session'] as const)('refuses %s before any range can be signed', async (changed) => {
  const f = await fixture()
  expect(() => selectNativeFilePolicy(f.ctx, f.session, '/project', {
    mode: 'workspace-write',
    workspaceRoot: changed === 'root' ? '/other' : '/project',
    ...changed === 'no-session' ? {} : { sessionId: changed === 'session' ? SessionId('other') : f.session.id },
  })).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
})

it.each(['unsupported', 'toString'])('rejects a malformed runtime override mode %s', async (mode) => {
  const f = await fixture(), policy = { mode: 'workspace-write' as const, workspaceRoot: '/project', sessionId: f.session.id }
  Object.defineProperty(policy, 'mode', { value: mode })
  expect(() => selectNativeFilePolicy(f.ctx, f.session, '/project', policy))
    .toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
})

it('rejects a missing native policy rather than falling back to writable mounts', async () => {
  const f = await fixture()
  await f.policyFiber.dispose()
  expect(() => selectNativeFilePolicy(f.ctx, f.session, '/project')).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
  expect(() => selectNativeFilePolicy(f.ctx, f.session, '/project', {
    mode: 'danger-full-access', workspaceRoot: '/project', sessionId: f.session.id,
  })).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
})

it('captures trusted per-call full access without changing the standing Session mode', async () => {
  const f = await fixture('danger-full-access')
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project')).toEqual({ mode: 'danger-full-access' })
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project', { mode: 'workspace-write', workspaceRoot: '/project', sessionId: f.session.id })).toEqual({ mode: 'workspace-write' })
  setSandboxMode(f.session, 'workspace-write')
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project', { mode: 'danger-full-access', workspaceRoot: '/project', sessionId: f.session.id }))
    .toEqual({ mode: 'danger-full-access' })
  expect(selectNativeFilePolicy(f.ctx, f.session, '/project')).toEqual({ mode: 'workspace-write' })
})
