// @vitest-environment jsdom
/** Boot native Files and the product through the production browser Loader; only Host facts and tab records are fixtures. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestSessions, TestWorkspaces } from '@deepseek-ai/dsh-client-test-runtime'
import { ClientRoster, TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteMock, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as nativeFiles from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import { fileDownloadPrepareRequest, fileDownloadUrl } from '@power-evolve/contracts/file-download'
import * as product from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const ALICE = '598f346b-178c-4ef3-80ef-3a68f4cb4888' as SessionId
const BOB = '7668a96c-43cd-4b9b-8bdb-a0e743802af7' as SessionId
const WORKSPACE = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const FILES = '@deepseek-ai/dsh-client-ui-sidebar-files'
const PRODUCT = '@power-evolve/client-workspace-files'
const OWNER = '@power-evolve/test-files-owner'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function boot(language: 'en' | 'zh' = 'en') {
  const owner = createSnapshotStore({ sessionId: ALICE, tabId: 'files-1', visible: true })
  const records = new Map<string, AbortController>()
  const refs = new Map<SessionId, SessionReference>()
  const opened = vi.fn()
  let locale: LocaleRuntime
  let sessions: TestSessions
  const mock = RemoteMock.create().load(remoteDefaultResponses)
    .stream('workspaceFiles/changes', openStream([{ kind: 'ready' }]))
    .unary('workspaceFiles/list', (args) => {
      const path = args[1]
      return ok({ path, truncated: false, entries: path === '/workspace/nested'
        ? [{ name: 'same.txt', type: 'file', size: 3 }]
        : [
          { name: 'nested', type: 'directory' }, { name: 'same.txt', type: 'file', size: 3 },
          { name: '中文.txt', type: 'file', size: 3 }, { name: 'image.bin', type: 'file', size: 3 },
          { name: 'pipe', type: 'other' },
        ] })
    })
  const provider = {
    inject: ['slots'],
    async apply(ctx: Context) {
      const stabilize = async (fn: () => unknown) => { await act(async () => { await fn() }) }
      sessions = new TestSessions(stabilize, ctx)
      await sessions.add({ id: ALICE, summary: { cwd: '/workspace' } })
      await sessions.add({ id: BOB, summary: { cwd: '/workspace' } })
      for (const id of [ALICE, BOB]) refs.set(id, sessions.retain(id))
      ctx.effect(() => () => { for (const ref of refs.values()) ref.release() })
      ctx.provide('sessions', sessions)
      ctx.provide('workspaces', new TestWorkspaces(stabilize))
      ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
      ctx.provide('sidebarRight', { commandTarget: () => undefined, openTabFromTarget: () => {} } as never)
      locale = new LocaleRuntime(ctx)
      locale.setLocale(language)
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.slots.register({ name: 'root', children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session',
          inject: { hooks: { tabInfo: (_standard: unknown, useTabInfo: UseSidebarRightTabInfo) => useTabInfo } } },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
        'conversation.input.left': { kind: 'list', scope: 'session' },
        'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
      } } as never, (props: PropsRenderSlots<'sidebar.right.pane.tab'> & { SessionProvider: React.ComponentType<{ session: SessionReference; children: React.ReactNode }> }) => {
        const current = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
        const key = `${current.sessionId}:${current.tabId}`
        let record = records.get(key)
        if (record === undefined) { record = new AbortController(); records.set(key, record) }
        const tab = { id: current.tabId, signal: record.signal,
          actions: { bindCommands: () => () => {}, openResource: opened }, visible: true }
        const useTabInfo = () => ({ tab })
        return <props.SessionProvider session={refs.get(current.sessionId)!}>
          {current.visible && props.renderSlot('sidebar.right.pane.tab', {},
            { entryKey: FILES, hookContext: useTabInfo as never })}
        </props.SessionProvider>
      })
    },
  }
  const base = webApp.closure(['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer'])
  const rows = [
    ...base.rows,
    { name: OWNER, inject: ['@deepseek-ai/dsh-client-ui-renderer'], immediately: false },
    { name: '@deepseek-ai/dsh-client-ui-session', inject: [OWNER], immediately: false },
    { name: FILES, inject: [OWNER, '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-api-gateway'], immediately: false },
    { name: PRODUCT, inject: [OWNER, FILES], immediately: false },
  ]
  const client = await TestClient.start({ roster: ClientRoster.of(rows), provide: {
    [OWNER]: provider, [FILES]: nativeFiles, [PRODUCT]: product,
    '@deepseek-ai/dsh-client-ui-session': uiSession,
  } }, mock, { mount: true })
  const container = client.container!
  const query = within(container)
  await query.findByRole('checkbox', { name: `${language === 'en' ? 'Select file: ' : '选择文件：'}/workspace/same.txt` })
  onTestFinished(async () => {
    for (const record of records.values()) record.abort()
    await client.dispose()
    mock.assertNoUnmatched()
  })
  return { client, container, query, mock, records, owner, locale: locale!, sessions: sessions!, opened,
    move: async (next: Partial<ReturnType<typeof owner.getSnapshot>>) => {
      await act(async () => { owner.update(state => { Object.assign(state, next) }) })
    },
    checkbox: (path: string) => container.querySelector<HTMLInputElement>(`[data-workspace-download-select="${path}"]`)!,
  }
}

function metadata(request: unknown) {
  const parsed = fileDownloadPrepareRequest.parse(request)
  const revision = 'a'.repeat(64)
  return { sessionId: parsed.sessionId, workspaceId: WORKSPACE, revision,
    downloadUrl: fileDownloadUrl({ ...parsed, revision }), fileCount: parsed.paths.length,
    fileName: parsed.paths.length === 1 ? parsed.paths[0]!.split('/').at(-1)! : 'workspace-files.zip',
    contentType: parsed.paths.length === 1 ? 'application/octet-stream' : 'application/zip',
    sourceBytes: 3 * parsed.paths.length, totalBytes: parsed.paths.length === 1 ? 3 : 300 }
}

function snapshot(container: HTMLElement) {
  return {
    root: container.querySelector('[data-files-root]')?.getAttribute('data-files-root'),
    rows: [...container.querySelectorAll('[data-files-entry]')].map(row => ({
      path: row.getAttribute('data-files-path'), type: row.getAttribute('data-files-entry'),
      selection: row.querySelector<HTMLInputElement>('input')?.checked ?? null,
      label: row.querySelector('input')?.getAttribute('aria-label') ?? null,
    })),
    controls: [...container.querySelectorAll('[data-workspace-download-toolbar] button')].map(button => ({
      label: button.getAttribute('aria-label'), disabled: button.hasAttribute('disabled'), preparing: button.getAttribute('aria-busy'),
    })),
    error: container.querySelector('[role="alert"]')?.textContent ?? null,
  }
}

for (const language of ['en', 'zh'] as const) {
  it(`records ${language} native Files selection, preparation, cancellation, failure and browser handoff`, async () => {
    const copy = language === 'en' ? en : zh
    const calls: { request: unknown; signal: AbortSignal }[] = []
    const awaiting = Promise.withResolvers<Response>()
    let respond: (body: unknown) => Promise<Response> = () => awaiting.promise
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { request } = JSON.parse(String(init.body)) as { request: unknown }
      calls.push({ request, signal: init.signal! })
      return respond(request)
    }))
    const navigations: { url: string | null; name: string; target: string; rel: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      navigations.push({ url: this.getAttribute('href'), name: this.download, target: this.target, rel: this.rel })
    })
    const b = await boot(language)
    const initial = snapshot(b.container)
    fireEvent.click(b.checkbox('/workspace/中文.txt'))
    fireEvent.click(b.checkbox('/workspace/image.bin'))
    await vi.waitFor(() => { expect(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '2') })).toBeTruthy() })
    expect(b.opened).not.toHaveBeenCalled()
    expect(b.container.querySelector('button input')).toBeNull()
    const selected = snapshot(b.container)
    fireEvent.click(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '2') }))
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.request).toEqual({ sessionId: ALICE, paths: ['中文.txt', 'image.bin'] })
    const preparing = snapshot(b.container)
    fireEvent.click(b.query.getByRole('button', { name: copy.cancelDownloadPreparation }))
    expect(calls[0]!.signal.aborted).toBe(true)
    await act(async () => { awaiting.resolve(Response.json(metadata(calls[0]!.request))) })
    expect(navigations).toEqual([])
    respond = async () => new Response(null, { status: 409 })
    fireEvent.click(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '2') }))
    expect(await b.query.findByRole('alert')).toHaveProperty('textContent', copy.downloadChanged)
    const changed = snapshot(b.container)
    respond = async body => Response.json(metadata(body))
    for (let index = 0; index < 2; index++) {
      fireEvent.click(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '2') }))
      await vi.waitFor(() => { expect(navigations).toHaveLength(index + 1) })
    }
    expect(navigations[0]).toEqual({ url: metadata(calls[0]!.request).downloadUrl,
      name: 'workspace-files.zip', target: '_blank', rel: 'noopener' })
    expect(b.container.querySelector('a[download]')).toBeNull()
    expect(b.checkbox('/workspace/中文.txt').checked).toBe(true)
    const downloaded = snapshot(b.container)
    fireEvent.click(b.query.getByRole('button', { name: copy.clearSelection }))
    await vi.waitFor(() => { expect(b.checkbox('/workspace/中文.txt').checked).toBe(false) })
    const cleared = snapshot(b.container)
    expect({ initial, selected, preparing, changed, downloaded, cleared }).toMatchSnapshot()
    await b.client.reload(PRODUCT)
    await vi.waitFor(() => { expect(b.container.querySelectorAll('[data-workspace-download-toolbar]')).toHaveLength(1) })
    fireEvent.click(b.checkbox('/workspace/same.txt'))
    await vi.waitFor(() => { expect(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '1') })).toBeTruthy() })
    fireEvent.click(b.query.getByRole('button', { name: copy.downloadSelected.replace('{count}', '1') }))
    await vi.waitFor(() => { expect(navigations).toHaveLength(3) })
    expect(navigations[2]!.name).toBe('same.txt')
  }, 30_000)
}

it('keeps selections per viewed Session and tab through hiding, and forgets a closed tab while hidden', async () => {
  const b = await boot()
  fireEvent.click(b.checkbox('/workspace/same.txt'))
  await vi.waitFor(() => { expect(b.checkbox('/workspace/same.txt').checked).toBe(true) })
  await b.move({ visible: false })
  await b.move({ visible: true })
  expect(b.checkbox('/workspace/same.txt').checked).toBe(true)
  await b.move({ sessionId: BOB })
  await b.query.findByRole('checkbox', { name: 'Select file: /workspace/same.txt' })
  expect(b.checkbox('/workspace/same.txt').checked).toBe(false)
  fireEvent.click(b.checkbox('/workspace/image.bin'))
  await vi.waitFor(() => { expect(b.checkbox('/workspace/image.bin').checked).toBe(true) })
  await b.move({ sessionId: ALICE, tabId: 'files-2' })
  await b.query.findByRole('checkbox', { name: 'Select file: /workspace/same.txt' })
  expect(b.checkbox('/workspace/same.txt').checked).toBe(false)
  await b.move({ tabId: 'files-1' })
  expect(b.checkbox('/workspace/same.txt').checked).toBe(true)
  await b.move({ visible: false })
  await act(async () => { b.records.get(`${ALICE}:files-1`)!.abort() })
  b.records.set(`${ALICE}:files-1`, new AbortController())
  await b.move({ visible: true })
  await b.query.findByRole('checkbox', { name: 'Select file: /workspace/same.txt' })
  expect(b.checkbox('/workspace/same.txt').checked).toBe(false)
  await b.move({ sessionId: BOB })
  expect(b.checkbox('/workspace/image.bin').checked).toBe(true)
}, 30_000)

it('cancels preparation when the viewed body or selection changes and preserves nested same-name selections', async () => {
  const calls: { request: unknown; signal: AbortSignal }[] = []
  const pending: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request: unknown = JSON.parse(String(init.body)).request
    calls.push({ request, signal: init.signal! })
    const promise = Promise.withResolvers<Response>()
    pending.push(promise)
    return promise.promise
  }))
  const browser = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const b = await boot()
  fireEvent.click(b.query.getByRole('button', { name: 'nested' }))
  await b.query.findByRole('checkbox', { name: 'Select file: /workspace/nested/same.txt' })
  fireEvent.click(b.checkbox('/workspace/nested/same.txt'))
  fireEvent.click(b.checkbox('/workspace/same.txt'))
  await vi.waitFor(() => { expect(b.query.getByRole('button', { name: 'Download selected files (2)' })).toBeTruthy() })
  fireEvent.click(b.query.getByRole('button', { name: 'Download selected files (2)' }))
  await vi.waitFor(() => { expect(calls).toHaveLength(1) })
  expect(calls[0]!.request).toEqual({ sessionId: ALICE, paths: ['nested/same.txt', 'same.txt'] })
  await b.move({ sessionId: BOB })
  expect(calls[0]!.signal.aborted).toBe(true)
  await act(async () => { pending[0]!.resolve(Response.json(metadata(calls[0]!.request))) })
  expect(browser).not.toHaveBeenCalled()
  await b.move({ sessionId: ALICE })
  fireEvent.click(b.query.getByRole('button', { name: 'Download selected files (2)' }))
  await vi.waitFor(() => { expect(calls).toHaveLength(2) })
  fireEvent.click(b.query.getByRole('button', { name: 'Clear selection' }))
  expect(calls[1]!.signal.aborted).toBe(true)
  await act(async () => { pending[1]!.resolve(Response.json(metadata(calls[1]!.request))) })
  expect(browser).not.toHaveBeenCalled()
  await b.client.unload(PRODUCT)
  expect(b.container.querySelector('[data-workspace-download-toolbar]')).toBeNull()
  expect(b.container.querySelector('[data-workspace-download-select]')).toBeNull()
  expect(document.getElementById('@power-evolve/dsh-client-workspace-files')).toBeNull()
  await b.client.unload(FILES)
}, 30_000)
