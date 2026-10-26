// @vitest-environment jsdom
/** Real Cordis page/Connection, main/sidebar/overlay registration and synchronous withdrawal; no backend publication. */
import type { ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { installCloudSkillSettings } from '../src/client/skill-settings.ts'
import { installCloudManagement } from '../src/client/management/register.tsx'
import { CLOUD_MANAGEMENT_NAMESPACE } from '../src/client/management/locales.ts'
import { SKILLS_MANAGEMENT_NAMESPACE } from '../src/client/management/skills/locales.ts'
import type { SkillsPageInjected } from '../src/client/management/skills/types.ts'
import type { ManagementActionToastInjected } from '../src/client/management/ManagementActionToast.tsx'

function TestHost({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist' | 'shell.overlay' | 'settings.section'>): ReactNode {
  return [renderSlot('main', {}, { entryKey: 'power-evolve-skills' }),
    renderSlot('sidebar.panellist', { size: 16, active: false }), renderSlot('shell.overlay', {}),
    renderSlot('settings.section', { close: () => {} })]
}
class Socket implements ConnectionWebSocket {
  readyState = 1
  private readonly listeners = new Set<() => void>()
  send(): void {}
  close(): void { this.readyState = 3; for (const listener of this.listeners) listener(); this.listeners.clear() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.add(() => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
async function fixture(manage: boolean, configured: boolean) {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: 'A', displayName: 'A' }, recipeVersion: 'sample-ui', connectionGeneration: 'G',
    capabilities: { projects: { state: 'available' }, filePreview: disabled, shell: disabled, developmentServices: disabled,
      servicePreview: disabled, sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'sample', plugins: [], skills: { manage }, credentials: { write: false }, fields: [] } } }
  const prepared = PreparedCloudPage.prepare({ baseUrl: 'https://example.test/app/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000,
      ...configured ? { skillSettings: { requestTimeoutMs: 1000, maxFileBytes: 4096 } } : {} },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 64, maxValueBytes: 256, maxTotalBytes: 4096, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => Response.json(bootstrap), createWebSocket: () => new Socket(),
  }, new AbortController().signal)
  const page = await prepared.ready, ctx = new Context()
  const failed: Promise<unknown>[] = []
  ctx.on('internal/status', (fiber) => { if (fiber.state === FiberState.FAILED) failed.push(fiber.await().catch((error: unknown) => error)) })
  onTestFinished(async () => { await prepared.dispose() })
  ctx.provide('clientPersistence', page.nativeOptions.persistence)
  const slots = new SlotRegistry(ctx), locale = new LocaleRuntime(ctx); locale.setLocale('en'); ctx.provide('locale', locale)
  const declare = () => slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' },
  } }, TestHost)
  const withdrawDeclaration = declare()
  const unused = vi.fn(async (): Promise<never> => { throw new Error('No current or publish belongs to slot registration') })
  new TestRemote(ctx, { cloudSkills: { current: unused, publish: unused, installed: unused, details: unused,
    install: unused, update: unused, uninstall: unused, download: unused } })
  let owner: Context | undefined, management: ReturnType<Context['plugin']> | undefined
  const installManagement = async (): Promise<void> => {
    if (owner === undefined) throw new Error('No original activation')
    management = owner.plugin((scope) => { installCloudManagement(scope, page) })
    await management.await()
  }
  const gate = Promise.withResolvers<undefined>()
  let holdCleanup = false
  const entry = {
    run: async () => {
      page.nativeOptions.prepareContext(ctx)
      const fiber = ctx.plugin((scope) => { owner = scope; page.activate(scope); installCloudSkillSettings(scope, page) })
      await fiber.await()
      await installManagement()
    },
    dispose: async () => { if (holdCleanup) await gate.promise; await ctx.fiber.dispose() },
  }
  await page.start(entry)
  expect(page.bootstrap.capabilities.configuration.skills.manage).toBe(manage)
  expect(page.skillSettings !== undefined).toBe(configured)
  expect(ctx.get('slots')).toBeDefined()
  expect(ctx.get('locale')).toBeDefined()
  expect(ctx.get('remote.cloudSkills')).toBeDefined()
  await Promise.resolve()
  if (manage && configured) {
    for (const error of await Promise.all(failed)) throw error
  }
  return { page, slots, locale, unused, declare, withdrawDeclaration, installManagement,
    management: () => { if (management === undefined) throw new Error('No management owner'); return management }, owner: () => { if (owner === undefined) throw new Error('No activation'); return owner },
    hold: () => { holdCleanup = true }, release: () => { gate.resolve(undefined) } }
}
it.each([[false, true], [true, false]] as const)('leaves management closed for manage=%s configured=%s', async (manage, configured) => {
  const f = await fixture(manage, configured)
  expect(f.slots.entries('settings.section')).toEqual([])
  expect(f.slots.entries('main')).toEqual([])
  expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.unused).not.toHaveBeenCalled()
})
it('keeps the real adapter, registers one main/sidebar and withdraws copy and overlay before held page cleanup', async () => {
  const f = await fixture(true, true)
  expect(f.slots.entries('settings.section')).toEqual([])
  expect(f.slots.entries('main')).toHaveLength(1)
  expect(f.slots.entries('main')[0]?.options.key).toBe('power-evolve-skills')
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(1)
  expect(f.slots.entries('sidebar.panellist')[0]?.options.id).toBe('power-evolve-skills')
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('skills')).toBe('Skills')
  expect(f.locale.bind(SKILLS_MANAGEMENT_NAMESPACE)('title')).toBe('Skills')
  f.locale.setLocale('zh')
  const label = f.slots.entries('sidebar.panellist')[0]?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('技能')
  expect(f.unused).not.toHaveBeenCalled()
  const source = f.page.skillVersionEditing, sample = source.getSnapshot().sample
  expect(sample?.phase).toBe('idle')
  const face = f.slots.entries('main')[0]?.inject?.() as Partial<SkillsPageInjected> | undefined
  expect(face?.hooks?.skillManagement).toBe(source)
  f.hold(); const closing = f.page.dispose()
  expect(f.slots.entries('main')).toEqual([])
  expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('skills')).toBe('skills')
  expect(f.locale.bind(SKILLS_MANAGEMENT_NAMESPACE)('title')).toBe('title')
  expect(f.page.skillVersionEditing).toBe(source)
  expect(source.getSnapshot().sample?.phase).toBe('unavailable')
  await expect(sample?.open(new AbortController().signal)).rejects.toThrow()
  expect(f.unused).not.toHaveBeenCalled()
  f.release(); await closing
})
it('rebinds declaration generations once and keeps final feedback with the overlay owner', async () => {
  const f = await fixture(true, true)
  const old = f.slots.entries('main')[0]?.inject?.() as Partial<SkillsPageInjected> | undefined
  const toast = f.slots.entries('shell.overlay')[0]?.inject?.() as Partial<ManagementActionToastInjected> | undefined
  if (old?.report === undefined || toast?.hooks === undefined) throw new Error('Missing original feedback binding')
  const notice = toast.hooks.managementNotice
  old.report('import', 'unavailable')
  expect(notice.getSnapshot()).toEqual({ sequence: 1, action: 'import', outcome: 'unavailable' })
  f.withdrawDeclaration()
  expect(f.slots.entries('main')).toEqual([])
  expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  old.report('refresh', 'confirmed')
  expect(notice.getSnapshot()).toEqual({ sequence: 2, action: 'refresh', outcome: 'confirmed' })
  f.declare()
  await vi.waitFor(() => { expect(f.slots.entries('main')).toHaveLength(1) })
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(1)
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  const next = f.slots.entries('main')[0]?.inject?.() as Partial<SkillsPageInjected> | undefined
  const nextToast = f.slots.entries('shell.overlay')[0]?.inject?.() as Partial<ManagementActionToastInjected> | undefined
  expect(next?.scope).not.toBe(old.scope)
  expect(next?.hooks?.skillManagement).toBe(f.page.skillVersionEditing)
  expect(nextToast?.hooks?.managementNotice).toBe(notice)
  toast.dismiss?.(1)
  expect(notice.getSnapshot()?.sequence).toBe(2)
  nextToast?.dismiss?.(2)
  expect(notice.getSnapshot()).toBeNull()
  expect(f.unused).not.toHaveBeenCalled()
})
it('withdraws the management owner synchronously and installs one replacement without another adapter', async () => {
  const f = await fixture(true, true), source = f.page.skillVersionEditing
  const old = f.slots.entries('main')[0]?.inject?.() as Partial<SkillsPageInjected> | undefined
  const toast = f.slots.entries('shell.overlay')[0]?.inject?.() as Partial<ManagementActionToastInjected> | undefined
  const notice = toast?.hooks?.managementNotice
  const feedback = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { feedback.mockRestore() })
  const closing = f.management().dispose()
  expect(f.slots.entries('main')).toEqual([])
  expect(f.slots.entries('sidebar.panellist')).toEqual([])
  expect(f.slots.entries('shell.overlay')).toEqual([])
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('skills')).toBe('skills')
  expect(f.locale.bind(SKILLS_MANAGEMENT_NAMESPACE)('title')).toBe('title')
  old?.report?.('refresh', 'unknown')
  expect(notice?.getSnapshot()).toBeNull()
  expect(feedback).toHaveBeenCalledExactlyOnceWith('Cloud management feedback unavailable.')
  await closing
  expect(f.page.skillVersionEditing).toBe(source)
  expect(source.getSnapshot().sample?.phase).toBe('idle')
  await f.installManagement()
  expect(f.slots.entries('main')).toHaveLength(1)
  expect(f.slots.entries('sidebar.panellist')).toHaveLength(1)
  expect(f.slots.entries('shell.overlay')).toHaveLength(1)
  expect(f.locale.bind(CLOUD_MANAGEMENT_NAMESPACE)('skills')).toBe('Skills')
  expect(f.unused).not.toHaveBeenCalled()
})

it('binds managed and legacy editing to one original page source and revokes both before cleanup', async () => {
  const f = await fixture(true, true), source = f.page.skillVersionEditing
  const original = source.getSnapshot(), managed = original.managed, sample = original.sample
  expect(managed?.phase).toBe('idle')
  expect(sample?.phase).toBe('idle')
  expect(managed?.scope).toContain('"A"')
  expect(sample?.scope).toBe(managed?.scope)
  expect(f.unused).not.toHaveBeenCalled()
  f.hold(); const closing = f.page.dispose()
  expect(f.page.skillVersionEditing).toBe(source)
  expect(source.getSnapshot().managed?.phase).toBe('unavailable')
  expect(source.getSnapshot().sample?.phase).toBe('unavailable')
  await expect(managed?.refresh(new AbortController().signal)).rejects.toThrow()
  await expect(sample?.open(new AbortController().signal)).rejects.toThrow()
  expect(f.unused).not.toHaveBeenCalled()
  f.release(); await closing
})
