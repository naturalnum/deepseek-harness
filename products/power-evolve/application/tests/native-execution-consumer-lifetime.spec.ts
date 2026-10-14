/** The actual Runtime execution consumer joins actual HTTP clients and retains original cleanup rejection. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { grant as grantSchema, PlatformError } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import RuntimeScope from '../src/host/scope.ts'
import NativeRuntimeExecution from '../src/host/native-runtime-execution.ts'
import { nativeExecutionWorld } from '../src/native-execution/types.ts'

const cases = [
  { failed: false, heldWorld: false, fsFailure: null, nullCleanup: false },
  { failed: true, heldWorld: false, fsFailure: null, nullCleanup: false },
  { failed: true, heldWorld: true, fsFailure: null, nullCleanup: false },
  { failed: true, heldWorld: false, fsFailure: 'stop', nullCleanup: false },
  { failed: true, heldWorld: false, fsFailure: 'release', nullCleanup: false },
  { failed: true, heldWorld: false, fsFailure: 'stop', nullCleanup: true },
  { failed: true, heldWorld: false, fsFailure: null, nullCleanup: true },
]
for (const { failed, heldWorld, fsFailure, nullCleanup } of cases) test(nullCleanup
  ? `actual ${fsFailure ? 'Fs reader return' : 'process drain'} rejects an invalid original cleanup acknowledgment`
  : fsFailure
    ? `actual Fs reader return preserves original ${fsFailure} failure through repeated execution drain`
    : heldWorld
      ? 'actual execution shutdown joins a held world read and rejects late reuse before original cleanup'
      : `actual native execution drain ${failed ? 'retains rejected' : 'joins successful'} original HTTP cleanup`, async () => {
  const filesystem = fsFailure !== null
  const grant = grantSchema.parse({ operationId: randomUUID(), sessionId: randomUUID(), userId: randomUUID(),
    requestId: randomUUID(), text: 'consumer fixture', token: 'f'.repeat(43), epoch: 1,
    settings: { model: 'fixture', maxTokens: 1000, revision: 1 }, executionEnabled: true })
  const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: grant.userId, sessionId: grant.sessionId,
    agentId: grant.sessionId, workspaceId: randomUUID(), operationId: grant.operationId, operationEpoch: grant.epoch,
    storageGeneration: 1, permissionGeneration: 1, mode: 'read-only', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const worldEntered = Promise.withResolvers<undefined>(), worldRelease = Promise.withResolvers<undefined>()
  let opened = 0, lateBind: Promise<void> | undefined
  const calls: Array<{ path: string; id: string | undefined }> = [], faults: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (bearer(request) !== grant.token) throw new Error('Original operation bearer was substituted')
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const input = z.object({ id: z.uuid().optional() }).loose().parse(await readJson(request, 4096))
        calls.push({ path, id: input.id })
        if (path === '/runtime/native-world/open') {
          if (heldWorld && ++opened > 1) { worldEntered.resolve(undefined); await worldRelease.promise }
          sendJson(response, world); return
        }
        if (path === '/runtime/native-world/fs') {
          sendJson(response, { ok: true, value: { targetKey: world.worldId + ':/workspace/fixture.txt', displayPath: '/workspace/fixture.txt' } }); return
        }
        if (path === '/runtime/native-world/fs/stream/start') { sendJson(response, { id: input.id }); return }
        if (path === '/runtime/native-world/fs/stream/poll') {
          entered.resolve(undefined); await release.promise
          sendJson(response, { state: 'running', outcome: null, error: null,
            output: { data: '', nextOffset: 0, lossy: false, exhausted: false } }); return
        }
        if (path === '/runtime/native-world/process/start') { sendJson(response, { id: input.id }); return }
        if (path === '/runtime/native-world/process/poll') {
          entered.resolve(undefined); await release.promise
          const channel = { data: '', nextOffset: 0, lossy: false, exhausted: false }
          sendJson(response, { state: 'running', outcome: null, error: null, stdout: channel, stderr: channel,
            control: { ...channel, ended: false } }); return
        }
        if (path.endsWith('/stop') || path.endsWith('/release')) {
          if (nullCleanup) { sendJson(response, null); return }
          if (failed && (!filesystem || path.endsWith('/' + fsFailure))) throw new PlatformError(503, 'native_original_stop_unconfirmed')
          sendJson(response, { stopped: true }); return
        }
        throw new Error('Unexpected execution consumer route')
      } catch (error) {
        if (!(error instanceof PlatformError)) faults.push(error)
        sendFailure(response, error)
      }
    })()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not acquire an owned TCP address')
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: '/workspace' })
    const runtime = new RuntimeScope(ctx, RuntimeScope.Config({ platformUrl: `http://127.0.0.1:${address.port}`,
      runtimeUserId: grant.userId, workerId: randomUUID(), runtimeTokenFile: '/unused', timeoutMs: 1000, maxResponseBytes: 65536 }))
    runtime.grants.set(grant.sessionId, grant)
    const agent = await harness.create(grant.sessionId, { provider: 'fixture', model: 'fixture' }, { cwd: '/workspace' })
    const execution = new NativeRuntimeExecution(ctx, { pollMs: 1, maxOutputBytes: 65536 })
    await execution.bind(agent, grant)
    if (filesystem) {
      const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve('/workspace/fixture.txt'))
      const stream = await ctx.agents.withInitiator(agent, () => ctx.fs.streamText(target))
      const iterator = stream[Symbol.asyncIterator]()
      if (!iterator.return) throw new Error('Native reader did not retain its explicit close')
      await entered.promise
      release.resolve(undefined)
      if (nullCleanup) await expect(iterator.return()).rejects.toBeInstanceOf(Error)
      else await expect(iterator.return()).rejects.toMatchObject({ message: 'native_original_stop_unconfirmed' })
      const original = await execution.drain(agent).then(() => undefined, (error: unknown) => error)
      expect(original).toBeInstanceOf(AggregateError)
      const attempted = calls.length
      await expect(execution.drain(agent)).rejects.toBe(original)
      await agent.ctx.fiber.dispose()
      await expect(execution.drain(agent)).rejects.toBe(original)
      expect(calls).toHaveLength(attempted)
      const ids = calls.filter(call => call.path.startsWith('/runtime/native-world/fs/stream/')).map(call => call.id)
      expect(ids.every(id => id !== undefined)).toBe(true); expect(new Set(ids).size).toBe(1)
      expect(calls.filter(call => call.path.endsWith('/start'))).toHaveLength(1)
      expect(faults).toEqual([])
      return
    }
    const process = ctx.agents.withInitiator(agent, () => ctx.subprocess.spawn({ argv: ['fixture'], cwd: '/workspace',
      graceMs: 1000, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }))
    void process.done.catch(() => {})
    await entered.promise
    if (heldWorld) {
      release.resolve(undefined)
      const originalFailure = await execution.drain(agent).then(() => undefined, (error: unknown) => error)
      expect(originalFailure).toBeInstanceOf(AggregateError)
      lateBind = execution.bind(agent, grant)
      void lateBind.catch(() => {})
      await worldEntered.promise
    }
    const lifecycle = (): Promise<void> => heldWorld ? execution.shutdown() : execution.drain(agent)
    let settled = false
    const draining = lifecycle().finally(() => { settled = true })
    void draining.catch(() => {})
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false)
    if (heldWorld) {
      worldRelease.resolve(undefined)
      await expect(lateBind).rejects.toMatchObject({ message: 'native_execution_closing' })
    }
    release.resolve(undefined)
    if (failed) {
      const original = await draining.then(() => undefined, (error: unknown) => error)
      expect(original).toBeInstanceOf(AggregateError)
      const attempted = calls.length
      await expect(lifecycle()).rejects.toBe(original)
      await agent.ctx.fiber.dispose()
      // Cordis records disposer errors; a fulfilled Fiber disposal cannot erase explicit original cleanup failure.
      await expect(lifecycle()).rejects.toBe(original)
      expect(calls).toHaveLength(attempted)
    } else {
      await draining; await expect(process.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
      const attempted = calls.length
      await execution.drain(agent); expect(calls).toHaveLength(attempted)
    }
    const originalIds = calls.filter(call => call.path !== '/runtime/native-world/open').map(call => call.id)
    expect(originalIds.every(id => id !== undefined)).toBe(true)
    expect(new Set(originalIds).size).toBe(1)
    expect(calls.filter(call => call.path.endsWith('/start'))).toHaveLength(1)
    expect(faults).toEqual([])
  } finally {
    worldRelease.resolve(undefined); release.resolve(undefined)
    await lateBind?.catch(() => {}); await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})
