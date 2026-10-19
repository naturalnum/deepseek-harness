// @vitest-environment jsdom
/** Real SlotRegistry/component assembly; page/Remote collaborators do not claim authenticated product acceptance. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { installCloudFileDownloads, type FileDownloadPage } from '../src/client/downloads.ts'
import { FileDownloadAction, type FileDownloadActionProps, type FileDownloadActionInjected } from '../src/client/FileDownloadAction.tsx'
import { DOWNLOAD_NAMESPACE } from '../src/client/download/locales.ts'
import type { CloudFileReadBytes } from '../src/client/file-download.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

const holes = ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable'] as const
const id = SessionId('actual-slot-session')
function PreviewHost({ renderSlot }: PropsRenderSlots<typeof holes[number]>) {
  return <>{renderSlot(holes[0], { absolutePath: '/native/report.bin' })}
    {renderSlot(holes[1], { absolutePath: '/native/opaque.dat' })}</>
}
function complete(): Awaited<ReturnType<CloudFileReadBytes>> {
  return { ok: true, value: { absolutePath: '/native/report.bin', version: 'v', bytes: 2,
    offset: 0, eof: true, data: new Uint8Array([0, 255]) } }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture(options: { cap?: number; disabled?: boolean; noRemote?: boolean; read?: CloudFileReadBytes } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx, undefined, { preference: 'en', languages: ['en-US'] }))
  const pageLife = new AbortController()
  const page: FileDownloadPage = { maxDownloadBytes: options.cap,
    bootstrap: { capabilities: { filePreview: options.disabled ? { state: 'disabled', reason: 'not-approved' } : { state: 'available' } } },
    lifetime: { transport: { signal: pageLife.signal } } }
  const read = vi.fn(options.read ?? vi.fn<CloudFileReadBytes>().mockResolvedValue(complete()))
  let methodReads = 0
  const workspaceFiles = { get readBytes() { methodReads++; return read } }
  const supply = () => {
    ctx.provide('remote', { workspaceFiles } as never)
    ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  }
  if (!options.noRemote) supply()
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
  } }, PreviewHost)
  const fiber = ctx.plugin({ apply(owner: Context) { installCloudFileDownloads(owner, page) } })
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  await fiber.await()
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:slot-download')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const clicked: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download) })
  const counts = () => holes.map(hole => ctx.slots.entries(hole).length)
  const action = (hole: typeof holes[number] = holes[0], sessionId = id, absolutePath = '/native/report.bin') => {
    const entry = ctx.slots.entries(hole)[0]
    if (entry?.inject === undefined) throw new Error('Actual download action did not register')
    const face = entry.inject()
    const signal = face['signal'], maxFileBytes = face['maxFileBytes'], readBytes = face['readBytes']
    if (!(signal instanceof AbortSignal) || typeof maxFileBytes !== 'number' || typeof readBytes !== 'function') {
      throw new Error('Actual slot injection is incomplete')
    }
    const injected: FileDownloadActionInjected = { signal, maxFileBytes, readBytes: readBytes as CloudFileReadBytes }
    const props = { ...injected, sessionId, absolutePath, t: ctx.locale.bind(DOWNLOAD_NAMESPACE) } as FileDownloadActionProps
    const Component = entry.component as typeof FileDownloadAction
    return <Component {...props} />
  }
  return { ctx, fiber, pageLife, read, declare, supply, counts, action, createObjectURL, revokeObjectURL, clicked,
    methodReads: () => methodReads }
}

it('keeps download entries absent with legacy missing cap or unavailable preview capability', async () => {
  for (const options of [{}, { cap: 65536, disabled: true }]) {
    const f = await fixture(options)
    f.declare()
    expect(f.counts()).toEqual([0, 0])
    expect(f.methodReads()).toBe(0)
    expect(f.read).not.toHaveBeenCalled()
  }
})

it('fills late declarations, redeclares and withdraws the real component registrations with its fiber', async () => {
  const f = await fixture({ cap: 65536 })
  expect(f.counts()).toEqual([0, 0])
  const remove = f.declare()
  await waitFor(() => { expect(f.counts()).toEqual([1, 1]) })
  expect(f.methodReads()).toBe(1)
  const view = render(f.action())
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Download requested') })
  expect(f.read).toHaveBeenCalledWith(id, '/native/report.bin', {}, expect.any(AbortSignal))
  expect(f.clicked).toEqual(['report.bin'])
  expect(f.revokeObjectURL).toHaveBeenCalledOnce()
  view.unmount()
  remove()
  expect(f.counts()).toEqual([0, 0])
  f.declare()
  expect(f.counts()).toEqual([1, 1])
  expect(f.methodReads()).toBe(1)
  await f.fiber.dispose()
  expect(f.counts()).toEqual([0, 0])
})

it('also adapts the actual unpreviewable slot Session and path without querying global selection', async () => {
  const f = await fixture({ cap: 65536 })
  f.declare()
  const sourceSession = SessionId('unpreviewable-slot-session')
  render(f.action(holes[1], sourceSession, '/native/opaque.dat'))
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await waitFor(() => { expect(f.clicked).toEqual(['opaque.dat']) })
  expect(f.read).toHaveBeenCalledWith(sourceSession, '/native/opaque.dat', {}, expect.any(AbortSignal))
})

it('rejects a late read after declaration withdrawal even while the old component has not unmounted', async () => {
  const ready = Promise.withResolvers<Awaited<ReturnType<CloudFileReadBytes>>>()
  const f = await fixture({ cap: 65536, read: () => ready.promise })
  const remove = f.declare()
  render(f.action())
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(f.read).toHaveBeenCalledOnce()
  remove()
  expect(f.counts()).toEqual([0, 0])
  await act(async () => { ready.resolve(complete()) })
  expect(f.createObjectURL).not.toHaveBeenCalled()
  expect(f.clicked).toEqual([])
})

it('withdraws entries on original page revocation and discards a late native result', async () => {
  const ready = Promise.withResolvers<Awaited<ReturnType<CloudFileReadBytes>>>()
  const f = await fixture({ cap: 65536, read: () => ready.promise })
  const remove = f.declare()
  render(f.action())
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  await act(async () => { f.pageLife.abort() })
  expect(f.read.mock.calls[0]?.[3]?.aborted).toBe(true)
  await waitFor(() => { expect(f.counts()).toEqual([0, 0]) })
  await act(async () => { ready.resolve(complete()) })
  expect(f.createObjectURL).not.toHaveBeenCalled()
  remove()
  f.declare()
  expect(f.counts()).toEqual([0, 0])
})

it('does not activate a delayed Remote supplier after the original page was revoked', async () => {
  const f = await fixture({ cap: 65536, noRemote: true })
  f.declare()
  f.pageLife.abort()
  f.supply()
  await Promise.resolve()
  expect(f.counts()).toEqual([0, 0])
  expect(f.methodReads()).toBe(0)
})
