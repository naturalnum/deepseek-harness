/** Empty native DSH overlay for the collected remote-command slice; the remote world owns its fixed environment. */
import type { Context } from '@deepseek-ai/cordis'
import type { DshEnvironment } from '@deepseek-ai/dsh-shell'
import { ShellEnvRegistry, type BashEnvContributor, type BashEnvVariableInfo } from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ExecutionStateError } from './errors.ts'
import type { NativeExecutionProviderPort } from './native-providers.ts'

/**
 * Keep the native shellEnv service without exporting host DSHCLI, Session or profile facts.
 * Root's original port retains scope lookup and authorization; execution arguments create no authority.
 * Remote PATH/HOME/TMPDIR/LANG remain owned by the fixed command world, not this DSH overlay.
 */
export class CloudShellEnvRegistry extends ShellEnvRegistry {
  private readonly empty: DshEnvironment = Object.freeze({})

  /**
   * @param ctx Actual cloud account service scope; Root retains its installation and lifetime.
   * @param port Original native execution capability; construction performs no native call lookup or allocation.
   */
  constructor(ctx: Context, private readonly port: NativeExecutionProviderPort) {
    super(ctx, { dshHome: '/opt/session-env/home' })
  }

  /**
   * @param _execution Native caller metadata; the port checks its original retained scope rather than these fields.
   * @returns A frozen empty DSH overlay after original native admission succeeds.
   */
  override collect(_execution: ToolExecution): DshEnvironment {
    this.port.assertCurrent(this.ctx)
    return this.empty
  }

  /** @param _contributor Unsupported extra environment contribution; registration grants no sandbox operation. */
  override register(_contributor: BashEnvContributor): never {
    throw new ExecutionStateError('cloud/execution-unavailable', 'This cloud command slice does not support environment contributions.')
  }

  /** @returns No contributed environment declarations; enumeration performs no sandbox operation. */
  override list(): BashEnvVariableInfo[] { return [] }
}
