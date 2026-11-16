/** Original configuration parsers and pure profile assembly; no listener, credentials, SDK or deployment starts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { applyServicePreview, rootEntryRows } from './service-preview-profile.mjs'

const inertRoute = { method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' }
const applicationRoute = { method: 'POST', path: '/cloud/service-application', handlerId: 'cloud:serviceApplication', guard: 'account-session' }
const transportLimits = { maxHeaderPairs: 32, maxHeaderBytes: 4096, highWaterMark: 4096, maxConnections: 16 }
function fixture(mode = 'service-application-v1') {
  const fields = { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' }
  const response = { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 512, maxHeaderCount: 32, maxHeaderBytes: 4096 }
  const access = { publicOrigin: 'http://console.auth.dsh.localhost:32803', deploymentMode: 'development', trustedProxyAddresses: [],
    authSecretRef: 'FIXTURE_AUTH_REF', sessionRecheckMs: 5000, authCheckTimeoutMs: 1000,
    maxPeers: 4, maxPeersPerAccount: 2, maxPeerWaiters: 8, maxPeerWaitersPerAccount: 4,
    maxPeerCarriers: 8, maxPeerCarriersPerAccount: 4, maxPeerCarriersPerLogin: 2, peerCloseTimeoutMs: 1000,
    maxAuthOperations: 4, maxTrackedLogins: 8, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 4, bindingFields: fields,
    database: { host: '127.0.0.1', port: 1, user: 'fixture', database: 'unavailable', passwordRef: 'FIXTURE_DB_REF', ssl: false },
    pool: { maxConnections: 2, connectionTimeoutMs: 500, statementTimeoutMs: 1000, lockTimeoutMs: 500,
      idleTimeoutMs: 1000, idleTransactionTimeoutMs: 5000, maxLifetimeSeconds: 10 },
    startupTimeoutMs: 1000, secretResolveTimeoutMs: 1000, maxSecretOperations: 2, maxSecretBytes: 128,
    ingress: { sessionRecheckLeadMs: 1000, maxOperations: 32, maxOperationsPerAccount: 16, requestTimeoutMs: 15000,
      maxAuthRequestBodyBytes: 4096, maxRequestBodyBytes: 4096, maxBootstrapResponseBytes: 8192, maxGenerationBindings: 8,
      maxFrameBytes: 8192, maxLogicalStreams: 8, maxLogicalStreamsPerAccount: 4, maxLogicalStreamsPerPeer: 2 } }
  const client = { client: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 15000, maxBootstrapResponseBytes: 8192,
    maxErrorResponseBytes: 512, maxPendingFetches: 4, maxSockets: 1, closeTimeoutMs: 1000 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 1024, maxListItems: 128 },
    persistenceLimits: { maxKeys: 8, maxKeyBytes: 256, maxValueBytes: 4096, maxTotalBytes: 16384, maxNamespaceBytes: 256 },
    fields, auth: { requestTimeoutMs: 15000, maxRequestBytes: 4096, maxResponseBytes: 4096 } }
  const selected = { mode, cookieDomain: 'auth.dsh.localhost', inertOrigin: 'http://text.auth.dsh.localhost:32803',
    inert: { maxUrlBytes: 2048, maxFieldBytes: 128, maxRequestHeaderCount: 32, maxRequestHeaderBytes: 4096, response } }
  if (mode === 'service-application-v1') Object.assign(selected, {
    applications: { origin: 'http://apps.dsh.localhost:32804', siteDomain: 'dsh.localhost',
      maxUrlBytes: 2048, maxPathBytes: 1024, maxRequestHeaderCount: 32, maxRequestHeaderBytes: 4096,
      maxRequestBodyBytes: 4096, maxQueuedRequests: 8, queueTimeoutMs: 15000, response,
      views: { maxViews: 8, maxViewsPerAccount: 4, maxRetainedBytes: 131072, maxFieldBytes: 128, lifetimeMs: 120000 } },
    client: { requestTimeoutMs: 15000, maxRequestBytes: 4096, maxResponseBytes: 2048, maxFieldBytes: 128 },
    listener: { host: '127.0.0.1', port: 18921, compression: 'none', transportLimits },
  })
  const input = { server: { host: '127.0.0.1', port: 18920, publicOrigin: access.publicOrigin, compression: 'none', transportLimits },
    servicePreview: selected }
  const rows = [{ id: 'access-root', config: access }, { id: 'api-root', config: { exactFetchRoutes: [inertRoute,
    ...mode === 'service-application-v1' ? [applicationRoute] : []] } }, { id: 'connection', config: { web: client } },
  { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: input.server.host, port: input.server.port } }]
  return { input: structuredClone(input), rows: structuredClone(rows) }
}

test('full mode enables the original Browser and isolated Native group without changing original budgets or input bytes', () => {
  const { input, rows } = fixture(), original = structuredClone(input), budgets = structuredClone(rows[0].config.ingress)
  const observed = applyServicePreview(input, rows)
  assert.equal(observed.mode, 'service-application-v1'); assert.deepEqual(input, original)
  const entries = rootEntryRows(rows), browser = entries.find(row => row.id === 'ui-sidebar-browser')
  assert.equal(browser.name, '@deepseek-ai/dsh-client-ui-sidebar-browser'); assert.equal(browser.disabled, false)
  const group = entries.find(row => row.id === 'service-content')
  assert.deepEqual(group.isolate, { webServer: true })
  assert.equal(entries.find(row => row.id === 'service-content-access').name, '@deepseek-ai/dsh-pe-cloud-access/applications')
  assert.equal(entries.find(row => row.id === 'service-content-webserver').config.port, 18921)
  assert.equal(rows[2].config.web.client.serviceApplications.contentOrigin, 'http://apps.dsh.localhost:32804')
  assert.deepEqual({ ...rows[0].config.ingress, servicePreview: undefined }, { ...budgets, servicePreview: undefined })
})

test('inert-only and omitted inputs do not manufacture an application listener', () => {
  const inert = fixture('inert-text-v1')
  assert.equal(applyServicePreview(inert.input, inert.rows).mode, 'inert-text-v1')
  assert.equal(inert.rows[0].config.applications, undefined)
  assert.equal(inert.rows.some(row => row.id === 'service-content'), false)
  delete inert.input.servicePreview; inert.rows[1].config.exactFetchRoutes = []
  assert.equal(applyServicePreview(inert.input, inert.rows), undefined)
  assert.equal(inert.rows[0].config.servicePreview, undefined)
})

test('group discovery follows only original Cordis groups, not account or preset configuration', () => {
  const preset = { id: 'preset', name: 'cordis:agent-preset', config: { plugins: [{ id: 'not-root' }] } }
  const rows = [preset, { id: 'group', name: 'cordis:group', group: true,
    config: [{ id: 'nested', name: 'cordis:group', group: true, config: [{ id: 'listener' }] }] }]
  assert.deepEqual(rootEntryRows(rows).map(row => row.id), ['preset', 'group', 'nested', 'listener'])
})

test('missing or altered exact approvals fail before any generated output', () => {
  for (const change of [rows => rows[1].config.exactFetchRoutes.pop(), rows => { rows[1].config.exactFetchRoutes[1].guard = 'authenticated-account' }]) {
    const f = fixture(); change(f.rows)
    assert.throws(() => applyServicePreview(f.input, f.rows), /Exact approved/)
  }
})

test('rejects ambiguous modes, unlimited listeners, colliding ports and oversized handoff budgets', () => {
  for (const change of [f => { f.input.servicePreview.mode = 'unknown' }, f => { delete f.input.servicePreview.client },
    f => { f.input.servicePreview.listener.transportLimits.maxConnections = 0 },
    f => { f.input.servicePreview.listener.port = f.input.server.port },
    f => { f.input.servicePreview.client.maxRequestBytes = 4097 }]) {
    const f = fixture(); change(f); assert.throws(() => applyServicePreview(f.input, f.rows))
  }
})

test('generated inputs pass the actual matching Root, public client and Native listener parsers without mounting resources', async () => {
  const anchor = process.env.DSH_DEPLOY_TEST_INSTALL_ANCHOR
  assert.ok(anchor?.startsWith('/'), 'Supply this checkout built package.json through DSH_DEPLOY_TEST_INSTALL_ANCHOR')
  const require = createRequire(anchor), load = name => import(pathToFileURL(require.resolve(name)).href)
  const [access, client, native, applications] = await Promise.all([load('@deepseek-ai/dsh-pe-cloud-access/root'),
    load('@deepseek-ai/dsh-pe-cloud-client/schema'), load('@deepseek-ai/dsh-host-webserver'), load('@deepseek-ai/dsh-pe-cloud-access/applications')])
  const f = fixture(); applyServicePreview(f.input, f.rows)
  access.parseAuthRootConfig(f.rows[0].config); client.parseCloudWebManifest(f.rows[2].config.web)
  const entries = rootEntryRows(f.rows), schema = native.Config ?? native.default.Config
  schema(f.rows[3].config); schema(entries.find(row => row.id === 'service-content-webserver').config)
  applications.Config({})
  const bad = fixture(); bad.input.servicePreview.applications.origin = 'http://apps.auth.dsh.localhost:32804'
  applyServicePreview(bad.input, bad.rows)
  assert.throws(() => access.parseAuthRootConfig(bad.rows[0].config))
})
