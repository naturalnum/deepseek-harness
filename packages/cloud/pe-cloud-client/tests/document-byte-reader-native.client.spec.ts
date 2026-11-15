/** Original Native apply, SlotRegistry, store and face; only the remote boundary is scripted. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply, inject, type DocumentFileBytes, type TextInjected, type TextStore } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCloudDocumentByteReader } from '../src/client/document-byte-reader.ts'

type TabId = Parameters<TextInjected['loadAll']>[0]
const SESSION = 'same-document-session' as SessionId, TAB = 'document-tab' as TabId
const FILE = { sessionId: SESSION, path: 'work/data.csv' }
const EXCEL = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel'
const TEXT = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
type Read = ClientRemote['workspaceFiles']['readBytes']
function responder(source: Uint8Array<ArrayBuffer>): Read {
  return async (_session, _path, options) => {
    const offset = options?.range?.offset ?? 0, length = options?.range?.length ?? source.length
    const data = source.slice(offset, offset + length)
    return { ok: true, value: { absolutePath: '/account/work/data.csv', version: 'v1', bytes: source.length,
      offset, data, eof: offset + data.length === source.length } }
  }
}
async function fixture(read: Read) {
  const ctx = new Context(), controllers: AbortController[] = [], slots = new SlotRegistry(ctx)
  onTestFinished(async () => { for (const controller of controllers) controller.abort(); await ctx.fiber.dispose() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  ctx.provide('resources', new ResourceRegistry(ctx))
  ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} },
    read: () => undefined } satisfies Context['fileDrag'])
  ctx.provide('contextMenus', { open: vi.fn() } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) } } as never)
  slots.register({ name: 'root', children: {
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  const mountRemote = async (next: Read) => {
    const provider = ctx.plugin((owner) => { new TestRemote(owner, { workspaceFiles: { readBytes: next } }) })
    await provider.await(); return provider
  }
  const remote = await mountRemote(read)
  const native = ctx.plugin({ inject: [...inject], apply }); await native.await()
  const mountCloud = async () => {
    const owner = ctx.plugin(installCloudDocumentByteReader); await owner.await(); return owner
  }
  const bind = () => {
    const entry = slots.entries('sidebar.right.pane.tab').find(value => value.options.key === TEXT)
    if (entry?.store === undefined || entry.inject === undefined) throw new Error('Original Native preview registration absent')
    const instance = (entry.store as TextStore).create(), controller = new AbortController()
    controllers.push(controller)
    // StoredEntry erases positional injection; the Native registration already proves this public face.
    const face = (
      entry.inject as unknown as (sessionId: SessionId, actions: typeof instance.actions) => TextInjected
    )(SESSION, instance.actions)
    return { entry, instance, face, signal: controller.signal }
  }
  return { ctx, slots, native, remote, mountRemote, mountCloud, bind }
}
async function loaded(binding: ReturnType<Awaited<ReturnType<typeof fixture>>['bind']>, source: Uint8Array<ArrayBuffer>) {
  await vi.waitFor(() => { expect(binding.instance.getSnapshot().byTab[TAB]?.complete?.data).toEqual(source) })
}

it('retains the original Native CSV read, then routes the same actual Native face through Cloud 100KiB windows', async () => {
  const source = Uint8Array.from({ length: 102_672 }, (_, i) => i % 251), read = vi.fn(responder(source))
  const f = await fixture(read), b = f.bind()
  b.face.loadAll(TAB, FILE, b.signal, 'v1', EXCEL); await loaded(b, source)
  expect(read).toHaveBeenCalledExactlyOnceWith(SESSION, FILE.path, {}, expect.any(AbortSignal))
  read.mockClear(); await f.mountCloud()
  b.face.reloadAll(TAB, FILE, b.signal, 'v1', EXCEL); await loaded(b, source)
  expect(read.mock.calls.map(call => call[2]?.range?.offset)).toEqual([0, 32768, 65536, 98304, 102672])
})

it('keeps ordinary complete-byte reads for another renderer and restores the original route after Cloud withdrawal', async () => {
  const source = new Uint8Array([1, 2, 3]), read = vi.fn(responder(source)), f = await fixture(read)
  const owner = await f.mountCloud(), b = f.bind()
  b.face.loadAll(TAB, FILE, b.signal, 'v1', 'example/custom-bytes'); await loaded(b, source)
  expect(read).toHaveBeenCalledExactlyOnceWith(SESSION, FILE.path, {}, expect.any(AbortSignal))
  await owner.dispose(); expect(f.ctx.get('documentPreviewByteReader')).toBeUndefined(); read.mockClear()
  b.face.reloadAll(TAB, FILE, b.signal, 'v1', EXCEL); await loaded(b, source)
  expect(read).toHaveBeenCalledExactlyOnceWith(SESSION, FILE.path, {}, expect.any(AbortSignal))
})

it('keeps separate account byte sources when both original Native graphs use the same Session and file address', async () => {
  const aBytes = new Uint8Array(40_000).fill(17), bBytes = new Uint8Array(40_000).fill(29)
  const aRead = vi.fn(responder(aBytes)), bRead = vi.fn(responder(bBytes))
  const a = await fixture(aRead), b = await fixture(bRead); await a.mountCloud(); await b.mountCloud()
  const one = a.bind(), two = b.bind()
  one.face.loadAll(TAB, FILE, one.signal, 'v1', EXCEL); two.face.loadAll(TAB, FILE, two.signal, 'v1', EXCEL)
  await loaded(one, aBytes); await loaded(two, bBytes)
  expect(aRead).toHaveBeenCalledTimes(3); expect(bRead).toHaveBeenCalledTimes(3)
  expect(aRead.mock.calls.every(call => call[0] === SESSION && call[1] === FILE.path)).toBe(true)
  expect(bRead.mock.calls.every(call => call[0] === SESSION && call[1] === FILE.path)).toBe(true)
})

it('withdraws the captured reader with its original Remote and binds the replacement Native graph to the new provider', async () => {
  const before = new Uint8Array([7]), after = new Uint8Array([9]), original = vi.fn(responder(before))
  const f = await fixture(original); await f.mountCloud()
  const old = f.bind(), control = f.ctx.get('documentPreviewByteReader')
  if (control === undefined) throw new Error('Cloud byte reader absent')
  old.face.loadAll(TAB, FILE, old.signal, 'v1', EXCEL); await loaded(old, before)
  await f.remote.dispose(); expect(f.ctx.get('documentPreviewByteReader')).toBeUndefined()
  const calls = original.mock.calls.length
  await expect(Promise.resolve().then(() => control.read(
    FILE, old.signal, { rendererId: EXCEL, delimitedMaxBytes: 1024 },
  ))).rejects.toThrow()
  expect(original).toHaveBeenCalledTimes(calls)
  const replacement = vi.fn(responder(after)); await f.mountRemote(replacement)
  await vi.waitFor(() => { expect(f.ctx.get('documentPreviewByteReader')).toBeDefined() })
  const next = f.bind(); expect(next.entry).not.toBe(old.entry)
  next.face.loadAll(TAB, FILE, next.signal, 'v1', EXCEL); await loaded(next, after)
  expect(replacement).toHaveBeenCalledTimes(2); expect(original).toHaveBeenCalledTimes(calls)
})

it('aborts a withdrawn reader but waits for the actual pending RPC before ending the old Native load, without another window', async () => {
  const gate = Promise.withResolvers<RemoteResult<DocumentFileBytes>>()
  let pendingSignal: AbortSignal | undefined
  const read = vi.fn<Read>((_session, _path, _options, signal) => { pendingSignal = signal; return gate.promise })
  const f = await fixture(read), owner = await f.mountCloud(), b = f.bind()
  b.face.loadAll(TAB, FILE, b.signal, 'v1', EXCEL)
  try {
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
    await owner.dispose(); expect(pendingSignal?.aborted).toBe(true)
    expect(b.instance.getSnapshot().byTab[TAB]?.loading).toBe(true)
    gate.resolve({ ok: true, value: { absolutePath: '/account/work/data.csv', version: 'v1', bytes: 40_000,
      offset: 0, data: new Uint8Array(32768), eof: false } })
    await vi.waitFor(() => { expect(b.instance.getSnapshot().byTab[TAB]?.failure).toBeDefined() })
    expect(read).toHaveBeenCalledTimes(1); expect(b.instance.getSnapshot().byTab[TAB]?.complete).toBeUndefined()
  } finally {
    gate.resolve({ ok: true, value: { absolutePath: '/account/work/data.csv', version: 'v1', offset: 0, data: new Uint8Array(), eof: true } })
    await read.mock.results[0]?.value
  }
})
