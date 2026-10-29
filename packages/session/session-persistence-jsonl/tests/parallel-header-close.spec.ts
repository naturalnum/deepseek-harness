import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const hooks = vi.hoisted(() => ({ paths: [] as string[], enabled: () => false,
  entered: undefined as (() => void) | undefined, release: undefined as Promise<unknown> | undefined,
  count: 0, readFailure: undefined as Error | undefined, closeFailure: new Error('independent sibling close failure') }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), index = hooks.paths.indexOf(String(args[0]))
    if (index < 0 || args[1] !== 'r' || !hooks.enabled()) return handle
    let gated = false
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
        if (!gated) { gated = true; hooks.count += 1; if (hooks.count === 2) hooks.entered?.(); await hooks.release }
        if (index === 0 && hooks.readFailure !== undefined) throw hooks.readFailure
        return target.read(...readArgs)
      }
      if (property === 'close') return async () => {
        await target.close()
        if (gated && index === 1) throw hooks.closeFailure
      }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    } })
  } }
})

it.each(['cancel', 'no-cancel', 'cancel-double'] as const)('retains a parallel sibling header close failure with %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-close-cancel-')), ctx = new Context()
  const parent = SessionId('parent'), cwd = '/work'
  for (const id of [parent, SessionId('aaa-child'), SessionId('zzz-child')]) {
    const path = generationLogPath(root, cwd, id, 3, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ type: 'session', id, version: 3, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }) + '\n')
    if (id !== parent) hooks.paths.push(path)
  }
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const internal = ctx.sessionPersistence as unknown as { migrationPreparations: Map<SessionId, unknown> }
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  hooks.enabled = () => internal.migrationPreparations.has(parent)
  hooks.entered = () => { entered.resolve(undefined) }; hooks.release = release.promise
  onTestFinished(async () => {
    release.resolve(undefined); hooks.enabled = () => false; hooks.paths = []; hooks.count = 0; hooks.readFailure = undefined
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  const abort = new AbortController(), reason = new Error('cancel caller')
  const opening = ctx.sessionPersistence.open(parent, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await entered.promise
  if (mode !== 'no-cancel') abort.abort(reason)
  const readFailure = Object.assign(new Error('independent sibling read failure'), { code: 'EIO' })
  if (mode === 'cancel-double') hooks.readFailure = readFailure
  release.resolve(undefined)
  const error: unknown = await opening.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ name: 'JsonlReadCleanupError', cause: hooks.closeFailure })
  if (mode === 'cancel-double') expect(error).toMatchObject({ errors: [
    { name: 'AggregateError', errors: [readFailure, expect.objectContaining({ name: 'JsonlReadCleanupError', cause: hooks.closeFailure })] },
    hooks.closeFailure,
  ] })
  expect(hooks.count).toBe(2)
  expect(ctx.sessionPersistence.isQuiescent(8)).toBe(false)
})
