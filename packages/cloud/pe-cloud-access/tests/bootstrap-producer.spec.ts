/** Producer contract tests on a native policy graph; execution/inventory/content stubs prove no product readiness or ABI8. */
import { Context } from '@deepseek-ai/cordis'
import { CloudApiError, ExposureService, type EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'

vi.mock('@deepseek-ai/dsh-pe-opensandbox', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-pe-opensandbox')>(), assertClosedAccountExecution: () => {},
}))
vi.mock('../src/bootstrap-inventory.ts', () => ({ inspectBootstrapConfiguration: async () => ({
  configuration: { catalogVersion: 'producer-contract', plugins: [], skills: { manage: false },
    credentials: { write: false }, fields: [] }, assertCurrent: () => {},
}) }))

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536,
  maxQueuedEvents: 16, maxQueuedBytes: 131072 }
const fileRpc = ['read', 'stat', 'list', 'readBytes'].map(method => ({ endpoint: `workspaceFiles/${method}`,
  handlerId: 'native:workspaceFiles', guard: 'account-session' as const }))
const changes = { endpoint: 'workspaceFiles/changes', handlerId: 'native:workspaceFiles', guard: 'account-session' as const }

async function fixture(rpc: readonly EndpointExposure[] = [], streams: readonly EndpointExposure[] = []) {
  const native = policyFixture([], bounds), graph = await native.start(), root = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await root.fiber.dispose() })
  const manifest = native.exposureOwner.policy.manifest
  const exposure = new ExposureService(root, { ...manifest, rpcEndpoints: [...manifest.rpcEndpoints, ...rpc],
    streamEndpoints: [...manifest.streamEndpoints, ...streams], approvedConfiguration: {
      recipeVersion: manifest.recipeVersion, catalogVersion: 'producer-contract', maxEntries: 128,
      maxStringBytes: 128, maxCatalogBytes: 8192, plugins: [{ id: 'unit-catalog', entryId: 'unit-catalog',
        moduleName: '@deepseek-ai/dsh-pe-cloud-api', packageName: '@deepseek-ai/dsh-pe-cloud-api',
        packageVersion: '1.0.0', installable: false, toggleable: false }], skills: { mode: 'closed' },
      credentials: { mode: 'read-only' }, fields: [],
    } })
  // Only the added owner audits are stubbed; the first-screen methods keep their real native API checks.
  const requireRpc = graph.api.requireRpc.bind(graph.api), requireStream = graph.api.requireStream.bind(graph.api)
  const auditedRpc = vi.spyOn(graph.api, 'requireRpc').mockImplementation(endpoint =>
    rpc.find(row => row.endpoint === endpoint) ?? requireRpc(endpoint))
  const auditedStream = vi.spyOn(graph.api, 'requireStream').mockImplementation(endpoint =>
    streams.find(row => row.endpoint === endpoint) ?? requireStream(endpoint))
  const content = vi.spyOn(graph.files, 'assertContentAvailable').mockImplementation(() => {})
  const produce = () => produceCloudBootstrap(graph.ctx, graph.binding, exposure, () => undefined,
    { id: graph.binding.accountId, displayName: 'Producer contract' }, 8192, graph.binding.lifetime,
    () => { graph.ctx.fiber.assertActive() }, () => 'producer-generation')
  return { produce, graph, auditedRpc, auditedStream, content }
}

it('preserves the old first-trial wire and does not request a content capability for its metadata-only files owner', async () => {
  const f = await fixture(), result = await f.produce()
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { projects: { state: 'available' },
    filePreview: { state: 'disabled', reason: 'not-approved' }, shell: { state: 'disabled', reason: 'not-approved' } } })
  expect(f.content).not.toHaveBeenCalled()
  result.assertCurrent()
})

it('projects available preview only for the complete exact native file group and rechecks the original assertions', async () => {
  const create = { endpoint: 'cloudProjects/create', handlerId: 'native:cloudProjects', guard: 'authenticated-account' as const }
  const f = await fixture([...fileRpc, create], [changes]), result = await f.produce()
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { projects: { state: 'available' }, filePreview: { state: 'available' } } })
  for (const row of [...fileRpc, create]) expect(f.auditedRpc).toHaveBeenCalledWith(row.endpoint)
  expect(f.auditedStream).toHaveBeenCalledWith(changes.endpoint)
  expect(f.content).toHaveBeenCalled()
  f.content.mockImplementation(() => { throw new Error('Original content owner withdrew') })
  expect(result.assertCurrent).toThrow('Original content owner withdrew')
})

it('keeps preview disabled for a partial selected group while still requiring content availability', async () => {
  const f = await fixture(fileRpc.slice(0, -1), [changes]), result = await f.produce()
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { filePreview: { state: 'disabled', reason: 'not-approved' } } })
  expect(f.content).toHaveBeenCalled()
})

it.each(['cloudProjects/delete', 'workspaceFiles/write', 'workspaceFiles/readMore', 'workspaceFiles/changes'])(
  'rejects unreviewed unary %s even when an owner audit stub would accept it', async (endpoint) => {
    const row = { endpoint, handlerId: 'unit-only-owner', guard: 'account-session' as const }
    const f = await fixture([row])
    await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(f.auditedRpc).not.toHaveBeenCalledWith(endpoint)
  },
)

it.each(['workspaceFiles/read', 'workspaceFiles/otherChanges', 'cloudProjects/create'])(
  'rejects unreviewed logical stream %s', async (endpoint) => {
    const f = await fixture([], [{ endpoint, handlerId: 'unit-only-owner', guard: 'account-session' }])
    await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(f.auditedStream).not.toHaveBeenCalledWith(endpoint)
  },
)

it('rejects an actual metadata-only Node files owner rather than inferring content from methods or selected rows', async () => {
  const f = await fixture(fileRpc, [changes])
  f.content.mockRestore()
  await expect(f.produce()).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
})

it('withdraws a completed projection when the original endpoint audit rejects its current registration', async () => {
  const f = await fixture(fileRpc, [changes]), result = await f.produce()
  f.auditedRpc.mockImplementation(() => { throw new CloudApiError('cloud/account-unavailable', 'Native registration ended') })
  expect(result.assertCurrent).toThrow('Native registration ended')
})
