/** Owned official Device Profile process; exit and durable drain facts remain independent. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { deviceLifecycleReady, deviceLifecycleRequest, deviceLifecycleResponse,
  type DeviceLifecycleReady, type DeviceLifecycleSnapshot, type DeviceDrainReport,
  type DeviceLifecycleRequest, type DeviceServiceInstanceId, type DeviceLaunchId,
  type DeviceLifecycleRequestId } from '@power-evolve/contracts/device-lifecycle'

/** Main-owned launch choices; no renderer input or ambient credential environment is accepted. */
export interface DeviceProcessOptions {
  readonly nodeExecutable: string
  readonly cliEntrypoint: string
  readonly homeDir: string
  readonly profile: string
  readonly workingDir: string
  readonly loopbackOrigin: string
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly startupTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly quiesceTimeoutMs: number
  readonly exitTimeoutMs: number
  readonly maxOutputBytes: number
  readonly maxMessageBytes: number
  readonly maxHealthBytes: number
}

/** Fixed, nonprivate lifecycle failure; child diagnostics are never included. */
export class DeviceProcessError extends Error {
  /**
   * @param code - Fixed lifecycle category, without child output or local paths.
   */
  constructor(readonly code: string) { super(code); this.name = 'DeviceProcessError' }
}
interface Exit { readonly code: number | null; readonly signal: NodeJS.Signals | null }
interface Pending {
  readonly action: DeviceLifecycleRequest['action']
  readonly instanceId: DeviceServiceInstanceId | null
  readonly resolve: (snapshot: DeviceLifecycleSnapshot) => void
  readonly reject: (error: DeviceProcessError) => void
  readonly timer: ReturnType<typeof setTimeout>
}
interface Launch {
  readonly child: ChildProcess
  readonly launchId: DeviceLaunchId
  readonly ready: Promise<DeviceLifecycleReady>
  readonly resolveReady: (value: DeviceLifecycleReady) => void
  readonly rejectReady: (error: DeviceProcessError) => void
  readonly close: Promise<Exit>
  readonly cancel: AbortController
  readonly pending: Map<DeviceLifecycleRequestId, Pending>
  instance?: DeviceLifecycleReady
  cancelInstance?: DeviceServiceInstanceId
  verified: boolean
  closed: boolean
  stopping: boolean
  outputBytes: number
  failure?: DeviceProcessError
  notified: boolean
  clean: boolean
  forcing?: Promise<void>
  shutdown?: Promise<void>
}

function failure(code: string): DeviceProcessError { return new DeviceProcessError(code) }
function timed<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure(code)), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
function environment(options: DeviceProcessOptions, launchId: DeviceLaunchId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (!/(KEY|SECRET|TOKEN|PASSWORD|PROVIDER|CREDENTIAL|DATABASE|GRANT|AUTH|NONCE)/i.test(key)
      && !['NODE_OPTIONS', 'NODE_PATH', 'DSH_HOME', 'PE_DEVICE_LAUNCH_ID'].includes(key)) env[key] = value
  }
  return { ...env, DSH_HOME: options.homeDir, PE_DEVICE_LAUNCH_ID: launchId }
}
function quiescent(snapshot: DeviceLifecycleSnapshot): boolean {
  return snapshot.phase === 'quiescent' && !snapshot.admissionOpen && snapshot.pendingActions === 0 && snapshot.drain !== null
}
function cleanDrain(report: DeviceDrainReport): boolean {
  return report.cleanupPending === 0 && report.entries.every(entry => entry.state !== 'unconfirmed')
}

/** Matches DesktopBackendHost while owning only the child created through the official dsh CLI. */
export class DeviceProcess {
  private launch: Launch | undefined
  private starting: Promise<DeviceLifecycleReady> | undefined
  private stopping: Promise<void> | undefined
  private snapshot: DeviceLifecycleSnapshot | undefined
  private drain: DeviceDrainReport | undefined
  private clean = false

  /**
   * @param options - Validated local main-process launch configuration and explicit budgets.
   * @param onFailure - Receives a fixed fatal category for the owned, previously ready child.
   */
  constructor(private readonly options: DeviceProcessOptions, private readonly onFailure?: (error: DeviceProcessError) => void) {}

  /** Last verified lifecycle snapshot; absent when the child supplied no validated response. */
  get lastSnapshot(): DeviceLifecycleSnapshot | undefined { return this.snapshot }
  /** Last validated residual facts; child exit cannot create or clear this report. */
  get lastDrain(): DeviceDrainReport | undefined { return this.drain }
  /** Complete drain/termination/close with no unknown residual or pending cleanup. */
  get lastStopClean(): boolean { return this.clean }
  /** No child was spawned, or the current owned child's actual close event was observed. */
  get exitConfirmed(): boolean { return this.launch === undefined || this.launch.closed }

  /**
   * Start one official Profile and bind readiness to its child, launch, URL and HTTP instance.
   * @returns Validated readiness; concurrent callers share this startup.
   */
  start(): Promise<DeviceLifecycleReady> {
    if (this.stopping !== undefined) return Promise.reject(failure('device_stopping'))
    if (this.starting !== undefined) return this.starting
    if (this.launch !== undefined && !this.launch.closed) {
      if (this.launch.verified && this.launch.instance !== undefined && this.launch.failure === undefined) return Promise.resolve(this.launch.instance)
      return Promise.reject(this.launch.failure ?? failure('device_not_ready'))
    }
    this.clean = false
    this.snapshot = undefined
    this.drain = undefined
    const launch = this.spawn()
    this.launch = launch
    const pending = (async () => {
      try {
        const ready = await timed((async () => {
          const message = await launch.ready
          await this.health(launch, message)
          if (launch.stopping || launch.closed || launch.failure !== undefined) throw launch.failure ?? failure('device_start_cancelled')
          launch.verified = true
          return message
        })(), this.options.startupTimeoutMs, 'device_start_timeout')
        return ready
      } catch (error) {
        const original = error instanceof DeviceProcessError ? error : failure('device_start_failed')
        launch.cancel.abort()
        if (launch.stopping && this.stopping !== undefined) {
          try { await this.stopping }
          catch (_stopFailure) { /* Startup retains its original cancellation or failure category. */ }
        } else await this.forceExit(launch)
        throw original
      }
    })().finally(() => { if (this.starting === pending) this.starting = undefined })
    this.starting = pending
    return pending
  }

  /**
   * Query the current owned instance; no response from another launch can update the facts.
   * @returns Validated current process and durable-work observation.
   */
  async inspect(): Promise<DeviceLifecycleSnapshot> {
    const launch = this.launch
    if (launch === undefined || !launch.verified || launch.stopping) throw failure('device_not_ready')
    return this.request(launch, 'inspect', this.options.requestTimeoutMs)
  }

  /**
   * Quiesce, inspect residual facts, terminate and await close; uncertain work remains visible.
   * @returns Child exit, rejecting when complete clean shutdown was not established.
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const launch = this.launch
    if (launch === undefined) return Promise.resolve()
    launch.stopping = true
    launch.cancel.abort()
    this.rejectPending(launch, failure('device_start_cancelled'))
    // An incomplete acknowledgement never grants a second teardown request sequence.
    launch.shutdown ??= this.shutdown(launch)
    const pending = launch.shutdown.finally(() => { if (this.stopping === pending) this.stopping = undefined })
    this.stopping = pending
    return pending
  }

  private spawn(): Launch {
    const launchId = deviceLifecycleReady.shape.launchId.parse(randomUUID())
    const child = spawn(this.options.nodeExecutable, [this.options.cliEntrypoint, '--profile', this.options.profile], {
      cwd: this.options.workingDir, env: environment(this.options, launchId), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let resolveReady!: Launch['resolveReady'], rejectReady!: Launch['rejectReady']
    const ready = new Promise<DeviceLifecycleReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    void ready.catch(() => {})
    let resolveClose!: (value: Exit) => void
    const close = new Promise<Exit>(resolve => { resolveClose = resolve })
    const launch: Launch = { child, launchId, ready, resolveReady, rejectReady, close,
      cancel: new AbortController(), pending: new Map<DeviceLifecycleRequestId, Pending>(), verified: false, closed: false, stopping: false,
      outputBytes: 0, notified: false, clean: false }
    const output = (bytes: Buffer): void => {
      launch.outputBytes += bytes.length
      if (launch.outputBytes > this.options.maxOutputBytes) this.fail(launch, failure('device_output_limit'))
    }
    child.stdout?.on('data', output)
    child.stderr?.on('data', output)
    child.on('message', message => { this.message(launch, message) })
    child.once('error', () => { this.fail(launch, failure('device_spawn_failed')) })
    child.once('disconnect', () => {
      if (!launch.stopping && !launch.closed) this.fail(launch, failure('device_ipc_closed'))
    })
    child.once('close', (code, signal) => {
      launch.closed = true
      launch.cancel.abort()
      this.rejectPending(launch, failure('device_child_exited'))
      if (!launch.stopping) this.fail(launch, failure('device_child_exited'))
      resolveClose({ code, signal })
    })
    return launch
  }

  private message(launch: Launch, value: unknown): void {
    if (launch.closed || launch.failure !== undefined) return
    let bytes: number
    try { bytes = Buffer.byteLength(JSON.stringify(value)) }
    catch (_serializationError) { this.fail(launch, failure('device_invalid_ipc')); return }
    if (bytes > this.options.maxMessageBytes) { this.fail(launch, failure('device_message_limit')); return }
    if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'power-evolve-device-lifecycle') return
    const ready = deviceLifecycleReady.safeParse(value)
    if (ready.success) {
      const message = ready.data
      if (message.launchId !== launch.launchId || message.pid !== launch.child.pid
        || message.url !== `${this.options.loopbackOrigin}/`
        || (launch.instance !== undefined || launch.cancelInstance !== undefined)
          && message.instanceId !== (launch.instance?.instanceId ?? launch.cancelInstance)) {
        this.fail(launch, failure('device_ready_identity')); return
      }
      if (launch.stopping) return
      launch.instance = message
      launch.resolveReady(message)
      return
    }
    const response = deviceLifecycleResponse.safeParse(value)
    if (!response.success || response.data.launchId !== launch.launchId) {
      this.fail(launch, failure('device_response_identity')); return
    }
    const message = response.data, pending = launch.pending.get(message.requestId)
    // An expired request cannot settle a later action or replace its snapshot.
    if (pending === undefined) return
    if (pending.action !== message.action) { this.fail(launch, failure('device_response_identity')); return }
    const expectedInstance = launch.instance?.instanceId ?? launch.cancelInstance
    if (expectedInstance === undefined && launch.stopping && pending.action === 'quiesce'
      && pending.instanceId === null && message.status === 'ok' && quiescent(message.snapshot)) {
      // This owned-channel fact authorizes only cancelled startup teardown, never readiness.
      launch.cancelInstance = message.instanceId
    } else if (message.instanceId !== expectedInstance) {
      this.fail(launch, failure('device_response_identity')); return
    }
    launch.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.status === 'error') pending.reject(failure(`device_${message.code}`))
    else { this.snapshot = message.snapshot; if (message.snapshot.drain !== null) this.drain = message.snapshot.drain; pending.resolve(message.snapshot) }
  }

  private request(launch: Launch, action: DeviceLifecycleRequest['action'], timeout: number): Promise<DeviceLifecycleSnapshot> {
    if (launch.closed || !launch.child.connected || launch.failure !== undefined) return Promise.reject(launch.failure ?? failure('device_ipc_closed'))
    const request = deviceLifecycleRequest.parse({ kind: 'power-evolve-device-lifecycle', version: 1,
      type: 'request', launchId: launch.launchId, instanceId: launch.instance?.instanceId ?? launch.cancelInstance ?? null,
      requestId: deviceLifecycleRequest.shape.requestId.parse(randomUUID()), action })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { launch.pending.delete(request.requestId); reject(failure('device_request_timeout')) }, timeout)
      launch.pending.set(request.requestId, { action, instanceId: request.instanceId, resolve, reject, timer })
      try {
        launch.child.send(request, error => {
          if (error !== null && launch.pending.delete(request.requestId)) { clearTimeout(timer); reject(failure('device_ipc_send_failed')) }
        })
      } catch (_sendFailure) {
        launch.pending.delete(request.requestId); clearTimeout(timer); reject(failure('device_ipc_send_failed'))
      }
    })
  }

  private async health(launch: Launch, ready: DeviceLifecycleReady): Promise<void> {
    try {
      const response = await fetch(new URL('/health', ready.url), { redirect: 'error',
        signal: AbortSignal.any([launch.cancel.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]) })
      if (response.status !== 200 || response.body === null) throw failure('device_health_failed')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > this.options.maxHealthBytes) throw failure('device_health_limit')
          chunks.push(chunk.value)
        }
      } finally {
        try { await reader.cancel() }
        catch (_cancelFailure) { /* The original bounded health read determines startup failure. */ }
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || !('ready' in value) || value.ready !== true
        || !('service' in value) || value.service !== 'device' || !('instanceId' in value) || value.instanceId !== ready.instanceId) throw failure('device_health_identity')
    } catch (error) {
      if (launch.failure !== undefined) throw launch.failure
      if (error instanceof DeviceProcessError) throw error
      throw failure(launch.stopping ? 'device_start_cancelled' : 'device_health_failed')
    }
  }

  private async shutdown(launch: Launch): Promise<void> {
    if (launch.closed) {
      if (!launch.clean) throw failure('device_stop_unclean')
      return
    }
    let error: DeviceProcessError | undefined
    try {
      const drain = await this.request(launch, 'quiesce', this.options.quiesceTimeoutMs)
      if (!quiescent(drain)) throw failure('device_not_quiescent')
      const observed = await this.request(launch, 'inspect', this.options.requestTimeoutMs)
      if (!quiescent(observed)) throw failure('device_not_quiescent')
      const terminated = await this.request(launch, 'terminate', this.options.requestTimeoutMs)
      if (!quiescent(terminated)) throw failure('device_not_quiescent')
      const exit = await timed(launch.close, this.options.exitTimeoutMs, 'device_exit_timeout')
      launch.clean = launch.failure === undefined && exit.code === 0 && exit.signal === null
        && terminated.drain !== null && cleanDrain(terminated.drain)
      this.clean = launch.clean
      if (!launch.clean) error = failure('device_stop_unclean')
    } catch (cause) { error = cause instanceof DeviceProcessError ? cause : failure('device_stop_unclean') }
    if (!launch.closed) {
      try { await this.forceExit(launch) }
      catch (_forceFailure) { error ??= failure('device_exit_timeout') }
    }
    if (error !== undefined) throw error
  }

  private forceExit(launch: Launch): Promise<void> {
    launch.forcing ??= this.force(launch)
    return launch.forcing
  }

  private async force(launch: Launch): Promise<void> {
    launch.stopping = true
    launch.cancel.abort()
    this.rejectPending(launch, failure('device_stop_unclean'))
    if (launch.closed) return
    launch.child.kill('SIGTERM')
    try { await timed(launch.close, this.options.exitTimeoutMs, 'device_exit_timeout') }
    catch (_termTimeout) {
      if (!launch.closed) launch.child.kill('SIGKILL')
      await timed(launch.close, this.options.exitTimeoutMs, 'device_exit_timeout')
    }
  }

  private rejectPending(launch: Launch, error: DeviceProcessError): void {
    launch.rejectReady(error)
    for (const pending of launch.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    launch.pending.clear()
  }

  private fail(launch: Launch, error: DeviceProcessError): void {
    launch.failure ??= error
    this.rejectPending(launch, launch.failure)
    launch.cancel.abort()
    if (launch.verified && !launch.stopping && !launch.notified) {
      launch.notified = true
      try { this.onFailure?.(launch.failure) }
      catch (_listenerFailure) { /* A caller callback cannot interrupt owned child cleanup. */ }
    }
    if (!launch.closed) {
      void this.forceExit(launch).catch((_exitFailure: unknown) => { /* Fixed failure remains observable; no clean stop is inferred. */ })
    }
  }
}
