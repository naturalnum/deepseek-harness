/** Actual source-generated Remote/Typert, original account API, bootstrap inventory/producer and wire consumer.
 * Native Node storage/model fixture remains explicit; SSH execution is not exercised by metadata projection.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { ExposureService, type ApprovedConfigurationCatalog, type EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { descriptors, remotePolicy } from './fixtures/remote-servers/account.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'
import { decodeCloudBootstrap } from '../src/bootstrap.ts'

// The original closed Standard fixture owns execution. This test only removes the unrelated SSH
// prerequisite at preparation, never service inspection, account API admission, or bootstrap guards.
vi.mock('@deepseek-ai/dsh-pe-opensandbox', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-pe-opensandbox')>(), assertRemoteSshAvailable: vi.fn(() => {}),
}))
const endpoint: EndpointExposure = { endpoint: 'cloudRemoteServers/action', handlerId: 'cloud:remote-servers', guard: 'authenticated-account' }
const version = (path: string): string => (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'bootstrap-remote', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [
    { id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: version('../../../client/locale/package.json'), installable: false, toggleable: false },
    { id: 'model-provider', entryId: 'include:model-provider', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
      packageVersion: version('../../../llm/llm-deepseek-api-key/package.json'), installable: false, toggleable: false },
  ], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [], remoteServers: remotePolicy,
}
const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144, maxQueuedEvents: 128, maxQueuedBytes: 4194304 }

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-remote-codecs-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })
  const installed = descriptors(home)
  const artifact: unknown = await import(pathToFileURL(join(installed, 'lib/typert.host.js')).href)
  if (typeof artifact !== 'object' || artifact === null) throw new Error('Original generated module absent')
  const contribution = validateTypertManifest('@deepseek-ai/dsh-pe-cloud-api', Reflect.get(artifact, 'TYPERT'))
  const native = policyFixture([endpoint], bounds, 'bootstrap-remote', undefined, catalog, undefined, undefined, undefined, [], false, undefined, {
    defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset', selectable: true, config: { id: 'cloud-chat', plugins: [
      { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: 'Reply briefly.', complete: true, includeRuntimeContext: false } },
    ] } }], extraEntries: [{ id: 'remote-management', name: 'cordis:remote-management' }],
    prepare(owner) {
      owner.loader.builtins['remote-management'] = { inject: ['peCloudApi', 'peCloudFiles', 'credentials', 'storageDomain', 'tools', 'typert'],
        async apply(scope: Context) {
          scope.typert.register(contribution)
          await scope.peCloudApi.prepareCloudRemoteServers(scope, { ...remotePolicy, files: scope.peCloudFiles,
            withModelKeyPeerUse() { throw new Error('Bootstrap inspection cannot borrow a business Peer') },
            assertBusinessCurrent() { scope.peAccount.lifetime.throwIfAborted() },
            assertToolCurrent() { throw new Error('Bootstrap metadata cannot execute a tool') },
          })
        } }
    },
  })
  const graph = await native.start()
  const produce = (exposure = native.exposureOwner) => produceCloudBootstrap(
    graph.ctx, graph.binding, exposure, () => native.bootstrapPackages,
    { id: graph.binding.accountId, displayName: 'Actual Remote metadata fixture' }, 65536, graph.binding.lifetime,
    () => { graph.ctx.fiber.assertActive(); native.assertRootActive() }, () => 'remote-bootstrap-generation')
  const alternate = (row: EndpointExposure | undefined, approved = true, stream = false): ExposureService => {
    const owner = new Context()
    onTestFinished(() => owner.fiber.dispose())
    const manifest = native.exposureOwner.policy.manifest
    const { remoteServers: _remote, ...withoutRemote } = catalog
    return new ExposureService(owner, { ...manifest,
      rpcEndpoints: [...manifest.rpcEndpoints.filter(item => item.endpoint !== endpoint.endpoint),
        ...stream || row === undefined ? [] : [row]],
      streamEndpoints: [...manifest.streamEndpoints, ...stream && row !== undefined ? [row] : []],
      approvedConfiguration: approved ? catalog : withoutRemote,
    })
  }
  return { graph, native, produce, alternate }
}

it('projects the exact installed Remote through original API audit and complete bootstrap consumption', async () => {
  const f = await fixture(), service = f.graph.ctx.cloudRemoteServers
  expect(service.inspect().rpcEndpoints).toEqual([endpoint])
  expect(f.graph.ctx.typert.local.get(endpoint.endpoint)).toMatchObject({ service: 'cloudRemoteServers', namespace: 'cloudRemoteServers', method: 'action' })
  expect(f.graph.api.requireRpc(endpoint.endpoint)).toEqual(endpoint)
  const result = await f.produce()
  expect(decodeCloudBootstrap(JSON.parse(result.body), { maxBodyBytes: 65536, maxStringBytes: 65536, maxListItems: 512 })
    .capabilities.configuration.remoteServers).toEqual({ manage: true })
  result.assertCurrent()
  f.graph.api.invalidate()
  expect(result.assertCurrent).toThrow()
})

it('rejects wrong handler, guard, method, unknown Cloud endpoint and missing explicit approval', async () => {
  const f = await fixture()
  for (const row of [{ ...endpoint, handlerId: 'cloud:other' }, { ...endpoint, handlerId: 'native:cloudRemoteServers' },
    { ...endpoint, guard: 'account-session' as const }, { ...endpoint, endpoint: 'cloudRemoteServers/other' },
    { ...endpoint, endpoint: 'unknownCloud/action' }]) {
    await expect(f.produce(f.alternate(row))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  }
  await expect(f.produce(f.alternate(undefined))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(f.produce(f.alternate(endpoint, false))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(f.produce(f.alternate(endpoint, true, true))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('withdraws bootstrap when the original Remote descriptor is no longer the inspected method', async () => {
  const f = await fixture(), result = await f.produce(), view = f.graph.ctx.typert.local
  const descriptor = view.get(endpoint.endpoint)
  if (descriptor === undefined) throw new Error('Original Remote descriptor absent')
  const lookup = (path: string) => view.get(path)
  vi.spyOn(Typert.prototype, 'local', 'get').mockReturnValue({ ...view, get: path => path === endpoint.endpoint
    ? { ...descriptor, implementation: 'other' } : lookup(path) })
  expect(result.assertCurrent).toThrow()
})
