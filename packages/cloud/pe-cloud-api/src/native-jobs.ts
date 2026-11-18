/** Cloud admission for the original account Job Controller. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import JobController, { type Config } from '@deepseek-ai/dsh-api-job-controller'
import type { JobFollowRequest, JobKillRequest, JobKillValue, JobListRequest } from '@deepseek-ai/dsh-api-job-controller/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { JOB_CONTROLLER_ENDPOINTS, selectJobController } from './job-endpoints.ts'
import { inventoryMethodMatches } from './inventory-method.ts'

/** Original Loader owner and the exact methods it contributes to Cloud exposure. */
export interface NativeJobs {
  readonly value: JobController
  /** Recheck original owner and native method identity. */
  inspect(): ExposureInventory
}

type Method = typeof JOB_CONTROLLER_ENDPOINTS[number]
const [kill, list, follow] = JOB_CONTROLLER_ENDPOINTS

/** Install one guarded Job Controller under the original account and Project policy. */
export function createNativeJobs(
  owner: Context, binding: AccountBinding, policy: ExposurePolicy,
  projectForSession: (session: Session) => Workspace, maximum: number, config: Config,
): NativeJobs {
  function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The account job controller is unavailable.') }
  function forbidden(): never { throw new CloudApiError('cloud/forbidden', 'Jobs require an attached Session in its original account Project.') }
  const controller = new AbortController()
  const registry = original(owner.jobs)
  const gateway = owner.get('typertGateway')
  const installed = (): void => {
    controller.signal.throwIfAborted()
    owner.fiber.assertActive()
    if (binding.lifetime.aborted || owner.get('peAccount') !== binding || owner.root.get('peAccount') !== binding
      || original(owner.get('jobController')) !== value || original(owner.root.get('jobController')) !== value
      || original(owner.get('jobs')) !== registry || original(owner.root.get('jobs')) !== registry) unavailable()
  }
  const scope = (ctx: Context, method: Method, sessionId: JobFollowRequest['sessionId']) => {
    const invocation = ctx.invocation
    if (invocation === undefined || invocation.peer.ctx.root !== owner.root || invocation.peer.ctx.get('peAccount') !== binding
      || typeof sessionId !== 'string' || sessionId.length === 0) forbidden()
    const session = ctx.get('sessions')?.get(sessionId)
    if (session === undefined) forbidden()
    const admit = (): Workspace => {
      invocation.signal.throwIfAborted()
      invocation.peer.signal.throwIfAborted()
      installed()
      const row = method.mode === 'rpc' ? policy.requireRpc(method.endpoint) : policy.requireStream(method.endpoint)
      if (row.handlerId !== method.handlerId || row.guard !== method.guard) unavailable()
      if (ctx.get('sessions')?.get(sessionId) !== session) forbidden()
      return projectForSession(session)
    }
    const workspace = admit()
    return { sessionId, current: () => { if (admit() !== workspace) forbidden() } }
  }
  const assertJob = (ctx: Context, sessionId: SessionId, jobId: JobFollowRequest['jobId']): void => {
    const notFound = () => new RemoteError('job/not-found', 'The Session has no such job.', {
      sessionId, jobId,
    })
    let job: ReturnType<Context['jobs']['get']>
    try { job = ctx.jobs.get(jobId, sessionId) } catch { throw notFound() }
    if (job.owner !== sessionId) throw notFound()
  }
  async function* observe<Frame>(current: () => void, open: () => AsyncIterable<Frame>, signal: AbortSignal) {
    signal.throwIfAborted()
    const source = open()[Symbol.asyncIterator]()
    try {
      while (true) {
        current()
        const next = await source.next()
        signal.throwIfAborted()
        current()
        if (next.done) return
        yield next.value
      }
    } finally { await source.return?.() }
  }
  if (!selectJobController(policy.manifest) || policy.manifest.recipeVersion !== binding.recipeVersion
    || !(gateway instanceof Gateway)
    || owner.get('jobController') !== undefined || owner.root.get('jobController') !== undefined
    || original(owner.root.get('jobs')) !== registry) unavailable()

  class AccountJobController extends JobController {
    protected override readonly includeUnownedJobs = false

    override list(request: JobListRequest, signal: AbortSignal) {
      const { current } = scope(this.ctx, list, request.sessionId)
      const control = AbortSignal.any([signal, binding.lifetime, controller.signal])
      return observe(current, () => super.list(request, control), control)
    }

    override follow(request: JobFollowRequest, signal: AbortSignal) {
      const { current, sessionId } = scope(this.ctx, follow, request.sessionId)
      assertJob(this.ctx, sessionId, request.jobId)
      const control = AbortSignal.any([signal, binding.lifetime, controller.signal])
      return observe(current, () => super.follow(request, control), control)
    }

    override kill(request: JobKillRequest): JobKillValue {
      scope(this.ctx, kill, request.sessionId)
      assertJob(this.ctx, request.sessionId, request.jobId)
      return super.kill(request)
    }
  }

  const value = new AccountJobController(owner, config)
  owner.effect(() => () => { controller.abort(new CloudApiError('cloud/account-unavailable', 'The account job controller was withdrawn.')) },
    'pe-cloud-api: close native job streams')
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(owner, 'jobController', value, maximum)
    if (original(owner.get('typertGateway')) !== original(gateway)
      || original(owner.root.get('typertGateway')) !== original(gateway)) unavailable()
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'jobController' || remote.namespace !== 'job') unavailable()
    for (const row of JOB_CONTROLLER_ENDPOINTS) {
      const { method, mode } = row
      const marker = markers.find(row => row.method === method)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== mode
        || Reflect.get(value, method) !== Reflect.get(AccountJobController.prototype, method)
        || !inventoryMethodMatches(row, mode, gateway.inspectInvocation('job', method))) unavailable()
    }
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: [kill], streamEndpoints: [list, follow], exactFetchRoutes: [] }
  } }
}

function original(value: object | undefined): unknown {
  return value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
}
