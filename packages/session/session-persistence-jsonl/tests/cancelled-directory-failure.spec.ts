import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const hooks = vi.hoisted(() => ({ first: '', second: '', firstCalls: 0, secondCalls: 0,
  firstEntered: undefined as (() => void) | undefined, secondEntered: undefined as (() => void) | undefined,
  release: undefined as Promise<unknown> | undefined, failure: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, readdir: (async (...args: Parameters<typeof actual.readdir>) => {
    const result = await actual.readdir(...args)
    if (args[0] === hooks.first && ++hooks.firstCalls === 2) { hooks.firstEntered?.(); await hooks.release }
    if (args[0] === hooks.second && ++hooks.secondCalls === 2) {
      hooks.secondEntered?.(); await hooks.release
      if (hooks.failure !== undefined) throw hooks.failure
    }
    return result
  }) as typeof actual.readdir }
})

it.each(['independent', 'internal-reason'] as const)('preserves %s project failure when cancelled', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-project-cancel-')), ctx = new Context()
  const first = Promise.withResolvers<undefined>(), second = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    Object.assign(hooks, { first: '', second: '', firstCalls: 0, secondCalls: 0,
      firstEntered: undefined, secondEntered: undefined, release: undefined, failure: undefined })
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  const parent = SessionId('parent'), child = SessionId('child')
  const parentPath = generationLogPath(root, '/a', parent, 3, 'none')
  const childPath = generationLogPath(root, '/b', child, 3, 'none')
  await mkdir(dirname(parentPath), { recursive: true }); await mkdir(dirname(childPath), { recursive: true })
  await writeFile(parentPath, JSON.stringify({ type: 'session', id: parent, version: 3, createdAt: 1,
    cwd: '/a', isSeeded: false, delegationDepth: 0 }) + '\n')
  await writeFile(childPath, JSON.stringify({ type: 'session', id: child, version: 3, createdAt: 2,
    cwd: '/b', isSeeded: false, origin: 'subagent', parentSession: parent, delegationDepth: 1 }) + '\n')
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  hooks.first = dirname(dirname(parentPath)); hooks.second = dirname(dirname(childPath))
  hooks.firstEntered = () => { first.resolve(undefined) }; hooks.secondEntered = () => { second.resolve(undefined) }
  hooks.release = release.promise
  const abort = new AbortController(), reason = new Error('cancel parent')
  const opening = ctx.sessionPersistence.open(parent, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await Promise.all([first.promise, second.promise])
  const state = ctx.sessionPersistence as unknown as { migrationPreparations: Map<SessionId, { controller: AbortController }> }
  const preparation = state.migrationPreparations.get(parent)
  if (preparation === undefined) throw new Error('Missing preparation')
  abort.abort(reason)
  const failure = kind === 'independent' ? new Error('project listing failed') : preparation.controller.signal.reason as Error
  hooks.failure = failure; release.resolve(undefined)
  const error: unknown = await opening.catch((cause: unknown) => cause)
  if (kind === 'independent') expect(error).toMatchObject({ name: 'SessionPersistenceCorruptionError', cause: failure })
  else expect(error).toMatchObject({ name: 'SessionPersistenceCorruptionError', cause: {
    name: 'AggregateError', cause: failure, errors: [failure],
  } })
})
