/** Root Loader entry for the immutable deployment exposure policy. */
import { Context, Service } from '@deepseek-ai/cordis'
import { PLUGIN_RPC_ENDPOINTS } from './plugin-json.ts'
import { MODEL_KEY_RPC_ENDPOINTS } from './model-key-json.ts'
import { CloudApiError } from './errors.ts'
import { ExposurePolicy } from './exposure.ts'
import { ExposureRootConfigSchema } from './schema.ts'
import { approvedSettingsMatch } from './approved-settings.ts'
import { parseApprovedConfigurationCatalog } from './approved-catalog.ts'
import type { ApprovedConfigurationCatalog, ExposureManifest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root-owned C-04 exact exposure policy; never an account service provider. */
    peExposure: ExposureService
  }
}

/** Web settings can only name the two protected native providers and their official endpoints. */
function validateWebSearchPolicy(approved: ApprovedConfigurationCatalog | undefined): boolean {
  if (approved === undefined) return false
  const sections = new Set(['web', 'web-search-deepseek', 'web-deepseek-api'])
  const fields = approved.fields.filter(field => sections.has(field.namespace))
  if (fields.length === 0) return false
  const exact: Record<string, readonly (string | number | boolean | null)[] | undefined> = {
    'web.searchProvider': ['deepseek-official', 'deepseek-search-api'],
    'web.fetchProvider': ['http', 'deepseek-fetch-api'],
    'web-search-deepseek.baseURL': ['https://api.deepseek.com/anthropic/v1'],
    'web-search-deepseek.maxUses': undefined,
    'web-deepseek-api.baseURL': ['https://api.deepseek.com/v1/tools'],
    'web-deepseek-api.count': undefined,
  }
  const invalid = (): never => { throw new CloudApiError('cloud/invalid-config', 'Web search requires its exact protected account policy.') }
  if (fields.length !== Object.keys(exact).length) invalid()
  for (const field of fields) {
    const key = field.namespace + '.' + field.field
    if (!Object.hasOwn(exact, key)) invalid()
    const values = exact[key]
    if (values !== undefined && (field.values === undefined || field.values.length !== values.length
      || values.some(value => !field.values?.includes(value)))) invalid()
  }
  if (!approved.modelKey?.bindings.some(binding => binding.provider === 'deepseek-official'
    && binding.moduleName === '@deepseek-ai/dsh-llm-deepseek-api-key' && binding.ref === 'DEEPSEEK_API_KEY')) invalid()
  const protectedEntries = new Set(['web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http'])
  const protectedPackages = new Set(['@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web-search-deepseek',
    '@deepseek-ai/dsh-web-deepseek-api', '@deepseek-ai/dsh-web-fetch-http'])
  const protectedMember = (row: { entryId: string; packageName: string }): boolean =>
    protectedEntries.has(row.entryId.replace(/^include:/, '')) || protectedPackages.has(row.packageName)
  if (approved.plugins.some(plugin => plugin.control !== undefined && protectedMember(plugin))
    || approved.bundles?.some(bundle => protectedPackages.has(bundle.packageName)
      || bundle.members.some(protectedMember)) === true) invalid()
  return true
}

/** Root policy provider; registering it does not publish account readiness. */
export class ExposureService extends Service {
  static Config: typeof ExposureRootConfigSchema = ExposureRootConfigSchema
  /** Deployment exposure policy whose inventory audit is revoked on service disposal. */
  readonly policy: ExposurePolicy
  /** Explicit immutable approval description; it grants no account installation or mutation permission. */
  readonly approvedConfiguration: ApprovedConfigurationCatalog | undefined

  /**
   * @param ctx - root composition owner.
   * @param config - parsed deployment manifest.
   */
  constructor(ctx: Context, config: ExposureManifest & { readonly approvedConfiguration?: ApprovedConfigurationCatalog }) {
    const policy = new ExposurePolicy(config)
    const approved = parseApprovedConfigurationCatalog(config.approvedConfiguration, policy.manifest.recipeVersion,
      policy.manifest.allowedSettings.length === 0)
    validateWebSearchPolicy(approved)
    const writableSettings = (approved?.fields.length ?? 0) !== 0
    const settings = policy.manifest.allowedSettings
    const writers = policy.manifest.rpcEndpoints.filter(row => row.endpoint.startsWith('settings/') && row.endpoint !== 'settings/describe')
    if (!approvedSettingsMatch(approved?.fields ?? [], settings)
      || (writableSettings ? writers.length !== 1 || writers[0]?.endpoint !== 'settings/mutate'
        || writers[0].handlerId !== 'native:settingsController' || writers[0].guard !== 'authenticated-account'
        : writers.length !== 0)) {
      throw new CloudApiError('cloud/invalid-config', 'Approved settings require their exact native fields and mutation policy.')
    }
    const keyRows = policy.manifest.rpcEndpoints.filter(row => row.endpoint.startsWith('cloudModelKey/'))
    if (approved?.modelKey !== undefined ? keyRows.length !== MODEL_KEY_RPC_ENDPOINTS.length
      || keyRows.some(row => !MODEL_KEY_RPC_ENDPOINTS.includes(row.endpoint) || row.handlerId !== 'native:cloudModelKey'
        || row.guard !== 'authenticated-account') : keyRows.length !== 0) {
      throw new CloudApiError('cloud/invalid-config', 'The model-key policy requires its complete exact native RPC group.')
    }
    if (policy.manifest.streamEndpoints.some(row => row.endpoint.startsWith('cloudModelKey/'))
      || approved?.modelKey !== undefined && policy.manifest.rpcEndpoints.some(row =>
        row.endpoint === 'credentials/set' || row.endpoint === 'credentials/unset' || row.endpoint === 'settings/mutate' && !writableSettings)) {
      throw new CloudApiError('cloud/invalid-config', 'The independent model-key policy keeps native writers and model-key streams closed.')
    }
    const skillMethods = approved?.skills.mode === 'managed'
      ? ['cloudSkills/current', 'cloudSkills/publish', 'cloudSkills/installed', 'cloudSkills/details',
        'cloudSkills/install', 'cloudSkills/update', 'cloudSkills/uninstall', 'cloudSkills/download']
      : ['cloudSkills/current', 'cloudSkills/publish']
    const skillRows = policy.manifest.rpcEndpoints.filter(row => row.endpoint.startsWith('cloudSkills/'))
    if (approved !== undefined && approved.skills.mode !== 'closed' ? skillRows.length !== skillMethods.length
      || skillRows.some(row => !skillMethods.includes(row.endpoint) || row.handlerId !== 'native:cloudSkills'
        || row.guard !== 'authenticated-account') : skillRows.length !== 0) {
      throw new CloudApiError('cloud/invalid-config', 'The approved skill policy requires its complete exact native RPC group.')
    }
    if (policy.manifest.streamEndpoints.some(row => row.endpoint.startsWith('cloudSkills/'))) {
      throw new CloudApiError('cloud/invalid-config', 'Skill management does not expose streams.')
    }
    const pluginRows = policy.manifest.rpcEndpoints.filter(row => row.endpoint.startsWith('cloudPlugins/'))
    if (approved?.pluginControl !== undefined ? pluginRows.length !== PLUGIN_RPC_ENDPOINTS.length
      || pluginRows.some(row => !PLUGIN_RPC_ENDPOINTS.includes(row.endpoint) || row.handlerId !== 'native:cloudPlugins'
        || row.guard !== 'authenticated-account') : pluginRows.length !== 0) {
      throw new CloudApiError('cloud/invalid-config', 'Approved plugin controls require their exact native RPC group.')
    }
    if (policy.manifest.streamEndpoints.some(row => row.endpoint.startsWith('cloudPlugins/'))
      || approved?.pluginControl !== undefined && policy.manifest.rpcEndpoints.some(row => row.endpoint.startsWith('pluginManager/'))) {
      throw new CloudApiError('cloud/invalid-config', 'Approved plugin controls keep native manager/package endpoints closed.')
    }
    super(ctx, 'peExposure')
    this.policy = policy
    this.approvedConfiguration = approved
    ctx.effect(() => () => { this.policy.invalidate() }, 'pe-cloud-api: revoke exposure inventory')
  }
}

export default ExposureService
