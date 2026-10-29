/** Real local persistence and FileUploads; no Linux, quota, HTTP auth, or deployment claim. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { FileUploads, FileUploadIntakeUnconfirmedError, FileUploadTooLargeError } from '@deepseek-ai/dsh-client-file-upload'
import { handleFileUploadHttp } from '@deepseek-ai/dsh-client-file-upload/src/http-route.ts'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished } from 'vitest'
import { createNativeUploads, type NativeUploadPreparation } from '../src/native-uploads.ts'

async function fixture(preparation: NativeUploadPreparation['storeFileStream'], admit: () => void = () => {}) {
  const home = await mkdtemp(join(tmpdir(), 'native-uploads-published-')), ctx = new Context()
  const lifetime = new AbortController()
  onTestFinished(async () => {
    lifetime.abort()
    try { await ctx.agentLoop.stop(); await ctx.fiber.dispose() } finally { await rm(home, { recursive: true, force: true }) }
  })
  const binding: AccountBinding = { accountId: 'native-upload-test' as AccountId, epoch: '1' as OwnerEpoch,
    recipeVersion: 'test-only', lifetime: lifetime.signal }
  ctx.provide('peAccount', binding)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  await mountAgentLoopTestHarness(ctx)
  const uploads = createNativeUploads(ctx, binding, () => {}, admit, 1024, { maxPendingReceipts: 1, storeFileStream: preparation }).value
  const { agent } = await ctx.agents.create({ sessionId: SessionId('post-save-agent') })
  const stored = async (bytes: Uint8Array) => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    return stat(join(home, 'attachments', 'v1', 'file-objects', digest.slice(0, 2), digest))
  }
  const state = () => Reflect.get(uploads, 'state') as { occupied: number; closed: boolean }
  return { ctx, store, uploads, agent, stored, state }
}

it('keeps the native single-save receipt and its actual stored bytes', async () => {
  const f = await fixture(async (_agent, input, save) => save(input)), bytes = Uint8Array.of(1, 2, 3)
  const result = await f.uploads.uploadStream({ sessionId: f.agent.id, name: 'first.bin', data: (async function* () { yield bytes })() })
  expect(result.file.bytes).toBe(bytes.byteLength)
  expect((await f.stored(bytes)).size).toBe(bytes.byteLength)
  expect(f.state()).toMatchObject({ occupied: 1, closed: false })
})

it('reports unknown and retains the slot after a real save when custom preparation throws', async () => {
  const failure = new Error('after save'), f = await fixture(async (_agent, input, save) => { await save(input); throw failure })
  const bytes = Uint8Array.of(4, 5, 6)
  await expect(f.uploads.uploadStream({ sessionId: f.agent.id, name: 'first.bin', data: (async function* () { yield bytes })() }))
    .rejects.toMatchObject({ name: 'FileUploadIntakeUnconfirmedError', cause: failure })
  expect((await f.stored(bytes)).size).toBe(bytes.byteLength)
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})

it('reports unknown through HTTP when the first save succeeds and a second save throws', async () => {
  const f = await fixture(async (_agent, input, save) => { await save(input); return save(input) })
  const bytes = Uint8Array.of(7, 8, 9)
  const request = new Request(`http://fixture/upload?sessionId=${f.agent.id}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  })
  const response = await handleFileUploadHttp(f.uploads, request)
  expect(await response.json()).toMatchObject({ ok: false, error: { details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
  expect((await f.stored(bytes)).size).toBe(bytes.byteLength)
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})

it('waits for an already-started native save before reporting preparation failure', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const failure = new Error('preparation returned early')
  const f = await fixture(async (_agent, input, save) => { void save(input); throw failure })
  const data = (async function* () { yield Uint8Array.of(11); entered.resolve(undefined); await release.promise })()
  let settled = false
  const operation = f.uploads.uploadStream({ sessionId: f.agent.id, data })
  const rejected = expect(operation).rejects.toMatchObject({ name: 'FileUploadIntakeUnconfirmedError', cause: failure })
  void operation.catch(() => { settled = true })
  await entered.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.state()).toMatchObject({ occupied: 1 })
  release.resolve(undefined)
  await rejected
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})

it('preserves a preparation size rejection when the first native save itself failed', async () => {
  const f = await fixture(async (_agent, input, save) => {
    try { return await save(input) } catch { throw new FileUploadTooLargeError() }
  })
  const data = (async function* () { yield Uint8Array.of(1); throw new Error('controlled source failure') })()
  await expect(f.uploads.uploadStream({ sessionId: f.agent.id, data }))
    .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_UPLOAD_TOO_LARGE' } })
  expect(f.state()).toMatchObject({ occupied: 0, closed: false })
})

it('reports unknown if post-save cloud admission fails after actual bytes are stored', async () => {
  let count = 0
  const f = await fixture(async (_agent, input, save) => save(input), () => { if (++count === 2) throw new Error('admission revoked') })
  const bytes = Uint8Array.of(14, 15, 16)
  await expect(f.uploads.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield bytes })() }))
    .rejects.toBeInstanceOf(FileUploadIntakeUnconfirmedError)
  expect((await f.stored(bytes)).size).toBe(bytes.byteLength)
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})


it('leaves the slot available when preparation refuses without calling save', async () => {
  const failure = new Error('before save'), f = await fixture(async () => { throw failure })
  await expect(f.uploads.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield Uint8Array.of(1) })() }))
    .rejects.toMatchObject({ code: 'gateway/internal', cause: failure })
  expect(f.state()).toMatchObject({ occupied: 0, closed: false })
})

it('waits for an in-flight first save before rejecting a concurrent second call', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const f = await fixture(async (_agent, input, save) => { void save(input); return save(input) })
  const data = (async function* () { yield Uint8Array.of(31); entered.resolve(undefined); await release.promise })()
  let settled = false
  const operation = f.uploads.uploadStream({ sessionId: f.agent.id, data })
  const rejected = expect(operation).rejects.toBeInstanceOf(FileUploadIntakeUnconfirmedError)
  void operation.catch(() => { settled = true })
  await entered.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.state()).toMatchObject({ occupied: 1 })
  release.resolve(undefined)
  await rejected
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})

it('revokes an unused callback after preparation has already rejected', async () => {
  let captured: Parameters<NativeUploadPreparation['storeFileStream']>[2] | undefined
  const failure = new Error('before save')
  const f = await fixture(async (_agent, _input, save) => { captured = save; throw failure })
  await expect(f.uploads.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield Uint8Array.of(1) })() }))
    .rejects.toMatchObject({ code: 'gateway/internal', cause: failure })
  if (captured === undefined) throw new Error('Fixture did not capture the callback')
  await expect(captured({ data: (async function* () { yield Uint8Array.of(99) })() }))
    .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  const digest = createHash('sha256').update(Uint8Array.of(99)).digest('hex')
  await expect(stat(join(f.store.root, 'file-objects', digest.slice(0, 2), digest))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.state()).toMatchObject({ occupied: 0, closed: false })
})


it('continues to invoke a custom preinstalled FileUploads hook exactly once', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(FileUploads.prototype, 'storeFileStream')
  if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Native hook not found')
  const original = descriptor.value as (this: FileUploads, agent: Agent, input: SaveFileStreamAttachment) => Promise<FileAttachmentRef>
  let calls = 0
  Object.defineProperty(FileUploads.prototype, 'storeFileStream', { ...descriptor,
    value: function (this: FileUploads, agent: Agent, input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
      calls++
      return original.call(this, agent, input)
    },
  })
  try {
    const f = await fixture(async (_agent, input, save) => save(input)), bytes = Uint8Array.of(71, 72)
    const result = await f.uploads.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield bytes })() })
    expect(result.file.bytes).toBe(bytes.byteLength)
    expect((await f.stored(bytes)).size).toBe(bytes.byteLength)
    expect(calls).toBe(1)
  } finally { Object.defineProperty(FileUploads.prototype, 'storeFileStream', descriptor) }
})


it('keeps the slot unknown when a concurrent second call is rejected and the first save later fails', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const f = await fixture(async (_agent, input, save) => { void save(input); return save(input) })
  const data = (async function* () { yield Uint8Array.of(91); entered.resolve(undefined); await release.promise; throw new Error('first failed') })()
  const pending = f.uploads.uploadStream({ sessionId: f.agent.id, data })
  const rejected = expect(pending).rejects.toBeInstanceOf(FileUploadIntakeUnconfirmedError)
  await entered.promise
  release.resolve(undefined)
  await rejected
  expect(f.state()).toMatchObject({ occupied: 1, closed: true })
})
