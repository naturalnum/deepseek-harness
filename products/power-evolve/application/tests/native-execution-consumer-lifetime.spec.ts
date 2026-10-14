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

for (const failed of [false, true]) test(`actual native execution drain ${failed ? 'retains rejected' : 'joins successful'} original HTTP cleanup`, async () => {
  const grant = grantSchema.parse({ operationId: randomUUID(), sessionId: randomUUID(), userId: randomUUID(),
    requestId: randomUUID(), text: 'consumer fixture', token: 'f'.repeat(43), epoch: 1,
    settings: { model: 'fixture', maxTokens: 1000, revision: 1 }, executionEnabled: true })
  const world = nativeExecutionWorld.parse({ worldId: randomUUID(), userId: grant.userId, sessionId: grant.sessionId,
    agentId: grant.sessionId, workspaceId: randomUUID(), operationId: grant.operationId, operationEpoch: grant.epoch,
    storageGeneration: 1, permissionGeneration: 1, mode: 'read-only', workspaceRoot: '/workspace', homeRoot: '/home/agent' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const calls: Array<{ path: string; id: string | undefined }> = [], faults: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (bearer(request) !== grant.token) throw new Error('Original operation bearer was substituted')
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const input = z.object({ id: z.uuid().optional() }).loose().parse(await readJson(request, 4096))
        calls.push({ path, id: input.id })
        if (path === '/runtime/native-world/open') { sendJson(response, world); return }
        if (path === '/runtime/native-world/process/start') { sendJson(response, { id: input.id }); return }
        if (path === '/runtime/native-world/process/poll') {
          entered.resolve(); await release.promise
          const channel = { data: '', nextOffset: 0, lossy: false, exhausted: false }
          sendJson(response, { state: 'running', outcome: null, error: null, stdout: channel, stderr: channel,
            control: { ...channel, ended: false } }); return
        }
        if (path === '/runtime/native-world/process/stop' || path === '/runtime/native-world/process/release') {
          if (failed) throw new PlatformError(503, 'native_original_stop_unconfirmed')
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
    const process = ctx.agents.withInitiator(agent, () => ctx.subprocess.spawn({ argv: ['fixture'], cwd: '/workspace',
      graceMs: 1000, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }))
    void process.done.catch(() => {})
    await entered.promise
    let settled = false
    const draining = execution.drain(agent).finally(() => { settled = true })
    void draining.catch(() => {})
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false)
    release.resolve()
    if (failed) {
      const original = await draining.then(() => undefined, (error: unknown) => error)
      expect(original).toBeInstanceOf(AggregateError)
      const attempted = calls.length
      await expect(execution.drain(agent)).rejects.toBe(original)
      await agent.ctx.fiber.dispose()
      // Cordis records disposer errors; a fulfilled Fiber disposal cannot erase explicit original cleanup failure.
      await expect(execution.drain(agent)).rejects.toBe(original)
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
    release.resolve(); await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  }
})
