// @vitest-environment jsdom
import { TEST_PLUGIN_ID, pluginFixture } from './plugin-fixtures.client.ts'
/** Actual PreparedCloudPage and dependency lifetimes; only bootstrap/Remote replies and sockets are scripted. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime/src/remote.ts'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { preparePagePluginEdit, readPagePluginState } from '../src/client/management/plugins/page-plugin-edit.ts'
import { type CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'
import type { AccountPluginId } from '../src/client/management/plugins/types.ts'


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

it('binds the original namespace, rejects another row and revokes edits on owner or page shutdown before held cleanup', async () => {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: 'test-account', displayName: 'Test account' },
    recipeVersion: 'test-recipe', connectionGeneration: 'test-generation', capabilities: {
      projects: { state: 'available' }, filePreview: disabled, shell: disabled, developmentServices: disabled,
      servicePreview: disabled, sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'test-catalog', plugins: [{ id: TEST_PLUGIN_ID, installable: false, toggleable: true }],
        skills: { manage: false }, credentials: { write: false }, fields: [] } } }
  const prepared = PreparedCloudPage.prepare({ baseUrl: 'https://example.test/app/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 64, maxValueBytes: 256, maxTotalBytes: 4096, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => Response.json(bootstrap), createWebSocket: () => new Socket(),
  }, new AbortController().signal)
  const page = await prepared.ready, ctx = new Context(), gate = Promise.withResolvers<undefined>()
  let hold = false
  onTestFinished(async () => { gate.resolve(undefined); await prepared.dispose() })
  const current = vi.fn<CloudPluginRemote['current']>(async () => ({ ok: true, value: pluginFixture('test-edit') }))
  const change = vi.fn<CloudPluginRemote['change']>(async (): Promise<never> => { throw new Error('No write belongs to revoked page test') })
  new TestRemote(ctx, { cloudPlugins: { current, change } satisfies CloudPluginRemote })
  ctx.provide('clientPersistence', page.nativeOptions.persistence)
  await page.start({
    run: async () => {
      page.nativeOptions.prepareContext(ctx)
      await ctx.plugin((scope) => { page.activate(scope) }).await()
    },
    dispose: async () => { if (hold) await gate.promise; await ctx.fiber.dispose() },
  })
  const mount = async () => {
    let captured: Context | undefined
    const fiber = ctx.plugin({ inject: ['remote', 'remote.cloudPlugins'], apply(scope: Context) { captured = scope } })
    await fiber.await()
    if (captured === undefined) throw new Error('Missing original dependency')
    return { fiber, owner: captured }
  }
  const first = await mount(), observer = new AbortController(), id = brandString<AccountPluginId>(TEST_PLUGIN_ID)
  await expect(preparePagePluginEdit(first.owner, page, brandString<AccountPluginId>('another-row'), observer.signal)).rejects.toThrow()
  expect(current).not.toHaveBeenCalled()
  const facts = await readPagePluginState(first.owner, page, id, observer.signal)
  expect(facts).not.toHaveProperty('version')
  const oldEdit = await preparePagePluginEdit(first.owner, page, id, observer.signal)
  await first.fiber.dispose()
  expect(await oldEdit.submit({ kind: 'enabled', enabled: true }, 'if-idle', observer.signal)).toEqual({ kind: 'unknown' })
  expect(change).not.toHaveBeenCalled()

  const replacement = await mount(), nextEdit = await preparePagePluginEdit(replacement.owner, page, id, observer.signal)
  hold = true
  const closing = page.dispose()
  expect(page.lifetime.transport.signal.aborted).toBe(true)
  expect(await nextEdit.submit({ kind: 'enabled', enabled: true }, 'if-idle', observer.signal)).toEqual({ kind: 'unknown' })
  await expect(preparePagePluginEdit(replacement.owner, page, id, observer.signal)).rejects.toThrow()
  expect(current).toHaveBeenCalledTimes(3); expect(change).not.toHaveBeenCalled()
  gate.resolve(undefined); await closing
})
