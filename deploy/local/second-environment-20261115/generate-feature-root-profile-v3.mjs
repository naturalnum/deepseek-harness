/** V3 fresh Root/account candidate assembly. No service launch, credentials read or existing profile access. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { declarationHash, renderAccountBase } from './profile-composition.mjs'
import { applyServicePreview, rootEntryRows } from './service-preview-profile.mjs'
import { prepareOfficeRuntime, stageOfficeRuntime, officeRuntimeTargets, stageOfficeFeatureAssets } from '../office-runtime.mjs'

const need = (value, message) => { if (!value) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const absolute = value => { need(typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value,
  'Canonical absolute path required'); return value }
const positive = value => { need(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'Explicit finite integer required'); return value }
const digest = value => { need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Actual protected SHA256 required'); return value }
const read = (name, maximum) => { const stat = fs.lstatSync(name); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
  && stat.size > 0 && stat.size <= maximum, 'Bounded ordinary source input required'); return fs.readFileSync(name) }
const args = process.argv.slice(2), options = {}
while (args.length) { const key = args.shift(), value = args.shift()
  need(['--input', '--sha256', '--output-dir', '--check-only', '--check-only-base-source'].includes(key) && value !== undefined && options[key] === undefined, 'Exact generator arguments required'); options[key] = value }
need(options['--check-only'] === undefined || options['--check-only'] === 'true', 'Only explicit --check-only true is permitted')
const checkOnly = options['--check-only'] === 'true'
need(options['--check-only-base-source'] === undefined || checkOnly, 'A substitute base source is permitted only for check-only tests')
need(checkOnly || process.platform === 'linux' && process.getuid() === 0, 'Only the executing Root writes a protected profile')
const raw = read(absolute(options['--input']), 1048576)
need(hash(raw) === digest(options['--sha256']), 'Pinned new profile parameters required')
const input = JSON.parse(raw)
need(input.schema === 'dsh-combined-root-profile/v3' && object(input.sourceTemplate) && input.sourceTemplate.path.endsWith('.in'),
  'Only an explicitly supplied public source .in template is permitted')
const source = read(absolute(input.sourceTemplate.path), 1048576)
need(hash(source) === digest(input.sourceTemplate.sha256), 'Public source template digest changed')
const patch = JSON.parse(source)
need(Array.isArray(patch) && patch.length === 1 && Array.isArray(patch[0].insert), 'Public Root insert template required')
const rows = patch[0].insert
function row(id) { const found = rows.filter(value => value.id === id); need(found.length === 1 && object(found[0].config), 'Unique Root entry required: ' + id); return found[0] }
const database = clone(input.database)
need(object(database) && Object.keys(database).sort().join(',') === 'database,host,passwordRef,port,ssl,user'
  && database.database === 'dsh_combined_features_20261107' && typeof database.passwordRef === 'string'
  && /^[A-Za-z_][A-Za-z0-9_]*$/.test(database.passwordRef) && typeof database.ssl === 'boolean', 'Only new DB coordinates and a credential reference are accepted')
positive(database.port)
need(object(input.credentials) && typeof input.credentials.authSecretRef === 'string'
  && /^[A-Za-z_][A-Za-z0-9_]*$/.test(input.credentials.authSecretRef), 'New authentication credential reference required')
absolute(input.credentials.path)
need(typeof input.recipeVersion === 'string' && input.recipeVersion.length > 0 && input.recipeVersion.length <= 128, 'Explicit recipe required')
need(object(input.server) && new URL(input.server.publicOrigin).origin === input.server.publicOrigin, 'Canonical public origin required')
positive(input.server.port)
for (const key of ['sharedAccountsRoot', 'localCacheRoot', 'nativeConfigPath', 'frontendIndex']) absolute(input.paths[key])
absolute(input.installAnchor)
need(object(input.administrator) && typeof input.administrator.id === 'string' && input.administrator.id.length > 0
  && input.administrator.slotId === 'account-slot-a', 'Authentic initializer administrator and the exact first slot are required')
need(object(input.api) && object(input.api.approvedConfiguration) && Array.isArray(input.api.rpcEndpoints)
  && Array.isArray(input.api.streamEndpoints) && Array.isArray(input.api.exactFetchRoutes) && Array.isArray(input.api.allowedSettings),
  'Complete current nonsecret API policy is required; the historical locale-only policy is never adopted implicitly')
need(object(input.runtime) && object(input.runtime.accountPolicy) && Array.isArray(input.runtime.accountPolicy.presets)
  && typeof input.runtime.accountPolicy.defaultPresetId === 'string'
  && !Object.hasOwn(input.runtime.accountPolicy, 'presetId') && !Object.hasOwn(input.runtime.accountPolicy, 'presetEntryId'),
  'Current multi-preset account policy is required; old October policy fields are forbidden')
for (const preset of input.runtime.accountPolicy.presets) digest(preset.configSha256)
need(object(input.native) && Array.isArray(input.native.requiredEntryIds) && input.native.requiredEntryIds.length > 0,
  'Exact new public account-base inventory required')
need(object(input.execution) && input.execution.mode === 'session-collect' && object(input.execution.managed),
  'Complete current managed execution configuration required; closed/sample execution is not substituted')
need(object(input.executionDeployment) && typeof input.executionDeployment.path === 'string', 'New protected RootDeployment reference required')
absolute(input.executionDeployment.path); digest(input.executionDeployment.sha256)
need(object(input.storage), 'Actual measured v3 storage inputs required')
for (const key of ['planPath', 'probeHelperPath', 'helperPath']) absolute(input.storage[key])
digest(input.storage.planSha256); digest(input.storage.probeHelperSha256)

const credentials = row('credentials').config, web = row('webserver').config
credentials.path = input.credentials.path; credentials.watch = false
web.host = input.server.host; web.port = input.server.port; delete web.tls
const api = row('api-root').config = { ...clone(input.api), recipeVersion: input.recipeVersion }
api.approvedConfiguration.recipeVersion = input.recipeVersion
// The native original MCP service and exact one-RPC contract; no synthetic browser capability or role restriction.
const mcp = { limits: { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 8192, maxHeaderCount: 16,
  maxToolCallTimeoutMs: 60000, maxRequestBytes: 32768, maxReplyBytes: 65536 },
  runtime: { maxInstructionBytes: 32768, maxIncomingResponseBytes: 4194304, listMaxPages: 4, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 5 } } }
api.approvedConfiguration.mcp = clone(input.mcp ?? mcp)
need(!api.streamEndpoints.some(value => value.endpoint.startsWith('cloudMcpConnections/'))
  && !api.exactFetchRoutes.some(value => value.path.includes('cloudMcpConnections')), 'MCP has no stream or fetch exposure')
const mcpRows = api.rpcEndpoints.filter(value => value.endpoint.startsWith('cloudMcpConnections/'))
need(mcpRows.every(value => value.endpoint === 'cloudMcpConnections/action' && value.handlerId === 'native:cloudMcpConnections'
  && value.guard === 'authenticated-account') && mcpRows.length <= 1, 'Only the exact MCP management RPC is permitted')
if (mcpRows.length === 0) api.rpcEndpoints.push({ endpoint: 'cloudMcpConnections/action', handlerId: 'native:cloudMcpConnections', guard: 'authenticated-account' })

let modelKeyEntry
if (input.model !== undefined) {
  need(object(input.model) && typeof input.model.entryId === 'string' && typeof input.model.keyEntryId === 'string'
    && input.model.provider === 'deepseek-official' && typeof input.model.model === 'string'
    && typeof input.model.apiKeyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(input.model.apiKeyRef), 'Explicit original model provider/key entries required')
  let endpoint
  try { endpoint = new URL(input.model.baseURL) } catch { throw new Error('A canonical HTTP model root URL is required') }
  need(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'Messages-compatible model root URL required')
  need(input.runtime.accountPolicy.models.some(value => value.provider === input.model.provider && value.model === input.model.model),
    'The mock/real provider model must already be an explicitly approved account route')
  api.approvedConfiguration.modelKey ??= { bindings: [{ provider: input.model.provider, providerEntryId: input.model.entryId,
    moduleName: '@deepseek-ai/dsh-llm-deepseek-api-key', ref: input.model.apiKeyRef }],
    maxKeyBytes: 8192, maxVersionBytes: 256, maxReplyBytes: 32768, maxMetadataBytes: 32768 }
  for (const binding of api.approvedConfiguration.modelKey.bindings) {
    if (binding.ref === 'REQUIRED_NEW_MODEL_API_KEY_REF') binding.ref = input.model.apiKeyRef
  }
  need(api.approvedConfiguration.modelKey.bindings.some(value => value.provider === input.model.provider
    && value.providerEntryId === input.model.entryId && value.ref === input.model.apiKeyRef), 'Actual model/key approval must agree')
  const methods = ['metadata', 'describe', 'set', 'unset'].map(value => 'cloudModelKey/' + value)
  for (const value of api.rpcEndpoints.filter(value => value.endpoint.startsWith('cloudModelKey/'))) {
    need(methods.includes(value.endpoint) && value.handlerId === 'native:cloudModelKey' && value.guard === 'authenticated-account',
      'Only the original exact model-key RPC group is permitted')
  }
  for (const endpoint of methods) if (!api.rpcEndpoints.some(value => value.endpoint === endpoint)) {
    api.rpcEndpoints.push({ endpoint, handlerId: 'native:cloudModelKey', guard: 'authenticated-account' })
  }
  modelKeyEntry = { id: input.model.keyEntryId, name: 'cordis:pe-cloud-model-key' }
}

const sourceRuntime = clone(row('runtime-root').config)
const runtime = row('runtime-root').config = { ...row('runtime-root').config, ...clone(input.runtime),
  recipeVersion: input.recipeVersion, internalAddress: input.server.internalAddress, database: clone(database),
  maxMountedAccounts: 3, paths: { ...row('runtime-root').config.paths, sharedAccountsRoot: input.paths.sharedAccountsRoot,
    localCacheRoot: input.paths.localCacheRoot },
  staticAccounts: { initialAssignments: [{ accountId: input.administrator.id, slotId: input.administrator.slotId }] } }
runtime.pg = { ...sourceRuntime.pg, ...input.runtime.pg }
runtime.factory = { ...sourceRuntime.factory, ...input.runtime.factory }
runtime.saves = { ...sourceRuntime.saves, ...input.runtime.saves, maxAccounts: 3 }
runtime.native = { ...row('runtime-root').config.native, ...clone(input.native), configPath: input.paths.nativeConfigPath,
  installAnchor: input.installAnchor, bareModuleBaseUrl: pathToFileURL(input.installAnchor).href }
runtime.native.requiredEntryIds = [...new Set([...runtime.native.requiredEntryIds, 'cloud-mcp-connections', ...modelKeyEntry === undefined ? [] : [modelKeyEntry.id]])]
// No maintenance authority or old canary state is inherited from a public source fixture.
delete runtime.recovery; delete runtime.officeCanary
need(object(input.files) && object(input.files.content), 'Current content-capable helper requires explicit finite content limits')
if (api.approvedConfiguration.skills.mode === 'managed') {
  for (const key of ['skillBundles', 'skillProjection', 'skillVersions', 'staging']) {
    need(object(input.files[key]), 'Managed skill policy requires its current complete Files configuration: ' + key)
  }
}
const sourceFiles = clone(row('files-root').config)
const files = row('files-root').config = { ...row('files-root').config, ...clone(input.files ?? {}), maxLanes: 3,
  helperPath: input.storage.helperPath }
files.staticStorage = { ...sourceFiles.staticStorage, ...input.files?.staticStorage, planPath: input.storage.planPath, planSha256: input.storage.planSha256,
  probeHelperPath: input.storage.probeHelperPath, probeHelperSha256: input.storage.probeHelperSha256 }
delete files.staticStorage.skillRevalidation
if (input.storage.stagingHelperPath !== undefined) {
  absolute(input.storage.stagingHelperPath); need(object(files.staging), 'Staging limits must accompany an actual staging helper')
  files.staging.helperPath = input.storage.stagingHelperPath
}
const execution = row('execution-root').config = { ...clone(input.execution), rootDeployment: { path: input.executionDeployment.path, sha256: input.executionDeployment.sha256 } }
execution.managed.maxBoundAccounts = 3
need(execution.managed.allocations.maxAllocations >= 3, 'Execution must retain at least three actual account allocations')
const sourceAccess = clone(row('access-root').config)
const access = row('access-root').config = { ...row('access-root').config, ...clone(input.access ?? {}),
  publicOrigin: input.server.publicOrigin, database: clone(database), authSecretRef: input.credentials.authSecretRef, disableSignUp: true,
  accountAdministration: { maxAccounts: 3, maxPageSize: 3, initialAdministratorIds: [input.administrator.id] } }
access.pool = { ...sourceAccess.pool, ...input.access?.pool }
access.ingress = { ...sourceAccess.ingress, ...input.access?.ingress }
delete access.servicePreview; delete access.applications; delete access.ingress.ownerForwarding; delete access.ingress.servicePreview
access.pool.maxConnections = Math.max(2, access.pool.maxConnections)
const preparationMs = runtime.accountWaitTimeoutMs + 16 * (runtime.pg.queueTimeoutMs + runtime.pg.statementTimeoutMs)
const tailMs = 2 * (access.pool.connectionTimeoutMs + access.pool.statementTimeoutMs)
access.authCheckTimeoutMs = Math.max(access.authCheckTimeoutMs, preparationMs + tailMs + 1000)
access.pool.idleTransactionTimeoutMs = Math.max(access.pool.idleTransactionTimeoutMs, preparationMs + access.authCheckTimeoutMs + tailMs + 1000)
positive(access.authCheckTimeoutMs); positive(access.pool.idleTransactionTimeoutMs)
access.ingress.requestTimeoutMs = Math.max(access.ingress.requestTimeoutMs, access.authCheckTimeoutMs + 1000)
access.ingress.sessionRecheckLeadMs = input.access?.ingress?.sessionRecheckLeadMs ?? Math.min(1000, Math.floor(access.sessionRecheckMs / 2))
positive(access.ingress.sessionRecheckLeadMs)
row('frontend-static').config.distIndex = input.paths.frontendIndex
row('frontend-static').config.indexAuth = 'public'
const connection = row('connection')
if (input.client !== undefined) connection.config.web = clone(input.client)
connection.config.web.fields = clone(access.bindingFields)
delete connection.config.web.client.servicePreview; delete connection.config.web.client.serviceApplications
connection.config.web.client.bootstrapTimeoutMs = Math.max(connection.config.web.client.bootstrapTimeoutMs, runtime.accountWaitTimeoutMs + 1000)
if (modelKeyEntry !== undefined) connection.config.web.client.modelSettingsRequestTimeoutMs ??= 30000
connection.inject = ['clientModules']
const servicePreview = applyServicePreview(input, rows)
// Only the newly supplied reference name is substituted; credential values are never opened.
need(input.model !== undefined, 'The complete new model provider/reference is required')
const replacePublicReferences = value => JSON.parse(JSON.stringify(value).replaceAll('REQUIRED_NEW_MODEL_API_KEY_REF', input.model.apiKeyRef))
for (const value of rows) value.config = replacePublicReferences(value.config)
const serialized = JSON.stringify(patch, null, 2) + '\n'
need(!/REQUIRED_NEW|__PUBLIC_BASELINE__|@@|ROOT_TO_/.test(serialized), 'Unresolved public placeholder in the final Root profile')
need(!serialized.includes('@@') && !serialized.includes('ROOT_TO_') && !serialized.includes('/srv/dsh-cloud-trial')
  && !serialized.includes('/dsh-state/fresh'), 'An old identity/path or source placeholder remains in the new profile')

const output = absolute(options['--output-dir'])
need(!fs.existsSync(output), 'Output must be newly owned; no overwrite or regeneration')
need(input.paths.nativeConfigPath === '/opt/dsh-features/account-base.yml'
  && input.native.configPath === input.paths.nativeConfigPath
  && input.storage.planPath === output + '/storage-plan.json'
  && input.executionDeployment.path === output + '/rootDeployment.json', 'The measured shared base path is fixed; final plan/deployment references must target the fresh DSH_HOME')
function pinned(reference) {
  need(object(reference), 'Explicit pinned public/protected new source required')
  const bytes = read(absolute(reference.path), 1048576)
  need(hash(bytes) === digest(reference.sha256), 'Pinned new source changed')
  return bytes
}
const sharedBaseBytes = renderAccountBase(pinned(input.accountBase), input.model.apiKeyRef)
const sharedBase = JSON.parse(sharedBaseBytes)
need(digest(input.nativeBaseSha256) === hash(sharedBaseBytes), 'The rendered shared account base digest must be explicitly pinned')
const accountSkeleton = JSON.parse(pinned(input.accountSkeleton))
const planBytes = pinned({ path: input.storage.planSourcePath, sha256: input.storage.planSha256 })
const deploymentBytes = pinned({ path: input.executionDeployment.sourcePath, sha256: input.executionDeployment.sha256 })
need(Array.isArray(sharedBase) && Array.isArray(accountSkeleton), 'Public Native account base and skeleton required')

const require = createRequire(pathToFileURL(input.installAnchor)), dependencies = {}
for (const value of rootEntryRows(rows)) if (value.name?.startsWith('@') || value.name?.startsWith('deepscientist-harness-suite')) {
  const name = value.name.startsWith('@') ? value.name.split('/').slice(0, 2).join('/') : value.name.split('/')[0], meta = JSON.parse(read(require.resolve(name + '/package.json'), 131072))
  need(meta.name === name && typeof meta.version === 'string', 'Actual installed package metadata required'); dependencies[name] = meta.version
}
const { composeEntries } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { parseStorageDeploymentPlan } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pe-cloud-files/root')).href)
const { parseRootDeploymentInput } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pe-opensandbox')).href)
const protectedDeployment = parseRootDeploymentInput(JSON.parse(deploymentBytes))
const officeRuntime = input.officeRuntime === undefined ? undefined
  : await prepareOfficeRuntime(input.officeRuntime, protectedDeployment.lifecycle, input.installAnchor)
const officeTargets = new Set()
need(protectedDeployment.schema === 'pe-opensandbox-root-deployment-v2'
  && protectedDeployment.storage.plan.path === input.storage.planPath
  && protectedDeployment.storage.plan.sha256 === input.storage.planSha256, 'Files and SDK must pin the exact same final namespace plan')
need(object(input.researchSupplier) && protectedDeployment.lifecycle.imageDigest === input.researchSupplier.workloadImageDigest
  && protectedDeployment.selection.serverImageDigest === input.researchSupplier.serverImageDigest,
  'The original approved scientific workload/server pair must match the new protected deployment')
need(protectedDeployment.lifecycle.environmentVersion === execution.managed.allocations.environmentVersion
  && protectedDeployment.lifecycle.provider === execution.managed.allocations.provider, 'SDK lifecycle and managed allocation identity must match')
const measured = parseStorageDeploymentPlan(planBytes, runtime.paths.maxPathBytes)
need(measured.version === 3 && measured.slots.length === 3 && measured.maxAccounts === 3, 'Exactly three measured physical slots required')
need(measured.baseConfigPath === input.paths.nativeConfigPath && runtime.native.configPath === measured.baseConfigPath,
  'Measured plan, Runtime and input must use the original provisioned shared account base path')
const existingBaseBytes = read(absolute(options['--check-only-base-source'] ?? input.paths.nativeConfigPath), 1048576)
need(hash(existingBaseBytes) === input.nativeBaseSha256, 'The already prepared measured shared account base differs from the public rendered candidate')
need(measured.slots.some(slot => slot.slotId === input.administrator.slotId), 'Administrator must use an actual measured slot')
const slotPatches = []
for (const slot of measured.slots) {
  const accountPatch = replacePublicReferences(JSON.parse(JSON.stringify(accountSkeleton).replaceAll('/__PUBLIC_BASELINE__/account', slot.accountRoot)))
  const provider = accountPatch.flatMap(value => value.insert ?? [value]).find(value => value.id === input.model.entryId)
  need(provider?.config !== undefined, 'Original account model provider patch required')
  provider.config = { ...provider.config, baseURL: input.model.baseURL, apiKeyEnv: input.model.apiKeyRef, models: [{ id: input.model.model }] }
  const effective = composeEntries([[{ insert: sharedBase }], accountPatch], warning => { throw new Error('Native account composition warning: ' + warning) })
  for (const target of officeRuntimeTargets(effective, officeRuntime)) officeTargets.add(target)
  need(new Set(effective.map(value => value.id)).size === effective.length, 'Duplicate account native entry')
  for (const selected of runtime.accountPolicy.presets) {
    const actual = effective.find(value => value.id === selected.entryId)
    need(actual && declarationHash(actual.config) === selected.configSha256, 'Approved Preset differs from the final native composition: ' + selected.id)
  }
  need(runtime.accountPolicy.defaultPresetId === 'standard' && runtime.accountPolicy.presets.some(value => value.id === 'research-suite' && value.selectable),
    'Standard default and independent selectable Research preset required')
  need(runtime.native.requiredEntryIds.every(id => id === 'include' || effective.some(value => value.id === id)), 'Required native account entry missing')
  const patchBytes = JSON.stringify(accountPatch, null, 2) + '\n'
  need(!/REQUIRED_NEW|__PUBLIC_BASELINE__|@@|ROOT_TO_/.test(patchBytes), 'Unresolved slot account placeholder')
  slotPatches.push({ slotId: slot.slotId, accountRoot: slot.accountRoot, storageKey: slot.storageKey,
    target: slot.private.rootPath + '/profile/cordis.patch.yml', bytes: patchBytes, sha256: hash(Buffer.from(patchBytes)) })
}
need(api.approvedConfiguration.mcp.runtime.maxIncomingResponseBytes === 4194304
  && api.approvedConfiguration.mcp.runtime.listMaxPages === 4, 'The reviewed MCP incoming response/page bounds are required')
need(api.rpcEndpoints.some(value => value.endpoint === 'cloudResearch/action' && value.handlerId === 'native:cloudResearch'
  && value.guard === 'account-session'), 'Exact session-authorized research RPC required')
const rootSchemas = []
for (const id of ['webserver', 'runtime-root', 'api-root', 'files-root', 'execution-root', 'access-root', 'connection']) {
  const value = row(id), namespace = await import(pathToFileURL(require.resolve(value.name)).href)
  const schema = namespace.Config ?? namespace.default?.Config
  need(typeof schema === 'function', 'Actual installed Loader schema required: ' + id)
  schema(value.config); rootSchemas.push(id)
}
const accessModule = await import(pathToFileURL(require.resolve(row('access-root').name)).href)
need(typeof accessModule.parseAuthRootConfig === 'function', 'Matching installed full Root policy parser required')
accessModule.parseAuthRootConfig(access)
if (servicePreview !== undefined) {
  const clientModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pe-cloud-client/schema')).href)
  clientModule.parseCloudWebManifest(connection.config.web)
  for (const value of rootEntryRows(rows).filter(value => value.name === '@deepseek-ai/dsh-host-webserver' && value.id !== 'webserver'
    || value.name === '@deepseek-ai/dsh-pe-cloud-access/applications')) {
    const namespace = await import(pathToFileURL(require.resolve(value.name)).href)
    const schema = namespace.Config ?? namespace.default?.Config
    need(typeof schema === 'function', 'Actual installed content listener Loader schema required')
    schema(value.config); rootSchemas.push(value.id)
  }
}
if (checkOnly) {
  console.log(JSON.stringify({ status: 'loader-schemas-and-account-composition-checked-no-write', validatedLoaderSchemas: rootSchemas, ...servicePreview === undefined ? {} : { servicePreview }, protectedDeploymentParsed: true, nativeBasePath: runtime.native.configPath, nativeBaseSha256: input.nativeBaseSha256, substitutedBaseForCheckOnly: options['--check-only-base-source'] !== undefined, slots: slotPatches.length, credentialsRead: false, applicationStarted: false }))
  process.exit(0)
}
function directory(name, mode = 0o755) { fs.mkdirSync(name, { mode }); fs.chownSync(name, 0, 0); fs.chmodSync(name, mode) }
function write(name, bytes, mode = 0o444, uid = 0, gid = 0) { const fd = fs.openSync(name, 'wx', mode)
  try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
directory(output); directory(output + '/profiles'); directory(output + '/profiles/cloud'); directory(output + '/account-slots')
write(output + '/account-base.native.json', sharedBaseBytes)
if (officeRuntime !== undefined) {
  stageOfficeRuntime(officeRuntime, output + '/office-runtime')
  const featureAssetsDirectory = stageOfficeFeatureAssets(officeRuntime, {
    directory: output + '/feature-assets', accountBaseBytes: sharedBaseBytes, targets: [...officeTargets],
    nativeConfigPath: input.paths.nativeConfigPath, productRoot: path.dirname(input.installAnchor),
  })
  write(output + '/OFFICE-INSTALLATION.json', JSON.stringify({ ...officeRuntime.receipt,
    source: output + '/office-runtime/runtime.json', featureAssetsDirectory,
    mountTarget: path.dirname(input.paths.nativeConfigPath), targets: [...officeTargets], installed: false }, null, 2) + '\n')
}
write(output + '/storage-plan.json', planBytes); write(output + '/rootDeployment.json', deploymentBytes, 0o440, 0, 2000)
for (const slot of slotPatches) {
  directory(output + '/account-slots/' + slot.slotId)
  write(output + '/account-slots/' + slot.slotId + '/cordis.patch.yml', slot.bytes)
}
write(output + '/ACCOUNT-INSTALLATION.json', JSON.stringify({ schema: 'dsh-account-slot-patches/v3',
  instructions: 'Install each candidate into only its measured private profile path with uid/gid 2000 mode0600 before startup; preserve all other slot files.',
  slots: slotPatches.map(({ bytes, ...metadata }) => metadata), installed: false }, null, 2) + '\n')
write(output + '/profiles/cloud/package.json', JSON.stringify({ name: 'dsh-profile-cloud', private: true,
  dsh: { profile: { bundles: [] } }, dependencies }, null, 2) + '\n')
write(output + '/profiles/cloud/cordis.patch.yml', serialized)
write(output + '/profiles/cloud/cordis.yml', '', 0o600, 2000, 2000)
fs.symlinkSync(path.posix.dirname(input.installAnchor) + '/node_modules', output + '/profiles/cloud/node_modules', 'dir')
const mcpEntry = { id: 'cloud-mcp-connections', name: 'cordis:pe-cloud-mcp-connections' }
write(output + '/account-mcp.insert.json', JSON.stringify([mcpEntry], null, 2) + '\n')
if (input.model !== undefined) {
  write(output + '/account-model-key.insert.json', JSON.stringify([modelKeyEntry], null, 2) + '\n')
  need(object(input.model) && typeof input.model.entryId === 'string' && input.model.provider === 'deepseek-official'
    && typeof input.model.model === 'string' && typeof input.model.apiKeyRef === 'string', 'Original DeepSeek provider model patch required')
  write(output + '/account-model.patch.json', JSON.stringify([{ id: input.model.entryId, config: { baseURL: input.model.baseURL,
    apiKeyEnv: input.model.apiKeyRef, models: [{ id: input.model.model }] } }], null, 2) + '\n')
}
write(output + '/GENERATION.json', JSON.stringify({ schema: 'dsh-combined-root-profile-result/v3', recipeVersion: input.recipeVersion,
  ...servicePreview === undefined ? {} : { servicePreview },
  profileSha256: hash(Buffer.from(serialized)), storagePlanSha256: input.storage.planSha256, rootDeployment: { path: input.executionDeployment.path, sha256: input.executionDeployment.sha256 },
  authenticAdministratorId: input.administrator.id, slots: 3, mcpAccountEntryRequired: mcpEntry,
  ordinaryUsersMayManageOwnMcp: true, accountBaseMustAlreadyContainMcpEntry: true,
  ...modelKeyEntry === undefined ? {} : { modelKeyAccountEntryRequired: modelKeyEntry }, credentialsRead: false,
  nativeBasePath: runtime.native.configPath, nativeBaseSha256: input.nativeBaseSha256, schemaValidationPending: false, validatedLoaderSchemas: rootSchemas, protectedDeploymentParsed: true, applicationStarted: false, actualAccountReady: false,
  budgets: { authOperationMs: access.authCheckTimeoutMs, authIdleTransactionMs: access.pool.idleTransactionTimeoutMs,
    preparationMs, providerTailMs: tailMs } }, null, 2) + '\n')
console.log(JSON.stringify({ status: 'new-root-profile-candidate-generated-not-started', outputDirectory: output,
  profileSha256: hash(Buffer.from(serialized)), credentialsRead: false, schemaValidationPending: false }))
