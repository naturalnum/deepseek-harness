/** Original commands and goal domain through the Loader and account-bound Gateway. */
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Goals from '@deepseek-ai/dsh-goal'
import * as GoalCommand from '@deepseek-ai/dsh-command-goal'
import { createNativeCommands } from '../src/native-commands.ts'
import type { NativeCommands } from '../src/native-commands.ts'
import type { NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import { CloudApiError } from '../src/errors.ts'

async function fixture(id: string) {
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'native-controls', lifetime: lifetime.signal })
  const manifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: ['list', 'execute'].map(method => ({ endpoint: 'commands/' + method,
      handlerId: 'native:commands', guard: 'account-session' as const })),
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const policy = new ExposurePolicy(manifest)
  policy.audit(manifest)
  let owner: Context | undefined, commandOwner: Context | undefined, native: NativeCommands | undefined, businessCurrent = true
  const events: SessionEvent[] = []
  onTestFinished(async () => { await owner?.fiber.dispose() })
  const current = (): void => {
    if (!businessCurrent) throw new CloudApiError('cloud/account-unavailable', 'Account business admission is closed.')
    lifetime.signal.throwIfAborted()
    owner?.fiber.assertActive()
  }
  const assertActiveScope = vi.fn((agent: Agent): void => {
    current()
    if (agent.ctx.get('peAccount') !== binding || agent.session.header.cwd !== '/account-project') {
      throw new CloudApiError('cloud/forbidden', 'The project is not owned by this account.')
    }
  })
  const preparePromptFiles = vi.fn<NonNullable<NativeSessionGuards['preparePromptFiles']>>(async () => {})
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    firstScreen: { maxCollectionItems: 16, maxFrameBytes: 65536, maxQueuedEvents: 16, maxQueuedBytes: 65536,
      assertSessionRead() {} },
    assertHandlerEnabled() {}, resolveCreate: async request => request, assertSessionProject: async () => {},
    assertActiveScope, preparePromptFiles,
  }
  const ctx = await boot('native-cloud-commands', fileURLToPath(new URL('./fixtures/native-commands.cordis.yml', import.meta.url)), [], async (ctx) => {
    owner = ctx
    ctx.on('session/event', (_session, event) => { events.push(event) })
    ctx.provide('peAccount', binding)
    await ctx.plugin(Typert)
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await mountAgentLoopTestHarness(ctx)
    Object.assign(ctx.loader.builtins, {
      'account-commands': { inject: ['agents'], apply(scope: Context) {
        commandOwner = scope
        native = createNativeCommands(scope, binding, current, policy, guards, 128)
      } },
      'native-goals': Goals, 'native-command-goal': GoalCommand,
    })
  })
  if (native === undefined || commandOwner === undefined) throw new Error('The guarded native commands did not mount.')
  const service = native, commandScope = commandOwner
  const handle = await ctx.agents.create({ sessionId: SessionId('command-session-' + id), meta: { cwd: '/account-project' } })
  const agent = handle.agent
  const peer: PeerScope = { id: brandString<PeerId>('commands-' + id), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: lifetime.signal, dispose: async () => {} }
  const list = () => ctx.typertGateway.invoke({ namespace: 'commands', method: 'list', args: { agentId: agent.id }, peer })
  const execute = (line: string, attachments: readonly object[] = []) => ctx.typertGateway.invoke({ namespace: 'commands', method: 'execute',
    args: { agentId: agent.id, line, submittedAttachments: attachments }, peer })
  return { ctx, service, agent, events, binding, lifetime, policy, list, execute, assertActiveScope, preparePromptFiles,
    closeBusiness() { businessCurrent = false }, replaceRegistry() { commandScope.set('commands', {}) } }
}

it('runs the original goal command with native lifecycle and projection, and removes it on Loader disposal', async () => {
  const f = await fixture('goal')
  expect(await f.list()).toEqual([expect.objectContaining({ name: 'goal' })])
  expect(f.service.inspect().rpcEndpoints).toHaveLength(2)
  const result = await f.execute('/goal')
  expect(result).toMatchObject({ result: { kind: 'success' } })
  expect(result).toHaveProperty('result.text', expect.stringContaining('No goal is currently set'))
  expect(f.events.filter(event => event.type.startsWith('command/')).map(event => event.type))
    .toEqual(['command/run', 'command/done'])
  expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'goal')?.current).toBeNull()
  const commands = f.ctx.get('commands')
  await f.ctx.fiber.dispose()
  expect(commands?.find(f.agent, 'goal')).toBeUndefined()
  expect(() => f.service.inspect()).toThrow()
})

it('keeps two accounts separate and rejects a foreign Agent or ended generation before command lifecycle writes', async () => {
  const a = await fixture('a'), b = await fixture('b')
  await expect(a.execute('/goal')).resolves.toBeDefined()
  const before = b.events.length
  expect(() => a.service.value.list(b.agent)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await expect(a.service.value.execute(b.agent, '/goal', [], new AbortController().signal))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  a.lifetime.abort(new Error('ended generation'))
  await expect(a.execute('/goal')).rejects.toBeDefined()
  expect(b.events).toHaveLength(before)
  await expect(b.execute('/goal')).resolves.toBeDefined()
})

it.each(['generation', 'business'] as const)('does not dispatch after receipt preparation loses %s admission', async (closed) => {
  const f = await fixture('receipt-' + closed)
  const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  f.preparePromptFiles.mockImplementation(async () => { entered.resolve(undefined); await released.promise })
  const pending = f.execute('/goal', [{ type: 'file', receiptId: 'owned-receipt' }])
  const rejected = expect(pending).rejects.toBeDefined()
  onTestFinished(async () => { released.resolve(undefined); await Promise.allSettled([pending]) })
  await entered.promise
  if (closed === 'generation') f.lifetime.abort()
  else f.closeBusiness()
  released.resolve(undefined)
  await rejected
  expect(f.events.filter(event => event.type.startsWith('command/'))).toHaveLength(0)
  expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'goal')?.current).toBeNull()
  if (closed === 'business') expect(f.lifetime.signal.aborted).toBe(false)
})

it('rejects unavailable exposure, inline image intake and a replaced registry before native execution', async () => {
  const f = await fixture('denied')
  await expect(f.execute('/goal', [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }]))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  f.policy.invalidate()
  await expect(f.execute('/goal')).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.events.filter(event => event.type.startsWith('command/'))).toHaveLength(0)
  f.replaceRegistry()
  expect(() => f.service.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})
