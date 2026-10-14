/** The real SSH helper dispatches through caller-owned providers and joins its channel lifetime. */
import { createHash } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runSshHelper } from '@deepseek-ai/dsh-ssh/helper-runtime'
import { doneSchema, preparedSchema, targetSchema } from '../src/schemas.ts'
import { createHelperHarness } from './fixtures/helper.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

class PendingFileSystem extends LocalFileSystem {
  entered = Promise.withResolvers<undefined>()
  aborted = Promise.withResolvers<undefined>()
  release = Promise.withResolvers<undefined>()
  settled = false

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const abort = (): void => { this.aborted.resolve(undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    this.entered.resolve(undefined)
    try {
      await this.release.promise
      signal?.throwIfAborted()
      return await super.streamText(target, signal)
    } finally {
      this.settled = true
      signal?.removeEventListener('abort', abort)
    }
  }
}

class ObservedFileSystem extends LocalFileSystem {
  reads = 0

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    this.reads += 1
    return super.streamText(target, signal)
  }
}

class ObservedSubprocess extends LocalSubprocessRuntime {
  launches: SubprocessHandle[] = []

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = super.spawn(spec)
    this.launches.push(handle)
    return handle
  }
}

class DenyingSandbox extends SandboxProvider {
  requests = 0

  override confine(_argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.requests += 1
    return Promise.reject(new SandboxUnavailableError(policy.mode, 'controlled provider refuses execution'))
  }
}

async function providers() {
  const ctx = new Context()
  await ctx.plugin(ObservedFileSystem)
  await ctx.plugin(ObservedSubprocess)
  await ctx.plugin(DenyingSandbox)
  return { ctx, fs: ctx.fs as ObservedFileSystem, subprocess: ctx.subprocess as ObservedSubprocess, sandbox: ctx.sandbox as DenyingSandbox }
}

async function prepared(test: Awaited<ReturnType<typeof createHelperHarness>>, argv: string[]) {
  const value = await test.client.request('process.prepare', {
    argv, cwd: test.root, graceMs: 50, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  }, preparedSchema)
  for (const endpoint of Object.values(value.streams)) {
    const socket = await test.connectStream(endpoint)
    socket.end(); socket.resume()
  }
  await test.client.request('process.start', { id: value.id }, z.object({}).strict())
  return value.id
}

describe.skipIf(process.platform === 'win32')('SSH helper composed providers', () => {
  it('refuses a supplied Context without its required providers rather than installing defaults', async () => {
    const ctx = new Context()
    const input = new PassThrough()
    const output = new PassThrough()
    try {
      await expect(runSshHelper({ input, output, entryPath: import.meta.filename, signal: new AbortController().signal }, ctx))
        .rejects.toThrow('Context requires fs')
      expect(ctx.get('fs')).toBeUndefined()
      expect(ctx.get('subprocess')).toBeUndefined()
      await ctx.plugin(ObservedFileSystem)
      await expect(runSshHelper({ input, output, entryPath: import.meta.filename, signal: new AbortController().signal }, ctx))
        .rejects.toThrow('Context requires subprocess')
      await ctx.plugin(ObservedSubprocess)
      await expect(runSshHelper({ input, output, entryPath: import.meta.filename, signal: new AbortController().signal }, ctx))
        .rejects.toThrow('Context requires sandbox')
    } finally { input.destroy(); output.destroy(); await ctx.fiber.dispose() }
  })

  it('uses injected filesystem, actual subprocess and sandbox refusal over the original framed protocol', async () => {
    const owner = await providers()
    const test = await createHelperHarness(true, 30_000, owner.ctx)
    try {
      const entry = fileURLToPath(new URL('../src/helper-entry.ts', import.meta.url))
      expect(test.facts!.hash).toBe(createHash('sha256').update(await readFile(entry)).digest('hex'))
      expect(test.facts!.protocol).toBe(1)
      await writeFile(`${test.root}/injected.txt`, 'caller filesystem')
      const target = await test.client.request('fs.resolve', { path: 'injected.txt' }, targetSchema)
      expect(await test.client.request('fs.readText', { target }, z.string())).toBe('caller filesystem')
      expect(owner.fs.reads).toBe(1)
      await expect(test.client.request('sandbox', {
        argv: [process.execPath], policy: { mode: 'read-only', workspaceRoot: test.root },
      }, z.unknown())).rejects.toThrow('controlled provider refuses execution')
      expect(owner.sandbox.requests).toBe(1)
      const id = await prepared(test, [process.execPath, '-e', 'process.stdout.write("fixed trusted fixture\\n")'])
      expect(await test.client.request('process.done', { id }, doneSchema)).toMatchObject({ outcome: { exitCode: 0, signal: null } })
      const processProvider = owner.subprocess
      expect(processProvider.launches).toHaveLength(1)
      expect(await processProvider.launches[0]!.waitForExit()).toBe(true)
      expect(await test.client.request('process.terminate', { id }, z.null())).toBeNull()
      await test.client.request('close', {}, z.null())
      expect(owner.ctx.get('subprocess')).toBeInstanceOf(ObservedSubprocess)
      expect((owner.ctx.get('subprocess') as ObservedSubprocess).launches).toBe(processProvider.launches)
      expect(await owner.ctx.subprocess.resolveExecutable(process.execPath)).toBe(process.execPath)
      await expect(stat(test.facts!.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await test.close(); await owner.ctx.fiber.dispose() }
  })

  it('stops a live fixed fixture and joins cleanup when the caller Context is disposed', async () => {
    const owner = await providers()
    const test = await createHelperHarness(true, 30_000, owner.ctx)
    try {
      await prepared(test, [process.execPath, '-e', 'setInterval(() => {}, 1000)'])
      const handle = owner.subprocess.launches[0]!
      await owner.ctx.fiber.dispose()
      await test.serving
      expect(await handle.waitForExit()).toBe(true)
      await expect(stat(test.facts!.root)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(test.client.request('heartbeat', {}, z.null())).rejects.toThrow('connection lost')
    } finally { await test.close(); await owner.ctx.fiber.dispose() }
  })

  it('joins a cancelled filesystem stream allocation before completing Context disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(PendingFileSystem)
    await ctx.plugin(ObservedSubprocess)
    await ctx.plugin(DenyingSandbox)
    const fs = ctx.fs as PendingFileSystem
    const test = await createHelperHarness(true, 30_000, ctx)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let disposing: Promise<void> | undefined
    try {
      // Remove unrelated disk scheduling from the teardown-completion observation.
      vi.mocked(rm).mockImplementation((path, options) => path === test.facts!.root
        ? Promise.resolve() : actual.rm(path, options))
      const target = await test.client.request('fs.resolve', { path: 'pending' }, targetSchema)
      const pending = test.client.request('fs.stream', { target }, z.string()).catch(() => {})
      await fs.entered.promise
      let disposed = false
      disposing = ctx.fiber.dispose().then(() => { disposed = true })
      await fs.aborted.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
      fs.release.resolve(undefined)
      await disposing
      await pending
      expect(fs.settled).toBe(true)
      expect(disposed).toBe(true)
    } finally {
      fs.release.resolve(undefined)
      await disposing
      vi.mocked(rm).mockImplementation(actual.rm)
      await test.close()
      await ctx.fiber.dispose()
      await actual.rm(test.facts!.root, { recursive: true, force: true })
    }
  })

  it('settles startup and closes transport when the Context unloads during resource allocation', async () => {
    const owner = await providers()
    const input = new PassThrough()
    const output = new PassThrough()
    const serving = runSshHelper({ input, output, entryPath: import.meta.filename, signal: new AbortController().signal }, owner.ctx)
      .then(() => undefined, (error: unknown) => {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/inactive|disposed/iu)
      })
    try {
      await owner.ctx.fiber.dispose()
      await serving
      expect(input.destroyed).toBe(true)
      expect(output.destroyed).toBe(true)
    } finally { input.destroy(); output.destroy(); await owner.ctx.fiber.dispose() }
  })
})
