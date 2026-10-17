/** Account-local configuration consumer for the real native Profile mechanism fixture. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { AccountBinding } from '../../src/types.ts'
import type {} from '../../src/account.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-owned native configuration consumer, with no product provider capability. */
    nativeAccountProbe: NativeAccountProbe
  }
}

/** Observes native configuration replacement and the exact account-local inputs. */
export class NativeAccountProbe extends Service {
  static inject = ['peAccount', 'profileContext', 'launchEnvironment']
  static Config = z.object({ ordinary: z.string().required(), count: z.number().required().volatile() })
  readonly profile: ProfileContext
  readonly environment: LaunchEnvironmentSnapshot
  readonly binding: AccountBinding
  readonly pid = process.pid
  closed = false

  /**
   * @param ctx Native Loader-owned consumer context.
   * @param config Ordinary configuration whose updates remount this consumer.
   */
  constructor(ctx: Context, readonly config: { ordinary: string }) {
    super(ctx, 'nativeAccountProbe')
    this.profile = ctx.profileContext
    const environment = ctx.get('launchEnvironment')
    if (environment === undefined) throw new Error('Native fixture environment is missing')
    this.environment = environment
    this.binding = ctx.peAccount
    ctx.effect(() => () => { this.closed = true })
  }
}

export default NativeAccountProbe
