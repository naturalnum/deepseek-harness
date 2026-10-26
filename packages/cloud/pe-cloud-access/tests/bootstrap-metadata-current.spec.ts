/** Real Loader/catalog/API and original auth guard; DB login response and monotonic cost are external fixtures. */
import { readFileSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import pg from 'pg'
import type { Auth } from 'better-auth'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { CloudAccountApi, type ApprovedConfigurationCatalog } from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'
import { accessConfig } from './ingress-fixture.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
  maxQueuedEvents: 128, maxQueuedBytes: 4194304 }
const version = (relative: string): string => (JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'native-metadata-regression', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [
    { id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: version('../../../client/locale/package.json'), installable: false, toggleable: false },
    { id: 'model-provider', entryId: 'include:model-provider', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
      packageVersion: version('../../../llm/llm-deepseek-api-key/package.json'), installable: false, toggleable: false },
  ], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [],
}
type Graph = Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>

async function fixture() {
  const native = policyFixture([], bounds, 'bootstrap-metadata-regression', undefined, catalog), graph = await native.start()
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused', max: 1, connectionTimeoutMillis: 10 })
  const connect = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Physical DB connect forbidden in this component fixture') })
  const query = vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('Physical DB query forbidden in this component fixture') })
  const resources: { auth?: BetterAuthAccess } = {}
  const socket = new Socket(), request = new IncomingMessage(socket)
  onTestFinished(async () => {
    await resources.auth?.close(); await pool.end(); request.destroy(); socket.destroy(); vi.restoreAllMocks()
  })
  const auth = await BetterAuthAccess.create({ ...accessConfig(), sessionRecheckMs: 5000, authCheckTimeoutMs: 10000 },
    pool, 'offline-metadata-regression-secret-01234567890123456789', async () => {})
  resources.auth = auth
  const library = Reflect.get(auth, 'auth') as Auth, createdAt = new Date(), expiresAt = new Date(Date.now() + 60000)
  const session = vi.spyOn(library.api, 'getSession').mockResolvedValue({
    user: { id: graph.binding.accountId, name: 'Metadata regression', email: 'metadata@example.test', emailVerified: true, createdAt, updatedAt: createdAt },
    session: { id: 'metadata-regression-login', userId: graph.binding.accountId, token: 'offline-library-response', expiresAt,
      createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null },
  })
  request.method = 'GET'; request.url = '/cloud/bootstrap'
  request.headers = { host: '127.0.0.1:4100', cookie: 'better-auth.session_token=external-fixture' }
  request.rawHeaders = ['Host', '127.0.0.1:4100', 'Cookie', 'better-auth.session_token=external-fixture']
  const requestId = 'bootstrap-metadata-regression-request' as Parameters<BetterAuthAccess['authenticateForBootstrap']>[1]
  const authenticate = () => auth.authenticateForBootstrap(request, requestId, 65536)
  const produce = (verified: Awaited<ReturnType<typeof authenticate>>) => produceCloudBootstrap(graph.ctx, graph.binding,
    native.exposureOwner, () => native.bootstrapPackages, verified.account, 65536, graph.binding.lifetime, () => {
      auth.assertLoginCurrent(verified.principal, requestId)
      graph.ctx.fiber.assertActive(); graph.binding.lifetime.throwIfAborted(); native.assertRootActive()
    }, () => 'metadata-regression-generation')
  return { native, graph, auth, authenticate, produce, requestId, session, connect, query }
}

function costEachEndpoint(graph: Graph, clock: { now: number }, milliseconds: number) {
  const rpc = vi.spyOn(graph.api, 'requireRpc').mockImplementation(function (this: CloudAccountApi, endpoint) {
    const result = CloudAccountApi.prototype.requireRpc.call(this, endpoint)
    clock.now += milliseconds
    return result
  })
  const stream = vi.spyOn(graph.api, 'requireStream').mockImplementation(function (this: CloudAccountApi, endpoint) {
    const result = CloudAccountApi.prototype.requireStream.call(this, endpoint)
    clock.now += milliseconds
    return result
  })
  return { rpc, stream }
}

it('keeps metadata projection within the original five-second login window without repeating endpoint admission per reader check', async () => {
  const f = await fixture(), clock = { now: 10000 }
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const cost = costEachEndpoint(f.graph, clock, 20), verified = await f.authenticate()
  const projected = await f.produce(verified)
  f.auth.assertLoginCurrent(verified.principal, f.requestId)
  projected.assertCurrent()
  expect(JSON.parse(projected.body)).toMatchObject({ capabilities: { configuration: {
    plugins: [{ id: 'locale' }, { id: 'model-provider' }], skills: { manage: false },
  } } })
  expect(cost.rpc.mock.calls.length + cost.stream.mock.calls.length).toBeLessThan(100)
  expect(clock.now - 10000).toBeLessThan(5000)
  clock.now = 14999; f.auth.assertLoginCurrent(verified.principal, f.requestId)
  clock.now = 15000
  expect(() => { f.auth.assertLoginCurrent(verified.principal, f.requestId) }).toThrow(expect.objectContaining({
    code: 'cloud/account-unavailable', status: 503,
  }))
  now.mockRestore()
  expect(f.session).toHaveBeenCalledTimes(1)
  expect(f.query).not.toHaveBeenCalled()
  expect(f.connect.mock.calls.length).toBeLessThanOrEqual(1)
  expect(f.graph.adapter.calls).toBe(0)
})

it('rejects native guard withdrawal after projection and before response transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  f.graph.withdrawLlmGuard()
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects a substituted original native implementation before response transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  const replaced = vi.spyOn(RemoteAccess.prototype, 'follow').mockImplementation(() => { throw new Error('Replaced native handler must not run') })
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(replaced).not.toHaveBeenCalled()
})

it('rejects native guard withdrawal during the actual catalog module await', async () => {
  const f = await fixture(), verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  let withdrawn = false
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale' && !withdrawn) { withdrawn = true; f.graph.withdrawLlmGuard() }
    return result
  })
  await expect(f.produce(verified)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(withdrawn).toBe(true)
})

it('rejects original Root owner closure during the catalog await', async () => {
  const f = await fixture(), verified = await f.authenticate()
  const locale = [...f.graph.ctx.loader.entries()].find(entry => entry.options.id === 'locale')!
  const tree = locale.parent.tree, load = tree.import.bind(tree)
  let closed = false
  vi.spyOn(tree, 'import').mockImplementation(async (name, stack) => {
    const result: unknown = await load(name, stack)
    if (name === '@deepseek-ai/dsh-client-locale' && !closed) { closed = true; await f.native.closeRoot() }
    return result
  })
  await expect(f.produce(verified)).rejects.toThrow()
  expect(closed).toBe(true)
})

it('keeps original authentication shutdown authoritative at final transfer', async () => {
  const f = await fixture(), projected = await f.produce(await f.authenticate())
  await f.auth.close()
  expect(projected.assertCurrent).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable', status: 503 }))
})
