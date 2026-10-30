/** C11 projection from original graph owners and explicitly audited execution/file policies. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { CloudAccountApi, CloudApiError, ExposureService, approvedSettingsMatch, MODEL_KEY_RPC_ENDPOINTS, PLUGIN_RPC_ENDPOINTS } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import { accountExecutionMode, accountServiceAvailability, assertAccountExecutionProviders } from '@deepseek-ai/dsh-pe-opensandbox'
import type { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { FILE_UPLOAD_PATH } from '@deepseek-ai/dsh-client-file-upload'
import { SESSION_LOG_EXPORT_PATH } from '@deepseek-ai/dsh-session-log-export'
import type { EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import { SERVICE_PREVIEW_ROUTE } from './preview-route.ts'
import { decodeCloudBootstrap } from './bootstrap.ts'
import { inspectBootstrapConfiguration } from './bootstrap-inventory.ts'
import type { CloudBootstrap } from './types.ts'

function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The actual bootstrap prerequisites could not be confirmed.') }
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
}

const fileRpcEndpoints: readonly string[] = [
  'workspaceFiles/read', 'workspaceFiles/stat', 'workspaceFiles/list', 'workspaceFiles/readBytes',
]
const fileStreamEndpoint = 'workspaceFiles/changes'

const nativeRpc: Readonly<Record<string, Pick<EndpointExposure, 'handlerId' | 'guard'>>> = {
  'session/create': { handlerId: 'native:sessionController', guard: 'account-project' },
  ...Object.fromEntries(['prompt', 'fork', 'cancel', 'page', 'list', 'selectModel', 'updateQueue'].map(method => [
    'session/' + method, { handlerId: 'native:sessionController', guard: 'account-session' as const },
  ])),
  'session/modelCatalog': { handlerId: 'native:sessionController', guard: 'authenticated-account' },
  'workspace/initializeDefault': { handlerId: 'native:workspaceController', guard: 'account-project' },
  'workspace/create': { handlerId: 'native:workspaceController', guard: 'account-project' },
  'settings/describe': { handlerId: 'native:settingsController', guard: 'authenticated-account' },
  'cloudProjects/create': { handlerId: 'native:cloudProjects', guard: 'authenticated-account' },
  ...Object.fromEntries(fileRpcEndpoints.map(endpoint => [endpoint, { handlerId: 'native:workspaceFiles', guard: 'account-session' as const }])),
  ...Object.fromEntries(['list', 'execute'].map(method => [
    'commands/' + method, { handlerId: 'native:commands', guard: 'account-session' as const },
  ])),
  ...Object.fromEntries(['get', 'edit', 'pause', 'resume', 'clear', 'create', 'complete'].map(method => [
    'goals/' + method, { handlerId: 'native:goals', guard: 'account-session' as const },
  ])),
  'permissionPresets/catalog': { handlerId: 'native:permissionPresets', guard: 'authenticated-account' },
  ...Object.fromEntries(['list', 'put', 'delete'].map(method => [
    'messageFeedback/' + method, { handlerId: 'native:messageFeedback', guard: 'account-session' as const },
  ])),
  'sessionFeedback/record': { handlerId: 'native:sessionFeedback', guard: 'account-session' },
  'userQuestions/answer': { handlerId: 'native:userQuestions', guard: 'account-session' },
  '$events/result': { handlerId: 'native:typertGateway', guard: 'authenticated-account' },
}
const nativeStreams: Readonly<Record<string, Pick<EndpointExposure, 'handlerId' | 'guard'>>> = {
  'session/follow': { handlerId: 'native:sessionController', guard: 'account-session' },
  'session/control': { handlerId: 'native:sessionController', guard: 'account-session' },
  'workspace/follow': { handlerId: 'native:workspaceController', guard: 'account-project' },
  'remoteAccess/follow': { handlerId: 'native:remoteAccess', guard: 'authenticated-account' },
  '$events': { handlerId: 'native:typertGateway', guard: 'authenticated-account' },
  'userQuestions/attachWait': { handlerId: 'native:userQuestions', guard: 'account-session' },
  [fileStreamEndpoint]: { handlerId: 'native:workspaceFiles', guard: 'account-session' },
}

function selectedNative(row: EndpointExposure, expected: Readonly<Record<string, Pick<EndpointExposure, 'handlerId' | 'guard'>>>): boolean {
  const native = Object.hasOwn(expected, row.endpoint) ? expected[row.endpoint] : undefined
  return native !== undefined && row.handlerId === native.handlerId && row.guard === native.guard
}

/**
 * Read original account providers and emit only the existing bounded C11 wire fields.
 * Open skill/plugin groups and the single approved locale writer retain the original endpoint audits.
 * @param ctx Exact context from the actual AccountUse.
 * @param binding Exact runtime-issued AccountUse binding.
 * @param exposure Original Root exposure owner captured by PeAuthService.
 * @param resolvePackages Original Root package-provider read; absence cannot become an empty installed catalog.
 * @param account Metadata from the same library-verified login, never a separate account lookup.
 * @param maximum Complete response/string/list bound from the existing ingress configuration.
 * @param signal Original request observer combined with the account lifetime.
 * @param current Original operation/login/Use/Root admission, checked around all awaited work.
 * @param generation Original access generation issuer; it grants no additional readiness.
 * @param recheckLogin Original ingress-owned captured-cookie verification after awaited work, before the same synchronous guards.
 * @returns Bounded compact JSON and an original-fact recheck to run immediately before response.end.
 */
export async function produceCloudBootstrap(
  ctx: Context, binding: AccountBinding, exposure: ExposureService | undefined, resolvePackages: () => PluginPackages | undefined,
  account: CloudBootstrap['account'], maximum: number, signal: AbortSignal,
  current: () => void, generation: () => string, recheckLogin?: () => Promise<void>,
): Promise<{ readonly body: string; readonly assertCurrent: () => void }> {
  current()
  if (!(exposure instanceof ExposureService) || account.id !== binding.accountId
    || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) unavailable()
  const catalog = exposure.approvedConfiguration, manifest = exposure.policy.manifest
  if (catalog === undefined || catalog.recipeVersion !== binding.recipeVersion
    || manifest.recipeVersion !== binding.recipeVersion) unavailable()
  const skillRpcEndpoints = catalog.skills.mode === 'closed' ? [] : catalog.skills.mode === 'sample'
    ? ['cloudSkills/current', 'cloudSkills/publish']
    : ['cloudSkills/current', 'cloudSkills/publish', 'cloudSkills/installed', 'cloudSkills/details',
      'cloudSkills/install', 'cloudSkills/update', 'cloudSkills/uninstall', 'cloudSkills/download']
  const pluginRpcEndpoints = catalog.pluginControl === undefined ? [] : PLUGIN_RPC_ENDPOINTS
  const settingsWrites = catalog.fields.length !== 0
  const settingsWriter = manifest.rpcEndpoints.find(row => row.endpoint === 'settings/mutate')
  const api = ctx.get('peCloudApi'), files = ctx.get('peCloudFiles')
  if (!(api instanceof CloudAccountApi) || !(files instanceof CloudAccountFiles)
    || files.binding !== binding || api.binding !== binding) unavailable()
  api.assertInstalled(ctx)
  files.assertInstalled(ctx)
  const project = files.project(), registry = ctx.get('workspaceRegistry')
  const selectedFiles = manifest.rpcEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/'))
    || manifest.streamEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/'))
  const previewSelected = fileRpcEndpoints.every(endpoint => manifest.rpcEndpoints.some(row => row.endpoint === endpoint))
    && manifest.streamEndpoints.some(row => row.endpoint === fileStreamEndpoint)
  const services = accountServiceAvailability(ctx)
  const previewRouteSelected = manifest.exactFetchRoutes.some(row => row.method === SERVICE_PREVIEW_ROUTE.method
    && row.path === SERVICE_PREVIEW_ROUTE.path)
  const identitiesCurrent = (): void => {
    signal.throwIfAborted()
    current()
    const currentApi = ctx.get('peCloudApi'), currentFiles = ctx.get('peCloudFiles'), currentRegistry = ctx.get('workspaceRegistry')
    if (ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding || exposure.approvedConfiguration !== catalog
      || exposure.policy.manifest !== manifest || currentApi === undefined || currentFiles === undefined
      || original(currentApi) !== original(api) || original(currentFiles) !== original(files)) unavailable()
    api.assertInstalled(ctx)
    files.assertInstalled(ctx)
    if (files.project() !== project || project.binding !== binding || registry === undefined
      || currentRegistry === undefined || original(currentRegistry) !== original(registry)
      || registry.get(project.workspace.id) !== project.workspace) unavailable()
    assertAccountExecutionProviders(ctx)
    const liveServices = accountServiceAvailability(ctx)
    if (liveServices.developmentServices !== services.developmentServices
      || liveServices.servicePreview !== services.servicePreview) unavailable()
  }
  const factsCurrent = (): void => {
    identitiesCurrent()
    // Only reviewed original upload, Session export and Root preview routes may coexist.
    const settings = manifest.allowedSettings
    // Every approved native leaf agrees with the original C04 field declarations.
    if (!approvedSettingsMatch(catalog.fields, settings)
      || settingsWrites && (settingsWriter === undefined
        || settingsWriter.handlerId !== 'native:settingsController' || settingsWriter.guard !== 'authenticated-account')
      || manifest.exactFetchRoutes.length > 4) unavailable()
    const selectedFetch = new Set<string>()
    for (const row of manifest.exactFetchRoutes) {
      const upload = row.method === 'POST' && row.path === FILE_UPLOAD_PATH && row.handlerId === 'native:fileUploads'
      const preview = row.method === SERVICE_PREVIEW_ROUTE.method && row.path === SERVICE_PREVIEW_ROUTE.path
        && row.handlerId === SERVICE_PREVIEW_ROUTE.handlerId
      const sessionExport = (row.method === 'GET' || row.method === 'HEAD') && row.path === SESSION_LOG_EXPORT_PATH
        && row.handlerId === 'native:sessionLogDownload'
      const key = `${row.method} ${row.path}`
      if ((!upload && !preview && !sessionExport) || row.guard !== 'account-session' || selectedFetch.has(key)) unavailable()
      selectedFetch.add(key)
      // Original API checks its audited manifest and freshly inspects actual native + Root inventory.
      const actual = api.requireFetch(row.method, row.path)
      if (actual.handlerId !== row.handlerId || actual.guard !== row.guard) unavailable()
    }
    const budget = catalog.maxEntries
    if (manifest.rpcEndpoints.length + manifest.streamEndpoints.length > budget) unavailable()
    if (skillRpcEndpoints.some(endpoint => !manifest.rpcEndpoints.some(row => row.endpoint === endpoint))) unavailable()
    if (pluginRpcEndpoints.some(endpoint => !manifest.rpcEndpoints.some(row => row.endpoint === endpoint))) unavailable()
    for (const row of manifest.rpcEndpoints) {
      const settingsMutation = settingsWrites && row === settingsWriter
      const plugins = catalog.pluginControl !== undefined && PLUGIN_RPC_ENDPOINTS.includes(row.endpoint)
        && row.handlerId === 'native:cloudPlugins' && row.guard === 'authenticated-account'
      const modelKey = catalog.modelKey !== undefined && MODEL_KEY_RPC_ENDPOINTS.includes(row.endpoint)
        && row.handlerId === 'native:cloudModelKey' && row.guard === 'authenticated-account'
      const skills = catalog.skills.mode !== 'closed' && (
        skillRpcEndpoints.includes(row.endpoint)
          && row.handlerId === 'native:cloudSkills' && row.guard === 'authenticated-account'
        || row.endpoint === 'skills/list' && row.handlerId === 'native:sessionSkillCatalog' && row.guard === 'account-session')
      if (!selectedNative(row, nativeRpc) && !modelKey && !skills && !plugins && !settingsMutation) unavailable()
      const actual = api.requireRpc(row.endpoint)
      if (actual.handlerId !== row.handlerId || actual.guard !== row.guard) unavailable()
    }
    for (const row of manifest.streamEndpoints) {
      if (!selectedNative(row, nativeStreams)) unavailable()
      const actual = api.requireStream(row.endpoint)
      if (actual.handlerId !== row.handlerId || actual.guard !== row.guard) unavailable()
    }
    if (api.requireStream('workspace/follow').guard !== 'account-project') unavailable()
    if (selectedFiles) files.assertContentAvailable()
  }
  factsCurrent()
  const resumeCurrent = async (): Promise<void> => {
    signal.throwIfAborted()
    if (recheckLogin !== undefined) await recheckLogin()
    signal.throwIfAborted()
  }
  const inventory = await inspectBootstrapConfiguration(ctx, catalog, identitiesCurrent, resolvePackages, resumeCurrent)
  await resumeCurrent()
  identitiesCurrent()
  const nativeCurrent = await api.assertBootstrapCurrent(ctx, signal)
  await resumeCurrent()
  identitiesCurrent()
  inventory.assertCurrent()
  const token = generation()
  const assertCurrent = (): void => {
    factsCurrent()
    inventory.assertCurrent()
    nativeCurrent()
    if (generation() !== token) unavailable()
  }
  const disabled = Object.freeze({ state: 'disabled', reason: 'not-approved' } as const)
  const value = decodeCloudBootstrap({ account, recipeVersion: binding.recipeVersion, connectionGeneration: token,
    capabilities: { projects: { state: 'available' }, filePreview: previewSelected ? { state: 'available' } : disabled,
      shell: accountExecutionMode(ctx) === 'session-collect' ? { state: 'available' } : disabled,
      developmentServices: services.developmentServices ? { state: 'available' } : disabled,
      servicePreview: services.servicePreview && previewRouteSelected ? { state: 'available' } : disabled, sandboxScope: 'session', backgroundJobs: false,
      localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: inventory.configuration,
    },
  }, { maxBodyBytes: maximum, maxStringBytes: maximum, maxListItems: Math.min(maximum, catalog.maxEntries) })
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body, 'utf8') > maximum) unavailable()
  return { body, assertCurrent }
}
