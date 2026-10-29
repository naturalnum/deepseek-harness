import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const hooks = vi.hoisted(() => ({ target: undefined as Buffer | undefined,
  entered: undefined as (() => void) | undefined, release: undefined as Promise<unknown> | undefined,
  failure: undefined as Error | undefined, secondary: undefined as Buffer | undefined,
  enteredSecondary: undefined as (() => void) | undefined, releaseSecondary: undefined as Promise<unknown> | undefined }))

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  return { ...actual, decompressZstdFrame: async (frame: Buffer) => {
    if (hooks.secondary?.equals(frame) === true) { hooks.enteredSecondary?.(); await hooks.releaseSecondary }
    if (hooks.target?.equals(frame) === true) {
      hooks.entered?.(); await hooks.release
      if (hooks.failure !== undefined) throw hooks.failure
    }
    return actual.decompressZstdFrame(frame)
  } }
})

it.each(['cancel', 'no-cancel', 'parallel'] as const)('preserves a child header failure with %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-child-header-')), ctx = new Context()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const enteredSecondary = Promise.withResolvers<undefined>(), releaseSecondary = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined); releaseSecondary.resolve(undefined)
    Object.assign(hooks, { target: undefined, entered: undefined, release: undefined, failure: undefined,
      secondary: undefined, enteredSecondary: undefined, releaseSecondary: undefined })
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  const parent = SessionId('a-historical-parent'), child = SessionId('z-historical-child')
  const parentPath = generationLogPath(root, '/work', parent, 3, 'zstd')
  const childPath = generationLogPath(root, '/work', child, 3, 'zstd')
  const parentHeader = { type: 'session', id: parent, version: 3, createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0 }
  const childHeader = { type: 'session', id: child, version: 3, createdAt: 2, cwd: '/work', isSeeded: false,
    origin: 'subagent', parentSession: parent, delegationDepth: 1 }
  await mkdir(dirname(parentPath), { recursive: true }); await mkdir(dirname(childPath), { recursive: true })
  const parentFrame = await compressZstdFrame(JSON.stringify(parentHeader) + '\n')
  await writeFile(parentPath, parentFrame)
  const childFrame = await compressZstdFrame(JSON.stringify(childHeader) + '\n')
  await writeFile(childPath, childFrame)
  await ctx.plugin(JsonlPersistence, { root, compression: 'zstd' })
  const failure = new Error('independent header decompression failed'), abort = new AbortController()
  hooks.target = childFrame; hooks.entered = () => { entered.resolve(undefined) }; hooks.release = release.promise; hooks.failure = failure
  if (mode === 'parallel') {
    hooks.secondary = parentFrame; hooks.enteredSecondary = () => { enteredSecondary.resolve(undefined) }
    hooks.releaseSecondary = releaseSecondary.promise
  }
  const opening = ctx.sessionPersistence.open(parent, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await Promise.race([entered.promise, opening.then(() => { throw new Error('Open completed before child header read') })])
  if (mode === 'parallel') await enteredSecondary.promise
  if (mode !== 'no-cancel') abort.abort(new Error('cancel parent'))
  release.resolve(undefined); releaseSecondary.resolve(undefined)
  if (mode !== 'no-cancel') {
    await expect(opening).rejects.toMatchObject({ name: 'SessionPersistenceCorruptionError', cause: failure })
  } else {
    const handle = await opening
    await handle.close()
  }
})
