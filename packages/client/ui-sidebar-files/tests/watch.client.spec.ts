/** Directory notifications and disposal through the shared scripted Remote transport. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SupervisedStreamOptions } from '@deepseek-ai/dsh-api-workspace-files/src/client/remote.ts'
import { FakeRemote, Source } from '../../../api/workspace-files/tests/fake-remote.client.ts'
import { createWatch } from '../src/client/face.ts'
import { createDirectoryPages } from '../src/client/directory-pages.ts'
import type { WorkspaceDirectoryFrame, WorkspaceDirectoryControl } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const SESSION = 'directory-watch-session' as SessionId
const ROOT = '/work/app'

/** Script only the original Remote stream; no supervisor or reconnection exists here. */
function pageTransport() {
  const lifetime = new AbortController(), carrier = new AbortController()
  const source = new Source<WorkspaceDirectoryFrame>(carrier.signal)
  const send = vi.fn<(value: WorkspaceDirectoryControl) => void>()
  const dispose = vi.fn(() => { carrier.abort() })
  const listPages = vi.fn(() => ({ send, dispose, end: vi.fn(), [Symbol.asyncIterator]: () => source[Symbol.asyncIterator]() }))
  const pages = createDirectoryPages({ workspaceFiles: { listPages } })(SESSION, ROOT, lifetime.signal)
  const version = '1:2:3:4:5:6:7' as WorkspaceDirectoryControl['version']
  const cursor = (token: string): WorkspaceDirectoryControl['cursor'] => token as WorkspaceDirectoryControl['cursor']
  const ready: WorkspaceDirectoryFrame = { kind: 'ready', path: '', version, cursor: cursor('first') }
  onTestFinished(() => { carrier.abort() })
  return { pages, source, send, dispose, lifetime, listPages, version, cursor, ready }
}

describe('the Files original page stream', () => {
  it('sends one credit on readiness and replaces the bounded page on each explicit pull', async () => {
    const h = pageTransport(), first = h.pages.next()
    expect(h.listPages).toHaveBeenCalledExactlyOnceWith(SESSION, ROOT)
    expect(h.send).not.toHaveBeenCalled()
    await h.source.deliver(h.ready)
    expect(h.send).toHaveBeenCalledExactlyOnceWith({ kind: 'credit', version: h.version, cursor: h.cursor('first') })
    h.source.push({ kind: 'page', path: '', version: h.version, entries: [{ name: 'first', type: 'file' }], nextCursor: h.cursor('second'), closed: false })
    await expect(first).resolves.toMatchObject({ entries: [{ name: 'first' }], page: { number: 1, more: true } })
    expect(h.send).toHaveBeenCalledTimes(1)
    const second = h.pages.next()
    expect(h.send).toHaveBeenLastCalledWith({ kind: 'credit', version: h.version, cursor: h.cursor('second') })
    h.source.push({ kind: 'page', path: '', version: h.version, entries: [{ name: 'last', type: 'file' }], nextCursor: null, closed: true })
    await expect(second).resolves.toMatchObject({ entries: [{ name: 'last' }], truncated: false, page: { number: 2, more: false } })
    let released = false
    const closing = h.pages.close().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    h.source.end()
    await closing
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(h.dispose).toHaveBeenCalledOnce()
  })

  it('closes on the same uplink and joins the Host terminal after the acknowledgement', async () => {
    const h = pageTransport()
    await h.source.deliver(h.ready)
    const closing = h.pages.close()
    let released = false
    void closing.then(() => { released = true })
    expect(h.send).toHaveBeenCalledExactlyOnceWith({ kind: 'close', version: h.version, cursor: h.cursor('first') })
    await h.source.deliver({ kind: 'closed', version: h.version, closed: true })
    expect(released).toBe(false)
    h.source.end()
    await closing
    expect(released).toBe(true)
  })

  it('waits for an in-flight page before closing with its new token', async () => {
    const h = pageTransport(), first = h.pages.next()
    await h.source.deliver(h.ready)
    const closing = h.pages.close()
    expect(h.send).toHaveBeenCalledTimes(1)
    await h.source.deliver({ kind: 'page', path: '', version: h.version, entries: [{ name: 'discarded', type: 'file' }], nextCursor: h.cursor('next'), closed: false })
    await first
    expect(h.send).toHaveBeenLastCalledWith({ kind: 'close', version: h.version, cursor: h.cursor('next') })
    h.source.push({ kind: 'closed', version: h.version, closed: true }); h.source.end()
    await closing
  })

  it('node abort requests Host closure and a quiet local end cannot substitute for its acknowledgement', async () => {
    const h = pageTransport()
    await h.source.deliver(h.ready)
    h.lifetime.abort()
    expect(h.send).toHaveBeenLastCalledWith({ kind: 'close', version: h.version, cursor: h.cursor('first') })
    const closing = expect(h.pages.close()).rejects.toThrow('not confirmed')
    h.source.end()
    await closing
  })

  it('preserves a changed-directory failure while accepting only its explicit confirmed cleanup', async () => {
    const h = pageTransport(), first = h.pages.next()
    await h.source.deliver(h.ready)
    const changed = new RemoteError('workspace-file/directory-changed', 'changed', { path: ROOT, closed: true })
    const failure = expect(first).rejects.toBe(changed)
    h.source.fail(changed)
    await failure
    await expect(h.pages.ended).rejects.toBe(changed)
    await expect(h.pages.close()).resolves.toBeUndefined()
  })
})

function mount() {
  const remote = new FakeRemote()
  remote.autoReady = false
  const controller = new AbortController()
  const supervise = vi.spyOn(remote, '$stream')
  // createWatch consumes only the stream supervisor and workspaceFiles.changes.
  const iterator = createWatch(remote as unknown as ClientRemote)(SESSION, ROOT, controller.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => {
    controller.abort()
    const returned = iterator.return?.()
    await remote.dispose()
    await returned
  })
  return { remote, controller, iterator, supervise }
}

describe('createWatch', () => {
  it('opens the requested directory, accepts ready, and forwards changes without accepting them', async () => {
    const h = mount()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    expect(watch).toMatchObject({ sessionId: SESSION, path: ROOT })
    expect(h.supervise.mock.calls[0]?.[0].name).toBe(`directory ${ROOT}`)
    watch.source.push({ kind: 'ready' })
    await expect(first).resolves.toEqual({ done: false, value: 'ready' })
    expect(h.remote.calls).toEqual(['changes', 'accept'])
    const next = h.iterator.next()
    watch.source.push({ kind: 'change', change: { absolutePath: ROOT, version: 'changed' } })
    await expect(next).resolves.toEqual({ done: false, value: 'change' })
    expect(h.remote.calls).toEqual(['changes', 'accept'])
    await h.iterator.return?.()
    expect(watch.source.aborted).toBe(true)
  })

  it('does not create a stream for an already-cancelled node', async () => {
    const h = mount()
    h.controller.abort()
    await expect(h.iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(h.supervise).not.toHaveBeenCalled()
    expect(h.remote.opened).toEqual([])
  })

  it.each([false, true])('classifies a normal stream end after ready=%s and disposes it', async (ready) => {
    const h = mount()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    const options = h.supervise.mock.calls[0]![0]
    const ended = vi.spyOn(options, 'ended')
    let pending = first
    if (ready) {
      watch.source.push({ kind: 'ready' })
      await expect(first).resolves.toEqual({ done: false, value: 'ready' })
      pending = h.iterator.next()
    }
    const rejected = expect(pending).rejects.toThrow(`Directory watch ended: ${ROOT}`)
    watch.source.end()
    await rejected
    expect(ended).toHaveBeenCalledExactlyOnceWith(ready)
    expect(h.remote.disposed).toEqual([`directory ${ROOT}`])
    expect(watch.source.aborted).toBe(true)
  })

  it('awaits disposal on consumer return and removes the node abort listener', async () => {
    const h = mount()
    const gate = h.remote.holdDisposal()
    const first = h.iterator.next()
    const watch = await h.remote.waitForChanges(0)
    watch.source.push({ kind: 'ready' })
    await first
    const result = h.supervise.mock.results[0]
    if (result?.type !== 'return') throw new Error('expected a supervised stream')
    const dispose = vi.spyOn(result.value, 'dispose')
    let closed = false
    const closing = h.iterator.return!().then((value) => { closed = true; return value })
    try {
      await h.remote.waitForDispose(0)
      expect(closed).toBe(false)
      expect(watch.source.aborted).toBe(true)
      gate.resolve(undefined)
      await expect(closing).resolves.toEqual({ done: true, value: undefined })
      expect(dispose).toHaveBeenCalledTimes(1)
      h.controller.abort()
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve(undefined)
      await closing
    }
  })

  it('does not yield a frame delivered after the node cancels', async () => {
    const h = mount()
    const supervise = FakeRemote.prototype.$stream.bind(h.remote)
    const pulled = Promise.withResolvers<undefined>()
    const deliver = Promise.withResolvers<undefined>()
    h.supervise.mockImplementation(function<Item>(options: SupervisedStreamOptions<Item>) {
      const stream = supervise(options)
      return {
        dispose: () => stream.dispose(),
        async *[Symbol.asyncIterator]() {
          for await (const item of stream) {
            pulled.resolve(undefined)
            await deliver.promise
            yield item
          }
        },
      }
    })
    const pending = h.iterator.next()
    try {
      const watch = await h.remote.waitForChanges(0)
      watch.source.push({ kind: 'ready' })
      await pulled.promise
      h.controller.abort()
      await h.remote.waitForDispose(0)
      deliver.resolve(undefined)
      await expect(pending).resolves.toEqual({ done: true, value: undefined })
      expect(h.remote.calls).toEqual(['changes'])
      expect(watch.source.aborted).toBe(true)
    } finally {
      deliver.resolve(undefined)
    }
  })
})
