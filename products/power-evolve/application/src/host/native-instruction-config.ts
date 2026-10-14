/** Configure maintained instruction consumers for the tenant's virtual execution filesystem. */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { apply as applyInstructions } from '@deepseek-ai/dsh-agent-instructions'

declare module '@deepseek-ai/cordis' {
  interface Context { nativeInstructionConfig: NativeInstructionConfig }
}

/** Explicit user-global instruction location and project discovery markers. */
export const Config = schema.object({
  dshHome: schema.string().required(),
  projectRootMarkers: schema.array(schema.string()).required(),
})
/** Validated instruction discovery settings in the execution world. */
export type Config = ReturnType<typeof Config>

/** Native presets wait for this provider before their instruction plugins activate. */
export default class NativeInstructionConfig extends Service {
  static Config = Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'nativeInstructionConfig')
    ctx.on('internal/config', function (this: Fiber, _input, next) {
      const input: unknown = next()
      if (this.runtime?.callback !== applyInstructions) return input
      // Preserve invalid input for the original plugin schema to reject.
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
      return { ...input, dshHome: config.dshHome, projectRootMarkers: [...config.projectRootMarkers] }
    }, { global: true })
  }
}
