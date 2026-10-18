/** Terminal factory stop retains actual native Agent and JSONL handle cleanup. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context, FiberState, symbols } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished, vi } from 'vitest'

const seed: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

async function harness(beforeLoop?: (ctx: Context) => void, configured = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-loop-stop-'))
  const ctx = new Context()
  const releases: (() => void)[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    try { await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) }
  })
  const gate = () => {
    const deferred = Promise.withResolvers<undefined>()
    const release = () => { deferred.resolve(undefined) }
    releases.push(release)
    return { promise: deferred.promise, release }
  }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  beforeLoop?.(ctx)
  const fiber = await ctx.plugin(AgentLoop, { agents: configured ? [{ id: 'configured', sessionId: SessionId('configured-stop') }] : [] })
  const original: unknown = Reflect.get(ctx.agentLoop, symbols.original) ?? ctx.agentLoop
  if (!(original instanceof AgentLoop)) throw new Error('Original native AgentLoop is absent')
  return { ctx, loop: original, fiber, root, gate }
}

it('drains an idle live Agent through its actual asynchronous write-handle close before Context disposal', async () => {
  const f = await harness()
  const entered = f.gate(), closing = f.gate()
  const create = f.ctx.sessionPersistence.create.bind(f.ctx.sessionPersistence)
  let closeCalls = 0
  vi.spyOn(f.ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    const handle = await create(header, options), close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closeCalls++
      entered.release()
      await closing.promise
      await close()
    })
    return handle
  })
  const id = SessionId('idle-stop')
  const handle = await f.ctx.agents.create({ sessionId: id, seed })
  const agents = f.ctx.agents, sessions = f.ctx.sessions
  expect(handle.agent.status).toBe('idle')
  expect(agents.get(id)).toBe(handle.agent)
  expect(sessions.get(id)).toBe(handle.agent.session)
  const stopped = f.ctx.agentLoop.stop()
  expect(f.ctx.agentLoop.stop()).toBe(stopped)
  await entered.promise
  expect(f.fiber.state).toBe(FiberState.ACTIVE)
  expect(agents.get(id)).toBe(handle.agent)
  let settled = false
  void stopped.then(() => { settled = true })
  await setImmediate()
  expect(settled).toBe(false)
  closing.release()
  await stopped
  await f.ctx.fiber.dispose()
  expect(f.loop.stop()).toBe(stopped)
  expect(closeCalls).toBe(1)
  expect(agents.get(id)).toBeUndefined()
  expect(sessions.get(id)).toBeUndefined()
  const verify = new Context()
  try {
    await verify.plugin(Jsonl, { root: f.root, compression: 'none' })
    const reader = await verify.sessionPersistence.open(id, 'write')
    expect(reader.id).toBe(id)
    await reader.close()
  } finally { await verify.fiber.dispose() }
})

it.each(['stop', 'context'] as const)('publishes the same stop Promise before abort reentry when %s closes first', async (first) => {
  const f = await harness()
  const held = f.gate(), aborted = f.gate()
  const { agent } = await f.ctx.agents.create({ sessionId: SessionId('reentrant-stop') })
  let reentered: Promise<void> | undefined
  const work = agent.runMaintenance(async (signal) => {
    signal.addEventListener('abort', () => {
      reentered = f.loop.stop()
      aborted.release()
    }, { once: true })
    await held.promise
  })
  const firstDisposal = first === 'context' ? f.ctx.fiber.dispose() : undefined
  const stopped = f.loop.stop()
  await aborted.promise
  expect(reentered).toBe(stopped)
  expect(f.loop.stop()).toBe(stopped)
  await expect(f.loop.create(SessionId('closed-create'))).rejects.toThrow('agent loop is not active')
  await expect(f.loop.createAgent(f.ctx, { sessionId: SessionId('closed-create-agent') })).rejects.toThrow('agent loop is not active')
  await expect(f.loop.resume(f.ctx, { resumeSessionId: agent.id })).rejects.toThrow(/agent loop is not active|inactive context/)
  held.release()
  await Promise.all([work, stopped, firstDisposal])
})

it('retains a failed stop while all other Agent handle closes settle and later Context disposal joins it', async () => {
  const f = await harness()
  const entered = f.gate(), held = f.gate(), failure = new Error('native handle close failed')
  const create = f.ctx.sessionPersistence.create.bind(f.ctx.sessionPersistence)
  const closes = vi.fn()
  vi.spyOn(f.ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    const handle = await create(header, options), close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closes(handle.id)
      if (handle.id === SessionId('held-close')) { entered.release(); await held.promise }
      await close()
      if (handle.id === SessionId('failed-close')) throw failure
    })
    return handle
  })
  await f.ctx.agents.create({ sessionId: SessionId('failed-close') })
  await f.ctx.agents.create({ sessionId: SessionId('held-close') })
  const stopped = f.loop.stop()
  const rejected = expect(stopped).rejects.toBe(failure)
  await entered.promise
  let settled = false
  void stopped.then(() => { settled = true }, () => { settled = true })
  await setImmediate()
  expect(settled).toBe(false)
  held.release()
  await rejected
  expect(f.loop.stop()).toBe(stopped)
  await expect(f.loop.stop()).rejects.toBe(failure)
  await f.ctx.fiber.dispose()
  expect(f.loop.stop()).toBe(stopped)
  expect(closes).toHaveBeenCalledTimes(2)
})

it.each(['createAgent', 'resume'] as const)('retains a cancelled %s late handle and its asynchronous close', async (operation) => {
  const f = await harness()
  const id = SessionId('late-stop-' + operation)
  if (operation === 'resume') await (await f.ctx.agents.create({ sessionId: id, seed })).dispose()
  const acquired = f.gate(), deliver = f.gate(), closeEntered = f.gate(), closeHeld = f.gate()
  const failure = new Error('late handle close failed')
  const delay = async (handle: SessionHandle) => {
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closeEntered.release()
      await closeHeld.promise
      await close()
      throw failure
    })
    acquired.release()
    await deliver.promise
    return handle
  }
  if (operation === 'createAgent') {
    const create = f.ctx.sessionPersistence.create.bind(f.ctx.sessionPersistence)
    vi.spyOn(f.ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => delay(await create(header, options)))
  } else {
    const open = f.ctx.sessionPersistence.open.bind(f.ctx.sessionPersistence)
    vi.spyOn(f.ctx.sessionPersistence, 'open').mockImplementation(async (sessionId, access, options) => delay(await open(sessionId, access, options)))
  }
  const caller = new AbortController()
  const pending = operation === 'createAgent'
    ? f.ctx.agents.create({ sessionId: id, signal: caller.signal })
    : f.ctx.agents.resume({ resumeSessionId: id, signal: caller.signal })
  const rejected = expect(pending).rejects.toThrow('agent loop is not active')
  await acquired.promise
  const stopped = f.loop.stop()
  const failedStop = expect(stopped).rejects.toBe(failure)
  if (operation === 'createAgent') caller.abort(new Error('agent loop is not active'))
  await rejected
  let settled = false
  void stopped.then(() => { settled = true }, () => { settled = true })
  await setImmediate()
  expect(settled).toBe(false)
  deliver.release()
  await closeEntered.promise
  expect(settled).toBe(false)
  closeHeld.release()
  await failedStop
  expect(f.loop.stop()).toBe(stopped)
  expect(f.ctx.agents.get(id)).toBeUndefined()
  expect(f.ctx.sessions.get(id)).toBeUndefined()
})

it.each(['create', 'createAgent', 'configured'] as const)('retains a late %s handle close failure without a caller signal and denies later acquisitions', async (operation) => {
  const acquired = Promise.withResolvers<undefined>(), deliver = Promise.withResolvers<undefined>()
  onTestFinished(() => { deliver.resolve(undefined) })
  const failure = new Error('unpublished handle close failed')
  let closeCalls = 0
  const f = await harness((ctx) => {
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
      const handle = await create(header, options), close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { closeCalls++; await close(); throw failure })
      acquired.resolve(undefined)
      await deliver.promise
      return handle
    })
  }, operation === 'configured')
  const pending = operation === 'configured' ? undefined : operation === 'create'
    ? f.loop.create(SessionId('direct-create-stop'))
    : f.ctx.agents.create({ sessionId: SessionId('direct-create-agent-stop') })
  const rejected = pending === undefined ? undefined : expect(pending).rejects.toThrow('agent loop is not active')
  await acquired.promise
  const stopped = f.loop.stop()
  const failedStop = expect(stopped).rejects.toBe(failure)
  const create = vi.spyOn(f.ctx.sessionPersistence, 'create'), calls = create.mock.calls.length
  await expect(f.loop.create(SessionId('denied-public'))).rejects.toThrow('agent loop is not active')
  await expect(f.ctx.agents.create({ sessionId: SessionId('denied-factory') })).rejects.toThrow('agent loop is not active')
  await expect(f.ctx.agents.resume({ resumeSessionId: SessionId('denied-resume') })).rejects.toThrow('agent loop is not active')
  expect(create).toHaveBeenCalledTimes(calls)
  let settled = false
  void stopped.then(() => { settled = true }, () => { settled = true })
  await setImmediate()
  expect(settled).toBe(false)
  deliver.resolve(undefined)
  await Promise.all([failedStop, rejected])
  expect(closeCalls).toBe(1)
  expect(f.ctx.agents.list()).toEqual([])
  expect(f.ctx.sessions.list()).toEqual([])
})

it('leaves ordinary create and resume failures with their callers without poisoning stop', async () => {
  const f = await harness()
  const failure = new Error('backend create refused')
  vi.spyOn(f.ctx.sessionPersistence, 'create').mockRejectedValueOnce(failure)
  await expect(f.ctx.agents.create({ sessionId: SessionId('refused-create') })).rejects.toBe(failure)
  await expect(f.ctx.agents.resume({ resumeSessionId: SessionId('missing-resume') })).rejects.toThrow('not found')
  await expect(f.loop.stop()).resolves.toBeUndefined()
  expect(f.ctx.agents.list()).toEqual([])
  expect(f.ctx.sessions.list()).toEqual([])
})
