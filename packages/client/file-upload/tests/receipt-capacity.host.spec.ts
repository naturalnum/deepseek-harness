/** Native receipt slots include actual unfinished work and remain held for unconfirmed intake. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import FileUploads, { type Config, FILE_UPLOAD_PATH, FileUploadIntakeUnconfirmedError } from '../src/index.ts'
import { handleFileUploadHttp } from '../src/http-route.ts'

class SwitchUploads extends FileUploads {
  failure: Error | undefined
  observe: ((input: SaveFileStreamAttachment) => void) | undefined
  calls = 0
  protected override async storeFileStream(agent: Agent, input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    this.calls++
    this.observe?.(input)
    if (this.failure !== undefined) throw this.failure
    return super.storeFileStream(agent, input)
  }
}

async function fixture(maxPendingReceipts: number) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-receipt-cap-')), ctx = new Context()
  const jobs: Promise<unknown>[] = [], release: (() => void)[] = []
  const cleanup: { unconfirmed: boolean; stop?: () => Promise<void> } = { unconfirmed: false }
  const logger = ctx.logger
  onTestFinished(async () => {
    try {
      for (const finish of release) finish()
      await Promise.allSettled(jobs)
      await cleanup.stop?.()
      await ctx.fiber.dispose()
      const errors = logger.buffer.filter(message => message.type === 'error')
      if (cleanup.unconfirmed) {
        expect(errors.some(message => message.args.some(arg => arg instanceof FileUploadIntakeUnconfirmedError))).toBe(true)
      }
      else expect(errors).toEqual([])
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await mountAgentLoopTestHarness(ctx)
  const loop = ctx.agentLoop
  cleanup.stop = () => loop.stop()
  const handle = await ctx.agents.create({ sessionId: SessionId('capacity-owner') })
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  const route: { fetch?: (request: Request) => Promise<Response> } = {}
  ctx.provide('connection', { fetch: { register: (entry: { fetch: (request: Request) => Promise<Response> }) => {
    route.fetch = entry.fetch
    return () => { delete route.fetch }
  } } } as never)
  const owners: SwitchUploads[] = []
  class NativeUploads extends SwitchUploads {
    constructor(owner: Context, config: Config) { super(owner, config); owners.push(this) }
  }
  await ctx.plugin(NativeUploads, { maxPendingReceipts })
  const service = owners[0]
  if (service === undefined) throw new Error('Native upload owner did not activate')
  return { ctx, handle, store, uploads: service, cleanup, release, logger,
    request: (request: Request) => {
      if (route.fetch === undefined) throw new Error('Native upload route was not registered')
      return route.fetch(request)
    },
    track: <T>(job: Promise<T>) => { jobs.push(job); return job },
    empty: (agent = handle.agent) => {
      const data = (async function* () { yield new Uint8Array() })()
      return service.uploadStream({ sessionId: agent.id, data, name: 'empty.bin' })
    },
  }
}

function heldSource() {
  const waiting = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  let closed = false
  const data = (async function* () {
    try { yield Uint8Array.of(1); waiting.resolve(undefined); await finish.promise; yield Uint8Array.of(2) }
    finally { closed = true }
  })()
  return { data, waiting, finish, get closed() { return closed } }
}

const full = { code: 'session/attachment-invalid', details: { reason: 'FILE_UPLOAD_CAPACITY' } }

it('shares native intake state across real plugin callers and the constructor-captured HTTP service', async () => {
  const f = await fixture(1), callers: FileUploads[] = []
  class ConsumerA {
    static inject = ['fileUploads']
    constructor(ctx: Context) { callers.push(ctx.fileUploads) }
  }
  class ConsumerB {
    static inject = ['fileUploads']
    constructor(ctx: Context) { callers.push(ctx.fileUploads) }
  }
  await f.ctx.plugin(ConsumerA)
  await f.ctx.plugin(ConsumerB)
  const [a, b] = callers
  if (a === undefined || b === undefined) throw new Error('Native plugin consumers did not activate')
  expect(a).not.toBe(f.uploads)
  expect(b).not.toBe(a)
  const input = { sessionId: f.handle.agent.id, data: (async function* () { yield new Uint8Array() })() }
  const first = await f.track(a.uploadStream(input))
  await expect(f.track(b.uploadStream({ ...input, data: (async function* () {})() }))).rejects.toMatchObject(full)
  const binding = b.bindPrompt(f.handle.agent, [first.receiptId], 'proxy-prompt')
  binding.commit(); binding[Symbol.dispose]()
  b.retirePrompt(f.handle.agent, 'proxy-prompt')
  const resolver = vi.fn(async () => f.handle.agent)
  const unregister = b.registerAgentResolver(resolver)
  expect(() => a.registerAgentResolver(async () => f.handle.agent)).toThrow('already registered')
  vi.spyOn(f.ctx.agents, 'get').mockReturnValueOnce(undefined)
  const request = new Request(`http://fixture${FILE_UPLOAD_PATH}?sessionId=${f.handle.agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([Uint8Array.of(7)]),
  })
  const response = await f.track(f.request(request)), result: unknown = await response.json()
  expect(result).toMatchObject({ ok: true, value: { file: { bytes: 1 } } })
  expect(resolver).toHaveBeenCalledExactlyOnceWith(f.handle.agent.id)
  unregister()
  const remove = a.registerAgentResolver(async () => f.handle.agent)
  remove()
})

it.each([
  { name: 'omitted', config: undefined, expected: 128 },
  { name: 'explicit', config: { maxPendingReceipts: 2 }, expected: 2 },
])('registers the real FileUploads service with $name configuration', async ({ config, expected }) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-upload-native-default-')), ctx = new Context()
  const logger = ctx.logger
  const register = vi.fn(() => () => {})
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    await mountAgentLoopTestHarness(ctx)
    new LocalAttachmentStore(ctx, { dshHome: home })
    ctx.provide('connection', { fetch: { register } } as never)
    const fiber = config === undefined ? ctx.plugin(FileUploads) : ctx.plugin(FileUploads, config)
    await fiber
    expect(fiber.config).toEqual({ maxPendingReceipts: expected })
    expect(ctx.get('fileUploads')).toBeDefined()
    expect(register).toHaveBeenCalledOnce()
    expect(logger.buffer.filter(message => message.type === 'error')).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('defaults to 128 finite slots and rejects invalid capacities', () => {
  expect(FileUploads.Config.parse(undefined)).toEqual({ maxPendingReceipts: 128 })
  expect(FileUploads.Config.parse({})).toEqual({ maxPendingReceipts: 128 })
  for (const maxPendingReceipts of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => FileUploads.Config.parse({ maxPendingReceipts })).toThrow()
  }
})

it('bounds zero-byte receipts and releases only entries actually retired or disposed', async () => {
  const f = await fixture(2)
  const first = await f.track(f.empty()), second = await f.track(f.empty())
  let pulls = 0
  const data = (async function* () { pulls++; yield new Uint8Array() })()
  await expect(f.track(f.uploads.uploadStream({ sessionId: f.handle.agent.id, data }))).rejects.toMatchObject(full)
  expect(pulls).toBe(0)
  expect(f.uploads.calls).toBe(2)
  f.uploads.retirePrompt(f.handle.agent, 'never-bound')
  await expect(f.track(f.empty())).rejects.toMatchObject(full)
  const binding = f.uploads.bindPrompt(f.handle.agent, [first.receiptId], 'accepted')
  binding.commit(); binding[Symbol.dispose]()
  f.uploads.retirePrompt(f.handle.agent, 'accepted')
  f.uploads.retirePrompt(f.handle.agent, 'accepted')
  const replacement = await f.track(f.empty())
  expect(f.uploads.resolve(f.handle.agent, first.receiptId)).toBeUndefined()
  expect(f.uploads.resolve(f.handle.agent, second.receiptId)).toBe(second.file)
  expect(f.uploads.resolve(f.handle.agent, replacement.receiptId)).toBe(replacement.file)
  await expect(f.track(f.empty())).rejects.toMatchObject(full)
  await f.handle.dispose()
  const next = await f.ctx.agents.create({ sessionId: SessionId('capacity-next') })
  await f.track(f.empty(next.agent)); await f.track(f.empty(next.agent))
  await expect(f.track(f.empty(next.agent))).rejects.toMatchObject(full)
})

it('retains an unfinished real save through caller cancellation and native Session disposal', async () => {
  const f = await fixture(1), source = heldSource(), abort = new AbortController()
  f.release.push(() => { source.finish.resolve(undefined) })
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.handle.agent.id, data: source.data, signal: abort.signal }))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/internal' })
  await source.waiting.promise
  abort.abort(new Error('caller left while original save waits'))
  await f.handle.dispose()
  const next = await f.ctx.agents.create({ sessionId: SessionId('capacity-after-dispose') })
  await expect(f.track(f.empty(next.agent))).rejects.toMatchObject(full)
  expect(source.closed).toBe(false)
  expect(f.uploads.calls).toBe(1)
  source.finish.resolve(undefined)
  await rejected
  expect(source.closed).toBe(true)
  await f.track(f.empty(next.agent))
})

it('refuses a late receipt for a disposed native Session even if Agent lookup still returns it', async () => {
  const f = await fixture(1), source = heldSource()
  f.release.push(() => { source.finish.resolve(undefined) })
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.handle.agent.id, data: source.data }))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'session/not-found' })
  await source.waiting.promise
  await f.handle.dispose()
  const lookup = vi.spyOn(f.ctx.agents, 'get').mockReturnValue(f.handle.agent)
  source.finish.resolve(undefined)
  await rejected
  lookup.mockRestore()
  expect(source.closed).toBe(true)
})

it('reserves before cold Agent resolution and frees an ordinary failed intake', async () => {
  const f = await fixture(1), entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  f.release.push(() => { resume.resolve(undefined) })
  f.uploads.registerAgentResolver(async () => { entered.resolve(undefined); await resume.promise; throw new Error('cold resolution failed') })
  const pending = f.track(f.uploads.uploadStream({ sessionId: SessionId('missing-agent'), data: (async function* () {})() }))
  const rejected = expect(pending).rejects.toThrow('cold resolution failed')
  await entered.promise
  await expect(f.track(f.empty())).rejects.toMatchObject(full)
  resume.resolve(undefined)
  await rejected
  f.uploads.failure = new Error('ordinary hook failure')
  await expect(f.track(f.empty())).rejects.toMatchObject({ code: 'gateway/internal' })
  f.uploads.failure = undefined
  await f.track(f.empty())
})

it('retains an unconfirmed slot, closes admission, and reports unconfirmed owner disposal', async () => {
  const f = await fixture(2)
  const first = await f.track(f.empty())
  const binding = f.uploads.bindPrompt(f.handle.agent, [first.receiptId], 'accepted')
  binding.commit(); binding[Symbol.dispose]()
  const failure = new FileUploadIntakeUnconfirmedError()
  f.uploads.failure = failure; f.cleanup.unconfirmed = true
  await expect(f.track(f.empty())).rejects.toBe(failure)
  f.uploads.retirePrompt(f.handle.agent, 'accepted')
  f.uploads.failure = undefined
  await expect(f.track(f.empty())).rejects.toMatchObject(full)
  expect(f.uploads.calls).toBe(2)
  await f.ctx.agentLoop.stop()
  await f.ctx.fiber.dispose()
  // Cordis reports effect-disposal errors through its structured logger, not the outer promise.
  expect(f.logger.buffer.some(message => message.args.some(arg => arg instanceof FileUploadIntakeUnconfirmedError))).toBe(true)
})

it('joins the actual unfinished native save during owner disposal', async () => {
  const f = await fixture(1), source = heldSource(), abort = new AbortController()
  f.release.push(() => { source.finish.resolve(undefined) })
  const pending = f.track(f.uploads.uploadStream({ sessionId: f.handle.agent.id, data: source.data, signal: abort.signal }))
  const reason = new Error('caller abort while native owner closes')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/internal', cause: reason })
  await source.waiting.promise
  let disposed = false
  const closing = f.ctx.fiber.dispose().then(() => { disposed = true })
  await Promise.resolve(); await Promise.resolve()
  expect(disposed).toBe(false)
  expect(source.closed).toBe(false)
  abort.abort(reason)
  source.finish.resolve(undefined)
  await rejected; await closing
  expect(source.closed).toBe(true)
  expect(disposed).toBe(true)
})

it('interrupts a blocked Request read and keeps return pending until actual source cancellation settles', async () => {
  const f = await fixture(1), opened = Promise.withResolvers<undefined>(), cancelled = Promise.withResolvers<undefined>()
  f.release.push(() => { cancelled.resolve(undefined) })
  let cancels = 0, iterator: AsyncIterator<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    pull() { opened.resolve(undefined) },
    cancel() { cancels++; return cancelled.promise },
  }, { highWaterMark: 0 })
  const init = { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' as const }
  const request = new Request(`http://fixture${FILE_UPLOAD_PATH}?sessionId=${f.handle.agent.id}`, init)
  f.uploads.observe = (input) => { iterator = input.data[Symbol.asyncIterator]() }
  const response = f.track(handleFileUploadHttp(f.uploads, request))
  await opened.promise
  expect(body.locked).toBe(true)
  if (iterator?.return === undefined) throw new Error('Native raw iterator is missing return')
  let returned = false, responded = false
  const closing = iterator.return().then(() => { returned = true })
  void response.then(() => { responded = true })
  expect(cancels).toBe(1)
  await Promise.resolve(); await Promise.resolve()
  expect(returned).toBe(false)
  expect(responded).toBe(false)
  expect(body.locked).toBe(true)
  cancelled.resolve(undefined)
  await closing
  expect((await response).status).toBe(200)
  expect(body.locked).toBe(false)
  expect(cancels).toBe(1)
})


it('waits for real request-body cancellation when the native hook refuses before reading', async () => {
  const f = await fixture(1), cancelStarted = Promise.withResolvers<undefined>(), cancelFinish = Promise.withResolvers<undefined>()
  f.release.push(() => { cancelFinish.resolve(undefined) })
  f.uploads.failure = new Error('native hook rejected')
  let pulls = 0, cancels = 0, responded = false
  const body = new ReadableStream<Uint8Array>({
    pull() { pulls++ },
    cancel() { cancels++; cancelStarted.resolve(undefined); return cancelFinish.promise },
  }, { highWaterMark: 0 })
  const request = new Request(`http://fixture${FILE_UPLOAD_PATH}?sessionId=${f.handle.agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const response = f.track(handleFileUploadHttp(f.uploads, request))
  void response.then(() => { responded = true })
  await cancelStarted.promise
  expect(pulls).toBe(0)
  expect(cancels).toBe(1)
  expect(responded).toBe(false)
  expect(body.locked).toBe(true)
  cancelFinish.resolve(undefined)
  expect(await (await response).json()).toMatchObject({ ok: false, error: { message: 'failed to store file upload: Error: native hook rejected' } })
  expect(cancels).toBe(1)
  expect(body.locked).toBe(false)
})

it('reports unconfirmed request cleanup when an unconsumed body rejects cancellation', async () => {
  const f = await fixture(1)
  f.uploads.failure = new Error('native hook rejected')
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; throw new Error('cancel failed') } }, { highWaterMark: 0 })
  const request = new Request(`http://fixture${FILE_UPLOAD_PATH}?sessionId=${f.handle.agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const response = await f.track(handleFileUploadHttp(f.uploads, request))
  expect(await response.json()).toMatchObject({ ok: false, error: { message: 'File upload intake settlement is unconfirmed.' } })
  expect(cancels).toBe(1)
  // The route reports its own cleanup uncertainty; this early rejection had already released the service slot.
  f.uploads.failure = undefined
  await expect(f.track(f.empty())).resolves.toMatchObject({ file: { name: 'empty.bin' } })
})

it('cancels an unread request body when native receipt capacity rejects before the hook', async () => {
  const f = await fixture(1)
  await f.track(f.empty())
  let pulls = 0, cancels = 0
  const body = new ReadableStream<Uint8Array>({ pull() { pulls++ }, cancel() { cancels++ } }, { highWaterMark: 0 })
  const request = new Request(`http://fixture${FILE_UPLOAD_PATH}?sessionId=${f.handle.agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const response = await f.track(handleFileUploadHttp(f.uploads, request))
  expect(await response.json()).toMatchObject({ ok: false, error: { details: { reason: 'FILE_UPLOAD_CAPACITY' } } })
  expect(pulls).toBe(0)
  expect(cancels).toBe(1)
})
