/** C11 projection from original graph owners and explicitly audited execution/file policies. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { CloudAccountApi, CloudApiError, ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import { accountExecutionMode, accountServiceAvailability, assertAccountExecutionProviders } from '@deepseek-ai/dsh-pe-opensandbox'
import type { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { FILE_UPLOAD_PATH } from '@deepseek-ai/dsh-client-file-upload'
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

/**
 * Read original account providers and emit only the existing bounded C11 wire fields.
 * @param ctx Exact context from the actual AccountUse.
 * @param binding Exact runtime-issued AccountUse binding.
 * @param exposure Original Root exposure owner captured by PeAuthService.
 * @param resolvePackages Original Root package-provider read; absence cannot become an empty installed catalog.
 * @param account Metadata from the same library-verified login, never a separate account lookup.
 * @param maximum Complete response/string/list bound from the existing ingress configuration.
 * @param signal Original request observer combined with the account lifetime.
 * @param current Original operation/login/Use/Root admission, checked around all awaited work.
 * @param generation Original access generation issuer; it grants no additional readiness.
 * @returns Bounded compact JSON and an original-fact recheck to run immediately before response.end.
 */
export async function produceCloudBootstrap(
  ctx: Context, binding: AccountBinding, exposure: ExposureService | undefined, resolvePackages: () => PluginPackages | undefined,
  account: CloudBootstrap['account'], maximum: number, signal: AbortSignal,
  current: () => void, generation: () => string,
): Promise<{ readonly body: string; readonly assertCurrent: () => void }> {
  current()
  if (!(exposure instanceof ExposureService) || account.id !== binding.accountId
    || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) unavailable()
  const catalog = exposure.approvedConfiguration, manifest = exposure.policy.manifest
  if (catalog === undefined || catalog.recipeVersion !== binding.recipeVersion
    || manifest.recipeVersion !== binding.recipeVersion) unavailable()
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
  const factsCurrent = (): void => {
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
    // Only the original native upload and Root's protocol-fixed preview route may coexist.
    if (manifest.allowedSettings.length !== 0 || manifest.exactFetchRoutes.length > 2) unavailable()
    const selectedFetch = new Set<string>()
    for (const row of manifest.exactFetchRoutes) {
      const upload = row.method === 'POST' && row.path === FILE_UPLOAD_PATH && row.handlerId === 'native:fileUploads'
      const preview = row.method === SERVICE_PREVIEW_ROUTE.method && row.path === SERVICE_PREVIEW_ROUTE.path
        && row.handlerId === SERVICE_PREVIEW_ROUTE.handlerId
      const key = `${row.method} ${row.path}`
      if ((!upload && !preview) || row.guard !== 'account-session' || selectedFetch.has(key)) unavailable()
      selectedFetch.add(key)
      // Original API checks its audited manifest and freshly inspects actual native + Root inventory.
      api.requireFetch(row.method, row.path)
    }
    const budget = catalog.maxEntries
    if (manifest.rpcEndpoints.length + manifest.streamEndpoints.length > budget) unavailable()
    for (const row of manifest.rpcEndpoints) {
      if (!/^(?:session|workspace|remoteAccess)\//.test(row.endpoint) && row.endpoint !== 'settings/describe'
        && row.endpoint !== '$events/result' && row.endpoint !== 'cloudProjects/create'
        && !fileRpcEndpoints.includes(row.endpoint)) unavailable()
      api.requireRpc(row.endpoint)
    }
    for (const row of manifest.streamEndpoints) {
      if (!/^(?:session|workspace|remoteAccess)\//.test(row.endpoint) && row.endpoint !== '$events'
        && row.endpoint !== fileStreamEndpoint) unavailable()
      api.requireStream(row.endpoint)
    }
    if (api.requireStream('workspace/follow').guard !== 'account-project') unavailable()
    if (selectedFiles) files.assertContentAvailable()
  }
  factsCurrent()
  const inventory = await inspectBootstrapConfiguration(ctx, catalog, factsCurrent, resolvePackages)
  factsCurrent()
  await api.assertBootstrapCurrent(ctx, signal)
  factsCurrent()
  inventory.assertCurrent()
  const token = generation()
  const assertCurrent = (): void => {
    factsCurrent()
    inventory.assertCurrent()
    if (generation() !== token) unavailable()
  }
  assertCurrent()
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
  assertCurrent()
  return { body, assertCurrent }
}
