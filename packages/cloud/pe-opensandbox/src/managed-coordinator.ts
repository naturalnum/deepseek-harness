/** Root composition of durable allocations, original account ports and independently settled command reservations. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, AccountRuntimeService, OperationId, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { FdMutationFailure, FilesFailure, type ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SandboxCoordinator, type NativeAccountExecutionAuthority } from './coordinator.ts'
import { IssuedExecutionPort, assertInstalledExecutionBinding, requireIssuedExecutionPort, type AccountExecutionPort } from './account-port.ts'
import { SessionAllocationOwner, type AllocationOwnerConfig, type NativeAllocationRequest, type PreparedSandbox } from './allocation-owner.ts'
import { PostgresAllocationStore } from './allocation-store.ts'
import type { AllocationStoreLimits } from './allocation-types.ts'
import { allocationDatabase } from './allocation-database.ts'
import type { VerifiedExecutionMount } from './lifecycle-types.ts'
import type { SdkAllocationBackend } from './sdk-lifecycle.ts'
import type { SkillCommandBorrow, TrustedRuntimeRegistry } from './trusted-runtime.ts'
import { NativeCommandAccount, type NativeCommandAccountLimits, type NativeCommandReservation } from './native-command-account.ts'
import { CloudShellExecutor, CloudSubprocessRuntime, type NativeExecutionConfig } from './native-providers.ts'
import { CloudShellEnvRegistry } from './native-shell-env.ts'
import type { ExecutionScope } from './scopes.ts'
import { ExecutionStateError } from './errors.ts'
import type { ManagedServiceConfig, ManagedNativeCommandConfig } from './service-config.ts'
import { registerDevServiceConsumer, type DevServiceRegistration } from './dev-service-consumer.ts'
import { SLICE_LIMITS } from './agent-data/constants.ts'
import type { ApplicationServiceSelection, RegisteredApplicationService } from './types.ts'
import type { HttpRequestCharge } from './application-http.ts'

/** Explicit Root limits; logical payload reservations bound retained copies rather than claiming a V8 RSS quota. */
export interface ManagedCoordinatorConfig {
  readonly maxBoundAccounts: number
  readonly maxActiveCommands: number
  readonly maxActiveCommandsPerAccount: number
  readonly maxResidentCommands: number
  readonly maxResidentCommandsPerAccount: number
  readonly maxResidentBytes: number
  readonly maxResidentBytesPerAccount: number
  readonly maxStopObservers: number
  readonly stopWaitBudgetMs: number
  readonly recoveryPageSize: number
  readonly allocations: AllocationOwnerConfig
  readonly store: AllocationStoreLimits
  readonly commands: ManagedNativeCommandConfig
  readonly shell: NativeExecutionConfig
}

/** Original infrastructure export/share; it must retain the actual backing through backend destruction. */
export interface ExecutionExportShare {
  readonly value: VerifiedExecutionMount
  release(): void
}

/** Fixed Root-selected deployment. Account recipes receive neither this object nor SDK credentials. */
export interface ManagedExecutionDeployment {
  readonly backend: SdkAllocationBackend
  readonly runtimes: TrustedRuntimeRegistry
  /** Root-selected explicit bound; actual membership must come from the original files owner. */
  readonly skillCopies?: { readonly maxCopiesPerOperation: number }
  assertCurrent(): void
  /** @param grant Files owner's original mount grant. @param assertCurrent Original native/files admission recheck.
   * @returns Retained, exact daemon exports of the same project/protected .pe/environment devices and quotas.
   */
  share(grant: ExecutionMountGrant, assertCurrent: () => void, skills?: VerifiedExecutionMount['skills']): Promise<ExecutionExportShare>
  /** Assert that this exact epoch retains no export descriptors, including failed unpublished preparation. */
  assertEpochReleased(binding: AccountBinding): void
}

interface EpochObserver { settle(value: ParticipantReceipt): void }

interface SessionRetirement {
  readonly request: NativeAllocationRequest<VerifiedExecutionMount>
  readonly prepared: PreparedSandbox
  readonly actual: Promise<void>
}

/** Files refused environment preparation before an allocation intent or SDK request existed. */
class SessionEnvironmentCapacityError extends ExecutionStateError {
  constructor(cause: FdMutationFailure) {
    super('cloud/capacity', 'No free session environment is available. Continue in a session that already has an environment, or ask an administrator to release or provision one.')
    this.cause = cause
  }
}

interface AccountWork {
  readonly binding: AccountBinding
  readonly root: Context
  readonly assertMountCurrent: () => void
  readonly authority: NativeAccountExecutionAuthority
  readonly stopId: OperationId
  readonly sessions: Map<SessionId, NativeAllocationRequest<VerifiedExecutionMount>>
  readonly observers: Set<EpochObserver>
  readonly capacity: { active: number; resident: number; bytes: number; requests: number }
  readonly detach: () => void
  open: boolean
  claimed: boolean
  providers?: {
    readonly ctx: Context
    readonly commands: NativeCommandAccount
    readonly shell: CloudShellExecutor
    readonly subprocess: CloudSubprocessRuntime
    readonly shellEnv: CloudShellEnvRegistry
    services?: { readonly configuration: ManagedServiceConfig; readonly registration: DevServiceRegistration }
  }
  allocationsStopping?: Promise<void>
  retiring?: SessionRetirement | undefined
  stopping?: Promise<void>
  outcome?: ParticipantReceipt
  privateFailure?: { readonly cause: unknown }
}

class ManagedAccountPort extends IssuedExecutionPort {
  constructor(binding: AccountBinding, private readonly owner: ManagedCoordinator, override readonly enforcesSessionFilePolicy?: true) {
    super(binding, owner, 'session-collect')
  }
  assertCurrent(ctx: Context): void { this.owner.assertPort(this, ctx) }
  deny(ctx: Context, signal?: AbortSignal): never {
    this.assertCurrent(ctx); signal?.throwIfAborted()
    throw new ExecutionStateError('cloud/execution-unavailable', 'Execution requires its original native command provider.')
  }
  claim(ctx: Context): void { this.owner.claim(this, ctx) }
  close(): void { this.owner.closePort(this) }
  installProviders(ctx: Context): void { this.owner.installProviders(this, ctx) }
  withApplicationService(ctx: Context, selection: ApplicationServiceSelection, signal: AbortSignal,
    deadlineAtMs: number, consume: (service: RegisteredApplicationService) => Promise<void>): Promise<void> {
    return this.owner.withApplicationService(this, ctx, selection, signal, deadlineAtMs, consume)
  }
}

/** Root owns all actual work; account scope revocation closes starts without reporting cleanup complete. */
export class ManagedCoordinator extends SandboxCoordinator {
  private readonly bindings = new WeakMap<AccountBinding, AccountWork>()
  private readonly ports = new WeakMap<AccountExecutionPort, AccountWork>()
  private readonly accounts = new Map<AccountId, AccountWork>()
  private readonly state: {
    open: boolean
    ready: boolean
    recoveryClear: boolean
    active: number
    resident: number
    bytes: number
    requests: number
    observers: number
    starting?: Promise<void>
    closing?: Promise<void>
  } = { open: true, ready: false, recoveryClear: false, active: 0, resident: 0, bytes: 0, requests: 0, observers: 0 }
  private readonly resources: {
    store?: PostgresAllocationStore
    allocations?: SessionAllocationOwner<VerifiedExecutionMount>
  } = {}

  /**
   * @param ctx Root execution entry scope.
   * @param runtime Original runtime registration and metadata owner.
   * @param config Complete finite limits resolved by Root's configuration parser.
   * @param deployment Actual fixed backend, authenticated client registry and retained export authority.
   */
  constructor(ctx: Context, runtime: Pick<AccountRuntimeService, 'registerDrainParticipant' | 'controlDatabase'>,
    private readonly config: ManagedCoordinatorConfig,
    private readonly deployment: ManagedExecutionDeployment) {
    for (const value of [config.maxBoundAccounts, config.maxActiveCommands, config.maxActiveCommandsPerAccount,
      config.maxResidentCommands, config.maxResidentCommandsPerAccount, config.maxResidentBytes,
      config.maxResidentBytesPerAccount, config.maxStopObservers, config.stopWaitBudgetMs, config.recoveryPageSize]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Managed execution requires finite positive limits.')
    }
    if (config.maxActiveCommandsPerAccount > config.maxActiveCommands || config.maxResidentCommandsPerAccount > config.maxResidentCommands
      || config.maxResidentBytesPerAccount > config.maxResidentBytes || config.recoveryPageSize > config.store.maxRows) {
      throw new RangeError('Managed execution account or recovery limits exceed Root capacity.')
    }
    const copies = deployment.skillCopies?.maxCopiesPerOperation
    if (copies !== undefined && (!Number.isSafeInteger(copies) || copies < 1 || copies > 2147483647
      || !Number.isSafeInteger(copies * 2048 + 4096) || copies * 2048 + 4096 > config.maxResidentBytesPerAccount)) {
      throw new RangeError('Working-copy metadata cannot fit the explicit original execution reservation.')
    }
    super(ctx)
    runtime.registerDrainParticipant(this)
    this.resources.store = new PostgresAllocationStore(allocationDatabase(runtime.controlDatabase(this)), config.store)
    this.resources.allocations = new SessionAllocationOwner(this.store, {
      create: (intent, mount) => deployment.backend.create(intent, mount),
      prepare: async (created, mount, until) => deployment.runtimes.bindPrepared(await deployment.backend.prepare(created, mount, until)),
      stop: (created, prepared) => deployment.backend.stop(created, prepared),
    }, config.allocations)
    ctx.effect(() => () => this.closeRoot(), 'pe-opensandbox: retain Root execution until actual cleanup')
  }

  /**
   * Initialize metadata and reject retained nonterminal allocations before opening Root admission.
   * @returns Actual migration and bounded orphan check; existing nonterminal metadata never authorizes create replay.
   */
  start(): Promise<void> {
    return this.state.starting ??= (async () => {
      this.deployment.assertCurrent()
      await this.store.migrate()
      const retained = await this.store.listNonterminal(null, null, this.config.recoveryPageSize)
      if (retained.allocations.length !== 0 || retained.nextCursor !== null) this.unavailable()
      this.state.recoveryClear = true
      if (!this.state.open) this.unavailable()
      this.deployment.assertCurrent()
      this.state.ready = true
    })()
  }

  override assertReady(): void {
    if (!this.state.open || !this.state.ready) this.unavailable()
    this.deployment.assertCurrent()
  }

  /** Observe original command/request and allocation settlement while retaining healthy warm Sessions.
   * @param binding Original installed epoch, never a copied account/epoch value.
   * @returns True only when the original owners prove quiet; retained selections and completed output are not activity.
   */
  override isEpochIdle(binding: AccountBinding): boolean {
    this.assertReady()
    const work = this.bindings.get(binding)
    if (work === undefined || this.accounts.get(binding.accountId) !== work || !work.open || binding.lifetime.aborted) return false
    work.assertMountCurrent()
    return work.stopping === undefined && work.allocationsStopping === undefined && work.privateFailure === undefined
      && work.capacity.active === 0 && work.capacity.requests === 0
      && work.providers !== undefined && work.providers.commands.isIdle() && this.allocations.isEpochIdle(binding)
  }

  override bindAccount(ctx: Context, binding: AccountBinding, assertCurrent: () => void,
    authority?: NativeAccountExecutionAuthority): AccountExecutionPort {
    this.assertReady(); assertCurrent()
    assertInstalledExecutionBinding(ctx, binding, ctx.root)
    binding.lifetime.throwIfAborted()
    if (authority === undefined || ctx.root === this.ctx.root || this.bindings.has(binding)
      || this.accounts.has(binding.accountId)) this.stale()
    if (this.accounts.size >= this.config.maxBoundAccounts) this.capacity()
    const abort = (): void => { this.beginStop(work) }
    const work: AccountWork = { binding, root: ctx.root, assertMountCurrent: assertCurrent, authority,
      stopId: brandString<OperationId>(randomUUID()), sessions: new Map(), observers: new Set(),
      capacity: { active: 0, resident: 0, bytes: 0, requests: 0 }, open: true, claimed: false,
      detach: () => { binding.lifetime.removeEventListener('abort', abort) } }
    const port = Object.freeze(new ManagedAccountPort(binding, this,
      this.config.shell.enforceSessionFilePolicy === true ? true : undefined))
    this.bindings.set(binding, work); this.ports.set(port, work); this.accounts.set(binding.accountId, work)
    binding.lifetime.addEventListener('abort', abort, { once: true })
    return port
  }

  /**
   * Check the installed binding, open Root/account admission and original mount guard.
   * @param port Exact issued port.
   * @param ctx Actual installation or native caller scope.
   */
  assertPort(port: AccountExecutionPort, ctx: Context): void {
    const work = this.owned(port)
    assertInstalledExecutionBinding(ctx, work.binding, work.root)
    this.assertReady()
    if (!work.open || work.binding.lifetime.aborted) this.stale()
    work.assertMountCurrent()
  }

  /**
   * Claim the sole provider installation and fence this account when its entry is disposed.
   * @param port Original live account port.
   * @param ctx Sole execution entry scope.
   */
  claim(port: AccountExecutionPort, ctx: Context): void {
    this.assertPort(port, ctx)
    const work = this.owned(port)
    if (work.claimed) throw new ExecutionStateError('cloud/invalid-config', 'Execution providers already belong to this generation.')
    work.claimed = true
    ctx.effect(() => () => { this.beginStop(work) }, 'pe-opensandbox: fence original account execution port')
  }

  /**
   * Install native execution providers and the optional service consumer in their sole account entry.
   * @param port Original installed port.
   * @param ctx Sole execution account entry scope.
   */
  installProviders(port: AccountExecutionPort, ctx: Context): void {
    if (requireIssuedExecutionPort(ctx) !== port) this.stale()
    const service = this.config.commands.services
    if (service !== undefined && ctx.get('tools') === undefined) {
      throw new ExecutionStateError('cloud/invalid-config', 'Development services require the original native tools provider.')
    }
    if (ctx.get('shell') !== undefined || ctx.root.get('shell') !== undefined
      || ctx.get('subprocess') !== undefined || ctx.root.get('subprocess') !== undefined
      || ctx.get('shellEnv') !== undefined || ctx.root.get('shellEnv') !== undefined) {
      throw new ExecutionStateError('cloud/invalid-config', 'The account already has native execution or environment providers.')
    }
    this.claim(port, ctx)
    const work = this.owned(port)
    const configured = this.config.commands
    const commandConfig: NativeCommandAccountLimits = {
      enforceSessionFilePolicy: this.config.shell.enforceSessionFilePolicy === true,
      allowedTools: configured.allowedTools, maxScopes: configured.maxScopes, commandLimits: configured.commandLimits,
      ...(this.deployment.skillCopies === undefined ? {}
        : { maxSkillCopiesPerOperation: this.deployment.skillCopies.maxCopiesPerOperation }),
      ...(service === undefined ? {} : { services: {
        profile: service.profile, operationLimits: configured.commandLimits,
        ...(service.application === undefined ? {} : { application: {
          maxRequestsPerService: service.application.maxRequestsPerService,
          reserve: (scope, charge) => this.reserveApplication(work, scope, charge),
          transport: (registration, identity, owner) => {
            this.assertProviders(port, ctx)
            const application = service.application
            if (application === undefined) this.unavailable()
            return this.deployment.runtimes.application(registration, identity, application.transport, owner)
          },
        } }),
        assertQualified: (profile) => {
          this.assertPort(port, ctx)
          if (profile !== service.profile || profile.runMs !== SLICE_LIMITS.serviceRunMs) {
            throw new ExecutionStateError('cloud/invalid-config', 'The selected service policy differs from the fixed runtime.')
          }
        },
        serviceSpec: (scope, _profile, start) => ({
          argv: ['/opt/session-env/venv/bin/python', '-B', posix.join(scope.project.path, start.script), ...start.args],
          cwd: scope.project.path, graceMs: service.graceMs, signal: scope.lifetime,
          stdio: { stdin: 'ignore', stdout: { maxBytes: service.maxOutputBytes }, stderr: { maxBytes: service.maxOutputBytes } },
        }),
      } }),
    }
    const commands = new NativeCommandAccount(ctx, work.binding, work.authority, commandConfig, {
      acquire: async (scope, signal, registered) => {
        registered?.assertCurrent()
        const request = await this.request(work, scope, signal)
        try {
          let prepared = await this.allocations.prepare(request, signal)
          if (registered === undefined && this.deployment.runtimes.needsContinuation(prepared)) {
            commands.assertContinuation(scope)
            // stop synchronously fences the old allocation; its original promise joins physical and SQL settlement.
            await this.allocations.stop(request)
            this.deployment.backend.retireStopped(prepared, (selection) =>{  this.deployment.runtimes.retireStopped(prepared, selection) })
            signal.throwIfAborted(); request.assertCurrent()
            commands.retireCompletedSession(scope)
            prepared = await this.allocations.prepare(request, signal)
            signal.throwIfAborted(); request.assertCurrent()
          }
          const policy = this.deployment.skillCopies, parent = this.deployment.runtimes.skillProject(prepared)
          if ((policy === undefined) !== (parent === undefined)) this.stale()
          let copies: Parameters<TrustedRuntimeRegistry['command']>[1]
          try {
            if (policy !== undefined && parent !== undefined) {
              copies = await this.borrowProjectCopies(work, parent, signal)
              request.assertCurrent(); registered?.assertCurrent()
            }
            if (registered === undefined) return this.deployment.runtimes.command(prepared, copies)
            registered.assertCurrent()
            if (registered.scope !== scope) this.stale()
            return this.deployment.runtimes.service(prepared, registered, copies)
          } catch (cause) { copies?.release(); throw cause }
        }
        catch (cause) {
          if (cause instanceof SessionEnvironmentCapacityError) {
            try {
              // Only this typed, pre-intent files refusal proves no backend was created. Join the original owner anyway.
              await this.allocations.stop(request)
              if (work.sessions.get(request.sessionId) === request) work.sessions.delete(request.sessionId)
            } catch (failure) {
              work.privateFailure ??= { cause: failure }
              return this.unavailable()
            }
            if (signal.aborted) throw signal.reason
            throw new ExecutionStateError('cloud/capacity', cause.message)
          }
          work.privateFailure ??= { cause }
          if (signal.aborted) throw signal.reason
          return this.unavailable()
        }
      },
      unknown: (scope, operation, cause) => {
        work.privateFailure ??= { cause }
        const request = work.sessions.get(scope.sessionId)
        if (request === undefined) return
        void this.allocations.stop(request).then(() => { operation.acknowledgePhysicalStop() },
          (failure: unknown) => { work.privateFailure ??= { cause: failure } })
      },
      reserve: (scope, spec) => this.reserve(work, scope, spec),
      close: () => this.stopAllocations(work),
    })
    const shell = new CloudShellExecutor(ctx, commands, this.config.shell), subprocess = new CloudSubprocessRuntime(ctx, commands)
    const shellEnv = new CloudShellEnvRegistry(ctx, commands)
    const providers: NonNullable<AccountWork['providers']> = { ctx, commands, shell, subprocess, shellEnv }
    work.providers = providers
    if (service !== undefined) ctx.effect(() => {
      const registration = registerDevServiceConsumer(ctx, commands.calls, subprocess, commands, service.profile)
      providers.services = { configuration: service, registration }
      return () => { registration(); delete providers.services }
    }, 'pe-opensandbox: original native development-service consumer')
  }

  /**
   * Verify exact live provider instances and their installation fiber without invoking a native tool.
   * @param port Original installed port.
   * @param ctx Actual account audit scope.
   */
  assertProviders(port: AccountExecutionPort, ctx: Context): void {
    this.assertPort(port, ctx)
    const providers = this.owned(port).providers
    if (providers === undefined || providers.ctx.fiber.state !== FiberState.ACTIVE
      || providers.commands.enforcesSessionFilePolicy !== port.enforcesSessionFilePolicy
      || (port.enforcesSessionFilePolicy === true) !== (this.config.shell.enforceSessionFilePolicy === true)) this.stale()
    const original = (value: unknown): unknown => {
      if (value === null || typeof value !== 'object' && typeof value !== 'function') return value
      const target: unknown = Reflect.get(value, symbols.original)
      return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
    }
    for (const [key, expected] of [['shell', providers.shell], ['subprocess', providers.subprocess],
      ['shellEnv', providers.shellEnv]] as const) {
      const entry = providers.ctx.fiber.store?.[key]
      if (original(ctx.get(key)) !== expected || original(ctx.root.get(key)) !== expected
        || entry?.fiber !== providers.ctx.fiber || original(entry.value) !== expected) this.stale()
    }
  }

  /**
   * Recheck the original provider pair and retained Session work before a synchronous policy change.
   * @param port Exact Root-issued account execution capability.
   * @param ctx Original account caller.
   * @param session Original native Session whose permission events will change.
   */
  assertSessionFilePolicyChange(port: AccountExecutionPort, ctx: Context, session: Session): void {
    this.assertProviders(port, ctx)
    const providers = this.owned(port).providers
    if (port.enforcesSessionFilePolicy !== true || providers === undefined) this.stale()
    providers.commands.assertSessionFilePolicyChange(session)
  }

  /**
   * Verify installed service registration and qualification without checking application readiness.
   * @param port Original issued port.
   * @param ctx Actual admitted account consumer scope.
   * @returns Current consumer and configured application-factory availability; no HTTP request is made.
   */
  inspectServices(port: AccountExecutionPort, ctx: Context): { developmentServices: boolean; servicePreview: boolean } {
    this.assertProviders(port, ctx)
    const service = this.config.commands.services, providers = this.owned(port).providers
    if (service === undefined) return Object.freeze({ developmentServices: false, servicePreview: false })
    if (providers === undefined) this.stale()
    const installed = providers.services
    if (installed === undefined || installed.configuration !== service || !this.config.commands.allowedTools.includes('dev_service')) this.stale()
    installed.registration.assertCurrent(ctx)
    providers.commands.assertQualified(service.profile)
    return Object.freeze({ developmentServices: true,
      servicePreview: service.application !== undefined && this.deployment.runtimes.hasApplicationProvider() })
  }

  /**
   * Borrow from this exact installed generation without entering allocation preparation.
   * @param port Original Root-issued account port.
   * @param ctx Original admitted account context.
   * @param selection Original native Session and service row identifiers.
   * @param signal Original ingress cancellation observer.
   * @param deadlineAtMs Original absolute request deadline.
   * @param consume Consumer retained through actual local response settlement.
   * @returns Original service-row borrow and I/O settlement.
   */
  async withApplicationService(port: AccountExecutionPort, ctx: Context, selection: ApplicationServiceSelection,
    signal: AbortSignal, deadlineAtMs: number, consume: (service: RegisteredApplicationService) => Promise<void>): Promise<void> {
    this.assertProviders(port, ctx); signal.throwIfAborted()
    const commands = this.owned(port).providers?.commands
    if (commands === undefined) this.stale()
    await commands.withApplicationService(selection, signal, deadlineAtMs, async (service) => {
      this.assertProviders(port, ctx)
      await consume(service)
    })
    this.assertProviders(port, ctx)
  }

  /**
   * Permanently fence this account and begin retained cleanup independently of business-current admission.
   * @param port Original issued port; cleanup never depends on business-current admission.
   */
  closePort(port: AccountExecutionPort): void { this.beginStop(this.owned(port)) }

  override stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt> {
    const work = this.bindings.get(binding)
    if (work === undefined) this.stale()
    if (!Number.isSafeInteger(deadlineAtMs)) throw new RangeError('Execution stop requires a finite server deadline.')
    const remaining = Math.min(deadlineAtMs - Date.now(), this.config.stopWaitBudgetMs)
    this.beginStop(work)
    if (work.outcome !== undefined) return Promise.resolve(work.outcome)
    if (remaining <= 0) return Promise.resolve(this.receipt(work, false))
    if (this.state.observers >= this.config.maxStopObservers) this.capacity()
    return new Promise((resolve) => {
      const observer: EpochObserver = { settle: (value) => {
        if (!work.observers.delete(observer)) return
        clearTimeout(timer); this.state.observers--; resolve(value)
      } }
      const timer = setTimeout(() => { observer.settle(this.receipt(work, false)) }, remaining)
      work.observers.add(observer); this.state.observers++
    })
  }

  /**
   * Fence Root and join account, backend and startup work before checking unresolved metadata.
   * @returns Original actual Root shutdown promise; failure retains participant and Root metadata ownership.
   */
  closeRoot(): Promise<void> {
    if (this.state.closing !== undefined) return this.state.closing
    this.state.open = false; this.state.ready = false
    const closing = Promise.withResolvers<undefined>()
    this.state.closing = closing.promise
    const accounts = [...this.accounts.values()]
    for (const work of accounts) this.beginStop(work)
    const startupJoined = this.state.starting?.then(() => undefined, () => undefined)
    const actual = Promise.allSettled([this.resources.allocations?.close(), startupJoined,
      this.deployment.backend.closeRootActual(), ...accounts.map(work => work.stopping)])
    void actual.then((results) => {
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') closing.reject(failed.reason)
      else {
        const store = this.resources.store?.inspect()
        if (store !== undefined && (store.pendingQueries !== 0 || store.mutationResponsibilities !== 0)
          || this.state.starting !== undefined && !this.state.recoveryClear) {
          closing.reject(new ExecutionStateError('cloud/execution-unavailable', 'Root execution metadata remains unconfirmed.'))
        } else closing.resolve(undefined)
      }
    })
    return this.state.closing
  }

  /** Derive the complete bounded set only from the original files owner; no API publication mirror grants membership. */
  private async borrowProjectCopies(work: AccountWork, parent: NonNullable<VerifiedExecutionMount['skills']>,
    signal: AbortSignal): Promise<SkillCommandBorrow> {
    signal.throwIfAborted(); work.authority.assertBusinessCurrent()
    const files = work.authority.files()
    files.assertSkillProjectGrant(parent.grant)
    const held = await files.borrowAllBundleWorkingCopies(parent.grant, signal)
    try {
      files.assertBundleOperationCopies(held.value)
      if (held.value.project !== parent.grant) this.stale()
      if (held.value.copies.length > parent.maxCopies) this.capacity()
      work.authority.assertBusinessCurrent(); signal.throwIfAborted()
      return { value: held.value, maxCopies: parent.maxCopies,
        assertCurrent: () => { work.authority.assertBusinessCurrent(); files.assertBundleOperationCopies(held.value) },
        release: () => { held.release() } }
    } catch (cause) { held.release(); throw cause }
  }

  /** Obtain a cached request, joining one exact idle retirement when concurrent compute capacity is full.
   * @param work Original account retaining all active and failed selections.
   * @param scope Current original consumer; a victim Session waits for its old compute to retire before rebuilding.
   * @param signal Original acquisition cancellation; it never cancels the shared actual retirement.
   * @returns Original cached request or one fresh selection after actual retirement releases capacity.
   */
  private async request(work: AccountWork, scope: ExecutionScope<Workspace>,
    signal: AbortSignal): Promise<NativeAllocationRequest<VerifiedExecutionMount>> {
    for (;;) {
      this.assertReady(); work.authority.assertBusinessCurrent(); scope.lifetime.throwIfAborted(); signal.throwIfAborted()
      if (!work.open || scope.binding !== work.binding) this.stale()
      const retiring = work.retiring
      if (retiring?.request.sessionId === scope.sessionId) { await retiring.actual; continue }
      const existing = work.sessions.get(scope.sessionId)
      if (existing !== undefined) {
        if (existing.workspaceId !== scope.project.id) this.stale()
        existing.assertCurrent()
        return existing
      }
      if (work.privateFailure !== undefined) this.unavailable()
      if (work.sessions.size < this.config.allocations.maxAllocationsPerAccount
        && this.allocations.inspect().allocations < this.config.allocations.maxAllocations) break
      if (retiring !== undefined) { await retiring.actual; continue }
      const commands = work.providers?.commands
      if (commands === undefined) this.unavailable()
      let selected: Pick<SessionRetirement, 'request' | 'prepared'> | undefined
      for (const request of work.sessions.values()) {
        if (!commands.isSessionQuiescent(request.sessionId)) continue
        const prepared = this.allocations.preparedForRetirement(request)
        if (prepared !== undefined) { selected = { request, prepared }; break }
      }
      if (selected === undefined) this.capacity()
      const settled = Promise.withResolvers<void>()
      const original: SessionRetirement = { ...selected, actual: settled.promise }
      // Fence only this Session before any await; concurrent admission joins this original retirement.
      work.retiring = original
      void original.actual.catch(() => { /* The original rejected retirement remains retained. */ })
      void this.retireSession(work, original).then(() => {
        settled.resolve()
        if (work.retiring === original) work.retiring = undefined
      }, (cause: unknown) => {
        work.privateFailure ??= { cause }
        settled.reject(cause)
      })
      await original.actual
    }
    const session: Session = scope.agent.session, workspace = scope.project
    const current = (): void => {
      this.assertReady(); work.authority.assertBusinessCurrent()
      if (!work.open || work.binding.lifetime.aborted || work.authority.projectForSession(session) !== workspace
        || !workspace.sessionIds.includes(scope.sessionId)) this.stale()
    }
    const request: NativeAllocationRequest<VerifiedExecutionMount> = { binding: work.binding, sessionId: scope.sessionId,
      workspaceId: workspace.id, assertCurrent: current,
      prepareMount: async () => {
        current()
        const files = work.authority.files(), project = await files.projectFor(workspace)
        current()
        const held = await files.prepareExecutionMounts(project, session.id, this.config.allocations.environmentVersion)
          .catch((cause: unknown) => {
            if (cause instanceof FdMutationFailure && cause.outcome === 'not-published' && cause.code === 'FS_TOO_LARGE'
              && cause.cause instanceof FilesFailure && cause.cause.code === 'cloud/capacity') {
              throw new SessionEnvironmentCapacityError(cause)
            }
            throw cause
          })
        let share: ExecutionExportShare | undefined
        let parent: Awaited<ReturnType<typeof files.prepareSkillProject>> | undefined
        const granted = (): void => {
          current(); files.assertExecutionMountGrant(held.value)
          if (parent !== undefined) files.assertSkillProjectGrant(parent.value)
        }
        try {
          const policy = this.deployment.skillCopies
          if (policy !== undefined) {
            if (!Number.isSafeInteger(policy.maxCopiesPerOperation)
              || policy.maxCopiesPerOperation < 1 || policy.maxCopiesPerOperation > 2147483647) this.capacity()
            parent = await files.prepareSkillProject(project, work.binding.lifetime)
          }
          granted(); share = await this.deployment.share(held.value, granted, parent === undefined || policy === undefined ? undefined
            : { grant: parent.value, maxCopies: policy.maxCopiesPerOperation }); granted()
          if (share.value.grant !== held.value) this.stale()
          const originalShare = share
          return { value: originalShare.value, projectMountVersion: held.value.project.mountVersion,
            assertCurrent: () => { granted(); originalShare.value.assertCurrent() },
            release: () => { originalShare.release(); parent?.release(); held.release() } }
        } catch (cause) { share?.release(); parent?.release(); held.release(); throw cause }
      } }
    work.sessions.set(scope.sessionId, request)
    return request
  }

  /** Retire one original idle compute after synchronously fencing its Session admission.
   * @param work Original account owner retaining the request and native operations.
   * @param original Exact prepared object and shared retirement promise selected before this call.
   * @returns Actual physical/SQL/SDK/runtime settlement; a rejection retains the original request and fence.
   */
  private async retireSession(work: AccountWork, original: SessionRetirement): Promise<void> {
    if (work.retiring !== original || work.sessions.get(original.request.sessionId) !== original.request
      || work.providers?.commands.isSessionQuiescent(original.request.sessionId) !== true
      || this.allocations.preparedForRetirement(original.request) !== original.prepared) this.unavailable()
    await this.allocations.stop(original.request)
    this.deployment.backend.retireStopped(original.prepared, (selection) => {
      this.deployment.runtimes.retireStopped(original.prepared, selection)
    })
    if (work.sessions.get(original.request.sessionId) !== original.request) this.stale()
    work.sessions.delete(original.request.sessionId)
  }

  private reserve(work: AccountWork, scope: ExecutionScope<Workspace>, spec: SubprocessSpawnSpec): NativeCommandReservation {
    this.assertReady(); work.authority.assertBusinessCurrent()
    if (!work.open || scope.binding !== work.binding || typeof spec.stdio.stdout === 'string'
      || typeof spec.stdio.stderr === 'string') this.stale()
    const stdinBytes = typeof spec.stdio.stdin === 'object' ? Buffer.byteLength(spec.stdio.stdin.data) : 0
    const bytes = 8 * (spec.stdio.stdout.maxBytes + spec.stdio.stderr.maxBytes + stdinBytes + Buffer.byteLength(spec.cwd)
      + spec.argv.reduce((total, part) => total + Buffer.byteLength(part) + 1, 0)) + 8192
      + this.config.commands.commandLimits.maxWaiters * 256
      + (this.deployment.skillCopies === undefined ? 0 : this.deployment.skillCopies.maxCopiesPerOperation * 2048 + 4096)
    if (!Number.isSafeInteger(bytes) || bytes < 1 || this.state.active >= this.config.maxActiveCommands
      || work.capacity.active >= this.config.maxActiveCommandsPerAccount || this.state.resident >= this.config.maxResidentCommands
      || work.capacity.resident >= this.config.maxResidentCommandsPerAccount || this.state.bytes + bytes > this.config.maxResidentBytes
      || work.capacity.bytes + bytes > this.config.maxResidentBytesPerAccount) this.capacity()
    this.state.active++; this.state.resident++; this.state.bytes += bytes
    work.capacity.active++; work.capacity.resident++; work.capacity.bytes += bytes
    let active = true, resident = true
    return Object.freeze({ releaseActive: () => {
      if (!active) return
      active = false; this.state.active--; work.capacity.active--
    }, releaseResident: () => {
      if (!resident) return
      resident = false; this.state.resident--; work.capacity.resident--; this.state.bytes -= bytes; work.capacity.bytes -= bytes
    } })
  }

  private reserveApplication(work: AccountWork, scope: ExecutionScope<Workspace>, charge: HttpRequestCharge): { release(): void } {
    this.assertReady(); work.authority.assertBusinessCurrent()
    if (!work.open || scope.binding !== work.binding || scope.purpose !== 'service') this.stale()
    const application = this.config.commands.services?.application
    if (application === undefined) this.unavailable()
    // Shared logical payload capacity includes request metadata and bounded URL copies, not a V8 RSS quota.
    const bytes = charge.retainedPayloadBytes + 8192 + charge.headerEntries * 256 + 4 * application.transport.maxPathBytes
    if (!Number.isSafeInteger(bytes) || bytes < 1 || this.state.requests >= application.maxRequests
      || work.capacity.requests >= application.maxRequestsPerAccount || this.state.bytes + bytes > this.config.maxResidentBytes
      || work.capacity.bytes + bytes > this.config.maxResidentBytesPerAccount) this.capacity()
    this.state.requests++; work.capacity.requests++; this.state.bytes += bytes; work.capacity.bytes += bytes
    let retained = true
    return Object.freeze({ release: () => {
      if (!retained) return
      retained = false; this.state.requests--; work.capacity.requests--; this.state.bytes -= bytes; work.capacity.bytes -= bytes
    } })
  }

  private stopAllocations(work: AccountWork): Promise<void> {
    work.open = false
    if (work.allocationsStopping !== undefined) return work.allocationsStopping
    const stops = [...work.sessions.values()].map(request => this.allocations.stop(request))
    if (work.retiring !== undefined) stops.push(work.retiring.actual)
    return work.allocationsStopping ??= Promise.allSettled(stops).then((results) => {
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }

  private beginStop(work: AccountWork): void {
    if (work.stopping !== undefined) return
    work.open = false
    const stopped = Promise.withResolvers<undefined>()
    work.stopping = stopped.promise
    const result = Promise.allSettled([this.stopAllocations(work), work.providers?.commands.closeProvider()]).then((results) => {
      const failed = results.find(value => value.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      this.deployment.assertEpochReleased(work.binding)
      if (work.capacity.active !== 0 || work.capacity.resident !== 0 || work.capacity.bytes !== 0
        || work.capacity.requests !== 0) this.unavailable()
      work.detach()
      if (this.accounts.get(work.binding.accountId) === work) this.accounts.delete(work.binding.accountId)
    })
    void result.then(() => { stopped.resolve(undefined); this.settle(work, true) }, (cause: unknown) => {
      work.privateFailure ??= { cause }; stopped.reject(cause); this.settle(work, false)
    })
    void work.stopping.catch(() => { /* The same failed actual stop remains owned and observable. */ })
  }

  private settle(work: AccountWork, confirmed: boolean): void {
    work.outcome = this.receipt(work, confirmed)
    for (const observer of work.observers) observer.settle(work.outcome)
  }

  private receipt(work: AccountWork, confirmed: boolean): ParticipantReceipt {
    const common = { participant: this.id, accountId: work.binding.accountId, epoch: work.binding.epoch,
      evidenceRefs: Object.freeze([`execution:${work.stopId}`]) }
    return Object.freeze(confirmed ? { ...common, status: 'confirmed', pendingOperationIds: Object.freeze([] as const) }
      : { ...common, status: 'unknown', pendingOperationIds: Object.freeze([work.stopId]), reason: 'Actual execution cleanup remains unconfirmed.' })
  }

  private owned(port: AccountExecutionPort): AccountWork {
    const work = this.ports.get(port)
    if (work === undefined) this.stale()
    return work
  }
  private get store(): PostgresAllocationStore {
    const store = this.resources.store
    if (store === undefined) this.unavailable()
    return store
  }
  private get allocations(): SessionAllocationOwner<VerifiedExecutionMount> {
    const allocations = this.resources.allocations
    if (allocations === undefined) this.unavailable()
    return allocations
  }
  private stale(): never { throw new ExecutionStateError('cloud/stale-generation', 'Execution requires the original current account generation.') }
  private unavailable(): never { throw new ExecutionStateError('cloud/execution-unavailable', 'Cloud execution is not confirmed available; Root retains cleanup responsibility.') }
  private capacity(): never { throw new ExecutionStateError('cloud/capacity', 'The configured cloud execution capacity is exhausted.') }
}

/**
 * Install only the original managed account port's providers after the selected account mode is checked.
 * @param ctx Sole account execution entry scope.
 * @param port Root-issued and installed managed capability.
 */
export function installManagedExecutionProviders(ctx: Context, port: AccountExecutionPort): void {
  if (!(port instanceof ManagedAccountPort)) throw new ExecutionStateError('cloud/stale-generation', 'Managed execution requires its original Root port.')
  IssuedExecutionPort.prototype.assertOwned.call(port, ctx)
  ManagedAccountPort.prototype.installProviders.call(port, ctx)
}
