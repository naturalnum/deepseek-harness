/** Source-generated MCP codecs, original Loader/AccountPolicy/Gateway audit and bounded bootstrap consumption. */
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
import { descriptors } from './fixtures/remote-servers/account.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'
import { decodeCloudBootstrap } from '../src/bootstrap.ts'

const endpoint: EndpointExposure = {
  endpoint: 'cloudMcpConnections/action', handlerId: 'native:cloudMcpConnections', guard: 'authenticated-account',
}
const version = (path: string): string => (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'bootstrap-mcp', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [
    { id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale', packageName: '@deepseek-ai/dsh-client-locale',
      packageVersion: version('../../../client/locale/package.json'), installable: false, toggleable: false },
    { id: 'model-provider', entryId: 'include:model-provider', moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key',
      packageName: '@deepseek-ai/dsh-llm-deepseek-api-key', packageVersion: version('../../../llm/llm-deepseek-api-key/package.json'),
      installable: false, toggleable: false },
  ], skills: { mode: 'closed' }, credentials: { mode: 'read-only' }, fields: [], mcp: {
    limits: { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 4096, maxHeaderCount: 8,
      maxToolCallTimeoutMs: 2000, maxRequestBytes: 20000, maxReplyBytes: 65536 },
    runtime: { maxInstructionBytes: 4096, reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 } },
  },
}
const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144, maxQueuedEvents: 128, maxQueuedBytes: 4194304 }

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-mcp-codecs-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })
  const installed = descriptors(home)
  const artifact: unknown = await import(pathToFileURL(join(installed, 'lib/typert.host.js')).href)
  if (typeof artifact !== 'object' || artifact === null) throw new Error('Original generated module absent')
  const contribution = validateTypertManifest('@deepseek-ai/dsh-pe-cloud-api', Reflect.get(artifact, 'TYPERT'))
  const native = policyFixture([endpoint], bounds, 'bootstrap-mcp', undefined, catalog, undefined, undefined, undefined, [], false, undefined, {
    defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset', selectable: true, config: { id: 'cloud-chat', plugins: [
      { id: 'persona', name: 'cordis:m8z-persona', config: { prefix: 'Reply briefly.', complete: true, includeRuntimeContext: false } },
    ] } }], extraEntries: [{ id: 'mcp-management', name: 'cordis:mcp-management' }],
    prepare(owner) {
      owner.loader.builtins['mcp-management'] = { inject: ['peCloudApi', 'peCloudFiles', 'credentials', 'storageDomain', 'tools', 'typert'],
        async apply(scope: Context) {
          scope.typert.register(contribution)
          if (catalog.mcp === undefined) throw new Error('Explicit fixture policy absent')
          await scope.peCloudApi.prepareCloudMcpConnections(scope, { policy: catalog.mcp, files: scope.peCloudFiles,
            assertBusinessCurrent() { scope.peAccount.lifetime.throwIfAborted() },
            assertToolCurrent() { throw new Error('Bootstrap cannot execute a tool') },
          })
        } }
    },
  })
  const graph = await native.start()
  const produce = (exposure = native.exposureOwner) => produceCloudBootstrap(graph.ctx, graph.binding, exposure,
    () => native.bootstrapPackages, { id: graph.binding.accountId, displayName: 'MCP metadata fixture' },
    65536, graph.binding.lifetime, () => { graph.ctx.fiber.assertActive(); native.assertRootActive() }, () => 'mcp-bootstrap-generation')
  const alternate = (row: EndpointExposure | undefined, stream = false): ExposureService => {
    const owner = new Context()
    onTestFinished(() => owner.fiber.dispose())
    const manifest = native.exposureOwner.policy.manifest
    return new ExposureService(owner, { ...manifest,
      rpcEndpoints: [...manifest.rpcEndpoints.filter(item => item.endpoint !== endpoint.endpoint),
        ...stream || row === undefined ? [] : [row]],
      streamEndpoints: [...manifest.streamEndpoints, ...stream && row !== undefined ? [row] : []], approvedConfiguration: catalog,
    })
  }
  return { graph, native, produce, alternate }
}

it('exposes only the approved installed MCP Remote and withdraws the bootstrap when its real descriptor changes', async () => {
  const f = await fixture(), service = f.graph.ctx.cloudMcpConnections
  expect(service.inspect().rpcEndpoints).toEqual([endpoint])
  expect(f.graph.api.isCapabilityEndpoint(endpoint.endpoint, 'rpc')).toBe(true)
  expect(f.graph.api.isCapabilityEndpoint('cloudMcpConnections/other', 'rpc')).toBe(false)
  const result = await f.produce()
  expect(decodeCloudBootstrap(JSON.parse(result.body), { maxBodyBytes: 65536, maxStringBytes: 65536, maxListItems: 512 })
    .capabilities.configuration.mcp).toEqual({ manage: true })
  result.assertCurrent()
  const view = f.graph.ctx.typert.local, descriptor = view.get(endpoint.endpoint)
  if (descriptor === undefined) throw new Error('Original Remote descriptor absent')
  const lookup = (path: string) => view.get(path)
  vi.spyOn(Typert.prototype, 'local', 'get').mockReturnValue({ ...view, get: path => path === endpoint.endpoint
    ? { ...descriptor, implementation: 'other' } : lookup(path) })
  expect(result.assertCurrent).toThrow()
})

it('refuses missing MCP selection, wrong handler or guard, unknown action and stream instead of the original RPC', async () => {
  const f = await fixture()
  for (const row of [{ ...endpoint, handlerId: 'native:other' }, { ...endpoint, guard: 'account-session' as const },
    { ...endpoint, endpoint: 'cloudMcpConnections/other' }, { ...endpoint, endpoint: 'unknownCloud/action' }]) {
    await expect(f.produce(f.alternate(row))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  }
  await expect(f.produce(f.alternate(undefined))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(f.produce(f.alternate(endpoint, true))).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})
