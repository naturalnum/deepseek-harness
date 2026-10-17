/** Root Loader entry for the immutable deployment exposure policy. */
import { Context, Service } from '@deepseek-ai/cordis'
import { ExposurePolicy } from './exposure.ts'
import { ExposureManifestSchema } from './schema.ts'
import type { ExposureManifest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root-owned C-04 exact exposure policy; never an account service provider. */
    peExposure: ExposureService
  }
}

/** Root policy provider; registering it does not publish account readiness. */
export class ExposureService extends Service {
  static Config = ExposureManifestSchema
  /** Deployment exposure policy whose inventory audit is revoked on service disposal. */
  readonly policy: ExposurePolicy

  /**
   * @param ctx - root composition owner.
   * @param config - parsed deployment manifest.
   */
  constructor(ctx: Context, config: ExposureManifest) {
    super(ctx, 'peExposure')
    this.policy = new ExposurePolicy(config)
    ctx.effect(() => () => { this.policy.invalidate() }, 'pe-cloud-api: revoke exposure inventory')
  }
}

export default ExposureService
