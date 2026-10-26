// @vitest-environment jsdom
/** Canonical preparation consumed by real Loader entries before native cache/Connection use. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { type ConnectionHandle, type ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as cloud from '../src/client/index.ts'
import { PreparedCloudPage, type CloudPagePreparationInput } from '../src/client/prepared-page.ts'
import type { PreparedCredentialEdit } from '@deepseek-ai/dsh-client-ui-settings-models/client'

const config = {
  bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192,
  maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000,
}
function bootstrap(accountId = 'A', connectionGeneration = 'G1'): CloudBootstrap {
  return {
    account: { id: accountId, displayName: accountId }, recipeVersion: 'recipe-1', connectionGeneration,
    capabilities: {
      projects: { state: 'available' }, filePreview: { state: 'disabled', reason: 'not-approved' },
      shell: { state: 'disabled', reason: 'not-approved' }, developmentServices: { state: 'disabled', reason: 'not-approved' },
      servicePreview: { state: 'disabled', reason: 'not-approved' }, sandboxScope: 'session',
      backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'catalog-1', plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] },
    },
  }
}
class Socket implements ConnectionWebSocket {
  readyState = 1
  send = vi.fn()
  private readonly listeners = new Set<() => void>()
  close(): void { this.readyState = 3; for (const listener of this.listeners) listener() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'close') this.listeners.add(() => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = () => {}
}
function fixture(response = bootstrap()) {
  const values = new Map<string, string>(), requests: Headers[] = [], sockets: string[] = []
  const uploads: { url: URL; init: RequestInit }[] = []
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) },
  }
  const fetcher = vi.fn<CloudPagePreparationInput['fetch']>(async (url, init) => {
    if (new URL(url).pathname.endsWith('/cloud/bootstrap')) return Response.json(response)
    requests.push(new Headers(init.headers))
    if (new URL(url).pathname.endsWith('/api/session/uploadFileBinary')) {
      if (!(init.body instanceof Blob)) throw new TypeError('Native upload fixture requires the original Blob')
      uploads.push({ url: new URL(url), init })
      return Response.json({ ok: true, value: {
        receiptId: `receipt-${response.account.id}-${response.connectionGeneration}`,
        file: { attachmentId: `file-${response.account.id}`, name: 'file.bin', bytes: init.body.size },
      } })
    }
    if (typeof init.body !== 'string') throw new TypeError('Native RPC fixture requires a JSON body')
    const body: unknown = JSON.parse(init.body)
    const rpcId = typeof body === 'object' && body !== null && 'rpcId' in body ? body.rpcId : undefined
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: 'accepted' } })
  })
  const input: CloudPagePreparationInput = {
    baseUrl: 'https://example.test/app/', config, storage, fetch: fetcher,
    createWebSocket: (url) => { sockets.push(url); return new Socket() },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 20, maxKeyBytes: 128, maxValueBytes: 1000, maxTotalBytes: 5000, maxNamespaceBytes: 200 },
  }
  return { input, values, storage, fetcher, requests, sockets, uploads }
}

/** The real Loader owns both modules; only immutable module arrival and a finite native consumer are fixtures. */
function native(page: PreparedCloudPage, options: { bind?: boolean; config?: cloud.Config } = {}) {
  const ctx = new Context(), events: string[] = []
  const consumer = {
    inject: ['connection'],
    async apply(scope: Context) {
      events.push('native')
      expect(scope.get('peCloudPage')).toBe(page)
      const source = createSnapshotStore('', { persist: { name: 'draft.same-session', storage: scope.get('clientPersistence') } })
      source.set(page.bootstrap.account.id)
      const connection = scope.get('connection') as ConnectionHandle
      expect(await connection.rpc.call('/api', 'session/prompt', { sessionId: 'same-session' })).toEqual({ ok: true, value: 'accepted' })
      connection.openWebSocket('/api/remote.mux')
    },
  }
  const entry = {
    async run() {
      ctx.provide('clientPersistence', page.nativeOptions.persistence)
      if (options.bind !== false) page.nativeOptions.prepareContext(ctx)
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { cloud, 'native-consumer': consumer })
      // A dependent row starts first; the service dependency owns activation order.
      await Promise.all([
        ctx.loader.create({ name: 'cordis:native-consumer' }),
        ctx.loader.create({ name: 'cordis:cloud', config: options.config ?? {} }),
      ])
      await ctx.loader.await()
      if ([...ctx.loader.entries()].some(row => row.fiber?.state !== FiberState.ACTIVE)) throw new Error('native Loader activation failed')
    },
    async dispose() {
      const fibers = ctx.get('loader') === undefined ? [] : [...ctx.loader.entries()].flatMap(row => row.fiber === undefined ? [] : [row.fiber])
      await Promise.all(fibers.reverse().map(fiber => fiber.dispose()))
      await ctx.fiber.dispose()
    },
  }
  return { ctx, entry, events }
}


it('publishes closed Models integration before activation and rejects an unconfigured capability', async () => {
  const f=fixture(), preparation=PreparedCloudPage.prepare(f.input,new AbortController().signal)
  onTestFinished(()=>preparation.dispose())
  const page=await preparation.ready
  expect(page.modelsSettingsIntegration.editing.getSnapshot()).toBeNull()
  expect(page.modelsSettingsIntegration.onboarding).toBe(false)
  const graph=native(page);await page.start(graph.entry)
  expect(graph.ctx.get('modelsSettingsIntegration')).toBe(page.modelsSettingsIntegration)
  expect(page.modelsSettingsIntegration.reads.isCurrent()).toBe(false)
  const unused=async ():Promise<never>=>{throw new Error('Unconfigured model callback must not be called')}
  expect(()=>page.attachModels(graph.ctx,{ metadata:unused,credentials:unused,prepare:unused })).toThrow()
})

it('revokes original prepared callbacks and source synchronously before native cleanup finishes', async () => {
  const f=fixture(), preparation=PreparedCloudPage.prepare({
    ...f.input,config:{ ...config,modelSettingsRequestTimeoutMs:1000 },
  },new AbortController().signal)
  const page=await preparation.ready, graph=native(page)
  await page.start(graph.entry)
  const saving=Promise.withResolvers<string|undefined>(), prepare=vi.fn(async()=>({ ref:'DEEPSEEK_API_KEY',store:vi.fn(()=>saving.promise),remove:vi.fn(async()=>undefined) }))
  const unused=async ():Promise<never>=>{throw new Error('No metadata read belongs to this public callback case')}
  const remove=page.attachModels(graph.ctx,{ metadata:unused,credentials:unused,prepare })
  const editing=page.modelsSettingsIntegration.editing.getSnapshot()
  if(editing===null)throw new Error('Original page did not publish its captured binding')
  const edit=await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  if(edit===null)throw new Error('Original intent did not prepare')
  const pending=edit.store('synthetic-only')
  const observed=Promise.allSettled([pending])
  const release=Promise.withResolvers<undefined>(), originalDispose=graph.entry.dispose.bind(graph.entry)
  graph.entry.dispose=async()=>{await release.promise;await originalDispose()}
  const closing=page.dispose()
  expect(page.modelsSettingsIntegration.editing.getSnapshot()).toBeNull()
  expect(page.modelsSettingsIntegration.onboarding).toBe(false)
  expect(editing.isCurrent()).toBe(false)
  expect(await editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)).toBeNull()
  await expect(edit.remove()).rejects.toMatchObject({ code:'closed' })
  saving.resolve(undefined)
  expect((await observed)[0]?.status).toBe('rejected')
  release.resolve(undefined);await closing;remove()
  expect(prepare).toHaveBeenCalledTimes(1)
})

it('withdraws the original dependency binding and never lets a late prepare publish an editor', async () => {
  const f=fixture(), preparation=PreparedCloudPage.prepare({
    ...f.input,config:{ ...config,modelSettingsRequestTimeoutMs:1000 },
  },new AbortController().signal)
  onTestFinished(()=>preparation.dispose())
  const page=await preparation.ready, graph=native(page);await page.start(graph.entry)
  const late=Promise.withResolvers<null>(), unused=async ():Promise<never>=>{throw new Error('unused')}
  const child=graph.ctx.plugin(()=>{});await child.await()
  let remove=()=>{}
  child.ctx.effect(()=>{remove=page.attachModels(child.ctx,{ metadata:unused,credentials:unused,prepare:()=>late.promise });return remove})
  const editing=page.modelsSettingsIntegration.editing.getSnapshot()
  if(editing===null)throw new Error('Missing original dependency binding')
  const pending=editing.prepare('DEEPSEEK_API_KEY',new AbortController().signal)
  await child.dispose()
  expect(page.modelsSettingsIntegration.editing.getSnapshot()).toBeNull()
  expect(page.modelsSettingsIntegration.onboarding).toBe(false)
  late.resolve(null);expect(await pending).toBeNull();expect(editing.isCurrent()).toBe(false)
  remove()
})

it('rechecks observer cancellation before and after prepare while the original page stays current', async () => {
  const f = fixture()
  const preparation = PreparedCloudPage.prepare({
    ...f.input, config: { ...config, modelSettingsRequestTimeoutMs: 1000 },
  }, new AbortController().signal)
  onTestFinished(() => preparation.dispose())
  const page = await preparation.ready, graph = native(page)
  await page.start(graph.entry)
  const late = Promise.withResolvers<PreparedCredentialEdit | null>()
  const prepare = vi.fn((_ref: string, _signal: AbortSignal) => late.promise)
  const unused = async (): Promise<never> => { throw new Error('No metadata read belongs to this observer case') }
  const remove = page.attachModels(graph.ctx, { metadata: unused, credentials: unused, prepare })
  const editing = page.modelsSettingsIntegration.editing.getSnapshot()
  if (editing === null) throw new Error('Missing original Models binding')
  const alreadyClosed = new AbortController()
  alreadyClosed.abort()
  expect(await editing.prepare('DEEPSEEK_API_KEY', alreadyClosed.signal)).toBeNull()
  expect(prepare).not.toHaveBeenCalled()
  const observer = new AbortController(), store = vi.fn(async () => undefined)
  const pending = editing.prepare('DEEPSEEK_API_KEY', observer.signal)
  observer.abort()
  expect(prepare.mock.calls[0]?.[1].aborted).toBe(true)
  late.resolve({ ref: 'DEEPSEEK_API_KEY', store, remove: store })
  expect(await pending).toBeNull()
  expect(editing.isCurrent()).toBe(true)
  expect(store).not.toHaveBeenCalled()
  expect(prepare).toHaveBeenCalledTimes(1)
  remove()
})
