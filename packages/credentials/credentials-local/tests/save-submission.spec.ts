/** Save admission observes the provider's actual queue, atomic commit and publication. */
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, CredentialSaveOperation, CredentialSaveSubmissionHook } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

afterEach(() => { vi.restoreAllMocks() })
beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})

const REF = credentialRef('DSH_SAVE_TEST')
const KEY = credentialKey('save-test', 'grant')

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dsh-credential-save-'))
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.credentials.yaml')
  await fs.writeFile(path, 'version: 1\nrefs:\n  DSH_SAVE_TEST: original\n', { mode: 0o600 })
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
  await fiber
  onTestFinished(async () => { await fiber.dispose() })
  return { ctx, path }
}

function observer() {
  const pending = new Set<Promise<unknown>>()
  const submitted: Promise<unknown>[] = []
  const operations: CredentialSaveOperation[] = []
  const failures: unknown[] = []
  let accepting = true
  const denied = new Error('credential admission closed')
  const hook: CredentialSaveSubmissionHook = {
    submit<T>(operation: CredentialSaveOperation, submit: () => Promise<T>): Promise<T> {
      if (!accepting) throw denied
      const task = submit()
      operations.push(operation)
      submitted.push(task)
      pending.add(task)
      void task.then(() => { pending.delete(task) }, (error: unknown) => {
        pending.delete(task)
        failures.push(error)
      })
      return task
    },
  }
  return { hook, pending, submitted, operations, failures, denied, stop: () => { accepting = false } }
}

it('registers every queued mutation synchronously, with no secret values in metadata', async () => {
  const { ctx, path } = await fixture()
  const tracked = observer()
  const dispose = ctx.credentials.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const before = readFileSync(path, 'utf8')
  const record: CredentialRecord = { kind: 'grant', payload: { token: 'private-grant' } }
  const set = ctx.credentials.set(REF, 'private-key')
  const modify = ctx.credentials.modifyRecord(KEY, () => Promise.resolve(record))
  const unset = ctx.credentials.unset(REF)
  const remove = ctx.credentials.deleteRecord(KEY)
  const tasks = [set, modify, unset, remove]
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled(tasks)
    await dispose()
  })
  expect(tracked.pending.size).toBe(4)
  expect(tracked.operations).toEqual([
    { kind: 'set', ref: REF }, { kind: 'modify-record', key: KEY },
    { kind: 'unset', ref: REF }, { kind: 'delete-record', key: KEY },
  ])
  await entered.promise
  expect(fs.rename).toHaveBeenCalledOnce()
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'original', source: 'file' })
  tracked.stop()
  await expect(ctx.credentials.set(REF, 'refused')).rejects.toBe(tracked.denied)
  expect(tracked.submitted).toHaveLength(4)
  release.resolve(undefined)
  await Promise.all(tasks)
  await expect(modify).resolves.toBe(record)
  expect(tracked.pending.size).toBe(0)
  expect(tracked.failures).toEqual([])
  expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
})

it('denies all mutation kinds before queue submission, mutators, I/O or cache changes', async () => {
  const { ctx, path } = await fixture()
  const tracked = observer()
  onTestFinished(ctx.credentials.registerSaveHook(tracked.hook))
  tracked.stop()
  const before = readFileSync(path, 'utf8')
  const mutate = vi.fn(() => Promise.resolve<CredentialRecord>({ kind: 'grant', payload: { secret: 'refused' } }))
  const tasks = [
    ctx.credentials.set(REF, 'refused'), ctx.credentials.unset(REF),
    ctx.credentials.modifyRecord(KEY, mutate), ctx.credentials.deleteRecord(KEY),
  ]
  for (const task of tasks) await expect(task).rejects.toBe(tracked.denied)
  expect(mutate).not.toHaveBeenCalled()
  expect(fs.rename).not.toHaveBeenCalled()
  expect(tracked.submitted).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'original', source: 'file' })
  expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
})

it('keeps an atomic-write rejection observable while the native queue continues', async () => {
  const { ctx } = await fixture()
  const tracked = observer()
  onTestFinished(ctx.credentials.registerSaveHook(tracked.hook))
  const failure = Object.assign(new Error('credential disk unavailable'), { code: 'EIO' })
  vi.mocked(fs.rename).mockRejectedValueOnce(failure)
  const first = ctx.credentials.set(REF, 'failed')
  const rejected = expect(first).rejects.toBe(failure)
  const second = ctx.credentials.set(REF, 'final')
  expect(tracked.pending.size).toBe(2)
  await rejected
  await second
  await expect(tracked.submitted[0]).rejects.toBe(failure)
  expect(tracked.failures).toEqual([failure])
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'final', source: 'file' })
  expect(tracked.pending.size).toBe(0)
})

it('retains slow record mutation and its rejection before later writes can run', async () => {
  const { ctx } = await fixture()
  const tracked = observer()
  const dispose = ctx.credentials.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const failure = new Error('token refresh failed')
  const first = ctx.credentials.modifyRecord(KEY, async () => {
    entered.resolve(undefined)
    await release.promise
    throw failure
  })
  const rejected = expect(first).rejects.toBe(failure)
  const second = ctx.credentials.set(REF, 'after-refresh')
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([first, second])
    await dispose()
  })
  expect(tracked.pending.size).toBe(2)
  await entered.promise
  expect(fs.rename).not.toHaveBeenCalled()
  release.resolve(undefined)
  await rejected
  await second
  expect(tracked.failures).toEqual([failure])
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'after-refresh', source: 'file' })
})

it('publishes committed cache changes before settlement and contains optional listener failures', async () => {
  const { ctx, path } = await fixture()
  const tracked = observer()
  onTestFinished(ctx.credentials.registerSaveHook(tracked.hook))
  const seen: string[] = []
  const snapshots: Array<Promise<unknown>> = []
  ctx.on('credentials/reference-updated', (ref) => {
    expect(tracked.pending.size).toBe(1)
    expect(readFileSync(path, 'utf8')).toContain('committed')
    snapshots.push(ctx.credentials.resolve(ref))
    seen.push('reference')
    throw new Error('optional reference observer failed')
  })
  ctx.on('credentials/record-updated', (key) => {
    expect(tracked.pending.size).toBe(1)
    snapshots.push(ctx.credentials.readRecord(key))
    seen.push('record')
    throw new Error('optional record observer failed')
  })
  await ctx.credentials.set(REF, 'committed')
  const record: CredentialRecord = { kind: 'grant', payload: { token: 'committed' } }
  await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(record))
  expect(seen).toEqual(['reference', 'record'])
  expect(await Promise.all(snapshots)).toEqual([{ value: 'committed', source: 'file' }, record])
  expect(tracked.failures).toEqual([])
  expect(tracked.pending.size).toBe(0)
})

it('owns one provider hook as a caller effect and withdraws it on caller unload', async () => {
  const { ctx } = await fixture()
  const tracked = observer()
  const owner = await ctx.plugin({ inject: ['credentials'], apply(scope) {
    scope.credentials.registerSaveHook(tracked.hook)
  } })
  expect(() => ctx.credentials.registerSaveHook(tracked.hook)).toThrow('already registered')
  await ctx.credentials.set(REF, 'observed')
  expect(tracked.operations).toEqual([{ kind: 'set', ref: REF }])
  await owner.dispose()
  await ctx.credentials.set(REF, 'native')
  expect(tracked.operations).toEqual([{ kind: 'set', ref: REF }])
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'native', source: 'file' })
})
