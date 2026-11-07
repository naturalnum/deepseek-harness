// @vitest-environment jsdom
/** Real prepared page/transport/native settings registration; the external HTTP replies are scripted. */
import { Context } from '@deepseek-ai/cordis'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { installCloudAccountManagement, type AccountFace } from '../src/client/account-management.tsx'

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
async function fixture(role: 'admin' | 'user') {
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
  locale.setLocale('en'); ctx.provide('locale', locale)
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
