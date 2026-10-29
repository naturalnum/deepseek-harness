import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { generationLogPath, toHeaderLine } from '../src/format.ts'

const gate = vi.hoisted(() => ({ path: '', entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined, finished: false, options: undefined as unknown }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (async (...args: Parameters<typeof actual.readFile>) => {
    if (args[0] === gate.path && gate.release !== undefined) {
      gate.options = args[1]
      const result = await actual.readFile(...args)
      gate.entered?.()
      await gate.release
      gate.finished = true
      return result
    }
    return actual.readFile(...args)
  }) as typeof actual.readFile }
})

it('joins the actual file read before rejecting a cancelled JSONL observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-native-observation-abort-'))
  const ctx = new Context(), abort = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined); gate.path = ''; gate.release = undefined; gate.entered = undefined
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const id = SessionId('native-abort'), header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/work' }
  const path = generationLogPath(root, header.cwd, id, SESSION_FORMAT_VERSION, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(toHeaderLine(header)) + '\n')
  gate.path = path; gate.entered = () => { entered.resolve(undefined) }; gate.release = release.promise
  gate.finished = false; gate.options = undefined
  const pending = new SessionObservationReader(ctx).read(id, { signal: abort.signal, projectionMode: 'none' })
  void pending.catch(() => {})
  await entered.promise
  const reason = new Error('cancel JSONL read')
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  abort.abort(reason)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  expect(gate.options).toBeUndefined()
  release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
  expect(gate.finished).toBe(true)
}, 5000)
