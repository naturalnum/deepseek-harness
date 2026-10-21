/** One fixed native tool over original Root work; no Job registry, HTTP control plane or process ownership. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { DevelopmentServiceId, ServicePreviewIdentity } from './types.ts'
import { ExecutionStateError } from './errors.ts'
import type { ExecutionScope } from './scopes.ts'
import { NativeExecutionCalls, type RetainedNativeService } from './native-calls.ts'

/** All values are required Root inputs. None is a default or proof that the original runtime supports services. */
export interface DevServiceProfile {
  readonly kind: 'python-http-v1'
  readonly port: 8000
  /** Startup observation/cancellation budget; independent of the remote role run and original command owner lifetimes. */
  readonly startWaitMs: number
  /** Actual remote service role run limit selected by Root; never an application self-exit timer. */
  readonly runMs: number
  readonly stopWaitMs: number
  readonly maxLogReadBytes: number
  readonly maxReplyBytes: number
  readonly maxScriptBytes: number
  readonly maxArgs: number
  readonly maxArgBytes: number
  readonly maxArgsBytes: number
}

/** Validated project-relative Python script and literal arguments; the original owner resolves its fixed executable. */
export interface ResolvedServiceStart {
  readonly script: string
  readonly args: readonly string[]
}

/** A view attached only to the same original Root work row; its opaque handle confers no authority. */
export interface OriginalDevServiceWork<Project> {
  readonly handle: DevelopmentServiceId
  readonly lease: RetainedNativeService<Project>
  assertCurrent(): void
  /**
   * Read the original Root-bound identity without adding it to the canonical/model result.
   * @returns A selector projection after original allocation binding, or undefined before it; never authority.
   */
  previewIdentity(): ServicePreviewIdentity | undefined
  status(): ToolExecutionSuccess['value']
  log(stream: 'stdout' | 'stderr', fromByte: number): ToolExecutionSuccess['value']
  observeStart(signal: AbortSignal): Promise<ToolExecutionSuccess['value']>
  stop(signal: AbortSignal): Promise<ToolExecutionSuccess['value']>
}

/**
 * Original-owner integration implemented by NativeCommandAccount; runtime qualification stays with Root.
 * Each method operates on its one existing work row; no alternate allocation or service registry is supplied.
 */
export interface OriginalDevServiceHooks<Project> {
  /** Check actual approved profile, finite role admission and runtime capability; declarations alone must reject. */
  assertQualified(profile: DevServiceProfile): void
  /** Resolve the fixed session Python and validated script under the original project; no host executable or environment input exists. */
  serviceSpec(scope: ExecutionScope<Project>, profile: DevServiceProfile, start: ResolvedServiceStart): SubprocessSpawnSpec
  /** Reserve the same original managed work row/capacity and bind start cancellation before public spawn. */
  prepareStart(lease: RetainedNativeService<Project>, profile: DevServiceProfile, signal: AbortSignal, spec: SubprocessSpawnSpec): void
  /** Attach the original public handle to that reserved row, never a new map or later process adoption. */
  attachOriginal(lease: RetainedNativeService<Project>, process: SubprocessHandle,
    profile: DevServiceProfile): OriginalDevServiceWork<Project>
  /** Locate only an original retained row, then recheck its exact account/epoch/Agent/Session/project/allocation. */
  resolve(scope: ExecutionScope<Project>, handle?: string): OriginalDevServiceWork<Project>
  /** Retain late/unknown work and its scope, even if synchronous spawn threw before returning a handle. Must not throw. */
  retainFailedStart(lease: RetainedNativeService<Project>, process: SubprocessHandle | undefined,
    cause: unknown): void
}

function validProfile(profile: DevServiceProfile): void {
  for (const value of [profile.startWaitMs, profile.runMs, profile.stopWaitMs, profile.maxLogReadBytes, profile.maxReplyBytes,
    profile.maxScriptBytes, profile.maxArgs, profile.maxArgBytes, profile.maxArgsBytes]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new ExecutionStateError('cloud/invalid-config', 'Every service limit must be specified and finite.')
  }
  if (profile.maxLogReadBytes > profile.maxReplyBytes) throw new ExecutionStateError('cloud/invalid-config', 'The service result limit must contain its log read.')
}

function resolveStart(script: unknown, rawArgs: unknown, profile: DevServiceProfile): ResolvedServiceStart {
  const utf8 = (value: string): boolean => Buffer.from(value).toString('utf8') === value
  if (typeof script !== 'string' || script.length === 0 || script.startsWith('/') || script.includes('\\')
    || script.split('/').some(part => part === '..' || part === '.') || posix.normalize(script) !== script
    || !script.endsWith('.py') || /[\u0000-\u001f\u007f]/u.test(script) || !utf8(script)
    || Buffer.byteLength(script) > profile.maxScriptBytes) {
    throw new ExecutionStateError('cloud/invalid-config', 'Use a canonical project-relative Python script path within the service input limit.')
  }
  const args = rawArgs === undefined ? [] : rawArgs
  if (!Array.isArray(args) || args.length > profile.maxArgs) {
    throw new ExecutionStateError('cloud/invalid-config', 'Service arguments must be a bounded list of literal strings.')
  }
  let bytes = 0
  const resolved: string[] = []
  for (const value of args) {
    if (typeof value !== 'string' || value.includes('\0') || !utf8(value) || Buffer.byteLength(value) > profile.maxArgBytes) {
      throw new ExecutionStateError('cloud/invalid-config', 'Each service argument must be a finite UTF-8 string without NUL.')
    }
    bytes += Buffer.byteLength(value) + 1
    if (bytes > profile.maxArgsBytes) throw new ExecutionStateError('cloud/invalid-config', 'Service arguments exceed the total byte limit.')
    resolved.push(value)
  }
  return Object.freeze({ script, args: Object.freeze(resolved) })
}

function previewMeta(args: { readonly action: string; readonly serviceHandle?: string }, value: ToolExecutionSuccess['value']): ToolExecutionSuccess['value'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['action', 'serviceHandle', 'observation'].includes(key))
    || value.action !== args.action || (value.action !== 'start' && value.action !== 'status')
    || typeof value.serviceHandle !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.serviceHandle)
    || args.serviceHandle !== undefined && args.serviceHandle !== value.serviceHandle) return null
  const observation = value.observation
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)
    || Object.keys(observation).some(key => !['serviceId', 'processSubmitted', 'httpReady', 'direct', 'range', 'phase'].includes(key))
    || observation.serviceId !== value.serviceHandle || observation.processSubmitted !== true || observation.httpReady !== false
    || observation.direct !== 'pending' || observation.range !== 'pending'
    || (value.action === 'start' ? observation.phase !== 'process-submitted' : observation.phase !== undefined)) return null
  return { kind: 'cloud-dev-service-v1', serviceHandle: value.serviceHandle, action: value.action, processSubmitted: true }
}

/** Same original Tools registration disposer with a current-definition check. */
export interface DevServiceRegistration {
  (): void
  /** @param caller Actual admitted consumer scope; both its Tools provider and the installation must remain original. */
  assertCurrent(caller: Context): void
}

/**
 * Register the sole fixed native consumer inside the existing managed account entry.
 * @param ctx Original account installation context with its original tools/subprocess providers.
 * @param calls That account's original execution issuer; Root must explicitly admit dev_service in its native consumer list.
 * @param subprocess The already-installed original public provider; never a host launcher or fallback.
 * @param root Same execution owner's qualified work-row hooks; no candidate implementation is substituted.
 * @param profile Required reviewed Root profile values, passed through unchanged to the original owner.
 * @returns Original tool registration disposer. Active work still belongs to Root after tool unregistration.
 */
export function registerDevServiceConsumer<Project>(ctx: Context, calls: NativeExecutionCalls<Project>,
  subprocess: Pick<SubprocessRuntime, 'spawn'>, root: OriginalDevServiceHooks<Project>, profile: DevServiceProfile): DevServiceRegistration {
  validProfile(profile)
  root.assertQualified(profile)
  const tools = ctx.get('tools')
  if (tools === undefined) throw new ExecutionStateError('cloud/invalid-config', 'Development services require the original native tools provider.')
  const definition = defineTool({
    name: 'dev_service',
    description: 'Start a project Python HTTP service on port 8000, inspect its process, read logs, or stop it. Startup confirms process submission; HTTP readiness is not checked.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'status', 'log', 'stop'] },
      script: { type: 'string', description: 'Required for start: canonical project-relative .py path.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional literal script arguments; omitted means an empty list.' },
      serviceHandle: { type: 'string' }, stream: { type: 'string', enum: ['stdout', 'stderr'] }, fromByte: { type: 'number' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: previewMeta },
    async execute(args, exec) {
      const call = calls.capture(ctx)
      if (call.scope.consumerId !== 'dev_service' || call.scope.purpose !== 'consumer' || call.scope.agent !== exec.agent) {
        throw new ExecutionStateError('cloud/stale-generation', 'The service action requires the current Session.')
      }
      call.signal.throwIfAborted()
      const allowed = args.action === 'start' ? ['action', 'script', 'args'] : args.action === 'log'
        ? ['action', 'serviceHandle', 'stream', 'fromByte'] : ['action', 'serviceHandle']
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new ExecutionStateError('cloud/invalid-config', 'The service action contains unsupported fields.')
      root.assertQualified(profile)
      let work: OriginalDevServiceWork<Project>, observation: ToolExecutionSuccess['value']
      if (args.action === 'start') {
        const start = resolveStart(args.script, args.args, profile)
        const signal = AbortSignal.any([call.signal, AbortSignal.timeout(profile.startWaitMs)])
        const lease = calls.retainService(ctx)
        let process: SubprocessHandle | undefined
        try {
          signal.throwIfAborted()
          const spec = root.serviceSpec(lease.scope, profile, start)
          if (spec.signal !== lease.scope.lifetime) throw new ExecutionStateError('cloud/invalid-config', 'The service lifetime is invalid.')
          root.prepareStart(lease, profile, signal, spec)
          signal.throwIfAborted()
          process = calls.withService(ctx, lease, () => subprocess.spawn(spec))
          work = root.attachOriginal(lease, process, profile)
          if (work.lease !== lease) throw new ExecutionStateError('cloud/stale-generation', 'The service is no longer current.')
          observation = await calls.withService(ctx, lease, () => work.observeStart(signal))
        } catch (cause) {
          root.retainFailedStart(lease, process, cause)
          throw cause
        }
      } else {
        const handle = args.serviceHandle
        if (handle === undefined ? args.action !== 'status' : typeof handle !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(handle)) {
          throw new ExecutionStateError('cloud/invalid-config', 'A valid service handle is required for this action.')
        }
        work = root.resolve(call.scope, handle)
        observation = await calls.withService(ctx, work.lease, () => {
          work.assertCurrent()
          if (args.action === 'status') return work.status()
          if (args.action === 'stop') return work.stop(AbortSignal.any([call.signal, AbortSignal.timeout(profile.stopWaitMs)]))
          if (args.stream !== 'stdout' && args.stream !== 'stderr' || typeof args.fromByte !== 'number'
            || !Number.isSafeInteger(args.fromByte) || args.fromByte < 0) {
            throw new ExecutionStateError('cloud/invalid-config', 'A log stream and finite byte offset are required.')
          }
          return work.log(args.stream, args.fromByte)
        })
      }
      const value = { action: args.action, serviceHandle: work.handle, observation }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(work.handle) || Buffer.byteLength(JSON.stringify(value)) > profile.maxReplyBytes) {
        throw new ExecutionStateError('cloud/capacity', 'The service result exceeds its output limit.')
      }
      return value
    },
  })
  const dispose = tools.register(definition)
  const original = (value: unknown): unknown => value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, symbols.original) ?? value : value
  let open = true
  return Object.assign(() => { open = false; dispose() }, { assertCurrent(caller: Context): void {
    ctx.fiber.assertActive(); caller.fiber.assertActive()
    if (!open || original(ctx.get('tools')) !== original(tools) || original(ctx.root.get('tools')) !== original(tools)
      || original(caller.get('tools')) !== original(tools) || original(caller.root.get('tools')) !== original(tools)
      || tools.get('dev_service') !== definition) {
      throw new ExecutionStateError('cloud/stale-generation', 'The original development-service consumer is unavailable.')
    }
    root.assertQualified(profile)
  } })
}
