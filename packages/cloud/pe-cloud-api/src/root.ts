/** Root Loader entry for the immutable deployment exposure policy. */
import { Context, Service } from '@deepseek-ai/cordis'
import { ExposurePolicy } from './exposure.ts'
import { ExposureRootConfigSchema } from './schema.ts'
import { parseApprovedConfigurationCatalog } from './approved-catalog.ts'
import type { ApprovedConfigurationCatalog, ExposureManifest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root-owned C-04 exact exposure policy; never an account service provider. */
    peExposure: ExposureService
  }
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
    super(ctx, 'peExposure')
    this.policy = policy
    this.approvedConfiguration = approved
    ctx.effect(() => () => { this.policy.invalidate() }, 'pe-cloud-api: revoke exposure inventory')
  }
}

export default ExposureService
