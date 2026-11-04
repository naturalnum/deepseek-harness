/** Original Loader, JSONL service and handles over real files; barriers only delay an existing storage method. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as JsonlPersistence from '../src/index.ts'
import { JsonlSessionHandle, type JsonlHandleStorage } from '../src/storage.ts'
import type { JsonlCompression } from '../src/format.ts'

async function fixture(compression: JsonlCompression) {
  const home = await mkdtemp(join(tmpdir(), 'jsonl-close-reads-')), config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([{ id: 'persistence', name: 'cordis:close-read', config: { root: join(home, 'logs'), compression } }]))
  const ctx = await boot('dsh', config, [], (owner) => { owner.loader.builtins['close-read'] = JsonlPersistence })
  const persistence = ctx.sessionPersistence
  const backend = (Reflect.get(persistence, symbols.original) ?? persistence) as SessionPersistence & JsonlHandleStorage
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('close-read'), createdAt: 1000, isSeeded: false, cwd: '/work' }
  const writer = await persistence.create(header)
  await writer.flush(); await writer.close()
  const reader = await persistence.open(header.id, 'read')
  expect(reader).toBeInstanceOf(JsonlSessionHandle)
  const releases: Array<() => void> = [], pending: Promise<unknown>[] = []
  const gate = () => {
    const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
    releases.push(() => { released.resolve(undefined) })
    return { entered, released }
  }
  const observe = <T>(promise: Promise<T>): Promise<T> => {
    pending.push(Promise.allSettled([promise]))
    return promise
  }
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.all(pending)
    vi.restoreAllMocks()
    try { await reader.close(); await ctx.fiber.dispose() }
    finally { await rm(home, { recursive: true, force: true }) }
  })
  return { persistence, backend, reader, gate, observe }
}

it.each(['none', 'zstd'] as const)('keeps %s reads tracked until concurrent idempotent close joins both', async (compression) => {
  const f = await fixture(compression), first = f.gate(), second = f.gate()
  const gates = [first, second], original = f.backend.resolveCurrentLog.bind(f.backend)
  let call = 0
  vi.spyOn(f.backend, 'resolveCurrentLog').mockImplementation(async (...args) => {
    const gate = gates[call++]
    if (gate === undefined) throw new Error('Unexpected additional admitted read')
    gate.entered.resolve(undefined); await gate.released.promise
    return original(...args)
  })
  const a = f.observe(f.reader.read()), b = f.observe(f.reader.read())
  await Promise.all([first.entered.promise, second.entered.promise])
  let closed = false
  const closing = f.observe(f.reader.close().then(() => { closed = true }))
  const originalClose = f.reader.close()
  expect(f.reader.close()).toBe(originalClose)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(f.persistence.isQuiescent(8)).toBe(false)
  expect(closed).toBe(false)
  await expect(f.reader.read(-1, -1)).rejects.toBeInstanceOf(SessionHandleClosedError)
  first.released.resolve(undefined); await a
  expect(closed).toBe(false)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  second.released.resolve(undefined); await b; await closing
  expect(f.persistence.isQuiescent(8)).toBe(true)
  console.info(JSON.stringify({ evidence: 'actual-close-joins-both-reads', compression, beforeAllReadsSettled: false, afterCloseQuiescent: true }))
})

it.each(['none', 'zstd'] as const)('joins a failed %s read without changing its original failure', async (compression) => {
  const f = await fixture(compression), gate = f.gate(), cause = new Error('Original stored read failed')
  const original = f.backend.readStoredLog.bind(f.backend)
  vi.spyOn(f.backend, 'readStoredLog').mockImplementation(async (...args) => {
    await original(...args)
    gate.entered.resolve(undefined); await gate.released.promise
    throw cause
  })
  const reading = f.observe(f.reader.read())
  await gate.entered.promise
  let closed = false
  const closing = f.observe(f.reader.close().then(() => { closed = true }))
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(closed).toBe(false)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  gate.released.resolve(undefined)
  await expect(reading).rejects.toBe(cause)
  await closing
  expect(f.persistence.isQuiescent(8)).toBe(true)
})

it.each(['none', 'zstd'] as const)('joins an aborted %s read before releasing its handle', async (compression) => {
  const f = await fixture(compression), gate = f.gate(), abort = new AbortController(), cause = new Error('Original read cancelled')
  const original = f.backend.resolveCurrentLog.bind(f.backend)
  vi.spyOn(f.backend, 'resolveCurrentLog').mockImplementation(async (...args) => {
    gate.entered.resolve(undefined); await gate.released.promise
    return original(...args)
  })
  const reading = f.observe(f.reader.read(0, undefined, { signal: abort.signal }))
  await gate.entered.promise
  let closed = false
  const closing = f.observe(f.reader.close().then(() => { closed = true }))
  abort.abort(cause)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(closed).toBe(false)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  gate.released.resolve(undefined)
  await expect(reading).rejects.toBe(cause)
  await closing
  expect(f.persistence.isQuiescent(8)).toBe(true)
})

it.each(['none', 'zstd'] as const)('retains ordinary %s read then close and closed-handle refusal precedence', async (compression) => {
  const f = await fixture(compression)
  expect((await f.reader.read()).events).toEqual([])
  expect(f.persistence.isQuiescent(8)).toBe(true)
  const closing = f.reader.close()
  expect(f.reader.close()).toBe(closing)
  await closing
  expect(f.persistence.isQuiescent(8)).toBe(true)
  const abort = new AbortController()
  abort.abort(new Error('Already aborted'))
  await expect(f.reader.read(-1, -1, { signal: abort.signal })).rejects.toBeInstanceOf(SessionHandleClosedError)
})
