/** Native upload storage admission with production Agents and bounded local attachment storage. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import FileUploads from '../src/index.ts'

class HeldUploads extends FileUploads {
  readonly entered = Promise.withResolvers<{ agent: Agent; input: SaveFileStreamAttachment }>()
  readonly admit = Promise.withResolvers<undefined>()
  saved: FileAttachmentRef | undefined
  failure: Error | undefined

  protected override async storeFileStream(agent: Agent, input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    this.entered.resolve({ agent, input })
    await this.admit.promise
    input.signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    this.saved = await super.storeFileStream(agent, input)
    return this.saved
  }
}

async function fixture<Upload extends FileUploads>(make: (ctx: Context) => Upload) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-upload-store-hook-'))
  const ctx = new Context(), jobs: Promise<unknown>[] = [], release: (() => void)[] = []
  onTestFinished(async () => {
    for (const finish of release) finish()
    await Promise.allSettled(jobs)
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  const native = await mountAgentLoopTestHarness(ctx)
  const agent = await native.create(SessionId('stream-store-owner'))
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  // Only route registration is a fixture; this test does not send HTTP or mount a Peer.
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  const uploads = make(ctx)
  return { ctx, agent, store, uploads, release, track: <T>(job: Promise<T>) => { jobs.push(job); return job } }
}

function source() {
  const tail = Promise.withResolvers<undefined>(), waiting = Promise.withResolvers<undefined>()
  let pulls = 0, closed = false
  const data = (async function* () {
    try {
      pulls++
      yield Uint8Array.of(0, 255)
      waiting.resolve(undefined)
      await tail.promise
      pulls++
      yield Uint8Array.of(1, 2)
    } finally { closed = true }
  })()
  return { data, waiting, tail, get pulls() { return pulls }, get closed() { return closed } }
}

it('awaits admission with the exact resolved Agent and original input, then waits for native storage before publishing', async () => {
  const f = await fixture(ctx => new HeldUploads(ctx)), body = source()
  f.release.push(() => { f.uploads.admit.resolve(undefined) }, () => { body.tail.resolve(undefined) })
  const resolve = vi.fn(async () => f.agent)
  f.uploads.registerAgentResolver(resolve)
  vi.spyOn(f.ctx.agents, 'get').mockReturnValueOnce(undefined)
  const save = vi.spyOn(f.store, 'saveFileStream'), signal = new AbortController().signal
  const published: unknown[] = []
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.agent.id, data: body.data, signal, name: 'raw.bin' }))
  void pending.then((value) => { published.push(value) }, () => undefined)
  const entered = await f.uploads.entered.promise
  expect(resolve).toHaveBeenCalledWith(f.agent.id)
  expect(entered.agent).toBe(f.agent)
  expect(entered.agent.session).toBe(f.agent.session)
  expect(entered.input.data).toBe(body.data)
  expect(entered.input.signal).toBe(signal)
  expect(entered.input.name).toBe('raw.bin')
  expect(body.pulls).toBe(0)
  expect(save).not.toHaveBeenCalled()
  expect(published).toEqual([])
  f.uploads.admit.resolve(undefined)
  await body.waiting.promise
  expect(body.pulls).toBe(1)
  expect(body.closed).toBe(false)
  expect(save).toHaveBeenCalledExactlyOnceWith(entered.input)
  expect(f.uploads.saved).toBeUndefined()
  expect(published).toEqual([])
  body.tail.resolve(undefined)
  const value = await pending
  expect(body.closed).toBe(true)
  expect(value.file).toBe(f.uploads.saved)
  expect(f.uploads.resolve(f.agent, value.receiptId)).toBe(value.file)
  const path = f.store.fileHostPath(value.file)
  expect(await readFile(path)).toEqual(Buffer.from([0, 255, 1, 2]))
  const binding = f.uploads.bindPrompt(f.agent, [value.receiptId], 'native-prompt')
  binding.commit()
  binding[Symbol.dispose]()
  f.uploads.retirePrompt(f.agent, 'native-prompt')
  expect(f.uploads.resolve(f.agent, value.receiptId)).toBeUndefined()
})

it.each(['ordinary', 'attachment'] as const)('keeps %s hook failure inside existing error handling and publishes no receipt', async (kind) => {
  const f = await fixture(ctx => new HeldUploads(ctx)), body = source()
  f.release.push(() => { f.uploads.admit.resolve(undefined) }, () => { body.tail.resolve(undefined) })
  const failure = kind === 'attachment'
    ? new AttachmentError('bounded admission rejected', 'ATTACHMENT_WRITE_FAILED') : new Error('bounded admission rejected')
  f.uploads.failure = failure
  const save = vi.spyOn(f.store, 'saveFileStream'), published = vi.fn()
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.agent.id, data: body.data }))
  void pending.then(published, () => undefined)
  const rejected = kind === 'attachment'
    ? expect(pending).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'ATTACHMENT_WRITE_FAILED' } })
    : expect(pending).rejects.toMatchObject({ code: 'gateway/internal', cause: failure })
  await f.uploads.entered.promise
  f.uploads.admit.resolve(undefined)
  await rejected
  expect(save).not.toHaveBeenCalled()
  expect(body.pulls).toBe(0)
  expect(published).not.toHaveBeenCalled()
})

it('keeps queued cancellation in the original signal and does not pull or publish', async () => {
  const f = await fixture(ctx => new HeldUploads(ctx)), body = source(), controller = new AbortController()
  f.release.push(() => { f.uploads.admit.resolve(undefined) }, () => { body.tail.resolve(undefined) })
  const save = vi.spyOn(f.store, 'saveFileStream'), published = vi.fn()
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.agent.id, data: body.data, signal: controller.signal }))
  void pending.then(published, () => undefined)
  const reason = new Error('cancelled while owned admission waits')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/internal', cause: reason })
  expect((await f.uploads.entered.promise).input.signal).toBe(controller.signal)
  controller.abort(reason)
  expect(body.pulls).toBe(0)
  f.uploads.admit.resolve(undefined)
  await rejected
  expect(save).not.toHaveBeenCalled()
  expect(published).not.toHaveBeenCalled()
})

it('defaults to the original native store and returns its exact durable reference without optional inputs', async () => {
  const f = await fixture(ctx => new FileUploads(ctx))
  const save = vi.spyOn(f.store, 'saveFileStream')
  const data = (async function* () { yield Uint8Array.of(9, 0, 255) })()
  const value = await f.track(f.uploads.uploadStream({ sessionId: f.agent.id, data }))
  expect(save).toHaveBeenCalledExactlyOnceWith({ data })
  const result = save.mock.results[0]
  if (result?.type !== 'return') throw new Error('Native storage did not return its promise')
  expect(value.file).toBe(await result.value)
  expect(value.file.bytes).toBe(3)
  expect(f.uploads.resolve(f.agent, value.receiptId)).toBe(value.file)
  expect(await readFile(f.store.fileHostPath(value.file))).toEqual(Buffer.from([9, 0, 255]))
})
