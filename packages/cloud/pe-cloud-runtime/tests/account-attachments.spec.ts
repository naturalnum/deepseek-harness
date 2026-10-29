/** Real native Agent/Session/receipt composition; typed files-port fixtures prove no Linux or quota facts. */
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import { FileUploadIntakeUnconfirmedError, FileUploadTooLargeError } from '@deepseek-ai/dsh-client-file-upload'
import { handleFileUploadHttp } from '@deepseek-ai/dsh-client-file-upload/src/http-route.ts'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter, markAgentLoopRequest, type GenerateOptions,
  type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CloudAccountFiles, StageFileResult } from '@deepseek-ai/dsh-pe-cloud-files'
import { LinuxFilesPool } from '@deepseek-ai/dsh-pe-cloud-files/src/worker-pool.ts'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AccountAttachments, type AccountAttachmentLimits } from '../src/account-attachments.ts'
import { AccountRuntimeError } from '../src/errors.ts'
import { CloudApiError } from '@deepseek-ai/dsh-pe-cloud-api'
import { createNativeUploads } from '@deepseek-ai/dsh-pe-cloud-api/src/native-uploads.ts'
import type { AccountBinding, AccountId, OwnerEpoch } from '../src/types.ts'

const limits: AccountAttachmentLimits = { maxSurfaceNodes: 8192, maxRefs: 16, maxRefBytes: 8192,
  maxPromptFiles: 4, maxFileBytes: 16, maxUploadChunkBytes: 4, intakeReservationBytes: 400000, maxPendingReceipts: 16 }
const message = (ref: FileAttachmentRef) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] })
const relativePath = (ref: FileAttachmentRef) => `.pe/attachments/${String(ref.attachmentId).slice(7)}/${ref.name}`

class FixtureAdapter extends LlmAdapter {
  calls = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function workspace(path: string): Workspace {
  const unused = async (): Promise<never> => { throw new Error('The workspace fixture owns no Registry mutation') }
  return { id: WorkspaceId(path), path, title: 'Fixture', createdAt: '2026-10-19', updatedAt: '2026-10-19', sessionIds: [],
    setTitle: unused, attachSession: unused, insertSessionBefore: unused, detachSession: unused, status: async () => 'ok' }
}

function staged(ref: FileAttachmentRef): StageFileResult {
  return { ref, relativePath: relativePath(ref), outcome: 'published', facts: {
    kind: 'published', code: 'OK', publication: 'published', closed: true, clean: true, temporaryPresent: false,
    writtenBytes: ref.bytes, readBytes: 0, sequence: 0, retainedCreatedDirectories: 0,
  } }
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* Consume the native LLM dispatcher, including its middleware finally. */ }
}

async function fixture(limitOverrides: Partial<AccountAttachmentLimits> = {}, allowIntake = false, nativeUpload = false,
  intake?: CloudAccountFiles['runAttachmentIntake']) {
  const selectedLimits = { ...limits, ...limitOverrides }
  const home = await mkdtemp(join(tmpdir(), 'account-attachments-composition-')), ctx = new Context()
  const lifetime = new AbortController()
  onTestFinished(async () => {
    lifetime.abort()
    try { await ctx.fiber.dispose() } finally { await rm(home, { recursive: true, force: true }) }
  })
  const binding: AccountBinding = Object.freeze({ accountId: 'component' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only-attachments', lifetime: lifetime.signal })
  ctx.provide('peAccount', binding)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  // Only original route registration is replaced; no HTTP, Cookie, Peer or Access claim is made.
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  const native = await mountAgentLoopTestHarness(ctx), adapter = new FixtureAdapter()
  const uploads = nativeUpload ? createNativeUploads(ctx, binding, () => {}, () => {}, 1024, {
    maxPendingReceipts: selectedLimits.maxPendingReceipts,
    storeFileStream: (agent, input, save) => feature.storeFileStream(agent, input, save),
  }).value : new FileUploads(ctx, { maxPendingReceipts: selectedLimits.maxPendingReceipts })
  ctx.llm.registerAdapter(['fixture'], adapter)
  const selected = new Map<Agent, Workspace>(), a = workspace(join(home, 'project-a')), b = workspace(join(home, 'project-b'))
  let insideStage = false, failure: Error | undefined
  const inputs: (readonly FileAttachmentRef[])[] = [], releases: ReturnType<typeof vi.fn>[] = []
  const port: Pick<CloudAccountFiles, 'stageAttachments' | 'runAttachmentIntake'> = {
    stageAttachments: vi.fn<CloudAccountFiles['stageAttachments']>(async (_workspace, buildRefs, check, signal) => {
      check()
      signal?.throwIfAborted()
      insideStage = true
      let refs: readonly FileAttachmentRef[]
      try { refs = buildRefs() } finally { insideStage = false }
      if (refs.length > 4) throw new Error('The component fixture admits at most four refs')
      inputs.push(refs)
      if (failure !== undefined) throw failure
      const release = vi.fn()
      releases.push(release)
      return { value: refs.map(staged), release }
    }),
    runAttachmentIntake: async (reservation, check, execute, signal) => {
      if (intake !== undefined) return intake(reservation, check, execute, signal)
      if (!allowIntake) throw new Error('Native intake settlement is outside these composition cases')
      check()
      return { value: await execute(lifetime.signal), release: () => {} }
    },
  }
  const feature = new AccountAttachments(ctx, binding, selectedLimits, () => port, (agent) => {
    const project = selected.get(agent)
    if (project === undefined || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session
      || agent.session.header.cwd !== project.path) {
      throw new CloudApiError('cloud/forbidden', 'The fixture Agent has no current project selection.')
    }
    return project
  }, (caller) => {
    if (caller.root !== ctx || caller.get('peAccount') !== binding || lifetime.signal.aborted) {
      throw new AccountRuntimeError('cloud/stale-generation', 'The fixture account is unavailable.')
    }
  })
  const create = async (id: string, project = a, seed?: readonly SessionEvent[]) => {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: project.path },
      ...seed === undefined ? {} : { seed } })
    selected.set(agent, project)
    return agent
  }
  const preStep = (agent: Agent, messages: UserMessage[], next: () => Promise<PreStepDecision>) =>
    ctx.agents.withInitiator(agent, () => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages, turn: 1, step: 1, signal: lifetime.signal,
    }, next))
  return { binding, ctx, store, uploads, native, adapter, feature, create, preStep, selected, a, b, inputs, releases,
    insideStage: () => insideStage, fail: (error: Error) => { failure = error } }
}

it('persists exactly the configured upload limit and rejects one extra byte as not published', async () => {
  const maximum = 1024 * 1024
  const f = await fixture({ maxFileBytes: maximum, maxUploadChunkBytes: maximum, intakeReservationBytes: 4 * maximum }, true)
  const agent = await f.create('upload-boundary')
  const input = (extra: boolean) => (async function* () {
    for (let i = 0; i < 16; i++) yield new Uint8Array(64 * 1024).fill(i)
    if (extra) yield Uint8Array.of(0xff)
  })()
  const save = f.store.saveFileStream.bind(f.store)
  const exact = await f.feature.storeFileStream(agent, { name: 'exact.bin', data: input(false) }, save)
  let read = 0
  for await (const chunk of f.store.readFileStream(exact)) read += chunk.byteLength
  expect(exact.bytes).toBe(maximum)
  expect(read).toBe(maximum)
  await expect(f.feature.storeFileStream(agent, { name: 'too-large.bin', data: input(true) }, save))
    .rejects.toBeInstanceOf(FileUploadTooLargeError)
})

it('preserves only a confirmed size rejection as a typed HTTP error', async () => {
  const f = await fixture({ maxFileBytes: 4, maxUploadChunkBytes: 4 }, true)
  const agent = await f.create('upload-http-limit')
  Object.defineProperty(f.uploads, 'storeFileStream', { value: (owner: Agent, input: Parameters<AccountAttachments['storeFileStream']>[1]) =>
    f.feature.storeFileStream(owner, input, f.store.saveFileStream.bind(f.store)) })
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Uint8Array.of(1, 2, 3, 4)); controller.enqueue(Uint8Array.of(5)); controller.close()
  } })
  const request = new Request(`http://fixture/upload?sessionId=${agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const response = await handleFileUploadHttp(f.uploads, request)
  expect(await response.json()).toEqual({ ok: false, error: {
    code: 'session/attachment-invalid', message: 'File exceeds the upload size limit.',
    details: { reason: 'FILE_UPLOAD_TOO_LARGE' },
  } })
  const small = new Request(`http://fixture/upload?sessionId=${agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.of(1, 2, 3, 4),
  })
  expect(await (await handleFileUploadHttp(f.uploads, small)).json()).toMatchObject({ ok: true })
})

it('does not call an oversized individual chunk a confirmed whole-file limit error', async () => {
  const f = await fixture({ maxFileBytes: 16, maxUploadChunkBytes: 4 }, true)
  const agent = await f.create('upload-chunk-limit')
  await expect(f.feature.storeFileStream(agent, { data: (async function* () { yield Uint8Array.of(1, 2, 3, 4, 5) })() },
    f.store.saveFileStream.bind(f.store))).rejects.toMatchObject({ code: 'FS_TOO_LARGE', outcome: 'not-published' })
})

it('does not report size-limit success if cleanup is unconfirmed', async () => {
  const f = await fixture({ maxFileBytes: 4, maxUploadChunkBytes: 4 }, true)
  const agent = await f.create('upload-cleanup-unknown')
  let count = 0
  const data: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
    async next() { return { done: false as const, value: ++count === 1 ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(5) } },
    async return() { throw new Error('fixture cleanup failed') },
  } } }
  await expect(f.feature.storeFileStream(agent, { data }, f.store.saveFileStream.bind(f.store)))
    .rejects.toBeInstanceOf(FileUploadIntakeUnconfirmedError)
})

it('collects native cold history and actual claimed input inside the lazy builder before next, then releases after marked dispatch', async () => {
  const f = await fixture()
  const oldRef = await f.store.saveFile({ data: Uint8Array.of(1), name: 'old.bin' })
  const old = message(oldRef), seed = Session.create(SessionId('cold-seed'))
  const event = seed.append('user/message', old, { surfaceOp: 'append' })
  const agent = await f.create('cold-agent', f.a, [event])
  const currentRef = await f.store.saveFile({ data: Uint8Array.of(2), name: 'claimed.bin' })
  agent.inject(message(currentRef))
  const claimed = f.native.claim(agent, 'next-step', 1)
  expect(claimed).toHaveLength(1)
  const derive = agent.session.deriveMessages.bind(agent.session)
  vi.spyOn(agent.session, 'deriveMessages').mockImplementation(() => {
    expect(f.insideStage()).toBe(true)
    return derive()
  })
  const next = vi.fn(async (): Promise<PreStepDecision> => {
    expect(f.feature.mapFileHostPath(agent.ctx, oldRef)).toBe(join(f.a.path, relativePath(oldRef)))
    expect(f.feature.mapFileHostPath(agent.ctx, currentRef)).toBe(join(f.a.path, relativePath(currentRef)))
    return { kind: 'enter', messages: claimed }
  })
  await f.preStep(agent, claimed, next)
  expect(next).toHaveBeenCalledOnce()
  expect(f.inputs[0]).toEqual([oldRef, currentRef])
  expect(f.releases[0]).not.toHaveBeenCalled()
  const options = markAgentLoopRequest({ provider: 'fixture', model: 'text', sessionId: agent.id, messages: [old, ...claimed] })
  await f.ctx.agents.withInitiator(agent, () => consume(f.ctx.llm.stream(options)))
  expect(f.adapter.calls).toBe(1)
  expect(f.releases[0]).toHaveBeenCalledOnce()
  expect(f.ctx.agents.withInitiator(agent, () => f.feature.mapFileHostPath(agent.ctx, oldRef))).toBeUndefined()
})

it('does not share a prepared same-hash path with another Agent, an agentless call or another project', async () => {
  const f = await fixture(), agent = await f.create('owner'), other = await f.create('other')
  const ref = await f.store.saveFile({ data: Uint8Array.of(3), name: 'shared-hash.bin' }), input = message(ref)
  await f.preStep(agent, [input], async () => ({ kind: 'enter', messages: [input] }))
  expect(f.feature.mapFileHostPath(agent.ctx, ref)).toBeUndefined()
  expect(f.ctx.agents.withInitiator(other, () => f.feature.mapFileHostPath(other.ctx, ref))).toBeUndefined()
  const options: GenerateOptions = { provider: 'fixture', model: 'text', messages: [input] }
  await expect(f.ctx.agents.withInitiator(other, () => consume(f.ctx.llm.stream(options))))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(consume(f.ctx.llm.stream(options))).rejects.toMatchObject({ code: 'cloud/forbidden' })
  f.selected.set(agent, f.b)
  expect(() => f.ctx.agents.withInitiator(agent, () => f.feature.mapFileHostPath(agent.ctx, ref)))
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(f.adapter.calls).toBe(0)
})

it('does not call next or retire a native upload receipt when copy preparation fails', async () => {
  const f = await fixture(), agent = await f.create('upload-owner')
  const uploaded = await f.uploads.uploadStream({ sessionId: agent.id, name: 'receipt.bin',
    data: (async function* () { yield Uint8Array.of(9, 0, 255) })() })
  const failure = new Error('The bounded files fixture refused copy preparation')
  f.fail(failure)
  const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }))
  const retire = vi.spyOn(f.uploads, 'retirePrompt')
  await expect(f.preStep(agent, [message(uploaded.file)], next)).rejects.toBe(failure)
  expect(next).not.toHaveBeenCalled()
  await expect(f.feature.preparePromptFiles(agent, [uploaded.receiptId])).rejects.toBe(failure)
  expect(f.uploads.resolve(agent, uploaded.receiptId)).toBe(uploaded.file)
  expect(retire).not.toHaveBeenCalled()
  expect(f.adapter.calls).toBe(0)
})


it('keeps an original account preparation size rejection usable through native HTTP', async () => {
  const f = await fixture({ maxFileBytes: 4, maxUploadChunkBytes: 4 }, true, true)
  const agent = await f.create('full-native-size-limit')
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Uint8Array.of(1, 2, 3, 4)); controller.enqueue(Uint8Array.of(5)); controller.close()
  } })
  const request = new Request(`http://fixture/upload?sessionId=${agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  expect(await (await handleFileUploadHttp(f.uploads, request)).json()).toMatchObject({ ok: false,
    error: { details: { reason: 'FILE_UPLOAD_TOO_LARGE' } } })
  const small = new Request(`http://fixture/upload?sessionId=${agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.of(1, 2, 3, 4),
  })
  expect(await (await handleFileUploadHttp(f.uploads, small)).json()).toMatchObject({ ok: true })
})


it('reports native alias publication failure as unconfirmed through real HTTP and retains the saved object', async () => {
  const f = await fixture({}, true, true), agent = await f.create('native-alias-failure')
  const bytes = Uint8Array.of(1, 2, 3), digest = createHash('sha256').update(bytes).digest('hex'), root = f.store.root
  await mkdir(join(root, 'files', digest.slice(0, 2), digest, 'collision.bin'), { recursive: true })
  const request = new Request(`http://fixture/upload?sessionId=${agent.id}&name=collision.bin`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  })
  const response = await handleFileUploadHttp(f.uploads, request), result: unknown = await response.json()
  expect(result).toMatchObject({ ok: false, error: { code: 'gateway/internal',
    details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
  expect(JSON.stringify(result)).not.toContain(root)
  expect((await stat(join(root, 'file-objects', digest.slice(0, 2), digest))).size).toBe(bytes.byteLength)
  expect(Reflect.get(f.uploads, 'state')).toMatchObject({ occupied: 1, closed: true })
})


it('retains the actual lane, reservation and HTTP intake when selection expires immediately after native save', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-post-save-lane-')), root = realpathSync(home)
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = []
  const staging = { helperPath: '/test-only/staging.node', maxFileBytes: 8 * 1024 * 1024, maxBatchRefs: 4,
    maxBatchBytes: 32 * 1024 * 1024, maxSourceChunkBytes: 65536, operationTimeoutMs: 30000, reservationBytes: 2 * 1024 * 1024 }
  const pool = new LinuxFilesPool({ maxLanes: 4, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 8, maxQueuedPerLane: 4,
    maxResidentBytes: 256 * 1024 * 1024, maxResidentBytesPerLane: 64 * 1024 * 1024, waitTimeoutMs: 30000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 8 * 1024 * 1024, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 20, helperPath: '/test-only/fd.node', maxReadBytes: 65536,
    maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 4096, staging,
  }, (input) => {
    const worker = new Worker(new URL('../../pe-cloud-files/tests/fixtures/stage-worker.mjs', import.meta.url),
      { workerData: { mode: 'normal', gate, staging: input.staging } })
    workers.push(worker)
    return worker
  })
  onTestFinished(async () => {
    Atomics.store(counters, 2, 1); Atomics.notify(counters, 2)
    await pool.stop(Date.now() + 100)
    await Promise.all(workers.map(worker => worker.terminate()))
    await rm(home, { recursive: true, force: true })
  })
  await pool.start()
  const lane: { port?: ReturnType<LinuxFilesPool['bind']> } = {}
  const f = await fixture({}, true, true, (bytes, check, execute, signal) => {
    if (lane.port === undefined) throw new Error('Fixture lane not installed')
    return lane.port.runNativeMutation(bytes, check, execute, signal)
  })
  const info = statSync(root, { bigint: true }), current = () => {}
  const port = pool.bind(f.binding, { rootPath: root, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '1' }, current)
  lane.port = port
  const agent = await f.create('post-save-stale-project'), bytes = Uint8Array.of(3, 2, 1)
  const nativeSave = f.store.saveFileStream.bind(f.store)
  Object.defineProperty(f.store, 'saveFileStream', { configurable: true,
    value: async (input: Parameters<LocalAttachmentStore['saveFileStream']>[0]) => {
      const ref = await nativeSave(input)
      f.selected.set(agent, f.b)
      return ref
    },
  })
  const request = new Request(`http://fixture/upload?sessionId=${agent.id}&name=evidence.bin`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  })
  expect(await (await handleFileUploadHttp(f.uploads, request)).json()).toMatchObject({ ok: false,
    error: { details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
  const digest = createHash('sha256').update(bytes).digest('hex')
  expect((await stat(join(f.store.root, 'file-objects', digest.slice(0, 2), digest))).size).toBe(bytes.byteLength)
  expect(pool.inspect().work).toMatchObject({ running: 1, pending: 1, residentBytes: limits.intakeReservationBytes })
  expect(Reflect.get(f.uploads, 'state')).toMatchObject({ occupied: 1, closed: true })
  let entered = false
  await expect(port.runNativeMutation(4096, current, async () => { entered = true })).rejects.toMatchObject({ outcome: 'unknown' })
  expect(entered).toBe(false)
})
