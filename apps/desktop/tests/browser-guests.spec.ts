import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserLeaseId, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserGuests as GuestManager } from '../src/browser-guests.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { app: Object.assign(new EventEmitter(), { isPackaged: true }), sessions: new Map<string, object>(), contents: [] as object[] }
})
vi.mock('electron', () => ({ app: native.app, session: { fromPartition: (partition: string) => {
  if (!native.sessions.has(partition)) native.sessions.set(partition, new BrowserSession())
  return native.sessions.get(partition)
} },
webContents: { getAllWebContents: () => native.contents } }))
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')

class BrowserSession extends EventEmitter {
  readonly setPermissionRequestHandler = vi.fn()
  readonly setPermissionCheckHandler = vi.fn()
  readonly setDevicePermissionHandler = vi.fn()
  readonly setDisplayMediaRequestHandler = vi.fn()
  readonly webRequest = { onBeforeRequest: vi.fn() }
  readonly closeAllConnections = vi.fn(async () => {})
  readonly flushStorageData = vi.fn()
  readonly clearStorageData = vi.fn(async () => {})
  readonly clearCache = vi.fn(async () => {})
  readonly clearAuthCache = vi.fn(async () => {})
  readonly clearSharedDictionaryCache = vi.fn(async () => {})
}
class Contents extends EventEmitter {
  dead = false
  url = ''
  readonly send = vi.fn()
  readonly setWindowOpenHandler = vi.fn()
  readonly close = vi.fn(() => {})
  constructor(readonly session?: BrowserSession, readonly hostWebContents: Contents | null = null) { super(); native.contents.push(this) }
  getURL() { return this.url }
  getType() { return this.hostWebContents === null ? 'window' : 'webview' }
  isDestroyed() { return this.dead }
  destroy() { this.dead = true; this.emit('destroyed') }
}
type ManagerFixture = Omit<GuestManager, 'bind' | 'acquire' | 'release'> & {
  bind(window: { webContents: Contents }, attachInput: (guest: Contents, id: DesktopBrowserLeaseId) => () => void): () => Promise<void>
  acquire(owner: Contents, workspace: unknown): DesktopBrowserReservation
  release(owner: Contents, id: unknown): Promise<void>
}
function fixture(rejectsUrl?: (url: URL) => boolean) {
  const manager = new DesktopBrowserGuests(() => 'http://127.0.0.1:19387', rejectsUrl === undefined ? {} : { rejectsUrl }) as Pick<GuestManager, 'retireWorkspace'> as ManagerFixture
  const owner = new Contents()
  const input = vi.fn(() => {})
  const attach = vi.fn(() => input)
  const dispose = manager.bind({ webContents: owner }, attach)
  const reserve = (workspace = 'cwd:/workspace', contents = owner) => manager.acquire(contents, workspace)
  const sessionFor = (reservation: DesktopBrowserReservation) => native.sessions.get(reservation.partition) as BrowserSession
  const accept = (reservation: DesktopBrowserReservation, contents = owner) => {
    const event = { preventDefault: vi.fn() }
    const preferences = { preload: '/forbidden.js', nodeIntegration: true }
    const params = { src: `about:blank#${reservation.lease}`, partition: reservation.partition }
    contents.emit('will-attach-webview', event, preferences, params)
    return { event, preferences }
  }
  const create = (reservation: DesktopBrowserReservation, contents = owner, identify = true) => {
    const guest = new Contents(sessionFor(reservation), contents)
    native.app.emit('web-contents-created', {}, guest)
    if (identify && !guest.dead) {
      guest.url = `about:blank#${reservation.lease}`
      guest.emit('did-start-navigation', { isMainFrame: true, url: guest.url })
    }
    contents.emit('did-attach-webview', {}, guest)
    return guest
  }
  const ready = (reservation: DesktopBrowserReservation, contents = owner) => {
    accept(reservation, contents)
    const guest = create(reservation, contents)
    guest.emit('dom-ready')
    return guest
  }
  return { manager, owner, attach, input, dispose, reserve, sessionFor, accept, create, ready }
}
afterEach(() => {
  for (const value of native.contents) { if (value instanceof Contents && !value.dead) value.destroy() }
  native.app.removeAllListeners()
  native.sessions.clear()
  native.contents.length = 0
  vi.clearAllMocks()
})

it('shares workspace storage across windows and retains it after ordinary guest release', async () => {
  const f = fixture()
  const other = new Contents()
  f.manager.bind({ webContents: other }, f.attach)
  const first = f.reserve()
  const second = f.reserve('cwd:/workspace', other)
  expect(second.partition).toBe(first.partition)
  expect(f.reserve('session:other').partition).not.toBe(first.partition)
  const a = f.ready(first), b = f.ready(second, other)
  const released = f.manager.release(f.owner, first.lease)
  expect(f.manager.release(f.owner, first.lease)).toBe(released)
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).not.toHaveBeenCalled()
  a.destroy()
  await released
  expect(f.sessionFor(first).clearStorageData).not.toHaveBeenCalled()
  expect(f.reserve().partition).toBe(first.partition)
  expect(f.input).toHaveBeenCalledOnce()
})

it('tracks created guests before attachment and retirement waits for real destruction', async () => {
  const f = fixture(), reservation = f.reserve('epoch:1')
  f.accept(reservation)
  const retirement = f.manager.retireWorkspace('epoch:1')
  expect(f.manager.retireWorkspace('epoch:1')).toBe(retirement)
  expect(() => f.reserve('epoch:1')).toThrow('retired')
  const guest = f.create(reservation, f.owner, false)
  await Promise.resolve()
  expect(guest.close).toHaveBeenCalledOnce()
  let settled = false
  void retirement.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  guest.emit('dom-ready')
  expect(f.attach).not.toHaveBeenCalled()
  guest.destroy()
  await retirement
  expect(f.sessionFor(reservation).closeAllConnections).toHaveBeenCalledOnce()
  for (const method of ['clearStorageData', 'clearCache', 'clearAuthCache', 'clearSharedDictionaryCache'] as const) {
    expect(f.sessionFor(reservation)[method]).toHaveBeenCalledOnce()
  }
  expect(() => f.reserve('epoch:1')).toThrow('retired')
  expect(f.accept(reservation).event.preventDefault).toHaveBeenCalledOnce()
})

it('waits for the exact bootstrap lease when multiple guest creations arrive out of order', async () => {
  const f = fixture(), first = f.reserve(), second = f.reserve()
  f.accept(first); f.accept(second)
  const closing = f.manager.release(f.owner, first.lease)
  const b = f.create(second), a = f.create(first)
  await Promise.resolve()
  expect(b.close).not.toHaveBeenCalled()
  expect(a.close).toHaveBeenCalledOnce()
  a.destroy()
  await closing
  b.emit('dom-ready')
  expect(f.attach).toHaveBeenCalledExactlyOnceWith(b, second.lease)
})

it('settles accepted attachments suppressed by native destruction before initial navigation', async () => {
  const f = fixture(), reservation = f.reserve()
  f.accept(reservation)
  const guest = f.create(reservation, f.owner, false)
  const closing = f.manager.release(f.owner, reservation.lease)
  guest.destroy()
  await closing
  expect(f.attach).not.toHaveBeenCalled()
  const absent = f.reserve()
  f.accept(absent)
  await f.manager.release(f.owner, absent.lease)
})

it('shares an in-flight ordinary close with retirement and closes both workspace owners', async () => {
  const f = fixture(), other = new Contents()
  f.manager.bind({ webContents: other }, f.attach)
  const aLease = f.reserve('epoch:1'), bLease = f.reserve('epoch:1', other)
  const a = f.ready(aLease), b = f.ready(bLease, other)
  const closing = f.manager.release(f.owner, aLease.lease)
  const retirement = f.manager.retireWorkspace('epoch:1')
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
  a.destroy()
  await closing
  expect(f.sessionFor(aLease).clearStorageData).not.toHaveBeenCalled()
  b.destroy()
  await retirement
})

it.each(['close', 'disposer'] as const)('retains ownership after %s failure and invokes an input disposer once', async (failure) => {
  const f = fixture(), reservation = f.reserve('epoch:1'), guest = f.ready(reservation)
  if (failure === 'close') guest.close.mockImplementationOnce(() => { throw new Error('close failed') })
  else f.input.mockImplementationOnce(() => { throw new Error('disposer failed') })
  const first = f.manager.release(f.owner, reservation.lease)
  if (failure === 'disposer') guest.destroy()
  await expect(first).rejects.toThrow('failed')
  const retry = f.manager.release(f.owner, reservation.lease)
  if (failure === 'close') guest.destroy()
  await retry
  expect(f.input).toHaveBeenCalledOnce()
  await f.manager.retireWorkspace('epoch:1')
  expect(() => f.reserve('epoch:1')).toThrow('retired')
})

it.each(['closeAllConnections', 'clearStorageData', 'clearCache', 'clearAuthCache', 'clearSharedDictionaryCache'] as const)(
  'keeps retirement blocked and retryable after %s failure', async (method) => {
    const f = fixture(), reservation = f.reserve('epoch:1')
    f.sessionFor(reservation)[method].mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(f.manager.retireWorkspace('epoch:1')).rejects.toThrow('failed')
    expect(() => f.reserve('epoch:1')).toThrow('retired')
    await f.manager.retireWorkspace('epoch:1')
    expect(f.sessionFor(reservation)[method]).toHaveBeenCalledTimes(2)
    expect(() => f.reserve('epoch:1')).toThrow('retired')
  })

it('composes fixed protocol and Host denials with additional URL policy across native entry points', async () => {
  const f = fixture(url => url.hostname === 'trusted.example'), reservation = f.reserve(), guest = f.ready(reservation)
  const request = f.sessionFor(reservation).webRequest.onBeforeRequest.mock.calls[0]?.[0] as
    (details: { url: string }, callback: (value: { cancel: boolean }) => void) => void
  for (const url of ['http://trusted.example/path', 'wss://trusted.example/ws', 'http://localhost:19387/private',
    'http://[::1]:19387/private', 'file:///secret', 'https://user:pass@public.example/']) {
    const callback = vi.fn()
    request({ url }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  }
  for (const url of ['https://public.example/', 'ws://public.example/ws', 'data:text/plain,hello', 'about:blank']) {
    const callback = vi.fn()
    request({ url }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: false })
  }
  const popup = guest.setWindowOpenHandler.mock.calls[0]?.[0] as (details: { url: string; postBody?: object }) => { action: string }
  const event = { preventDefault: vi.fn(), isMainFrame: true, url: 'https://trusted.example/' }
  guest.emit('will-frame-navigate', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  guest.emit('will-redirect', event, event.url, false, true)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  popup({ url: event.url })
  expect(f.owner.send).not.toHaveBeenCalled()
  popup({ url: 'https://public.example/' })
  expect(f.owner.send).toHaveBeenCalledOnce()
  const retirement = f.manager.retireWorkspace('cwd:/workspace')
  popup({ url: 'https://public.example/' })
  expect(f.owner.send).toHaveBeenCalledOnce()
  const callback = vi.fn()
  request({ url: 'https://public.example/' }, callback)
  expect(callback).toHaveBeenCalledWith({ cancel: true })
  guest.destroy()
  await retirement
})

it('removes scoped creation listeners only after the binding reaches native destruction', async () => {
  const f = fixture(), guest = f.ready(f.reserve())
  const disposal = f.dispose()
  expect(f.dispose()).toBe(disposal)
  expect(native.app.listenerCount('web-contents-created')).toBe(1)
  expect(() => f.reserve()).toThrow('disposed')
  guest.destroy()
  await disposal
  expect(native.app.listenerCount('web-contents-created')).toBe(0)
  const rejected = { preventDefault: vi.fn() }
  f.owner.emit('will-attach-webview', rejected, {}, { src: 'https://public.example/', partition: 'unknown' })
  expect(rejected.preventDefault).toHaveBeenCalledOnce()
})

it('releases guests on document replacement or owner death while retaining same-document leases', async () => {
  const f = fixture(), reservation = f.reserve(), guest = f.ready(reservation)
  await expect(f.manager.release(new Contents(), reservation.lease)).rejects.toThrow('another window')
  f.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  expect(guest.close).not.toHaveBeenCalled()
  f.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(guest.close).toHaveBeenCalledOnce()
  const closing = f.manager.release(f.owner, reservation.lease)
  f.owner.destroy()
  expect(() => f.reserve()).toThrow('disposed')
  const disposal = f.dispose()
  guest.destroy()
  await Promise.all([closing, disposal])
  expect(native.app.listenerCount('web-contents-created')).toBe(0)
})
