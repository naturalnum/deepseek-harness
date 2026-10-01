// @vitest-environment jsdom
/** Native Loader, WorkspacePicker and product registrations; only Host replies and durable data are fixtures. */
import { useRef, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TestSessions, TestWorkspaces } from '@deepseek-ai/dsh-client-test-runtime'
import { ClientRoster, TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as uiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  workspaceCreateSelection, workspaceBindingRestoreRequest, storageDirectoryCreateRequest,
  type WorkspaceBindingRestoreRequest,
} from '@power-evolve/contracts/workspace-binding'
import * as product from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { en as workspaceEn, zh as workspaceZh } from '@deepseek-ai/dsh-client-ui-workspace/src/client/locales.ts'

const SPACE = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const WORKSPACE = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const SID = SessionId('598f346b-178c-4ef3-80ef-3a68f4cb4888')
const OTHER = '7668a96c-43cd-4b9b-8bdb-a0e743802af7'
const OWNER = '@power-evolve/test-workspace-owner'
const PRODUCT = '@power-evolve/client-cloud-workspaces'
const UI_WORKSPACE = '@deepseek-ai/dsh-client-ui-workspace'
const UI_SESSION = '@deepseek-ai/dsh-client-ui-session'
const original = { workspaceId: WORKSPACE, title: 'Original', path: '/workspace', sessionIds: [SID],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
const spaces = { items: [{ spaceId: SPACE, title: 'Private files', isDefault: true, available: true }] }
const missing = { items: [{ workspaceId: WORKSPACE, title: 'Original', generation: 4, state: 'missing', target: null, recoveryRequestId: null }] }

type Call = { key: string; request: Record<string, unknown>; signal: AbortSignal }
function server(overrides: (call: Call) => Promise<Response | undefined> = async () => undefined) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const call = { key: url.slice('/api/powerEvolve/'.length), request: JSON.parse(String(init.body)).request, signal: init.signal! }
    calls.push(call)
    const overridden = await overrides(call)
    if (overridden) return overridden
    switch (call.key) {
      case 'storageSpaces': return Response.json(spaces)
      case 'workspaceBindingsMissing': return Response.json(missing)
      case 'storageDirectories': return Response.json({ spaceId: call.request.spaceId, parentPath: call.request.parentPath,
        entries: call.request.parentPath === '' ? [{ name: 'Existing', path: 'Existing' }] : [] })
      default: throw new Error(`Unexpected Host request ${call.key}`)
    }
  }))
  return calls
}
function receipt(request: WorkspaceBindingRestoreRequest, state: 'accepted' | 'stopping' | 'completed' | 'blocked') {
  return { requestId: request.requestId, workspaceId: request.workspaceId, expectedGeneration: request.expectedGeneration,
    state, bindingGeneration: state === 'completed' ? request.expectedGeneration + 1 : null,
    errorCode: state === 'blocked' ? 'workspace_writer_stop_unconfirmed' : null }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

async function boot(language: 'en' | 'zh' = 'en') {
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SID }))
  let workspaces: TestWorkspaces
  let sessions: TestSessions
  const picked = vi.fn()
  const owner = createSnapshotStore({ open: false, sidebar: false })
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const provider = {
    inject: ['slots'],
    async apply(ctx: Context) {
      const stabilize = async (fn: () => unknown) => { await act(async () => { await fn() }) }
      sessions = new TestSessions(stabilize, ctx)
      await sessions.add({ id: SID, events: [], summary: { cwd: '/workspace', blank: false } })
      workspaces = new TestWorkspaces(stabilize)
      await workspaces.update(draft => { draft.phase = 'ready'; draft.items = [original as never] })
      workspaces.stub('create', async input => {
        const selected = decode(input.path)
        const result = { ...original, workspaceId: OTHER as never, title: selected.title, sessionIds: [] }
        workspaces.list.update(draft => { draft.items.push(result) })
        return result
      })
      ctx.provide('sessions', sessions)
      ctx.provide('workspaces', workspaces)
      ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal } as never)
      ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
      const locale = new LocaleRuntime(ctx)
      locale.setLocale(language)
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      ctx.slots.provideRoot({ hooks: { panelInfo: createSnapshotStore({ activePanelId: null }) } })
      ctx.slots.register({ name: 'root', children: {
        'conversation.hero.workspace': { kind: 'single', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      } }, function Root(props: PropsRenderSlots<'conversation.hero.workspace' | 'sidebar.workspaces' | 'shell.overlay'>) {
        const { open, sidebar } = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
        const setOpen = (open: boolean) => { owner.set({ ...owner.getSnapshot(), open }) }
        const anchor = useRef<HTMLButtonElement>(null)
        return <><button data-owner-open={open} ref={anchor} onClick={() => { setOpen(true) }}>Open native picker</button>
          {!sidebar && props.renderSlot('conversation.hero.workspace', { open, anchorRef: anchor, onClose: () => { setOpen(false) },
            onPick: id => { picked(id); setOpen(false) } })}
          {sidebar && props.renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
          {props.renderSlot('shell.overlay', {})}</>
      })
    },
  }
  const base = webApp.closure(['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer'])
  const client = await TestClient.start({ roster: ClientRoster.of([...base.rows,
    { name: OWNER, inject: ['@deepseek-ai/dsh-client-ui-renderer'], immediately: false },
    { name: UI_SESSION, inject: [OWNER], immediately: false },
    { name: UI_WORKSPACE, inject: [OWNER, UI_SESSION], immediately: false },
    { name: PRODUCT, inject: [UI_WORKSPACE], immediately: false },
  ]), provide: { [OWNER]: provider, [UI_SESSION]: uiSession, [UI_WORKSPACE]: uiWorkspace, [PRODUCT]: product } }, mock, { mount: true })
  onTestFinished(async () => { await client.dispose(); mock.assertNoUnmatched() })
  await vi.waitFor(() => { expect(client.ctx.slots.entries('conversation.hero.workspace.directoryFlow')).toHaveLength(1) })
  await client.ctx.loader.await()
  await client.flush()
  const query = within(document.body)
  const open = async () => {
    if (owner.getSnapshot().sidebar) {
      fireEvent.click(query.getByRole('button', { name: (language === 'en' ? workspaceEn : workspaceZh)['workspace.add'] }))
      await query.findByRole('dialog', { name: (language === 'en' ? en : zh).title })
      return
    }
    await act(async () => { fireEvent.click(within(client.container!).getByRole('button', { name: 'Open native picker' })) })
    expect(owner.getSnapshot().open).toBe(true)
    await client.flush()
    expect(within(client.container!).getByRole('button', { name: 'Open native picker' }).dataset.ownerOpen).toBe('true')
    const copy = language === 'en' ? workspaceEn : workspaceZh
    fireEvent.click(await query.findByRole('menuitem', { name: copy['menu.addWorkspace'] }))
    await query.findByRole('dialog', { name: (language === 'en' ? en : zh).title })
  }
  return { client, query, workspaces: workspaces!, sessions: sessions!, picked, open, sidebar: async () => { await act(async () => { owner.set({ open: false, sidebar: true }) }) } }
}
function decode(path: string) {
  expect(path.startsWith('power-evolve-cloud-selection:')).toBe(true)
  return workspaceCreateSelection.parse(JSON.parse(decodeURIComponent(path.slice('power-evolve-cloud-selection:'.length))))
}

for (const language of ['en', 'zh'] as const) it(`creates from a nonempty existing private directory through the native picker (${language})`, async () => {
  const calls = server()
  const b = await boot(language)
  const copy = language === 'en' ? en : zh
  await b.open()
  expect(b.query.getByRole('dialog').textContent).toMatchSnapshot('new directory')
  fireEvent.change(b.query.getByRole('textbox', { name: copy.name }), { target: { value: ' 项目 A ' } })
  fireEvent.click(b.query.getByRole('tab', { name: copy.existingDirectory }))
  fireEvent.click(await b.query.findByRole('button', { name: 'Existing' }))
  await vi.waitFor(() => { expect(b.query.getByRole('button', { name: copy.create }).hasAttribute('disabled')).toBe(false) })
  expect(b.query.getByRole('dialog').textContent).toMatchSnapshot('existing directory')
  fireEvent.click(b.query.getByRole('button', { name: copy.create }))
  await vi.waitFor(() => { expect(b.picked).toHaveBeenCalledWith(OTHER) })
  const call = b.workspaces.calls.find(call => call.method === 'create')!
  const input = call.args[0] as { path: string }
  expect(decode(input.path)).toMatchObject({ title: '项目 A', target: { spaceId: SPACE, rootRelativePath: 'Existing' } })
  expect(calls.filter(call => call.key === 'storageDirectories').map(call => call.request.parentPath)).toEqual(['', 'Existing'])
  expect(b.workspaces.list.getSnapshot().items[0]).toEqual(original)
}, 30_000)

it('keeps the native creation request identity across the owner error and Choose again flow', async () => {
  server()
  const b = await boot()
  let attempts = 0
  b.workspaces.stub('create', async () => { attempts++; throw new Error('uncertain creation') })
  await b.open()
  fireEvent.change(b.query.getByRole('textbox', { name: en.name }), { target: { value: 'Retry project' } })
  fireEvent.click(b.query.getByRole('button', { name: en.create }))
  await b.query.findByText('uncertain creation')
  fireEvent.click(b.query.getByRole('button', { name: workspaceEn['folderError.retry'] }))
  await b.query.findByRole('dialog', { name: en.title })
  fireEvent.click(b.query.getByRole('button', { name: en.create }))
  await vi.waitFor(() => { expect(attempts).toBe(2) })
  const paths = b.workspaces.calls.filter(call => call.method === 'create').map(call => (call.args[0] as { path: string }).path)
  expect(decode(paths[0]!)).toEqual(decode(paths[1]!))
}, 30_000)

for (const language of ['en', 'zh'] as const) it(`recovers the original binding through accepted, stopping and completed without creating a Workspace (${language})`, async () => {
  let restore: WorkspaceBindingRestoreRequest
  let statusCalls = 0
  let complete = false
  const calls = server(async call => {
    if (call.key === 'workspaceBindingRestore') { restore = workspaceBindingRestoreRequest.parse(call.request); return Response.json(receipt(restore, 'accepted')) }
    if (call.key === 'workspaceBindingStatus') { statusCalls++; complete = statusCalls > 1; return Response.json(receipt(restore!, complete ? 'completed' : 'stopping')) }
    if (call.key === 'workspaceBindingsMissing' && complete) return Response.json({ items: [] })
    return undefined
  })
  const b = await boot(language)
  const copy = language === 'en' ? en : zh
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: copy.recovery }))
  fireEvent.click(await b.query.findByRole('button', { name: 'Existing' }))
  await vi.waitFor(() => { expect(b.query.getByRole('button', { name: copy.restore }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(b.query.getByRole('button', { name: copy.restore }))
  await b.query.findByText(copy.accepted)
  expect(b.query.getByRole('dialog').textContent).toMatchSnapshot('accepted recovery')
  fireEvent.click(b.query.getByRole('button', { name: copy.checkStatus }))
  await b.query.findByText(copy.stopping)
  fireEvent.click(b.query.getByRole('button', { name: copy.checkStatus }))
  await b.query.findByText(copy.completed)
  await b.query.findByText(copy.noMissing)
  expect(restore!).toMatchObject({ workspaceId: WORKSPACE, expectedGeneration: 4, spaceId: SPACE, rootRelativePath: 'Existing' })
  expect(calls.filter(call => call.key === 'workspaceBindingStatus').map(call => call.request)).toEqual([{ requestId: restore!.requestId }, { requestId: restore!.requestId }])
  expect(b.workspaces.calls.some(call => call.method === 'create')).toBe(false)
  expect(b.picked).not.toHaveBeenCalled()
  expect(b.workspaces.list.getSnapshot().items[0]).toEqual(original)
  expect(b.sessions.list.getSnapshot().ids).toContain(SID)
  expect(b.query.getByRole('dialog').textContent).toMatchSnapshot('completed recovery')
}, 30_000)

it('browses another page, creates a child directory and retries mkdir with the same request', async () => {
  let failures = 1
  const calls = server(async call => {
    if (call.key === 'storageDirectories' && call.request.parentPath === '') return Response.json({ spaceId: SPACE, parentPath: '',
      entries: call.request.cursor ? [{ name: 'Second', path: 'Second' }] : [{ name: 'Existing', path: 'Existing' }],
      ...(call.request.cursor ? {} : { nextCursor: 'next-page' }) })
    if (call.key === 'storageDirectoryCreate') {
      const request = storageDirectoryCreateRequest.parse(call.request)
      if (failures-- > 0) return Response.json({ error: 'storage_unavailable' }, { status: 503 })
      return Response.json({ name: request.name, path: request.name })
    }
    return undefined
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.existingDirectory }))
  fireEvent.click(await b.query.findByRole('button', { name: en.nextPage }))
  await b.query.findByRole('button', { name: 'Second' })
  expect(b.query.queryByRole('button', { name: 'Existing' })).toBeNull()
  fireEvent.change(b.query.getByRole('textbox', { name: en.directoryName }), { target: { value: 'Created' } })
  fireEvent.click(b.query.getByRole('button', { name: en.mkdir }))
  await b.query.findByRole('alert')
  fireEvent.click(b.query.getByRole('button', { name: en.mkdir }))
  await vi.waitFor(() => { expect(document.querySelector('[data-storage-selection]')?.textContent).toBe('Created') })
  const requests = calls.filter(call => call.key === 'storageDirectoryCreate').map(call => call.request)
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual(requests[1])
}, 30_000)

it('retains a lost recovery request across closure and checks its status with the same identity', async () => {
  let restore: WorkspaceBindingRestoreRequest
  const calls = server(async call => {
    if (call.key === 'workspaceBindingRestore') { restore = workspaceBindingRestoreRequest.parse(call.request); throw new Error('connection lost') }
    if (call.key === 'workspaceBindingStatus') return Response.json(receipt(restore!, 'blocked'))
    return undefined
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.recovery }))
  await b.query.findByRole('button', { name: 'Existing' })
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await b.query.findByRole('alert')
  fireEvent.click(b.query.getAllByRole('button', { name: en.cancel, exact: true }).at(-1)!)
  await b.open()
  fireEvent.click(b.query.getByRole('button', { name: en.checkStatus }))
  await b.query.findByText(en.blocked)
  expect(calls.find(call => call.key === 'workspaceBindingStatus')!.request).toEqual({ requestId: restore!.requestId })
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await vi.waitFor(() => { expect(calls.filter(call => call.key === 'workspaceBindingRestore')).toHaveLength(2) })
  expect(calls.filter(call => call.key === 'workspaceBindingRestore')[0]!.request.requestId).not.toEqual(calls.filter(call => call.key === 'workspaceBindingRestore')[1]!.request.requestId)
}, 30_000)

it('rejects overlap and mismatched recovery receipts without claiming a completed binding', async () => {
  let attempt = 0
  const calls = server(async call => {
    if (call.key === 'workspaceBindingRestore') {
      attempt++
      if (attempt === 1) return Response.json({ error: 'workspace_storage_overlap' }, { status: 409 })
      return Response.json({ ...receipt(workspaceBindingRestoreRequest.parse(call.request), 'completed'), workspaceId: OTHER })
    }
    return undefined
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.recovery }))
  await b.query.findByRole('button', { name: 'Existing' })
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await b.query.findByText(en.overlap)
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await b.query.findByText(en.failed)
  expect(b.query.queryByText(en.completed)).toBeNull()
  expect(calls.filter(call => call.key === 'workspaceBindingRestore')).toHaveLength(2)
  expect(b.workspaces.list.getSnapshot().items[0]).toEqual(original)
}, 30_000)

it('aborts superseded browsing and unloaded requests and ignores a late directory page', async () => {
  const delayed = Promise.withResolvers<Response>()
  const calls = server(async call => call.key === 'storageDirectories' && call.request.parentPath === '' ? delayed.promise : undefined)
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.existingDirectory }))
  await vi.waitFor(() => { expect(calls.some(call => call.key === 'storageDirectories')).toBe(true) })
  fireEvent.click(b.query.getByRole('tab', { name: en.newDirectory }))
  const request = calls.find(call => call.key === 'storageDirectories')!
  expect(request.signal.aborted).toBe(true)
  await act(async () => { delayed.resolve(Response.json({ spaceId: SPACE, parentPath: '', entries: [{ name: 'Late', path: 'Late' }] })) })
  expect(b.query.queryByRole('button', { name: 'Late' })).toBeNull()
  const waiting = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn(async () => waiting.promise))
  fireEvent.click(b.query.getByRole('tab', { name: en.existingDirectory }))
  await act(async () => { await b.client.dispose() })
  await act(async () => { waiting.resolve(Response.json({ spaceId: SPACE, parentPath: '', entries: [] })) })
  expect(b.query.queryByRole('dialog')).toBeNull()
}, 30_000)

it('starts a fresh creation intent after confirmed success even when the name and target are unchanged', async () => {
  server()
  const b = await boot()
  for (let index = 0; index < 2; index++) {
    await b.open()
    fireEvent.change(b.query.getByRole('textbox', { name: en.name }), { target: { value: 'Same title' } })
    fireEvent.click(b.query.getByRole('button', { name: en.create }))
    await vi.waitFor(() => { expect(b.picked).toHaveBeenCalledTimes(index + 1) })
    await b.client.flush()
  }
  const requests = b.workspaces.calls.filter(call => call.method === 'create').map(call => decode((call.args[0] as { path: string }).path))
  expect(requests).toHaveLength(2)
  expect(requests[0]!.title).toEqual(requests[1]!.title)
  expect(requests[0]!.requestId).not.toEqual(requests[1]!.requestId)
}, 30_000)

it('resumes a persisted request after page reload and permits a new target only after confirmed blocked', async () => {
  const prior = workspaceBindingRestoreRequest.parse({ requestId: OTHER, workspaceId: WORKSPACE,
    expectedGeneration: 4, spaceId: SPACE, rootRelativePath: 'OldTarget' })
  const calls = server(async call => {
    if (call.key === 'workspaceBindingsMissing') return Response.json({ items: [{ ...missing.items[0], state: 'recovering', recoveryRequestId: prior.requestId }] })
    if (call.key === 'workspaceBindingStatus') return Response.json(receipt(prior, 'blocked'))
    if (call.key === 'workspaceBindingRestore') return Response.json(receipt(workspaceBindingRestoreRequest.parse(call.request), 'accepted'))
    return undefined
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.recovery }))
  await b.query.findByText(en.resumeRecovery)
  expect(b.query.getByRole('button', { name: en.restore }).hasAttribute('disabled')).toBe(true)
  expect(calls.some(call => call.key === 'workspaceBindingRestore')).toBe(false)
  fireEvent.click(b.query.getByRole('button', { name: en.checkStatus }))
  await b.query.findByText(en.blocked)
  fireEvent.click(await b.query.findByRole('button', { name: 'Existing' }))
  await vi.waitFor(() => { expect(b.query.getByRole('button', { name: en.restore }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await b.query.findByText(en.accepted)
  const next = calls.find(call => call.key === 'workspaceBindingRestore')!.request
  expect(next.requestId).not.toEqual(prior.requestId)
  expect(next).toMatchObject({ workspaceId: WORKSPACE, expectedGeneration: 4, rootRelativePath: 'Existing' })
  expect(b.query.getByRole('button', { name: en.restore }).hasAttribute('disabled')).toBe(true)
  expect(b.query.getByRole('combobox', { name: en.storage }).hasAttribute('disabled')).toBe(true)
}, 30_000)

it('keeps the same recovery request and target while its first receipt is uncertain', async () => {
  const calls = server(async call => {
    if (call.key === 'workspaceBindingRestore') throw new Error('lost response')
    return undefined
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.recovery }))
  await b.query.findByRole('button', { name: 'Existing' })
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await b.query.findByRole('alert')
  expect(b.query.getByRole('combobox', { name: en.storage }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(b.query.getByRole('button', { name: en.restore }))
  await vi.waitFor(() => { expect(calls.filter(call => call.key === 'workspaceBindingRestore')).toHaveLength(2) })
  const requests = calls.filter(call => call.key === 'workspaceBindingRestore').map(call => call.request)
  expect(requests[0]).toEqual(requests[1])
}, 30_000)

it('shares an uncertain creation identity across the native hero and sidebar entries', async () => {
  server()
  const b = await boot()
  b.workspaces.stub('create', async () => { throw new Error('uncertain creation') })
  await b.open()
  fireEvent.change(b.query.getByRole('textbox', { name: en.name }), { target: { value: 'Shared draft' } })
  fireEvent.click(b.query.getByRole('button', { name: en.create }))
  await b.query.findByText('uncertain creation')
  await b.sidebar()
  await b.open()
  expect(b.query.getByRole('textbox', { name: en.name }).getAttribute('value')).toBe('Shared draft')
  fireEvent.click(b.query.getByRole('button', { name: en.create }))
  await vi.waitFor(() => { expect(b.workspaces.calls.filter(call => call.method === 'create')).toHaveLength(2) })
  const requests = b.workspaces.calls.filter(call => call.method === 'create').map(call => decode((call.args[0] as { path: string }).path))
  expect(requests[0]).toEqual(requests[1])
}, 30_000)

it('reloads the product through the native Loader and prevents the old directory reply from reaching its replacement', async () => {
  const delayed = Promise.withResolvers<Response>()
  let pages = 0
  const calls = server(async call => {
    if (call.key !== 'storageDirectories') return undefined
    if (++pages === 1) return delayed.promise
    return Response.json({ spaceId: SPACE, parentPath: '', entries: [{ name: 'Current', path: 'Current' }] })
  })
  const b = await boot()
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.existingDirectory }))
  await vi.waitFor(() => { expect(pages).toBe(1) })
  await act(async () => { await b.client.reload(PRODUCT) })
  expect(calls.find(call => call.key === 'storageDirectories')!.signal.aborted).toBe(true)
  await b.open()
  fireEvent.click(b.query.getByRole('tab', { name: en.existingDirectory }))
  await b.query.findByRole('button', { name: 'Current' })
  await act(async () => { delayed.resolve(Response.json({ spaceId: SPACE, parentPath: '', entries: [{ name: 'Late', path: 'Late' }] })) })
  expect(b.query.queryByRole('button', { name: 'Late' })).toBeNull()
  expect(b.query.getByRole('button', { name: 'Current' })).toBeTruthy()
}, 30_000)
