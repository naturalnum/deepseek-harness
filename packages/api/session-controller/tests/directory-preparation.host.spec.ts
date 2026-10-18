/** Public Controller create calls with real AgentLoop publication and owned local paths. */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import SessionController from '../src/index.ts'

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is outside this creation fixture.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is outside this creation fixture.')) }
}

async function fixture(prepare?: (cwd: string) => Promise<void>) {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'directory-preparation-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'directory-fixture', model: 'unused' })
  new ExactQuery(ctx)
  // Other-domain collaborators: no Workspace or attachment operation is exercised.
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('attachments', { imageLimits: {
    maxImageBytes: 1_024, maxImagesPerMessage: 1, maxMessageImageBytes: 1_024,
    maxImagePixels: 1_024, maxImageDimension: 32, mediaTypes: ['image/png'],
  } })
  class PreparedController extends SessionController {
    constructor(owner: Context, private readonly prepareDirectory: (cwd: string) => Promise<void>) {
      super(owner, { nativeOpen: false })
    }

    protected override ensureProjectDirectory(cwd: string): Promise<void> {
      return this.prepareDirectory(cwd)
    }
  }
  let controller: SessionController | undefined
  await ctx.plugin({
    inject: SessionController.inject,
    apply(scope) {
      controller = prepare === undefined ? new SessionController(scope, { nativeOpen: false }) : new PreparedController(scope, prepare)
    },
  })
  if (controller === undefined) throw new Error('The native Controller did not mount.')
  return { ctx, home, controller }
}

it('keeps default recursive mkdir and existing-directory behavior on actual new and explicitly named creation', async () => {
  const { ctx, home, controller } = await fixture()
  const cwd = join(home, 'new', 'nested')
  const first = await controller.create({ cwd })
  expect(existsSync(cwd)).toBe(true)
  expect(ctx.agents.get(first.sessionId)).toBeDefined()
  expect(ctx.sessions.get(first.sessionId)?.header.cwd).toBe(cwd)
  const named = SessionId('native-directory-named')
  expect(await controller.create({ cwd, sessionId: named })).toEqual({ sessionId: named })
  expect(ctx.agents.get(named)).toBeDefined()
  expect(ctx.sessions.list()).toHaveLength(2)
})

it('retains the default directory failure before native Agent or Session creation', async () => {
  const { ctx, home, controller } = await fixture()
  const file = join(home, 'file')
  writeFileSync(file, 'not a directory')
  const create = vi.spyOn(ctx.agents, 'create')
  const operation = controller.create({ cwd: join(file, 'child') })
  await expect(operation).rejects.toMatchObject({ code: 'gateway/internal' })
  await expect(operation).rejects.toThrow('failed to ensure project directory')
  expect(create).not.toHaveBeenCalled()
  expect(ctx.sessions.list()).toEqual([])
})

it('captures but does not invoke the override during super construction, then awaits it without default Node fallback', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const prepare = vi.fn(async (_cwd: string) => { entered.resolve(undefined); await release.promise })
  const { ctx, home, controller } = await fixture(prepare)
  expect(prepare).not.toHaveBeenCalled()
  const cwd = join(home, 'virtual-directory')
  const create = vi.spyOn(ctx.agents, 'create')
  const operation = controller.create({ cwd })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([operation]) })
  await entered.promise
  expect(create).not.toHaveBeenCalled()
  expect(ctx.sessions.list()).toEqual([])
  release.resolve(undefined)
  const result = await operation
  expect(prepare).toHaveBeenCalledExactlyOnceWith(cwd)
  expect(existsSync(cwd)).toBe(false)
  expect(ctx.agents.get(result.sessionId)).toBeDefined()
  expect(ctx.sessions.get(result.sessionId)?.header.cwd).toBe(cwd)
})

it('preserves named creation serialization and blank reuse while one directory preparation is pending', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const prepare = vi.fn(async (_cwd: string) => { entered.resolve(undefined); await release.promise })
  const { ctx, home, controller } = await fixture(prepare)
  const sessionId = SessionId('serialized-directory-claim')
  const request = { sessionId, cwd: join(home, 'virtual-project') }
  const first = controller.create(request)
  const second = controller.create(request)
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([first, second]) })
  await entered.promise
  expect(prepare).toHaveBeenCalledOnce()
  expect(ctx.sessions.list()).toEqual([])
  release.resolve(undefined)
  expect(await first).toEqual({ sessionId })
  expect(await second).toEqual({ sessionId })
  expect(prepare).toHaveBeenCalledOnce()
  expect(ctx.sessions.list()).toHaveLength(1)
})

it('preserves an injected native Remote failure and creates no directory, Agent or Session', async () => {
  const failure = new RemoteError('gateway/internal', 'The directory provider is unavailable.', {})
  const prepare = vi.fn(async () => { throw failure })
  const { ctx, home, controller } = await fixture(prepare)
  const cwd = join(home, 'unavailable-project')
  const create = vi.spyOn(ctx.agents, 'create')
  await expect(controller.create({ cwd, sessionId: SessionId('denied-directory') })).rejects.toBe(failure)
  expect(prepare).toHaveBeenCalledWith(cwd)
  expect(existsSync(cwd)).toBe(false)
  expect(create).not.toHaveBeenCalled()
  expect(ctx.sessions.list()).toEqual([])
})
