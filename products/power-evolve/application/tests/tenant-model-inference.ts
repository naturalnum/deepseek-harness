/** Native Host registry, Agent and persistence consume one real operation against the source Platform CLI. */
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { expect } from 'vitest'
import { harness } from '../../../../packages/preset/agent-preset-registry/tests/harness.ts'
import RuntimeScope from '../src/host/scope.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import * as Model from '../src/host/model.ts'
import { HostNativeWriterClient, type HostNativeWriterLease } from '../src/host/native-writer-client.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { requestId, sessionId } from '../src/contracts.ts'
import { nativeInputAdmissionCommand, originInputId } from '../src/native-input-ledger-contracts.ts'
import { NativeInputCoordinator } from '../src/host/native-input-coordinator.ts'
import { NativeInputHttp } from '../src/host/native-input-http.ts'
import type { SourceHttpActor, SourceHttpFixture } from './source-platform-http-fixture.ts'

/** Dispatch through real native Host services using only the exact leased operation and owned Runtime token.
 * @param fixture Actual source Platform, isolated PostgreSQL and bounded case lifetime.
 * @param root Owner-private temporary files for this Host instance.
 * @param actor Exact browser owner that selected and submitted the Session.
 * @param selected Session, provider and model already committed through the native UI carrier.
 * @returns Completion after native inference, canonical event persistence and exact Agent/Writer cleanup.
 */
export async function inferThroughNativeHost(fixture: SourceHttpFixture, root: string, actor: SourceHttpActor,
  selected: { sessionId: string; provider: string; model: string }): Promise<void> {
  const tasks = new TaskStore(fixture.pool, { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 4 })
  const id = sessionId.parse(selected.sessionId), workerId = randomUUID()
  await tasks.accept(actor.user, id, requestId.parse(randomUUID()), 'Owned inference input', actor.agent)
  const grant = await tasks.claim(workerId)
  if (!grant || grant.sessionId !== id || grant.userId !== actor.user.userId) throw new Error('Owned inference grant differs')
  const authority = new NativeRuntimeAuthority(fixture.pool)
  const credential = await authority.issue({ userId: grant.userId, runtimeId: workerId, generation: 1, lifetimeMs: 60_000 })
  const tokenFile = join(root, 'model-runtime-' + workerId)
  await writeFile(tokenFile, credential.token, { mode: 0o600 })
  const ctx = await harness()
  let writer: HostNativeWriterLease | undefined, handle: AgentHandle | undefined
  let completed = false
  try {
    await ctx.plugin(RuntimeScope, { platformUrl: fixture.url, runtimeUserId: grant.userId, workerId,
      runtimeTokenFile: tokenFile, timeoutMs: 5000, maxResponseBytes: 4_194_304 }).await()
    const runtime = ctx.powerEvolveRuntime
    const calls: unknown[] = [], original = runtime.call.bind(runtime)
    runtime.call = (path, token, input, signal) => { calls.push({ path, input }); return original(path, token, input, signal) }
    runtime.grants.set(id, grant)
    writer = await new HostNativeWriterClient(runtime).acquire(grant, randomBytes(32).toString('base64url'), fixture.signal)
    await ctx.plugin(PlatformPersistence).await()
    await ctx.plugin(Model, { streamIdleTimeoutMs: 5000 }).await()
    handle = await ctx.agents.resume({ resumeSessionId: id, signal: fixture.signal,
      disposeOptions: { keepInbox: true }, agentOptions: { provider: selected.provider, model: selected.model, maxTokens: 1000 } })
    const agent = handle.agent, session = agent.session
    const failures: unknown[] = []
    agent.ctx.on('agent/error', ({ agent: source, error }) => { if (source === agent) failures.push(error) })
    agent.ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source === agent) runtime.publication(grant).frame(frame)
    })
    const transport = new NativeInputHttp(runtime)
    const coordinator = new NativeInputCoordinator(agent, runtime, grant, writer.identity,
      session.snapshotEvents(), transport, (error) => { failures.push(error) })
    const pending = await transport.pending(grant, writer.identity, 8, fixture.signal)
    const own = pending.items.find(item => item.originOperationId === grant.operationId)
    if (!own) throw new Error('Owned accepted input was not available to its native Coordinator')
    await coordinator.admit(nativeInputAdmissionCommand.parse({ rpcNonce: `accepted:${own.originOperationId}`,
      sessionId: grant.sessionId, originInputId: originInputId.parse(own.originOperationId),
      originOperationId: own.originOperationId, messageId: own.message.id, target: 'next-turn' }), own.message, true)
    await agent.whenIdle()
    if (failures.length) throw new AggregateError(failures, 'Owned native model Agent failed')
    const assistant = session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'hello' }])
    await ctx.sessions.flush(session)
    expect(JSON.stringify(calls)).not.toMatch(/owned-alice-secret|owned-bob-secret/u)
    completed = true
  } finally {
    try { await handle?.dispose({ keepInbox: true }) }
    finally {
      try { if (writer !== undefined) await new HostNativeWriterClient(ctx.powerEvolveRuntime).release(writer.identity) }
      finally {
        await ctx.fiber.dispose()
        await tasks.finish(grant.token, completed ? 'completed' : 'failed', completed ? null : 'Owned native inference failed')
      }
    }
  }
}
