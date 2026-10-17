/** Constructor registration protects the real Cordis initialization migration. */
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialSaveOperation, CredentialSaveSubmissionHook, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider, type Config } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})

const REF = credentialRef('DSH_INITIAL_SAVE_TEST')
const FLAT = 'DSH_INITIAL_SAVE_TEST: original\n'

async function fixture(hook: CredentialSaveSubmissionHook, text = FLAT) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'credential-initial-save-'))
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.credentials.yaml')
  await fs.writeFile(path, text, { mode: 0o600 })
  const ctx = new Context()
  let resolveCredential = () => Promise.resolve<ResolvedCredential | undefined>(undefined)
  class GuardedLocalCredentials extends LocalCredentialProvider {
    constructor(scope: Context, config: Config) {
      super(scope, config)
      this.registerSaveHook(hook)
      resolveCredential = () => this.resolve(REF)
    }
  }
  const fiber = ctx.plugin(GuardedLocalCredentials, { path, watch: false })
  onTestFinished(async () => { await fiber.dispose() })
  return { ctx, dir, path, fiber, resolve: () => resolveCredential() }
}

it('registers before initialization writes and includes cache loading in the observed task', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const operations: CredentialSaveOperation[] = []
  const pending = new Set<Promise<unknown>>()
  const settledValues: unknown[] = []
  let resolveValue = () => Promise.resolve<unknown>(undefined)
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const boot = await fixture({
    submit<T>(operation: CredentialSaveOperation, submit: () => Promise<T>): Promise<T> {
      operations.push(operation)
      const task = submit()
      pending.add(task)
      void task.then(async () => {
        settledValues.push(await resolveValue())
        pending.delete(task)
      }, () => { pending.delete(task) })
      return task
    },
  })
  resolveValue = () => boot.resolve()
  const ready = boot.fiber.await()
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([ready]) })
  await entered.promise
  expect(operations).toEqual([{ kind: 'migrate-flat-document' }])
  expect(pending.size).toBe(1)
  expect(readFileSync(boot.path, 'utf8')).toBe(FLAT)
  expect(boot.ctx.get('credentials')).toBeUndefined()
  release.resolve(undefined)
  await ready
  expect(pending.size).toBe(0)
  expect(settledValues).toEqual([{ value: 'original', source: 'file' }])
  expect(await boot.ctx.credentials.resolve(REF)).toEqual({ value: 'original', source: 'file' })
  expect(readFileSync(boot.path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_INITIAL_SAVE_TEST: original\n')
})

it('denies initialization migration before lock files, temporary files or replacement', async () => {
  const denied = new Error('initial save admission closed')
  const boot = await fixture({ submit() { throw denied } })
  await expect(boot.fiber.await()).rejects.toBe(denied)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(await fs.readdir(boot.dir)).toEqual(['.credentials.yaml'])
  expect(readFileSync(boot.path, 'utf8')).toBe(FLAT)
  expect(boot.ctx.get('credentials')).toBeUndefined()
})

it('preserves actual initialization write failures and refuses service readiness', async () => {
  const tasks: Promise<unknown>[] = []
  const failures: unknown[] = []
  const failure = Object.assign(new Error('initial credential write failed'), { code: 'EIO' })
  vi.mocked(fs.rename).mockRejectedValueOnce(failure)
  const boot = await fixture({
    submit<T>(_operation: CredentialSaveOperation, submit: () => Promise<T>): Promise<T> {
      const task = submit()
      tasks.push(task)
      void task.catch((error: unknown) => { failures.push(error) })
      return task
    },
  })
  await expect(boot.fiber.await()).rejects.toBe(failure)
  expect(tasks).toHaveLength(1)
  await expect(tasks[0]).rejects.toBe(failure)
  expect(failures).toEqual([failure])
  expect(readFileSync(boot.path, 'utf8')).toBe(FLAT)
  expect(boot.ctx.get('credentials')).toBeUndefined()
})

it('starts a versioned document without a migration submission', async () => {
  const submit = vi.fn(() => { throw new Error('unexpected migration') })
  const boot = await fixture({ submit }, 'version: 1\nrefs:\n  DSH_INITIAL_SAVE_TEST: existing\n')
  await boot.fiber.await()
  expect(submit).not.toHaveBeenCalled()
  expect(fs.rename).not.toHaveBeenCalled()
  expect(await boot.ctx.credentials.resolve(REF)).toEqual({ value: 'existing', source: 'file' })
})
