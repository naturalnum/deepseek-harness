/** Native shellEnv projection only; no Loader, account readiness or remote execution qualification. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ShellEnvRegistry, type BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionStateError } from '../src/errors.ts'
import type { NativeExecutionProviderPort } from '../src/native-providers.ts'
import { CloudShellEnvRegistry } from '../src/native-shell-env.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  let admitted = true
  const failure = new ExecutionStateError('cloud/stale-generation', 'The original native call is unavailable.')
  const unused = vi.fn((): never => { throw new Error('An environment projection must not request execution work.') })
  const assertCurrent = vi.fn((caller: Context) => {
    expect(caller).toBe(ctx)
    if (!admitted) throw failure
  })
  const port: NativeExecutionProviderPort = {
    assertCurrent, projectRoot: unused, create: unused, assertOperationCurrent: unused, providerFailed: unused, closeProvider: unused,
  }
  const registry = new CloudShellEnvRegistry(ctx, port)
  const execution: ToolExecution = { token: Symbol('original-call') as ToolExecution['token'],
    callId: ToolCallId('native-shell-env'), rootCallId: ToolCallId('native-shell-env'), name: 'bash',
    arguments: { command: 'literal' }, signal: new AbortController().signal }
  return { ctx, registry, execution, unused, failure, assertCurrent, revoke: () => { admitted = false } }
}

it('checks the original native port for every collection and exposes only a frozen empty overlay', () => {
  const f = fixture()
  expect(f.registry).toBeInstanceOf(ShellEnvRegistry)
  expect(f.assertCurrent).not.toHaveBeenCalled()
  const env = f.registry.collect(f.execution)
  expect(env).toEqual({}); expect(Object.isFrozen(env)).toBe(true)
  f.revoke()
  expect(() => f.registry.collect(f.execution)).toThrow(f.failure)
  expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  expect(f.unused).not.toHaveBeenCalled()
})

it('omits ambient home and launcher profile paths without using the parent collector', () => {
  vi.stubEnv('DSH_HOME', '/host/private/harness-home')
  const parent = vi.spyOn(ShellEnvRegistry.prototype, 'collect')
  const f = fixture()
  f.ctx.provide('profileContext', { name: 'host-profile', dir: '/host/private/profile',
    patchPath: '/host/private/profile/cordis.patch.yml', installAnchor: '/host/private/package.json',
    cwd: '/host/private/cwd', home: '/host/private/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
  expect(f.registry.collect(f.execution)).toEqual({})
  expect(parent).not.toHaveBeenCalled()
  expect(f.unused).not.toHaveBeenCalled()
})

it('refuses contributions without exposing their values or calling resolvers and lists no declarations', () => {
  const f = fixture(), parent = vi.spyOn(ShellEnvRegistry.prototype, 'register')
  const resolve = vi.fn(() => ({ DSH_PRIVATE_FACT: '/host/private/value' }))
  const contribution: BashEnvContributor = { name: 'private-contributor-value',
    variables: { DSH_PRIVATE_FACT: { description: '/host/private/declaration' } }, resolve }
  expect(f.registry.list()).toEqual([])
  let failure: unknown
  try { f.registry.register(contribution) }
  catch (cause) { failure = cause }
  expect(failure).toBeInstanceOf(ExecutionStateError)
  expect(failure).toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(String(failure)).not.toContain(contribution.name)
  expect(String(failure)).not.toContain('/host/private')
  expect(resolve).not.toHaveBeenCalled(); expect(parent).not.toHaveBeenCalled()
  expect(f.registry.list()).toEqual([])
  expect(f.assertCurrent).not.toHaveBeenCalled(); expect(f.unused).not.toHaveBeenCalled()
})
