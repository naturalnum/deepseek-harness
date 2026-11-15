// @vitest-environment jsdom
/** Original Native tree/Factory/Session composition; only account I/O is scripted. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRenderFactories, PropsRenderSlots, ScopedStandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSlotRenderer } from '../../../client/ui-renderer/src/client/scoped-slots.tsx'
import { FileTree, type TreeEntry } from '../../../client/ui-sidebar-files/src/client/FileTree.tsx'
import { WorkspaceFileEntryAccessory } from '../../../client/ui-sidebar-files/src/client/FileNavigator.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from '../../../client/ui-sidebar-files/src/client/locales.ts'
import { installWorkspaceFileActions } from '../src/client/workspace-file-actions.tsx'
import { WORKSPACE_FILES_NAMESPACE, workspaceFileDictionaries } from '../src/client/workspace-file-locales.ts'
import type { WorkspaceFileManagement } from '../src/client/workspace-management-types.ts'

afterEach(cleanup)
const ROOT = '/account/project', SESSION = 'files-one' as SessionId
const entries: TreeEntry[] = [
  { path: `${ROOT}/one.py`, name: 'one.py', meta: { kind: 'file' } },
  { path: `${ROOT}/two.csv`, name: 'two.csv', meta: { kind: 'file' } },
  { path: `${ROOT}/src`, name: 'src', meta: { kind: 'directory' } },
]
interface HostFace {
  readonly hooks: { page: SnapshotStore<{ root: string; entries: TreeEntry[] }> }
  readonly refresh: () => void
  readonly open: (entry: TreeEntry) => void
}
function WorkspaceHost({ usePage, refresh, open, renderSlot, renderFactorySlot }:
  InjectFace<HostFace> & PropsRenderSlots<'sidebar.right.tab.files.actions'> & PropsRenderFactories) {
  const page = usePage(value => value)
  return <>{renderSlot('sidebar.right.tab.files.actions', { absolutePath: page.root, refresh })}
    {renderFactorySlot('sidebar.files.tree', { root: page.root, entries: page.entries, expanded: [], onToggle() {}, onOpen: open },
      { slots: { accessory: WorkspaceFileEntryAccessory } })}</>
}
async function fixture(install = true) {
  const ctx = new Context(), lifetime = new AbortController(), slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale); slots.installLocale(locale); slots.install(createSlotRenderer())
  for (const id of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) ctx.effect(() => locale.addLanguage({ id, label: id, fallback: 'en' }))
  locale.setLocale('en')
  ctx.effect(() => locale.register('sidebarFiles', { en, zh, ja, es, fr, de, ru, pt }))
  const sessionContexts = new Map<SessionId, Context>()
  const binding = (id: SessionId): ScopedStandardSourceBinding => {
    let scope = sessionContexts.get(id)
    if (scope === undefined) { scope = new Context(); sessionContexts.set(id, scope) }
    return { key: id, ctx: scope, hooks: {}, keyedHooks: {}, props: { sessionId: id } }
  }
  const current = createSnapshotStore(binding(SESSION))
  slots.installScope('session', { current, bindingSource: () => current, renderArea: (_binding, { children }) => <>{children}</> })
  const page = createSnapshotStore({ root: ROOT, entries }), refresh = vi.fn(), open = vi.fn()
  const release = vi.fn(async (_id: SessionId) => {})
  ctx.on('sidebar-files/release-directory', release)
  const upload = vi.fn<WorkspaceFileManagement['upload']>(async () => {})
  const download = vi.fn<WorkspaceFileManagement['download']>(async () => {})
  const createDirectory = vi.fn<WorkspaceFileManagement['createDirectory']>(async (_id, path, name) => `${path}/${name}`)
  ctx.provide('workspaceFileManagement', { upload, download, createDirectory })
  const removeTree = slots.registerFactory({ name: 'sidebar.files.tree', scope: 'root', locale: 'sidebarFiles',
    slots: { accessory: { scope: 'root' } } }, FileTree)
  const removeRoot = slots.register({ name: 'root', children: { 'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' } },
    inject: () => ({ hooks: { page }, refresh, open }) }, WorkspaceHost)
  const owners: Array<() => Promise<void>> = []
  const mount = () => {
    const fiber = ctx.plugin((scope) => { installWorkspaceFileActions(scope, lifetime.signal) })
    owners.push(() => fiber.dispose())
    return fiber
  }
  const owner = install ? mount() : undefined
  if (owner !== undefined) await owner.await()
  const view = render(slots.renderSlot('root', {}))
  onTestFinished(async () => {
    cleanup(); lifetime.abort()
    for (const dispose of [...owners].reverse()) await dispose()
    removeRoot(); removeTree()
    for (const scope of sessionContexts.values()) await scope.fiber.dispose()
    await ctx.fiber.dispose()
  })
  return { ctx, slots, locale, lifetime, page, current, binding, refresh, open, release, upload, download,
    createDirectory, owner, mount, view }
}

it('keeps Native empty by default, localizes the addon, and forgets rows that leave the current page', async () => {
  const f = await fixture(false)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'one.py' }))
  expect(f.open).toHaveBeenCalledExactlyOnceWith(entries[0])
  const owner = f.mount(); onTestFinished(() => owner.dispose())
  await act(async () => { await owner.await() })
  await screen.findByRole('checkbox', { name: 'Select one.py' })
  for (const [id, copy] of Object.entries(workspaceFileDictionaries)) {
    act(() => { f.locale.setLocale(id) })
    expect(screen.getByRole('button', { name: copy.upload })).toBeTruthy()
  }
  act(() => { f.locale.setLocale('en') })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select one.py' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select two.csv' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
  expect(f.download).toHaveBeenCalledWith(SESSION, [`${ROOT}/one.py`, `${ROOT}/two.csv`], expect.any(AbortSignal))
  act(() => { f.page.set({ root: ROOT, entries: [entries[2]!] }) })
  expect(screen.getByRole('button', { name: 'Download' })).toHaveProperty('disabled', true)
  await act(async () => { await owner.dispose() })
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(f.locale.bind(WORKSPACE_FILES_NAMESPACE)('upload')).toBe('upload')
})

it('joins directory closure before uploading into the selected directory and refreshes after confirmed folder creation', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  f.release.mockImplementationOnce(async () => { await gate.promise })
  fireEvent.click(screen.getByRole('radio', { name: 'Select src' }))
  const file = new File(['print(1)'], 'demo.py')
  const input = f.view.container.querySelector<HTMLInputElement>('input[type=file]:not([webkitdirectory])')!
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
  expect(f.upload).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledWith(SESSION)
  await act(async () => { gate.resolve(undefined); await gate.promise })
  expect(f.upload).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, [{ file, path: 'demo.py' }], expect.any(AbortSignal), expect.any(Function))
  expect(f.refresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
  const dialog = screen.getByRole('dialog', { name: 'New folder' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'New folder' }), { target: { value: 'reports' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'New folder' })) })
  expect(f.createDirectory).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, 'reports', expect.any(AbortSignal))
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeNull()
})

it('blocks file effects on unknown closure and keeps upload menu Escape and outside dismissal native', async () => {
  const f = await fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Upload options' }))
  expect(screen.getByRole('menuitem', { name: 'Upload folder' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Upload folder' }), { key: 'Escape' })
  expect(screen.queryByRole('menuitem', { name: 'Upload folder' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Upload options' }))
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menuitem', { name: 'Upload folder' })).toBeNull()
  f.release.mockRejectedValueOnce(new Error('Host close is unconfirmed'))
  const input = f.view.container.querySelector<HTMLInputElement>('input[type=file]:not([webkitdirectory])')!
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'x.txt')] } }) })
  expect(f.upload).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toBe(workspaceFileDictionaries.en.directoryCloseFailed)
  expect(screen.getByRole('button', { name: 'Upload' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'New folder' })).toHaveProperty('disabled', true)
})

it('keeps selection and pending operations on the original Session and withdraws with the account', async () => {
  const f = await fixture(), held = Promise.withResolvers<undefined>()
  onTestFinished(() => { held.resolve(undefined) })
  f.upload.mockImplementationOnce(async () => { await held.promise })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select one.py' }))
  const input = f.view.container.querySelector<HTMLInputElement>('input[type=file]:not([webkitdirectory])')!
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'x.txt')] } }) })
  const signal = f.upload.mock.calls[0]![3]
  expect(f.upload.mock.calls[0]![0]).toBe(SESSION)
  act(() => { f.current.set(f.binding('files-two' as SessionId)) })
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole('checkbox', { name: 'Select one.py' })).toHaveProperty('checked', false)
  expect(screen.getByRole('button', { name: 'Download' })).toHaveProperty('disabled', true)
  await act(async () => { held.resolve(undefined); await held.promise })
  act(() => { f.lifetime.abort() })
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(f.slots.entries('sidebar.right.tab.files.actions')).toHaveLength(0)
  expect(f.locale.bind(WORKSPACE_FILES_NAMESPACE)('upload')).toBe('upload')
})
