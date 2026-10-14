/** Tenant HTTP admission is ready before its original Web server begins listening. */
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { IncomingMessage } from 'node:http'
import { BrowserAgentAuth } from './browser-auth.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { nativeRuntimeUiAdmission: NativeRuntimeUiAdmission }
}

/** Exact deployment origins; credentials remain in the original RuntimeScope. */
export const Config = schema.object({ origin: schema.string().required(), platformOrigin: schema.string().required() })
/** Validated origins for tenant HTTP admission. */
export type Config = ReturnType<typeof Config>

/** The original Runtime and browser credentials fence every original tenant HTTP and upgrade route. */
export default class NativeRuntimeUiAdmission extends Service {
  static inject = ['powerEvolveRuntime']
  static Config = Config
  private readonly ownerFiber
  private readonly auth: BrowserAgentAuth
  private readonly pending = new Set<Promise<boolean>>()
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'nativeRuntimeUiAdmission')
    this.ownerFiber = owner.fiber
    const runtime = owner.powerEvolveRuntime
    if (runtime.config.runtimeUserId === '') throw new Error('Tenant HTTP admission requires an account Runtime')
    this.auth = new BrowserAgentAuth(config.origin, config.platformOrigin, runtime,
      runtime.config.runtimeUserId, token => runtime.verifyBroker(token))
    owner.effect(() => () => this.shutdown())
  }

  private isClosing(): boolean {
    return this.closing || this.ownerFiber.state === FiberState.UNLOADING || this.ownerFiber.state === FiberState.DISPOSED
  }

  /** Admit original HTTP or upgrades only after both original credentials identify this account.
   * @param request Actual tenant request; public readiness retains its existing Runtime-only credential boundary.
   * @returns Admission before any original route receives the request.
   */
  readonly admit = (request: IncomingMessage): Promise<boolean> => {
    if (this.isClosing()) return Promise.resolve(false)
    const work = (async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://tenant').pathname
        if (path === '/api' || path.startsWith('/api/')) return false
        if (path === '/health' || path === '/native/runtime/ready') {
          const token = request.headers['x-power-evolve-runner-token']
          await this.owner.powerEvolveRuntime.verifyBroker(typeof token === 'string' ? token : undefined)
        } else await this.auth.authenticate(request, true)
        return !this.isClosing()
      } catch { return false }
    })().finally(() => { this.pending.delete(work) })
    this.pending.add(work)
    return work
  }

  /** Stop admission and join every accepted credential check before the owning services are disposed.
   * @returns Cached shutdown of this admission owner.
   */
  shutdown(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true
      await Promise.all([...this.pending])
    })()
  }
}
