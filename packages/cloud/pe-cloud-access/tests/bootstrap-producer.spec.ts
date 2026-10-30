import { modelKeyBinding } from '../../pe-cloud-api/tests/model-key-policy-data.ts'
/** Producer contract tests on a native policy graph; execution/inventory/content stubs prove no product readiness or ABI8. */
import { Context } from '@deepseek-ai/cordis'
import { CloudApiError, ExposureService, MODEL_KEY_RPC_ENDPOINTS, PLUGIN_RPC_ENDPOINTS, APPROVED_PLUGIN_CONTROL, type ApprovedConfigurationCatalog, type EndpointExposure, type ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { FILE_UPLOAD_PATH } from '@deepseek-ai/dsh-client-file-upload'
import { accountExecutionMode, accountServiceAvailability, assertAccountExecutionProviders } from '@deepseek-ai/dsh-pe-opensandbox'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { produceCloudBootstrap } from '../src/bootstrap-producer.ts'

vi.mock('@deepseek-ai/dsh-pe-opensandbox', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-pe-opensandbox')>(),
  assertAccountExecutionProviders: vi.fn(() => {}), accountExecutionMode: vi.fn(() => 'closed'), accountServiceAvailability: vi.fn(() => ({ developmentServices: false, servicePreview: false })),
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

async function fixture(rpc: readonly EndpointExposure[] = [], streams: readonly EndpointExposure[] = [],
  fetch: readonly ExactFetchExposure[] = [], modelKey = false, pluginControl = false,
  skills: ApprovedConfigurationCatalog['skills'] = { mode: 'closed' }) {
  const native = policyFixture([], bounds), graph = await native.start(), root = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await root.fiber.dispose() })
  const manifest = native.exposureOwner.policy.manifest
  const exposure = new ExposureService(root, { ...manifest,
    rpcEndpoints: [...manifest.rpcEndpoints.filter(row => !rpc.some(extra => extra.endpoint === row.endpoint)), ...rpc],
    streamEndpoints: [...manifest.streamEndpoints.filter(row => !streams.some(extra => extra.endpoint === row.endpoint)), ...streams],
    exactFetchRoutes: fetch, approvedConfiguration: {
      recipeVersion: manifest.recipeVersion, catalogVersion: 'producer-contract', maxEntries: 128,
      maxStringBytes: 128, maxCatalogBytes: 8192, plugins: pluginControl
        ? [{ ...APPROVED_PLUGIN_CONTROL, installable: false, toggleable: true }] : [{ id: 'unit-catalog', entryId: 'unit-catalog',
          moduleName: '@deepseek-ai/dsh-pe-cloud-api', packageName: '@deepseek-ai/dsh-pe-cloud-api',
          packageVersion: '1.0.0', installable: false, toggleable: false }], skills,
      credentials: { mode: 'read-only' }, fields: [],
      ...pluginControl ? { pluginControl: { maxProfileBytes: 65536, maxRequestBytes: 8192,
        maxReplyBytes: 65536, maxVersionBytes: 256 } } : {},
      ...modelKey ? { modelKey: { bindings: [modelKeyBinding('provider')], maxKeyBytes: 128, maxVersionBytes: 128,
        maxReplyBytes: 4096, maxMetadataBytes: 65536 } } : {},
    } })
  // Only the added owner audits are stubbed; the first-screen methods keep their real native API checks.
  const requireRpc = graph.api.requireRpc.bind(graph.api), requireStream = graph.api.requireStream.bind(graph.api)
  const auditedRpc = vi.spyOn(graph.api, 'requireRpc').mockImplementation(endpoint =>
    rpc.find(row => row.endpoint === endpoint) ?? requireRpc(endpoint))
  const auditedStream = vi.spyOn(graph.api, 'requireStream').mockImplementation(endpoint =>
    streams.find(row => row.endpoint === endpoint) ?? requireStream(endpoint))
  const requireFetch = graph.api.requireFetch.bind(graph.api)
  const auditedFetch = vi.spyOn(graph.api, 'requireFetch').mockImplementation((method, path) =>
    fetch.find(row => row.method === method && row.path === path) ?? requireFetch(method, path))
  const content = vi.spyOn(graph.files, 'assertContentAvailable').mockImplementation(() => {})
  const produce = () => produceCloudBootstrap(graph.ctx, graph.binding, exposure, () => undefined,
    { id: graph.binding.accountId, displayName: 'Producer contract' }, 8192, graph.binding.lifetime,
    () => { graph.ctx.fiber.assertActive() }, () => 'producer-generation')
  return { produce, graph, auditedRpc, auditedStream, auditedFetch, content }
}

const upload: ExactFetchExposure = { method: 'POST', path: FILE_UPLOAD_PATH,
  handlerId: 'native:fileUploads', guard: 'account-session' }

it('permits only the selected native upload and withdraws bootstrap when its original route owner rejects', async () => {
  const f = await fixture(fileRpc, [changes], [upload]), result = await f.produce()
  expect(f.auditedFetch).toHaveBeenCalledWith(upload.method, upload.path)
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { filePreview: { state: 'available' } } })
  f.auditedFetch.mockImplementation(() => { throw new CloudApiError('cloud/account-unavailable', 'Native upload ended') })
  expect(result.assertCurrent).toThrow('Native upload ended')
})

it.each([
  { ...upload, method: 'GET' }, { ...upload, path: '/unreviewed-upload' },
  { ...upload, handlerId: 'other:upload' }, { ...upload, guard: 'authenticated-account' as const },
])('rejects an unreviewed upload declaration before trusting its owner stub: %j', async (row) => {
  const f = await fixture([], [], [row])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.auditedFetch).not.toHaveBeenCalled()
})

it('preserves the old first-trial wire and does not request a content capability for its metadata-only files owner', async () => {
  const f = await fixture(), result = await f.produce()
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { projects: { state: 'available' },
    filePreview: { state: 'disabled', reason: 'not-approved' }, shell: { state: 'disabled', reason: 'not-approved' } } })
  expect(f.content).not.toHaveBeenCalled()
  result.assertCurrent()
})

it('projects only shell from the account mode and withdraws it when the original execution providers reject', async () => {
  const f = await fixture()
  vi.mocked(accountExecutionMode).mockReturnValueOnce('session-collect')
  const result = await f.produce(), disabled = { state: 'disabled', reason: 'not-approved' }
  expect(accountExecutionMode).toHaveBeenLastCalledWith(f.graph.ctx)
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { shell: { state: 'available' },
    filePreview: disabled, developmentServices: disabled, servicePreview: disabled, backgroundJobs: false,
    subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
    configuration: { plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] },
  } })
  vi.mocked(assertAccountExecutionProviders).mockImplementationOnce(() => { throw new Error('Original execution providers ended') })
  expect(result.assertCurrent).toThrow('Original execution providers ended')
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

const preview: ExactFetchExposure={ method:'GET',path:'/cloud/service-preview',handlerId:'cloud:servicePreview',guard:'account-session' }
it('permits original upload and exact preview together only after both original API requirements',async()=>{
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:true,servicePreview:true })
  const f=await fixture([],[],[upload,preview]),r=await f.produce()
  expect(JSON.parse(r.body)).toMatchObject({ capabilities: { developmentServices:{ state:'available' },servicePreview:{ state:'available' } } })
  expect(f.auditedFetch).toHaveBeenCalledWith('POST',upload.path);expect(f.auditedFetch).toHaveBeenCalledWith('GET',preview.path)
  f.auditedFetch.mockImplementation(()=>{throw new CloudApiError('cloud/account-unavailable','Original Root registration ended')})
  expect(r.assertCurrent).toThrow('Original Root registration ended')
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:false,servicePreview:false })
})
it.each([{ ...preview,method:'POST' },{ ...preview,path:'/cloud/service-preview/other' }, { ...preview,handlerId:'other:preview' }, { ...preview,guard:'authenticated-account' as const }])('refuses undeclared preview variants: %j',async(row)=>{
  const f=await fixture([],[],[row]);await expect(f.produce()).rejects.toMatchObject({ code:'cloud/account-unavailable' })
})
it('refuses duplicate exact Fetch and extra third routes',async()=>{
  await expect(fixture([],[],[preview,preview])).rejects.toMatchObject({ code:'cloud/invalid-config' })
  for(const rows of [[upload,preview,{ ...upload,path:'/extra' }]]){
    const f=await fixture([],[],rows);await expect(f.produce()).rejects.toMatchObject({ code:'cloud/account-unavailable' }) }
})
it('withdraws the captured projection when the original service facts change',async()=>{
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:true,servicePreview:true })
  const f=await fixture([],[],[preview]),r=await f.produce()
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:true,servicePreview:false })
  expect(r.assertCurrent).toThrow()
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:false,servicePreview:false })
})
it('keeps preview disabled for missing route or original provider despite declarations',async()=>{
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:true,servicePreview:true })
  let f=await fixture(),r=await f.produce();expect(JSON.parse(r.body)).toMatchObject({ capabilities: { servicePreview: { state: 'disabled' } } })
  vi.mocked(accountServiceAvailability).mockReturnValue({ developmentServices:false,servicePreview:false })
  f=await fixture([],[],[preview]);r=await f.produce();expect(JSON.parse(r.body)).toMatchObject({ capabilities: { servicePreview: { state: 'disabled' } } })
})


it('admits only the explicit complete model-key RPC group while the original native credential catalog stays readonly', async () => {
  const rows = MODEL_KEY_RPC_ENDPOINTS.map(endpoint => ({ endpoint, handlerId: 'native:cloudModelKey', guard: 'authenticated-account' as const }))
  await expect(fixture(rows)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  const f = await fixture(rows, [], [], true), result = await f.produce()
  for (const row of rows) expect(f.auditedRpc).toHaveBeenCalledWith(row.endpoint)
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { configuration: { credentials: { write: false }, fields: [] } } })
  f.auditedRpc.mockImplementation((endpoint) => { throw new CloudApiError('cloud/account-unavailable', 'Original key registration ended: ' + endpoint) })
  expect(result.assertCurrent).toThrow()
})

const pluginRows = PLUGIN_RPC_ENDPOINTS.map(endpoint => ({ endpoint, handlerId: 'native:cloudPlugins', guard: 'authenticated-account' as const }))
it('approved plugin bootstrap admits the exact complete group and rechecks its original audit before sending', async () => {
  const f = await fixture(pluginRows, [], [], false, true), result = await f.produce()
  for (const row of pluginRows) expect(f.auditedRpc).toHaveBeenCalledWith(row.endpoint)
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { arbitraryBackendPlugins: false } })
  const original = f.auditedRpc.getMockImplementation()
  if (original === undefined) throw new Error('Missing original audit')
  f.auditedRpc.mockImplementation((endpoint) => {
    if (endpoint === 'cloudPlugins/change') throw new CloudApiError('cloud/account-unavailable', 'Original plugin registration ended')
    return original(endpoint)
  })
  expect(result.assertCurrent).toThrow('Original plugin registration ended')
})
it.each(PLUGIN_RPC_ENDPOINTS)('approved plugin bootstrap refuses a missing original %s', async (endpoint) => {
  await expect(fixture(pluginRows.filter(row => row.endpoint !== endpoint), [], [], false, true))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
})
it.each([{ handlerId: 'native:pluginManager' }, { guard: 'account-session' as const }])(
  'approved plugin bootstrap refuses a different handler or guard: %j', async (change) => {
    await expect(fixture(pluginRows.map(row => row.endpoint === 'cloudPlugins/change' ? { ...row, ...change } : row), [], [], false, true))
      .rejects.toMatchObject({ code: 'cloud/invalid-config' })
  },
)
it('approved plugin bootstrap keeps closed, raw-manager and stream policies closed', async () => {
  await expect(fixture(pluginRows)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  await expect(fixture([...pluginRows, { endpoint: 'pluginManager/setEnabled', handlerId: 'native:pluginManager', guard: 'authenticated-account' }], [], [], false, true))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
  await expect(fixture(pluginRows, [pluginRows[0]!], [], false, true)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
})
it('approved plugin bootstrap preserves the complete managed eight and model-key four in the same original policy', async () => {
  const skills = ['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download']
    .map(method => ({ endpoint: 'cloudSkills/' + method, handlerId: 'native:cloudSkills', guard: 'authenticated-account' as const }))
  const keys = MODEL_KEY_RPC_ENDPOINTS.map(endpoint => ({ endpoint, handlerId: 'native:cloudModelKey', guard: 'authenticated-account' as const }))
  const f = await fixture([...pluginRows, ...skills, ...keys], [], [], true, true, { mode: 'managed',
    limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 4096, maxRetainedVersions: 4 },
    management: { maxRequestBytes: 65536, maxReplyBytes: 65536, maxMetadataBytes: 65536, maxRetainedProviders: 4 } })
  const result = await f.produce(); result.assertCurrent()
  for (const row of [...pluginRows, ...skills, ...keys]) expect(f.auditedRpc).toHaveBeenCalledWith(row.endpoint)
  expect(JSON.parse(result.body)).toMatchObject({ capabilities: { arbitraryBackendPlugins: false,
    configuration: { credentials: { write: false }, fields: [] } } })
})

it.each(['settings/mutate', 'settings/update'])('Root refuses %s before bootstrap when no native field is approved', async (endpoint) => {
  await expect(fixture([{ endpoint, handlerId: 'native:settingsController', guard: 'authenticated-account' }]))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

const nativeControlRpc: readonly EndpointExposure[] = [
  { endpoint: 'session/updateQueue', handlerId: 'native:sessionController', guard: 'account-session' },
  { endpoint: 'session/modelCatalog', handlerId: 'native:sessionController', guard: 'authenticated-account' },
  { endpoint: 'session/selectModel', handlerId: 'native:sessionController', guard: 'account-session' },
  ...['list', 'execute'].map(method => ({ endpoint: 'commands/' + method, handlerId: 'native:commands', guard: 'account-session' as const })),
  ...['get', 'edit', 'pause', 'resume', 'clear', 'create', 'complete'].map(method => ({
    endpoint: 'goals/' + method, handlerId: 'native:goals', guard: 'account-session' as const,
  })),
  { endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'authenticated-account' },
  ...['list', 'put', 'delete'].map(method => ({ endpoint: 'messageFeedback/' + method,
    handlerId: 'native:messageFeedback', guard: 'account-session' as const })),
  { endpoint: 'sessionFeedback/record', handlerId: 'native:sessionFeedback', guard: 'account-session' },
  { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'account-session' },
  { endpoint: '$events/result', handlerId: 'native:typertGateway', guard: 'authenticated-account' },
]

it('admits only selected original native Session controls and rechecks every original owner', async () => {
  const f = await fixture(nativeControlRpc), result = await f.produce()
  for (const row of nativeControlRpc) expect(f.auditedRpc).toHaveBeenCalledWith(row.endpoint)
  const read = f.auditedRpc.getMockImplementation()
  if (read === undefined) throw new Error('Original audit missing')
  f.auditedRpc.mockImplementation((endpoint) => {
    if (endpoint === 'commands/execute') throw new CloudApiError('cloud/account-unavailable', 'Original Commands withdrew')
    return read(endpoint)
  })
  expect(result.assertCurrent).toThrow('Original Commands withdrew')
})

it('keeps unselected native Session controls absent from bootstrap owner reads', async () => {
  const f = await fixture()
  await f.produce()
  for (const row of nativeControlRpc) expect(f.auditedRpc).not.toHaveBeenCalledWith(row.endpoint)
})

it.each([
  { endpoint: 'session/updateQueue', handlerId: 'native:sessionController', guard: 'authenticated-account' },
  { endpoint: 'session/updateQueue', handlerId: 'foreign:sessionController', guard: 'account-session' },
  { endpoint: 'session/modelCatalog', handlerId: 'native:sessionController', guard: 'account-session' },
  { endpoint: 'session/selectModel', handlerId: 'foreign:sessionController', guard: 'account-session' },
  { endpoint: 'commands/execute', handlerId: 'native:commands', guard: 'authenticated-account' },
  { endpoint: 'goals/get', handlerId: 'foreign:goals', guard: 'account-session' },
  { endpoint: 'permissionPresets/catalog', handlerId: 'native:permissionPresets', guard: 'account-session' },
  { endpoint: 'messageFeedback/put', handlerId: 'native:messageFeedback', guard: 'authenticated-account' },
  { endpoint: 'sessionFeedback/record', handlerId: 'foreign:sessionFeedback', guard: 'account-session' },
  { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'authenticated-account' },
  { endpoint: '$events/result', handlerId: 'foreign:typertGateway', guard: 'authenticated-account' },
  { endpoint: 'session/deleteEverything', handlerId: 'native:sessionController', guard: 'account-session' },
  { endpoint: 'workspace/readAnything', handlerId: 'native:workspaceController', guard: 'account-project' },
  { endpoint: 'remoteAccess/allow', handlerId: 'native:remoteAccess', guard: 'authenticated-account' },
] as const)('rejects an unreviewed native control or foreign declaration before owner admission: %j', async (row) => {
  const f = await fixture([row])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.auditedRpc).not.toHaveBeenCalledWith(row.endpoint)
})

it.each([
  { endpoint: 'session/anything', handlerId: 'native:sessionController', guard: 'account-session' },
  { endpoint: '$events', handlerId: 'foreign:typertGateway', guard: 'authenticated-account' },
  { endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'authenticated-account' },
] as const)('refuses an unreviewed or foreign native stream declaration: %j', async (row) => {
  const f = await fixture([], [row])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.auditedStream).not.toHaveBeenCalledWith(row.endpoint)
})

it('requires the exact original Session-bound userQuestions wait stream owner', async () => {
  const row: EndpointExposure = { endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'account-session' }
  const f = await fixture([], [row]), result = await f.produce()
  expect(f.auditedStream).toHaveBeenCalledWith(row.endpoint)
  f.auditedStream.mockImplementation(() => { throw new CloudApiError('cloud/account-unavailable', 'Original userQuestions withdrew') })
  expect(result.assertCurrent).toThrow('Original userQuestions withdrew')
})

it.each(['rpc', 'stream'] as const)('refuses an owner result whose actual %s handler or guard differs from its approved declaration', async (kind) => {
  const row: EndpointExposure = kind === 'rpc'
    ? { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'account-session' }
    : { endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'account-session' }
  const f = await fixture(kind === 'rpc' ? [row] : [], kind === 'stream' ? [row] : [])
  const audit = kind === 'rpc' ? f.auditedRpc : f.auditedStream
  const read = audit.getMockImplementation()
  if (read === undefined) throw new Error('Original audit missing')
  audit.mockImplementation(endpoint => endpoint === row.endpoint ? { ...row, handlerId: 'foreign:userQuestions' } : read(endpoint))
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

const sessionExport: readonly ExactFetchExposure[] = ['GET', 'HEAD'].map(method => ({ method,
  path: '/api/session.export', handlerId: 'native:sessionLogDownload', guard: 'account-session' as const }))

it('admits the native export HEAD and GET beside the existing upload and preview routes', async () => {
  const preview: ExactFetchExposure = { method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' }
  const f = await fixture([], [], [upload, preview, ...sessionExport]), result = await f.produce()
  for (const row of [upload, preview, ...sessionExport]) expect(f.auditedFetch).toHaveBeenCalledWith(row.method, row.path)
  f.auditedFetch.mockImplementation(() => { throw new CloudApiError('cloud/account-unavailable', 'Original export route ended') })
  expect(result.assertCurrent).toThrow('Original export route ended')
})

it.each([
  { ...sessionExport[0]!, method: 'POST' },
  { ...sessionExport[0]!, path: '/api/session.export/other' },
  { ...sessionExport[0]!, handlerId: 'foreign:sessionLogDownload' },
  { ...sessionExport[0]!, guard: 'authenticated-account' as const },
])('rejects a changed native export declaration before trusting its owner: %j', async (row) => {
  const f = await fixture([], [], [row])
  await expect(f.produce()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.auditedFetch).not.toHaveBeenCalled()
})
