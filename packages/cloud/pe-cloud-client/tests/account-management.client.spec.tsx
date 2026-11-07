// @vitest-environment jsdom
/** Real prepared page/transport/native settings registration; the external HTTP replies are scripted. */
import { Context } from '@deepseek-ai/cordis'
import type { PropsRenderSlots, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { installCloudAccountManagement, type AccountFace } from '../src/client/account-management.tsx'
import { createSlotRenderer } from '../../../client/ui-renderer/src/client/scoped-slots.tsx'

afterEach(cleanup)

class Socket implements ConnectionWebSocket {
  readyState = 1
  send(): void {}
  close(): void { this.readyState = 3 }
  addEventListener: ConnectionWebSocket['addEventListener'] = () => {}
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
function isAccountFace(value: unknown): value is AccountFace {
  if (value === null || typeof value !== 'object' || typeof Reflect.get(value, 'submit') !== 'function') return false
  const hooks: unknown = Reflect.get(value, 'hooks')
  if (hooks === null || typeof hooks !== 'object') return false
  const store: unknown = Reflect.get(hooks, 'accountManagement')
  return store !== null && typeof store === 'object' && typeof Reflect.get(store, 'getSnapshot') === 'function'
    && typeof Reflect.get(store, 'subscribe') === 'function'
}
async function fixture(role: 'admin' | 'user', respond?: (body: object) => Response | Promise<Response>) {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: 'actor', displayName: 'Actor', role }, recipeVersion: 'accounts', connectionGeneration: 'original',
    capabilities: { accountAdministration: role === 'admin' ? { state: 'available' } : disabled,
      projects: { state: 'available' }, filePreview: disabled, shell: disabled, developmentServices: disabled, servicePreview: disabled,
      sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'accounts', plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] } } }
  const requests: Array<{ target: string; headers: Headers; body: object }> = []
  const preparation = PreparedCloudPage.prepare({ baseUrl: 'https://example.test/app/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 4, maxSockets: 2, closeTimeoutMs: 1000 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 64, maxValueBytes: 256, maxTotalBytes: 4096, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, createWebSocket: () => new Socket(),
    fetch: async (target, init) => {
      if (String(target).endsWith('/cloud/bootstrap')) return Response.json(bootstrap)
      const body: object = JSON.parse(String(init.body))
      requests.push({ target: String(target), headers: new Headers(init.headers), body })
      if (respond !== undefined) return respond(body)
      if (Reflect.get(body, 'op') === 'list') return Response.json({ accounts: [{ id: 'target', email: 'user@example.test',
        displayName: 'Ordinary', role: 'user', enabled: false, resourceState: 'failed' }], total: 1, offset: 0, limit: 10,
      templates: [{ id: 'standard', available: 1 }] })
      return Response.json({ id: 'target', resourceState: 'ready' })
    },
  }, new AbortController().signal)
  const page = await preparation.ready, ctx = new Context()
  onTestFinished(() => preparation.dispose())
  ctx.provide('clientPersistence', page.nativeOptions.persistence)
  const slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx)
  locale.setLocale('en'); ctx.provide('locale', locale); slots.installLocale(locale)
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } },
    ({ renderSlot }: PropsRenderSlots<'settings.section'>) => renderSlot('settings.section', { close() {} }))
  await page.start({ run: async () => {
    page.nativeOptions.prepareContext(ctx)
    await ctx.plugin((owner) => { page.activate(owner); installCloudAccountManagement(owner, page) }).await()
  }, dispose: () => ctx.fiber.dispose() })
  return { page, slots, requests }
}
it('keeps the account menu and management HTTP absent for ordinary users', async () => {
  const f = await fixture('user')
  expect(f.slots.entries('settings.section').some(row => row.options.id === 'cloud-account-management')).toBe(false)
  expect(f.requests).toHaveLength(0)
})

it('reads back a rejected disable after sign-in was already blocked and removes stale rows if that read is unavailable', async () => {
  let disabled = false, unavailable = false
  const f = await fixture('admin', (body) => {
    if (Reflect.get(body, 'op') === 'enabled') {
      disabled = true
      return Response.json({ error: { code: 'cloud/account-stop-unconfirmed' } }, { status: 503 })
    }
    if (unavailable) return Response.json({ error: { code: 'cloud/account-unavailable' } }, { status: 503 })
    return Response.json({ accounts: [{ id: 'target', email: 'user@example.test', displayName: 'Ordinary', role: 'user',
      enabled: !disabled, resourceState: disabled ? 'stop-unknown' : 'ready' }], total: 1, offset: 0, limit: 10,
    templates: [{ id: 'standard', available: 1 }] })
  })
  const entry = f.slots.entries('settings.section').find(row => row.options.id === 'cloud-account-management')
  const face: unknown = entry?.inject?.()
  if (!isAccountFace(face)) throw new Error('Account settings injection differs from the registered face')
  await vi.waitFor(() => { expect(face.hooks.accountManagement.getSnapshot().rows[0]?.enabled).toBe(true) })
  face.submit({ op: 'enabled', id: 'target', enabled: false })
  await vi.waitFor(() => {
    const state = face.hooks.accountManagement.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.pending).toBe(false)
    expect(state.rows[0]).toMatchObject({ enabled: false, resourceState: 'stop-unknown' })
  })
  expect(f.requests.map(row => Reflect.get(row.body, 'op'))).toEqual(['list', 'enabled', 'list'])
  unavailable = true
  face.submit({ op: 'enabled', id: 'target', enabled: false })
  await vi.waitFor(() => {
    const state = face.hooks.accountManagement.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.pending).toBe(false)
    expect(state.rows).toEqual([])
    expect(state.templates).toEqual([])
    expect(state.total).toBe(0)
    expect(state.listingRevision).toBe(2)
  })
  expect(f.requests.map(row => Reflect.get(row.body, 'op'))).toEqual(['list', 'enabled', 'list', 'enabled', 'list'])
})
it('loads on opening the admin settings entry and preserves the captured actor/transport for target operations', async () => {
  const f = await fixture('admin')
  expect(f.requests).toHaveLength(0)
  const entry = f.slots.entries('settings.section').find(row => row.options.id === 'cloud-account-management')
  if (entry?.inject === undefined) throw new Error('Account settings menu absent')
  const face: unknown = entry.inject()
  if (!isAccountFace(face)) throw new Error('Account settings injection differs from the registered face')
  await vi.waitFor(() => { expect(face.hooks.accountManagement.getSnapshot().rows).toHaveLength(1) })
  expect(f.requests[0]?.target).toBe('https://example.test/app/cloud/admin/accounts')
  expect(f.requests[0]?.headers.get('x-account')).toBe('actor')
  expect(f.requests[0]?.headers.get('x-generation')).toBe('original')
  face.submit({ op: 'rename', id: 'target', displayName: 'Changed' })
  await vi.waitFor(() => { expect(f.requests).toHaveLength(3) })
  expect(f.requests[1]?.body).toEqual({ op: 'rename', id: 'target', displayName: 'Changed' })
  await f.page.dispose()
  expect(f.slots.entries('settings.section').some(row => row.options.id === 'cloud-account-management')).toBe(false)
  expect(() => face.submit({ op: 'list', search: '', offset: 0 })).toThrow()
})

function authoritativeAccounts(): Response {
  return Response.json({ accounts: [{ id: 'target', email: 'user@example.test', displayName: 'Ordinary',
    role: 'admin', enabled: true, resourceState: 'ready' }], total: 1, offset: 0, limit: 10,
  templates: [{ id: 'standard', available: 1 }] })
}
function accountArticle(): HTMLElement {
  const article = screen.getByRole('heading', { name: 'user@example.test' }).closest('article')
  if (article === null) throw new Error('Native account article absent')
  return article
}
async function renderedAccount(respond: (body: object) => Response | Promise<Response>) {
  const f = await fixture('admin', respond)
  const absent = createSnapshotStore<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: { sessionId: undefined } })
  f.slots.installScope('session', { current: absent, bindingSource: () => absent })
  f.slots.install(createSlotRenderer())
  const tree = () => <>{f.slots.renderSlot('root', {})}</>, view = render(tree())
  await screen.findByRole('heading', { name: 'user@example.test' })
  return { ...f, view, tree }
}

it.each(['role', 'rename'] as const)('restores same-value authoritative controls after refused %s without replaying it', async (op) => {
  const mutation = Promise.withResolvers<Response>(), refresh = Promise.withResolvers<Response>()
  let lists = 0
  try {
    const f = await renderedAccount(async body => Reflect.get(body, 'op') === 'list'
      ? ++lists === 1 ? authoritativeAccounts() : refresh.promise : mutation.promise)
    const original = accountArticle()
    const control = op === 'role'
      ? within(original).getByRole<HTMLSelectElement>('combobox', { name: 'Role' })
      : within(original).getByRole<HTMLInputElement>('textbox', { name: 'Display name' })
    const changed = op === 'role' ? 'user' : 'Rejected name', previous = op === 'role' ? 'admin' : 'Ordinary'
    expect(control.value).toBe(previous)
    fireEvent.change(control, { target: { value: changed } })
    const form = control.closest('form')
    if (form === null) throw new Error('Original row form absent')
    fireEvent.submit(form)
    await vi.waitFor(() => { expect(f.requests).toHaveLength(2) })
    f.view.rerender(f.tree())
    expect(accountArticle()).toBe(original)
    expect(control.value).toBe(changed)
    await act(async () => { mutation.resolve(Response.json({ code: 'cloud/last-administrator' }, { status: 409 })) })
    await vi.waitFor(() => { expect(f.requests).toHaveLength(3) })
    expect(accountArticle()).toBe(original)
    expect(control.value).toBe(changed)
    await act(async () => { refresh.resolve(authoritativeAccounts()) })
    await vi.waitFor(() => {
      const authoritative = accountArticle()
      expect(op === 'role' ? within(authoritative).getByRole<HTMLSelectElement>('combobox', { name: 'Role' }).value
        : within(authoritative).getByRole<HTMLInputElement>('textbox', { name: 'Display name' }).value).toBe(previous)
      expect(authoritative).not.toBe(original)
    })
    expect(screen.getByRole('alert').textContent).toContain('refused')
    expect(f.requests.map(row => Reflect.get(row.body, 'op'))).toEqual(['list', op, 'list'])
  } finally {
    mutation.resolve(Response.json({}, { status: 409 }))
    refresh.resolve(authoritativeAccounts())
  }
})

it('resets unsaved row forms only after a complete explicit listing refresh', async () => {
  const refresh = Promise.withResolvers<Response>()
  let lists = 0
  try {
    const f = await renderedAccount(async () => ++lists === 1 ? authoritativeAccounts() : refresh.promise)
    const original = accountArticle(), role = within(original).getByRole<HTMLSelectElement>('combobox', { name: 'Role' })
    const name = within(original).getByRole<HTMLInputElement>('textbox', { name: 'Display name' })
    fireEvent.change(role, { target: { value: 'user' } })
    fireEvent.change(name, { target: { value: 'Unsaved' } })
    f.view.rerender(f.tree())
    expect(role.value).toBe('user'); expect(name.value).toBe('Unsaved')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await vi.waitFor(() => { expect(f.requests).toHaveLength(2) })
    expect(accountArticle()).toBe(original)
    expect(role.value).toBe('user'); expect(name.value).toBe('Unsaved')
    await act(async () => { refresh.resolve(authoritativeAccounts()) })
    await vi.waitFor(() => {
      expect(within(accountArticle()).getByRole<HTMLSelectElement>('combobox', { name: 'Role' }).value).toBe('admin')
      expect(within(accountArticle()).getByRole<HTMLInputElement>('textbox', { name: 'Display name' }).value).toBe('Ordinary')
    })
    expect(f.requests.map(row => Reflect.get(row.body, 'op'))).toEqual(['list', 'list'])
  } finally { refresh.resolve(authoritativeAccounts()) }
})

it('removes stale rows when mutation and refresh both fail, then restores authority after a valid manual read', async () => {
  const refresh = Promise.withResolvers<Response>()
  let lists = 0
  try {
    const f = await renderedAccount(async (body) => {
      if (Reflect.get(body, 'op') !== 'list') return Response.json({ code: 'cloud/last-administrator' }, { status: 409 })
      return ++lists === 2 ? refresh.promise : authoritativeAccounts()
    })
    const original = accountArticle(), role = within(original).getByRole<HTMLSelectElement>('combobox', { name: 'Role' })
    fireEvent.change(role, { target: { value: 'user' } })
    const form = role.closest('form')
    if (form === null) throw new Error('Original role form absent')
    fireEvent.submit(form)
    await vi.waitFor(() => { expect(f.requests).toHaveLength(3) })
    await act(async () => { refresh.resolve(Response.json({}, { status: 503 })) })
    await screen.findByRole('alert')
    expect(screen.queryByRole('heading', { name: 'user@example.test' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(original.isConnected).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await vi.waitFor(() => {
      expect(within(accountArticle()).getByRole<HTMLSelectElement>('combobox', { name: 'Role' }).value).toBe('admin')
    })
    expect(f.requests.map(row => Reflect.get(row.body, 'op'))).toEqual(['list', 'role', 'list', 'list'])
  } finally { refresh.resolve(authoritativeAccounts()) }
})
