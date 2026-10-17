/** Reproducible wiring gaps through actual public Gateway/Controllers; no alternate dispatcher. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { installActualLlmGuard } from '../src/llm-guard.ts'
import { ExposurePolicy } from '../src/exposure.ts'

afterEach(() => { vi.restoreAllMocks() })

class CountingAdapter extends LlmAdapter {
  calls: number = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function host() {
  const directory = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'dispatch-review-')))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('review'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-review', lifetime: new AbortController().signal,
  })
  ctx.provide('peAccount', binding)
  const peer: PeerScope = {
    id: brandString<PeerId>('native-dispatch-review'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: binding.lifetime, dispose: async () => {},
  }
  return { ctx, binding, peer, directory }
}

async function sessionHost() {
  const state = await host()
  const { ctx, directory } = state
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(DefaultModel, { provider: 'review', model: 'native-default' })
  // Unused query/workspace and text-only attachment/upload dependencies are
  // explicit test doubles. SessionController, AgentRegistry and AgentLoop are real.
  ctx.provide('sessionQuery', {})
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {}, resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  })
  ctx.provide('attachments', { admitPromptContent: (content: unknown) => Promise.resolve(content) })
  const defaultCwd = join(directory, 'unverified-native-default')
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(defaultCwd)
  const controller = new SessionController(ctx, { nativeOpen: false })
  cwd.mockRestore()
  const adapter = new CountingAdapter()
  ctx.llm.registerAdapter(['review'], adapter)
  const policy = new ExposurePolicy({
    recipeVersion: 'd08-review', rpcEndpoints: [
      { endpoint: 'session/create', handlerId: 'native-session', guard: 'account-project' },
      { endpoint: 'session/prompt', handlerId: 'native-session', guard: 'account-session' },
      { endpoint: 'session/cancel', handlerId: 'native-session', guard: 'account-session' },
    ], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
  })
  policy.audit({ recipeVersion: 'd08-review', rpcEndpoints: policy.manifest.rpcEndpoints, streamEndpoints: [], exactFetchRoutes: [] })
  const denied = new Error('shared cloud project guard refused')
  const guards = {
    assertHandlerEnabled: vi.fn(),
    resolveCreate: vi.fn((_request: SessionCreateRequest): Promise<SessionCreateRequest> => Promise.reject(denied)),
    assertSessionProject: vi.fn(() => Promise.reject(denied)),
  }
  return { ...state, controller, adapter, guards, denied, defaultCwd, policy }
}

async function workspaceHost() {
  const state = await host()
  const { ctx, directory } = state
  // Empty native history is the sole persistence test double in this case.
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) })
  const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(directory, 'native-storage') })
  await ctx.plugin(DomainStorage, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const documentsDirectory = join(directory, 'configured-documents')
  const controller = new WorkspaceController(ctx, { documentsDirectory })
  return { ...state, documentsDirectory, controller }
}

it('does not apply cloud project guards when only the base native Controller is mounted', async () => {
  const { ctx, peer, guards, defaultCwd, policy } = await sessionHost()
  const access = vi.spyOn(ctx.remoteAccess, 'decide').mockReturnValue({ kind: 'deny', reason: 'no-allow' })
  policy.requireRpc('session/create')
  const value = await ctx.typertGateway.invoke({ namespace: 'session', method: 'create', args: { request: {} }, peer }) as SessionCreateValue
  expect(typeof value.sessionId).toBe('string')
  expect(guards.resolveCreate).not.toHaveBeenCalled()
  expect(access).not.toHaveBeenCalled()
  expect(existsSync(defaultCwd)).toBe(true)
  expect(ctx.sessions.list()).toHaveLength(1)
  expect(ctx.sessions.list()[0]!.header.cwd).toBe(defaultCwd)
})

it('admits native prompt/cancel without the thin project guard while the real LLM hook still blocks dispatch', async () => {
  const { ctx, peer, directory, guards, adapter, binding, policy } = await sessionHost()
  const value = await ctx.typertGateway.invoke({
    namespace: 'session', method: 'create', args: { request: { cwd: join(directory, 'unapproved-project') } }, peer,
  }) as SessionCreateValue
  const checks = vi.fn()
  const acceptedMessage = vi.fn()
  ctx.on('session/event', (_session, event) => { if (event.type === 'user/message') acceptedMessage() })
  installActualLlmGuard(ctx, binding, checks, () => false)
  policy.requireRpc('session/prompt')
  await expect(ctx.typertGateway.invoke({
    namespace: 'session', method: 'prompt', args: { request: {
      sessionId: value.sessionId, requestId: 'dispatch-review-prompt', mode: 'followup', content: [{ type: 'text', text: 'accepted before model guard' }],
    } }, peer,
  })).resolves.toEqual({ accepted: true })
  await vi.waitFor(() => { expect(checks).toHaveBeenCalled() })
  expect(adapter.calls).toBe(0)
  expect(acceptedMessage).toHaveBeenCalled()
  policy.requireRpc('session/cancel')
  await expect(ctx.typertGateway.invoke({ namespace: 'session', method: 'cancel', args: { request: { sessionId: value.sessionId } }, peer }))
    .resolves.toEqual({ accepted: true })
  expect(guards.assertSessionProject).not.toHaveBeenCalled()
})

it('reuses native Workspace config without OS lookup but still creates its fixed-suffix path directly', async () => {
  const { ctx, peer, documentsDirectory, controller } = await workspaceHost()
  const access = vi.spyOn(ctx.remoteAccess, 'decide').mockReturnValue({ kind: 'deny', reason: 'no-allow' })
  const value = await ctx.typertGateway.invoke({ namespace: 'workspace', method: 'initializeDefault', args: {}, peer })
  const expected = join(documentsDirectory, 'deepseek-harness', 'default-workspace')
  expect(value).toMatchObject({ workspace: { path: expected } })
  expect(existsSync(expected)).toBe(true)
  expect(access).not.toHaveBeenCalled()
  expect(await controller.initializeDefault(new AbortController().signal)).toEqual(value)
  expect(ctx.workspaceRegistry.list()).toHaveLength(1)
})

it('can reuse the public Registry initializer before dispatch while retaining the native workspace result', async () => {
  const { ctx, peer, directory, documentsDirectory } = await workspaceHost()
  const approved = join(directory, 'projects', 'server-generated-key')
  const prepare = vi.fn(() => {
    mkdirSync(approved, { recursive: true })
    return Promise.resolve(approved)
  })
  const initialized = await ctx.workspaceRegistry.initializeDefault(prepare)
  expect(initialized?.path).toBe(approved)
  const value = await ctx.typertGateway.invoke({ namespace: 'workspace', method: 'initializeDefault', args: {}, peer })
  expect(value).toMatchObject({ workspace: { workspaceId: initialized!.id, path: approved } })
  expect(existsSync(documentsDirectory)).toBe(false)
  expect(prepare).toHaveBeenCalledOnce()
  expect(ctx.workspaceRegistry.list()).toHaveLength(1)
})
