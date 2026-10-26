import { TEST_PLUGIN_ID, TEST_BUNDLE_ID, pluginFixture, bundleFixture } from './plugin-fixtures.client.ts'
/** Original page, Connection, Gateway and actual API147 contribution; only HTTP replies and physical socket are scripted. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { apply, inject } from '@deepseek-ai/dsh-api-gateway/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionWebSocket, RpcFetch, ClientRequest, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection/src/rpc-schema.ts'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import contribution from '@deepseek-ai/dsh-pe-cloud-api/remote'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PreparedCloudPage } from '../src/client/prepared-page.ts'
import { createPagePluginCatalog } from '../src/client/management/plugins/catalog-reader.ts'
import type { CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'
import type { PluginManagementInjected, AccountPluginId } from '../src/client/management/plugins/types.ts'
import type { ManagementNotice } from '../src/client/management/ManagementActionToast.tsx'

type Current = Extract<Awaited<ReturnType<CloudPluginRemote['current']>>, { ok: true }>['value']
type Change = Extract<Awaited<ReturnType<CloudPluginRemote['change']>>, { ok: true }>['value']
type Answer = ConnectionRpcResult<Change>
const id = brandString<AccountPluginId>(TEST_PLUGIN_ID)
const facts = pluginFixture
class Socket implements ConnectionWebSocket {
  readyState = 1
  private readonly opened = new Map<object, () => void>()
  private readonly closed = new Map<object, () => void>()
  constructor() { queueMicrotask(() => { for (const listener of this.opened.values()) listener() }) }
  send(): void {}
  close(): void { this.readyState = 3; for (const listener of this.closed.values()) listener(); this.opened.clear(); this.closed.clear() }
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener) => {
    if (event === 'open') this.opened.set(listener, () => { listener({ data: undefined }) })
    if (event === 'close') this.closed.set(listener, () => { listener({ data: undefined }) })
  }
  removeEventListener: ConnectionWebSocket['removeEventListener'] = (event, listener) => {
    if (event === 'open') this.opened.delete(listener)
    if (event === 'close') this.closed.delete(listener)
  }
}
async function fixture(additional: readonly Current[] = [], generation = 'generation-A') {
  const disabled = { state: 'disabled', reason: 'not-approved' } as const
  const bootstrap: CloudBootstrap = { account: { id: 'A', displayName: 'A' }, recipeVersion: 'approved-plugin', connectionGeneration: generation,
    capabilities: { projects: { state: 'available' }, filePreview: disabled, shell: disabled, developmentServices: disabled, servicePreview: disabled,
      sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'approved', plugins: [{ id: TEST_PLUGIN_ID, installable: false, toggleable: true },
        ...additional.map(state => ({ id: state.id, installable: true, toggleable: false }))],
      skills: { manage: false }, credentials: { write: false }, fields: [] } } }
  const requests: ClientRequest[] = [], currentReplies: Current[] = []
  let currentCount = 0, changeReply: Answer = { ok: true, value: { kind: 'applied', value: facts('after', true) } }
  let blocked: Promise<undefined> | undefined, failChange = false
  const fetch: RpcFetch = async (_target, init) => {
    if (init?.method !== 'POST') return Response.json(bootstrap)
    if (typeof init.body !== 'string') throw new Error('Native RPC body is missing')
    expect(new Headers(init.headers).get('x-account')).toBe('A')
    expect(new Headers(init.headers).get('x-generation')).toBe(generation)
    const raw: unknown = JSON.parse(init.body), request = clientRequestSchema.parse(raw)
    requests.push(request)
    if (request.method === 'cloudPlugins/current') {
      currentCount++
      const value = currentReplies.shift() ?? facts(`edit-${currentCount}`)
      if (blocked !== undefined) await blocked
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
    }
    if (request.method !== 'cloudPlugins/change') throw new Error('Unexpected business endpoint: ' + request.method)
    if (blocked !== undefined) await blocked
    if (failChange) throw new TypeError('Scripted lost response after submission')
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: changeReply })
  }
  const prepared = PreparedCloudPage.prepare({ baseUrl: 'https://example.test/app/',
    config: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 1000, maxBootstrapResponseBytes: 8192, maxErrorResponseBytes: 512,
      maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 1000 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 10, maxKeyBytes: 64, maxValueBytes: 256, maxTotalBytes: 4096, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-account', generationHeader: 'x-generation', accountQuery: 'account', generationQuery: 'generation' },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, fetch, createWebSocket: () => new Socket(),
  }, new AbortController().signal)
  const page = await prepared.ready, ctx = new Context(), notices: Array<Pick<ManagementNotice, 'action' | 'outcome'>> = []
  onTestFinished(async () => { await prepared.dispose() })
  const locale = new LocaleRuntime(ctx); locale.setLocale('en'); ctx.provide('locale', locale)
  ctx.provide('clientPersistence', page.nativeOptions.persistence)
  let control: ReturnType<typeof createPagePluginCatalog> | undefined
  let owner: ReturnType<Context['plugin']> | undefined
  await page.start({ run: async () => {
    page.nativeOptions.prepareContext(ctx)
    await ctx.plugin((scope) => { page.activate(scope) })
    await ctx.plugin(TypertRegistry); await ctx.plugin({ inject, apply })
    await ctx.inject(['remote'], scope => scope.remote.$mount(contribution))
    owner = ctx.inject(['remote', 'remote.cloudPlugins', 'locale'], (scope) => {
      const bound = createPagePluginCatalog(scope, page, (state) => {
        const metadata = state.bundle?.meta ?? state.plugin?.meta
        return { title: metadata?.title === undefined ? state.bundle?.name ?? state.id : locale.resolveText(metadata.title),
          description: metadata?.description === undefined ? state.bundle?.description ?? state.plugin?.moduleName ?? ''
            : locale.resolveText(metadata.description) }
      }, (action, outcome) => { notices.push({ action, outcome }) })
      control = bound
      scope.effect(() => bound.dispose, 'fixture: original plugin catalog')
    })
    await owner
  }, dispose: async () => { await ctx.fiber.dispose() } })
  if (control === undefined || owner === undefined) throw new Error('Original native catalog did not attach')
  const source = control.injected.hooks.accountPluginCatalog, injected: PluginManagementInjected = control.injected
  return { page, ctx, locale, source, injected, notices, requests, currentReplies,
    changes: () => requests.filter(request => request.method === 'cloudPlugins/change'),
    reply: (value: Answer) => { changeReply = value }, loseResponse: () => { failChange = true },
    block: (value: Promise<undefined> | undefined) => { blocked = value },
    withdraw: () => { control?.dispose(); return owner?.dispose() } }
}
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  f.injected.refreshPluginCatalog?.()
  await vi.waitFor(() => { expect(f.source.getSnapshot().phase).toBe('ready'); expect(f.source.getSnapshot().refreshing).toBe(false) })
}
async function edit(f: Awaited<ReturnType<typeof fixture>>, configure = false) {
  if (configure) f.injected.openPluginConfiguration?.(id); else f.injected.requestPluginEnabled?.(id, true)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
}

it('uses the actual native15-method contribution, waits for gestures, and submits only the original captured edit and explicit idle mode', async () => {
  const f = await fixture()
  expect(f.requests).toEqual([])
  await read(f)
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ installed: true, enabled: false, version: null, toggle: 'available' })
  await edit(f)
  f.injected.refreshPluginCatalog?.()
  expect(f.requests).toHaveLength(2)
  const opened = f.source.getSnapshot().editor
  opened?.submit('if-idle'); opened?.submit('stop-and-apply')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('applied') })
  expect(f.changes()).toHaveLength(1)
  expect(f.changes()[0]?.payload).toEqual({ args: { request: { id: 'execution-tuning',
    version: facts('edit-2').version, mode: 'if-idle', operation: { kind: 'enabled', enabled: true } } } })
  expect(f.source.getSnapshot().plugins[0]?.enabled).toBe(true)
  expect(f.notices.at(-1)).toEqual({ action: 'plugin-toggle', outcome: 'confirmed' })
})

it('submits the approved configuration with explicit terminal mode and keeps accepted rebuild separate from applied state', async () => {
  const f = await fixture(); await read(f); await edit(f, true)
  f.reply({ ok: true, value: { kind: 'accepted-rebuild', operationId: brandString<Extract<Change, { kind: 'accepted-rebuild' }>['operationId']>('rebuild-1') } })
  const opened = f.source.getSnapshot().editor; opened?.editValue('[1,2]'); opened?.submit('stop-and-apply')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('accepted-rebuild') })
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { mode: 'stop-and-apply',
    version: facts('edit-2').version, operation: { kind: 'configure', path: ['limits', 'steps'], value: [1, 2] } } } })
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ enabled: false, toggle: 'unknown', configuration: 'unknown' })
  expect(f.notices.at(-1)?.outcome).toBe('accepted-rebuild')
})

it.each(['cloud/config-conflict', 'cloud/account-unavailable'] as const)('preserves confirmed facts and never retries %s', async (code) => {
  const f = await fixture(); await read(f); await edit(f)
  f.reply({ ok: false, error: { code, message: 'Scripted refusal', details: {} } })
  const opened = f.source.getSnapshot().editor; opened?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('result') })
  expect(f.source.getSnapshot().editor?.outcome).toBe(code === 'cloud/config-conflict' ? 'conflict' : 'unknown')
  opened?.submit('stop-and-apply'); f.injected.refreshPluginCatalog?.()
  expect(f.changes()).toHaveLength(1); expect(f.requests).toHaveLength(3)
  expect(f.source.getSnapshot().plugins[0]?.enabled).toBe(false)
})

it('retires old intent callbacks instead of letting them submit or alter a replacement edit', async () => {
  const f = await fixture(); await read(f); await edit(f, true)
  const old = f.source.getSnapshot().editor; old?.close(); await edit(f, true)
  expect(() => old?.submit('stop-and-apply')).toThrow()
  expect(() => old?.editValue('[1,2]')).toThrow()
  expect(f.changes()).toEqual([])
  expect(f.source.getSnapshot().editor?.valueText).toBe('[\n  3,\n  5,\n  8\n]')
})

it('does not publish a late original current reply or issue a write after its owner withdraws', async () => {
  const f = await fixture(); await read(f)
  const gate = Promise.withResolvers<undefined>(); f.block(gate.promise)
  f.injected.openPluginConfiguration?.(id)
  await vi.waitFor(() => { expect(f.requests).toHaveLength(2) })
  const before = f.source.getSnapshot(); await f.withdraw(); gate.resolve(undefined)
  await Promise.resolve(); await Promise.resolve()
  expect(f.source.getSnapshot().phase).toBe('unavailable')
  expect(f.source.getSnapshot().editor?.phase).toBe(before.editor?.phase)
  expect(f.changes()).toEqual([])
})

it('keeps a lost change response unknown and requires a new explicit current before another intent', async () => {
  const f = await fixture(); await read(f); await edit(f)
  f.loseResponse()
  const opened = f.source.getSnapshot().editor; opened?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('unknown') })
  opened?.submit('if-idle'); f.injected.requestPluginEnabled?.(id, false)
  expect(f.changes()).toHaveLength(1)
  f.source.getSnapshot().editor?.close(); f.injected.requestPluginEnabled?.(id, false)
  expect(f.source.getSnapshot().editor).toBeUndefined()
  await read(f); await edit(f)
  expect(f.requests.filter(request => request.method === 'cloudPlugins/current')).toHaveLength(4)
})
it('uses the same native path to disable a confirmed enabled plugin', async () => {
  const f = await fixture(); f.currentReplies.push(facts('read', true), facts('disable', true))
  await read(f); f.injected.requestPluginEnabled?.(id, false)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
  f.reply({ ok: true, value: { kind: 'applied', value: facts('disabled', false) } })
  f.source.getSnapshot().editor?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('applied') })
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { operation: { kind: 'enabled', enabled: false } } } })
  expect(f.source.getSnapshot().plugins[0]?.enabled).toBe(false)
})

it('reports the HTTP200 busy reply through the original namespace, closes controls and never escalates or retries', async () => {
  const f = await fixture(); await read(f); await edit(f)
  f.reply({ ok: false, error: { code: 'cloud/config-busy', message: 'The original account still owns non-observation Peer work.', details: {} } })
  const opened = f.source.getSnapshot().editor; opened?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('busy') })
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ installed: true, enabled: false, toggle: 'busy', configuration: 'busy' })
  expect(f.notices.at(-1)).toEqual({ action: 'plugin-toggle', outcome: 'busy' })
  opened?.submit('stop-and-apply'); f.injected.refreshPluginCatalog?.()
  expect(f.changes()).toHaveLength(1); expect(f.requests).toHaveLength(3)
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { mode: 'if-idle' } } })
  f.source.getSnapshot().editor?.close(); f.injected.requestPluginEnabled?.(id, false)
  expect(f.source.getSnapshot().editor).toBeUndefined()
  expect(f.requests).toHaveLength(3)
  await read(f)
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ enabled: false, toggle: 'available', configuration: 'available' })
  expect(f.changes()).toHaveLength(1)
})

it('reads the finite approved catalog, edits a different ordinary field, and preserves other rows and the original version', async () => {
  const second: Current = { ...pluginFixture('read-search', false, 12, 'search-tuning'), operations: ['configure'],
    configuration: { fields: [{ path: ['index', 'maxItems'], schema: { type: 'integer', minimum: 1 },
      writable: true, secrets: [], acceptsMissing: false, limitations: [], value: 12 },
    { path: ['index', 'tags'], schema: { type: 'array', items: { type: 'string' } }, writable: true, secrets: [], acceptsMissing: true, limitations: [] },
    { path: ['auth'], schema: {}, writable: false, readOnlyReason: 'protected', secrets: [{ path: ['token'], set: true }],
      acceptsMissing: 'unknown', limitations: [] }] } }
  const f = await fixture([second]); f.currentReplies.push(facts('read-execution'), second)
  await read(f)
  expect(f.source.getSnapshot().plugins.map(row => row.id)).toEqual([TEST_PLUGIN_ID, 'search-tuning'])
  expect(f.source.getSnapshot().plugins[1]).toMatchObject({ installable: true, toggle: 'not-approved', configuration: 'available' })
  const first = f.source.getSnapshot().plugins[0], secondId = brandString<AccountPluginId>('search-tuning')
  const editState = { ...second, version: { ...second.version, editToken: brandString<Current['version']['editToken']>('original-search-edit') } }
  f.currentReplies.push(editState); f.injected.openPluginConfiguration?.(secondId)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
  const editor = f.source.getSnapshot().editor
  editor?.chooseField(['index', 'tags']); expect(f.source.getSnapshot().editor).toMatchObject({ valueText: '', invalid: true })
  editor?.editValue('["one","two"]'); editor?.chooseField(['auth'])
  expect(() => editor?.editValue('{}')).toThrow(); editor?.submit('stop-and-apply'); expect(f.changes()).toEqual([])
  editor?.chooseField(['index', 'maxItems']); editor?.editValue('24')
  f.locale.setLocale('zh')
  expect(f.source.getSnapshot().plugins.map(row => row.title)).toEqual(['测试 execution-tuning', '测试 search-tuning'])
  expect(f.requests).toHaveLength(3)
  f.reply({ ok: true, value: { kind: 'applied', value: { ...second,
    configuration: { fields: [{ ...second.configuration.fields[0]!, value: 24 }] } } } })
  editor?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('applied') })
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { id: 'search-tuning', version: editState.version,
    operation: { kind: 'configure', path: ['index', 'maxItems'], value: 24 }, mode: 'if-idle' } } })
  expect(f.source.getSnapshot().plugins.map(row => row.id)).toEqual([TEST_PLUGIN_ID, 'search-tuning'])
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ ...first, title: '测试 execution-tuning', description: '获批插件元数据' })
})
it('keeps approved read-only identities visible without closing editable rows or granting writes', async () => {
  const { maxImpact: _impact, ...original } = pluginFixture('read-only', true, 7, 'read-only-core')
  const readOnly: Current = { ...original, operations: [], configuration: { fields: [] } }
  const f = await fixture([readOnly]); f.currentReplies.push(facts('editable'), readOnly)
  await read(f)
  expect(f.source.getSnapshot().phase).toBe('ready')
  expect(f.source.getSnapshot().plugins).toMatchObject([
    { id: TEST_PLUGIN_ID, toggle: 'available', configuration: 'available' },
    { id: 'read-only-core', installed: true, toggle: 'not-approved', configuration: 'read-only' },
  ])
  f.injected.openPluginConfiguration?.(brandString<AccountPluginId>('read-only-core'))
  expect(f.requests).toHaveLength(2); expect(f.changes()).toEqual([])
})

it('refuses invalid JSON and expression drafts without consuming or renewing the original edit', async () => {
  const f = await fixture(); await read(f); await edit(f, true)
  const editor = f.source.getSnapshot().editor
  for (const value of ['[', '{"__jsExpr":"unsafe()"}', '{"nested":{"constructor":3}}']) {
    editor?.editValue(value); editor?.submit('stop-and-apply')
    expect(f.source.getSnapshot().editor?.invalid).toBe(true)
    expect(f.changes()).toEqual([])
  }
  editor?.editValue('[10,20]'); editor?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('applied') })
  expect(f.changes()).toHaveLength(1); expect(f.requests).toHaveLength(3)
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { version: facts('edit-2').version,
    operation: { kind: 'configure', path: ['limits', 'steps'], value: [10, 20] } } } })
})

it('opens native preinstalled bundle selection without an Entry or profile dependency and submits one captured version', async () => {
  const bundle = bundleFixture('bundle-read'), f = await fixture([bundle])
  f.currentReplies.push(facts('entry-read'), bundle); await read(f)
  const row = f.source.getSnapshot().plugins[1], entry = f.source.getSnapshot().plugins[0]
  expect(row).toMatchObject({ id: TEST_BUNDLE_ID, installed: false, enabled: null, moduleName: null,
    availability: 'installation', version: '1.2.3', selected: false, toggle: 'available', configuration: 'read-only' })
  f.injected.requestPluginEnabled?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), true)
  f.injected.requestPluginSelected?.(id, true)
  expect(f.requests).toHaveLength(2)
  const original = bundleFixture('original-bundle-edit')
  f.currentReplies.push(original)
  f.injected.requestPluginSelected?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), true)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
  const opened = f.source.getSnapshot().editor
  expect(opened).toMatchObject({ action: 'selected', selected: true })
  expect(opened).not.toHaveProperty('fields'); expect(opened).not.toHaveProperty('version')
  f.locale.setLocale('zh'); f.injected.refreshPluginCatalog?.()
  expect(f.requests).toHaveLength(3); expect(f.changes()).toEqual([])
  f.reply({ ok: true, value: { kind: 'accepted-rebuild',
    operationId: brandString<Extract<Change, { kind: 'accepted-rebuild' }>['operationId']>('bundle-operation') } })
  opened?.submit('stop-and-apply'); opened?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('accepted-rebuild') })
  expect(f.changes()).toHaveLength(1)
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { id: TEST_BUNDLE_ID, version: original.version,
    operation: { kind: 'selected', selected: true }, mode: 'stop-and-apply' } } })
  expect(f.source.getSnapshot().plugins[1]).toMatchObject({ selected: false, installed: false, enabled: null,
    toggle: 'unknown', configuration: 'unknown', title: '预安装工具' })
  expect(f.source.getSnapshot().plugins[0]).toMatchObject({ ...entry, title: '测试 execution-tuning', description: '获批插件元数据' })
  expect(row?.selected).toBe(false); expect(f.notices.at(-1)?.outcome).toBe('accepted-rebuild')
})
it('keeps an idle bundle busy refusal distinct and never upgrades its mode or retries the consumed selection', async () => {
  const bundle = bundleFixture('selected-read', true), f = await fixture([bundle])
  f.currentReplies.push(facts('entry-read'), bundle); await read(f)
  const original = bundleFixture('deselect-original', true); f.currentReplies.push(original)
  f.injected.requestPluginSelected?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), false)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
  f.reply({ ok: false, error: { code: 'cloud/config-busy', message: 'Scripted existing account work', details: {} } })
  const opened = f.source.getSnapshot().editor; opened?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('busy') })
  opened?.submit('stop-and-apply')
  expect(f.changes()).toHaveLength(1)
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { version: original.version, mode: 'if-idle',
    operation: { kind: 'selected', selected: false } } } })
  expect(f.source.getSnapshot().plugins[1]).toMatchObject({ selected: true, installed: false, toggle: 'busy' })
  opened?.close(); f.injected.requestPluginSelected?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), false)
  expect(f.requests).toHaveLength(4)
  expect(f.source.getSnapshot().editor).toBeUndefined()
})
it('requires a new prepared connection and explicit current reads to confirm accepted bundle selection', async () => {
  const originalBundle = bundleFixture('old-bundle'), old = await fixture([originalBundle])
  old.currentReplies.push(facts('old-entry'), originalBundle); await read(old)
  old.currentReplies.push(bundleFixture('old-original-edit'))
  old.injected.requestPluginSelected?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), true)
  await vi.waitFor(() => { expect(old.source.getSnapshot().editor?.phase).toBe('editing') })
  old.reply({ ok: true, value: { kind: 'accepted-rebuild',
    operationId: brandString<Extract<Change, { kind: 'accepted-rebuild' }>['operationId']>('reconnect-operation') } })
  const oldEdit = old.source.getSnapshot().editor; oldEdit?.submit('stop-and-apply')
  await vi.waitFor(() => { expect(old.source.getSnapshot().editor?.outcome).toBe('accepted-rebuild') })
  await old.page.dispose()
  expect(() => oldEdit?.submit('stop-and-apply')).toThrow()
  expect(old.changes()).toHaveLength(1)
  const nextBundle = bundleFixture('new-read', true), next = await fixture([nextBundle], 'generation-B')
  next.currentReplies.push(facts('new-entry'), { ...nextBundle,
    version: { ...nextBundle.version, epoch: brandString<Current['version']['epoch']>('epoch-B') } })
  expect(next.requests).toEqual([]); await read(next)
  expect(next.source.getSnapshot().plugins[1]).toMatchObject({ selected: true, enabled: null, installed: false, toggle: 'available' })
  expect(next.changes()).toEqual([])
  expect(old.source.getSnapshot().phase).toBe('unavailable')
})

it('publishes bundle selection only from the original API applied reply, preserving absence of a profile dependency or entry', async () => {
  const bundle = bundleFixture('before'), f = await fixture([bundle])
  f.currentReplies.push(facts('entry'), bundle); await read(f)
  const entry = f.source.getSnapshot().plugins[0]
  const original = bundleFixture('apply-original'); f.currentReplies.push(original)
  f.injected.requestPluginSelected?.(brandString<AccountPluginId>(TEST_BUNDLE_ID), true)
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.phase).toBe('editing') })
  f.reply({ ok: true, value: { kind: 'applied', value: bundleFixture('verified', true) } })
  expect(f.source.getSnapshot().plugins[1]?.selected).toBe(false)
  f.source.getSnapshot().editor?.submit('if-idle')
  await vi.waitFor(() => { expect(f.source.getSnapshot().editor?.outcome).toBe('applied') })
  expect(f.source.getSnapshot().plugins[1]).toMatchObject({ selected: true, enabled: null, installed: false,
    moduleName: null, availability: 'installation', version: '1.2.3' })
  expect(f.source.getSnapshot().plugins[0]).toBe(entry)
  expect(f.changes()).toHaveLength(1); expect(f.requests).toHaveLength(4)
  expect(f.changes()[0]?.payload).toMatchObject({ args: { request: { id: TEST_BUNDLE_ID, version: original.version,
    operation: { kind: 'selected', selected: true }, mode: 'if-idle' } } })
})
