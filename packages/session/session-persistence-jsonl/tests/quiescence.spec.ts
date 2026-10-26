/** Actual JSONL I/O and handle ownership, with no factory or application-ready fixture. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'

it('observes create, unmaterialized handle, flush, read, stat, list and open until their actual continuations settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-quiescence-')), ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const persistence = ctx.sessionPersistence
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('quiescence'),
    createdAt: 1000, isSeeded: false, cwd: '/work' }
  expect(persistence.isQuiescent(8)).toBe(true)
  const creating = persistence.create(header)
  expect(persistence.isQuiescent(8)).toBe(false)
  const handle = await creating
  expect(persistence.isQuiescent(8)).toBe(false)
  const flushing = handle.flush()
  expect(persistence.isQuiescent(8)).toBe(false)
  await flushing
  await vi.waitFor(() => { expect(persistence.isQuiescent(8)).toBe(true) })
  const reading = handle.read()
  expect(persistence.isQuiescent(8)).toBe(false)
  await reading
  expect(persistence.isQuiescent(8)).toBe(true)
  const statting = persistence.stat(header.id)
  expect(persistence.isQuiescent(8)).toBe(false)
  await statting
  expect(persistence.isQuiescent(8)).toBe(true)
  const listing = persistence.list()
  expect(persistence.isQuiescent(8)).toBe(false)
  await listing
  expect(persistence.isQuiescent(8)).toBe(true)
  const opening = persistence.open(header.id, 'read')
  expect(persistence.isQuiescent(8)).toBe(false)
  const reader = await opening
  expect(persistence.isQuiescent(8)).toBe(true)
  await reader.close(); await handle.close()
  expect(persistence.isQuiescent(8)).toBe(true)
})
