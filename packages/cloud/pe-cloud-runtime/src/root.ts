/** Root control composition retains original PG/storage/native work through ready and drain settlement. */
import { posix } from 'node:path'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ConfigSaveCoordinator, type ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-pe-cloud-files/root'
import type { RuntimeRootConfig } from './root-config.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { AccountFactory, type AccountFactoryRequest, type AccountNativeCloseObservation } from './account-factory.ts'
import { deriveAccountLayout, defaultProjectLayout } from './account-layout.ts'
import { AccountMountPrerequisiteError, type AccountRecipe } from './account-mount.ts'
import { PgOwnerExecutor } from './owner-pg-executor.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import { RuntimeInstanceControl } from './instance-control.ts'
import { PostgresOwnerStore } from './owner-store.ts'
import { RuntimeCapacity } from './capacity.ts'
import { RootRecipeAudit, type RegisteredRootParticipant } from './recipe-audit.ts'
import type { OwnerRecoveryExpectation, OwnerRecoveryProof } from './owner-types.ts'

function hasRootFetch(value: unknown): value is { inspectRootFetch(): readonly ExactFetchExposure[] } {
  return value !== null && typeof value === 'object' && typeof Reflect.get(value, 'inspectRootFetch') === 'function'
}
import { createAccountPolicy } from './account-policy.ts'
import { AccountRuntimeError } from './errors.ts'
import { RuntimeConfigSchema, RuntimeRootConfigSchema } from './schema.ts'
import type { AccountBinding, AccountId, AccountOwner, AccountRecoveryRuntime, AccountRuntimeService, AccountUse, RuntimeControlObservation, DrainCapacityReservation, DrainParticipant, MountCapacityReservation, ParticipantId, RootMetadataDatabase, RootRecipeInput, RootRecipeObservation, RootRecoveryVerifier, RuntimeConfig } from './types.ts'

export { AccountRuntimeError } from './errors.ts'
export type * from './types.ts'


interface RootControl {
  readonly config: RuntimeRootConfig
  readonly executor: PgOwnerExecutor
  readonly database: RootMetadataDatabase
  readonly instance: RuntimeInstanceControl
  readonly owners: PostgresOwnerStore
  readonly factory: AccountFactory
  readonly saves: ConfigSaveCoordinator
  readonly requests: Map<AccountId, AccountFactoryRequest>
  readonly secrets: Set<Promise<string>>
  recovery?: AccountRecoveryRuntime
  recoveryVerifier?: { readonly participant: DrainParticipant; readonly verify: RootRecoveryVerifier['verify'] }
  phase: 'starting' | 'active' | 'failed' | 'closing' | 'closed'
  starting: Promise<void>
  heartbeat?: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
  failure?: unknown
}

interface RootParticipant extends RegisteredRootParticipant {
  readonly closeRoot?: () => Promise<void>
  readonly metadata: { accepting: boolean; shutdown?: Promise<void>; database?: RootMetadataDatabase }
}

/** Runtime-owned component API; only the function Loader entry creates the actual control plane. */
export class PeAccountRuntime extends Service implements AccountRuntimeService {
  static Config = RuntimeConfigSchema

  private readonly participants = new Map<ParticipantId, RootParticipant>()
  private readonly recipe: RootRecipeAudit
  private readonly capacity: RuntimeCapacity
  private closed = false
  private control: RootControl | undefined

  /** Root-only maintenance capability; ordinary and component-only runtimes keep recovery closed. */
  get recovery(): AccountRecoveryRuntime | undefined { return this.control?.recovery }

  /**
   * Install one root with explicit limits; this does not acquire a PG owner or mark an account ready.
   * @param ctx Root plugin context.
   * @param config Required deployment capacities.
   */
  constructor(ctx: Context, config: RuntimeConfig) {
    const resolved = RuntimeConfigSchema(config)
    super(ctx, 'peAccountRuntime')
    this.capacity = new RuntimeCapacity(resolved)
    this.recipe = new RootRecipeAudit(ctx, () => [...this.participants.values()], () => ({
      phase: this.control?.phase ?? 'component', recipeVersion: this.control?.config.recipeVersion,
      maximum: this.control?.config.native.maxEntries,
    }))
    const rootClose = ctx.root.effect(() => () => this.close(), 'pe-cloud-runtime: join actual control at root disposal')
    ctx.effect(() => async () => {
      try { await this.close() } finally { await rootClose() }
    }, 'pe-cloud-runtime: close actual root control')
  }

  /**
   * Register a root participant in the caller's effect scope; duplicates are rejected.
   * @param participant The files/root or execution/root actual-work owner.
   * @returns An idempotent disposer; caller unload also removes the contribution.
   * @throws AccountRuntimeError for duplicates or closed registration.
   */
  registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void> {
    this.assertOpen()
    if (this.participants.has(participant.id)) {
      throw new AccountRuntimeError('cloud/invalid-config', `Duplicate mandatory drain participant: ${participant.id}`)
    }
    return this.ctx.effect(() => {
      const metadata: RootParticipant['metadata'] = { accepting: true }
      const stop = participant.closeRoot?.bind(participant)
      const registered: RootParticipant = { participant, fiber: this.ctx.fiber, metadata,
        ...(stop === undefined ? {} : { closeRoot: () => metadata.shutdown ??= Promise.resolve().then(stop).then(() => {
          metadata.accepting = false
        }) }) }
      this.recipe.revoke()
      this.participants.set(participant.id, registered)
      return () => {
        this.recipe.revoke()
        const withdraw = (): void => { this.participants.delete(participant.id) }
        if (registered.closeRoot === undefined) {
          withdraw()
          return
        }
        return registered.closeRoot().then(withdraw)
      }
    }, 'pe-cloud-runtime: drain participant')
  }

  controlDatabase(participant: DrainParticipant): RootMetadataDatabase {
    const control = this.activeControl()
    const registration = this.participants.get(participant.id)
    if (registration?.participant !== participant || registration.closeRoot === undefined) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Root metadata requires the original registered Root shutdown owner')
    }
    if (registration.metadata.shutdown !== undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Root participant shutdown has already begun')
    }
    const participants = this.participants
    registration.metadata.database ??= Object.freeze({
      wasNotSubmitted: (cause: unknown) => control.database.wasNotSubmitted(cause),
      query(text: string, values: readonly (string | null)[]) {
        if (participants.get(participant.id) !== registration || !registration.metadata.accepting) {
          return Promise.reject(new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Root participant database admission is closed before SQL submission'))
        }
        return control.database.query(text, values)
      },
    })
    return registration.metadata.database
  }

  /**
   * Audit the actual Loader/providers and immutable deployment manifest before traffic.
   * @param input Fixed recipe requirements, not a caller-supplied success receipt.
   * @throws AccountRuntimeError while any fact or real storage capability is unavailable.
   */
  sealRecipe(input: RootRecipeInput): void {
    this.assertOpen()
    if (this.control !== undefined) this.assertBusinessMode(this.control)
    this.recipe.seal(input)
  }

  /**
   * Require a current complete seal before external admission.
   * @param recipeVersion Expected fixed deployment version.
   * @throws AccountRuntimeError for unsealed, revoked, closed or incomplete storage admission.
   */
  assertRecipeSealed(recipeVersion: string): void {
    this.assertOpen()
    if (this.control !== undefined) this.assertBusinessMode(this.control)
    this.recipe.assertSealed(recipeVersion)
  }

  /** Revoke root admission before replacing or reloading the recipe. */
  revokeRecipe(): void { this.recipe.revoke() }

  /**
   * Recheck the retained audit without authorizing traffic.
   * @returns Current safe audit facts; missing storage always prevents sealing.
   */
  inspectRecipe(): RootRecipeObservation { return this.recipe.inspect() }

  /**
   * Reject an incomplete root before a future recipe audit can consider its other evidence.
   * This check neither seals a recipe nor verifies storage, owner, execution, or config saving.
   * @throws AccountRuntimeError when files or execution is absent, or the root is closed.
   */
  assertRequiredParticipants(): void {
    this.assertOpen()
    for (const id of ['files', 'execution'] as const) {
      if (!this.participants.has(id)) {
        throw new AccountRuntimeError('cloud/invalid-config', `Missing mandatory drain participant: ${id}`)
      }
    }
  }

  /**
   * Reserve local factory capacity without acquiring owner metadata or creating a graph.
   * @param accountId Trusted account whose concurrent factory has already been merged by its owner.
   * @returns A reservation retained through actual mounting and graph disposal.
   */
  reserveMountCapacity(accountId: AccountId): MountCapacityReservation {
    this.assertRequiredParticipants()
    return this.capacity.reserveMount(accountId)
  }

  /**
   * Reserve bounded drain work for an existing local account reservation.
   * @param accountId Account whose actual drain will own the slot.
   * @returns A reservation released only after actual drain settlement.
   */
  reserveDrainCapacity(accountId: AccountId): DrainCapacityReservation {
    this.assertOpen()
    return this.capacity.reserveDrain(accountId)
  }

  /**
   * Construct the component and establish actual root control through the formal credential provider.
   * @param ctx Root Loader scope with credentials already available.
   * @param config Complete validated deployment configuration, never component-only capacities.
   * @returns The registered runtime after migrations and process registration; accounts remain unready.
   */
  static async mountRoot(ctx: Context, config: RuntimeRootConfig): Promise<PeAccountRuntime> {
    const resolved = structuredClone(RuntimeRootConfigSchema(config))
    validateRootLocations(resolved)
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new AccountRuntimeError('cloud/invalid-config', 'Runtime root requires the formal credentials service')
    const runtime = new PeAccountRuntime(ctx, resolved)
    const actual = runtime.startControl(resolved, credentials)
    try {
      await observe(actual, resolved.startupTimeoutMs, 'Runtime root startup observation expired')
      runtime.armRecipeSeal(resolved)
    }
    catch (cause) {
      runtime.controlFailure(cause)
      await runtime.close()
      throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime root startup failed; account admission remains closed')
    }
    return runtime
  }

  /**
   * Query actual owner metadata without creating a graph or treating absence as recovery authority.
   * @param accountId Authenticated identity supplied by trusted access composition.
   * @returns Current PG ownership or confirmed absence.
   */
  locateAccount(accountId: AccountId): Promise<AccountOwner | undefined> {
    return this.activeControl().owners.locate(accountId)
  }

  /**
   * Require a current recipe seal before any PG claim, then enter the retained concrete factory.
   * Missing real production ports independently reject before native boot and ready CAS.
   * @param accountId Authenticated account; browser expectations never select this value.
   * @param signal Optional observer abandonment; absence waits to accountWaitTimeoutMs.
   * @returns A ready AccountUse only after actual storage/native audit and ready CAS rechecks.
   */
  acquireAccount(accountId: AccountId, signal?: AbortSignal): Promise<AccountUse> {
    const control = this.activeControl()
    this.assertBusinessMode(control)
    this.assertRecipeSealed(control.config.recipeVersion)
    this.assertRequiredParticipants()
    let request = control.requests.get(accountId)
    const fresh = request === undefined
    if (request === undefined) {
      if (control.requests.size >= control.config.maxMountedAccounts) {
        throw new AccountRuntimeError('cloud/capacity', 'Runtime root account input capacity is exhausted')
      }
      request = this.accountRequest(control, accountId)
      control.requests.set(accountId, request)
    }
    // The factory checks observer admission before starting an actual claim.
    const borrowed = control.factory.acquireAccount(
      control.owners, request, Date.now() + control.config.accountWaitTimeoutMs, signal,
    )
    if (fresh) {
      if (!control.factory.retainsAccount(accountId)) control.requests.delete(accountId)
      else {
        const retained = request
        const settled = (): void => {
          if (!control.factory.retainsAccount(accountId) && control.requests.get(accountId) === retained) control.requests.delete(accountId)
        }
        void control.factory.claimAndMount(control.owners, request).then(settled, settled)
      }
    }
    return borrowed
  }

  /**
   * Require the current recipe seal and borrow the original ready graph for a login Peer.
   * @param binding Exact runtime-installed generation retained by the trusted caller.
   * @returns A fresh independent lifecycle reference; stale, unpublished and closed graphs reject.
   */
  async borrowAccount(binding: AccountBinding): Promise<AccountUse> {
    this.assertBusinessMode(this.activeControl())
    this.assertRecipeSealed(binding.recipeVersion)
    return this.activeControl().factory.borrowCurrent(binding)
  }

  /**
   * Check the exact installed graph during restricted native preparation as well as ready.
   * @param binding Original graph binding, never a request borrow.
   */
  assertMountCurrent(binding: AccountBinding): void {
    const control = this.activeControl()
    this.assertBusinessMode(control)
    control.factory.assertMountCurrent(binding)
  }

  /**
   * Admit business only with a current recipe seal and exact ready publication.
   * @param binding Original installed graph binding; unpublished, stale and closed graphs reject.
   */
  assertBusinessCurrent(binding: AccountBinding): void {
    this.assertBusinessMode(this.activeControl())
    this.assertRecipeSealed(binding.recipeVersion)
    this.activeControl().factory.assertBusinessCurrent(binding)
  }

  /**
   * Inspect root-control counts without deployment paths, secrets, SQL or native Contexts.
   * @returns Component-only status or actual retained control disposition; neither is account readiness.
   */
  inspectControl(): RuntimeControlObservation {
    const control = this.control
    return Object.freeze({
      phase: control?.phase ?? 'component', pendingSecrets: control?.secrets.size ?? 0,
      accounts: control?.factory.inspect().slots ?? 0, hasFailure: control?.failure !== undefined,
    })
  }

  /**
   * Close admission, then join actual root work before releasing its capacity or PG connections.
   * Observation expiry reports uncertainty and keeps awaiting the retained operation; it never releases resources.
   * Native-only observations cannot release an account owner or prove a clean drain.
   * @returns The retained close Promise; rejects after settlement when control/cleanup remains uncertain.
   */
  close(): Promise<void> {
    this.closed = true
    this.recipe.close()
    const control = this.control
    if (control === undefined) { this.capacity.close(); return Promise.resolve() }
    if (control.closing !== undefined) return control.closing
    control.phase = 'closing'
    clearTimeout(control.timer)
    const actual = this.finishControl(control)
    control.closing = actual
    const timer = setTimeout(() => {
      this.ctx.logger.error('Runtime root shutdown observation expired; actual work and owner responsibility remain retained')
    }, control.config.shutdownTimeoutMs)
    timer.unref()
    void actual.then(() => { clearTimeout(timer) }, () => { clearTimeout(timer) })
    return actual
  }

  private startControl(config: RuntimeRootConfig, credentials: CredentialProvider): Promise<void> {
    const secrets = new Set<Promise<string>>()
    const password = (): Promise<string> => this.resolvePassword(config, credentials, secrets)
    const executor = new PgOwnerExecutor({ ...config.database, password }, config.pg)
    const database: RootMetadataDatabase = Object.freeze({
      wasNotSubmitted: (cause: unknown) => cause instanceof OwnerPgNotSubmittedError,
      query: (text: string, values: readonly (string | null)[]) => executor.query(text, values),
    })
    const instance = new RuntimeInstanceControl(executor, config)
    const owners = new PostgresOwnerStore(executor, instance.identity, config, config.recovery === undefined ? undefined : {
      instanceId: instance.identity.instanceId, verifierId: config.recovery.verifierId, limits: config.recovery.limits,
      verify: expected => this.verifyRecovery(expected),
    })
    const factory = new AccountFactory(this.capacity, config.factory)
    const saves = new ConfigSaveCoordinator(config.saves)
    const control: RootControl = {
      config, executor, database, instance, owners, factory, saves, requests: new Map(), secrets,
      phase: 'starting', starting: Promise.resolve(),
    }
    this.control = control
    if (config.recovery !== undefined) control.recovery = this.recoveryCapability(control)
    control.starting = (async () => {
      await password()
      this.assertStarting(control)
      await instance.migrate()
      this.assertStarting(control)
      await owners.migrate()
      this.assertStarting(control)
      await instance.register()
      this.assertStarting(control)
      control.phase = 'active'
      this.scheduleHeartbeat(control)
    })()
    return control.starting
  }

  private resolvePassword(config: RuntimeRootConfig, credentials: CredentialProvider, pending: Set<Promise<string>>): Promise<string> {
    if (pending.size >= config.pg.maxConnections) {
      return Promise.reject(new AccountRuntimeError('cloud/capacity', 'Runtime credential resolution admission is unavailable'))
    }
    const actual = Promise.resolve().then(async () => {
      const resolved = await credentials.resolve(credentialRef(config.database.passwordRef))
      if (resolved === undefined || resolved.value.length === 0
        || resolved.value.length > config.maxSecretBytes || Buffer.byteLength(resolved.value) > config.maxSecretBytes) {
        throw new AccountRuntimeError('cloud/invalid-config', 'Runtime database credential is absent or exceeds its finite limit')
      }
      return resolved.value
    })
    pending.add(actual)
    void actual.then(() => { pending.delete(actual) }, () => { pending.delete(actual) })
    return observe(actual, config.secretResolveTimeoutMs, 'Runtime credential resolution observation expired')
  }

  private scheduleHeartbeat(control: RootControl): void {
    if (this.closed || control.phase !== 'active') return
    control.timer = setTimeout(() => {
      if (this.closed || control.phase !== 'active') return
      const actual = Promise.resolve().then(() => control.instance.heartbeat())
      control.heartbeat = actual
      void observe(actual, control.config.heartbeatTimeoutMs, 'Runtime instance heartbeat observation expired').then(
        () => { if (control.heartbeat === actual) delete control.heartbeat; this.scheduleHeartbeat(control) },
        (cause: unknown) => { this.controlFailure(cause) },
      )
    }, control.config.heartbeatIntervalMs)
    control.timer.unref()
  }

  private async finishControl(control: RootControl): Promise<void> {
    const faults: unknown[] = []
    try { await control.starting } catch (cause) { control.failure ??= cause }
    try { await control.heartbeat } catch (cause) { faults.push(cause) }
    let native: readonly AccountNativeCloseObservation[] = []
    try { native = await control.factory.close() } catch (cause) { faults.push(cause) }
    let rootWorkUnknown = false
    for (const registration of this.participants.values()) {
      try { await registration.closeRoot?.() }
      catch (cause) { rootWorkUnknown = true; faults.push(cause) }
    }
    for (const observation of native) {
      // Known complete production drains have already released; incomplete generations remain quarantined.
      try {
        const owner = await control.owners.locate(observation.accountId)
        if (owner?.ownerInstanceId === control.instance.identity.instanceId
          && (owner.phase === 'mounting' || owner.phase === 'ready')) {
          await control.owners.quarantine({ accountId: owner.accountId, epoch: owner.epoch })
        }
      } catch (cause) { faults.push(cause) }
      if (observation.status === 'unknown') faults.push(observation.cause ?? new AccountRuntimeError('cloud/stop-unconfirmed', 'Native account shutdown is not confirmed'))
    }
    if (rootWorkUnknown || native.some(observation => observation.status === 'unknown')) {
      control.failure ??= faults[0]
      control.phase = 'failed'
      this.ctx.logger.error('Actual account drain remains unresolved; original Root control resources and ownership remain retained')
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Root retains actual unresolved account work')
    }
    try { control.saves.close() } catch (cause) { faults.push(cause) }
    try { await control.instance.close() } catch (cause) { faults.push(cause) }
    await Promise.allSettled([...control.secrets])
    try { await control.executor.close() } catch (cause) { faults.push(cause) }
    this.capacity.close()
    control.requests.clear()
    if (faults.length !== 0) {
      control.failure ??= faults[0]
      control.phase = 'failed'
      this.ctx.logger.error('Runtime root control or shutdown is unconfirmed; account ownership was not released and automatic recovery remains closed')
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Runtime root shutdown retained unresolved control or cleanup evidence')
    }
    control.phase = control.failure === undefined ? 'closed' : 'failed'
  }

  private accountRequest(control: RootControl, accountId: AccountId): AccountFactoryRequest {
    const { config } = control
    const exposure = this.ctx.root.get('peExposure')
    const execution = this.ctx.root.get('peSandboxCoordinator')
    const files = this.ctx.root.get('peFilesPool')
    const selectedAuth: unknown = this.ctx.root.get('peAuth')
    const auth = hasRootFetch(selectedAuth) ? selectedAuth : undefined
    if (exposure === undefined || execution === undefined || files === undefined) throw new AccountMountPrerequisiteError()
    const storage = files.requireStorageOwner()
    storage.assertRootCurrent()
    const instanceId = control.instance.identity.instanceId
    const layout = deriveAccountLayout(accountId, instanceId, config.paths)
    return Object.freeze({
      accountId, instanceId, recipeVersion: config.recipeVersion, deployment: config.paths,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot, DSH_HOME: layout.privateRoot } }]),
      recipe: Object.freeze({
        profile: {
          name: 'pe-cloud-account', dir: layout.profileRoot, patchPath: layout.patchPath, installAnchor: config.native.installAnchor,
          cwd: defaultProjectLayout(layout, config.paths.maxPathBytes).root, home: layout.privateRoot,
          startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
        },
        configPath: config.native.configPath, bareModuleBaseUrl: config.native.bareModuleBaseUrl,
        requiredEntryIds: config.native.requiredEntryIds, maxObservedEvents: config.native.maxObservedEvents,
        maxPathBytes: config.paths.maxPathBytes,
        storage: Object.freeze({ owner: storage, files }),
        native: { saves: control.saves, exposure: exposure.policy, execution, stopTimeoutMs: config.shutdownTimeoutMs,
          maxNativeInventoryEntries: config.native.maxEntries,
          ...auth === undefined ? {} : { inspectRootFetch: () => {
            const current: unknown = this.ctx.root.get('peAuth')
            if (!hasRootFetch(current) || (Reflect.get(current, symbols.original) ?? current)
              !== (Reflect.get(auth, symbols.original) ?? auth)) throw new AccountMountPrerequisiteError()
            return auth.inspectRootFetch()
          } },
          ...config.native.attachments === undefined ? {} : { attachments: config.native.attachments },
          ...config.native.firstScreen === undefined ? {} : { firstScreen: {
            ...config.native.firstScreen, home: layout.privateRoot,
          } },
          guards: (ctx, binding, files) => createAccountPolicy(
            ctx, binding, files, config.accountPolicy, exposure.policy, config.native.maxEntries,
          ),
          assertRootCurrent: () => { this.assertRecipeSealed(config.recipeVersion) } },
        prepare: (_ctx, binding) => {
          storage.assertRootCurrent()
          this.assertRecipeSealed(config.recipeVersion)
          this.assertMountCurrent(binding)
        },
      } satisfies AccountRecipe),
    })
  }

  private armRecipeSeal(config: RuntimeRootConfig): void {
    if (config.recovery !== undefined) return
    const ready = this.ctx.root.get('appReady')
    if (ready === undefined) return
    this.ctx.effect(() => ready.onReady(() => {
      if (this.closed || this.control?.phase !== 'active') return
      try { this.recipe.sealCurrent(config.recipeVersion, config.native.maxEntries) }
      catch (_cause) { this.ctx.logger.error('Cloud Root recipe audit did not seal; account admission remains closed. Inspect the retained audit.') }
    }), 'pe-cloud-runtime: audit Root after native startup commits')
  }

  private activeControl(): RootControl {
    this.assertOpen()
    const control = this.control
    if (control === undefined || control.phase !== 'active') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime root control is not available')
    }
    return control
  }

  private assertBusinessMode(control: RootControl): void {
    if (control.config.recovery !== undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Maintenance recovery keeps ordinary account admission closed')
    }
  }

  private recoveryParticipant(control: RootControl, participant: DrainParticipant, mutation: boolean): RootParticipant {
    const registration = this.participants.get('execution')
    if (this.control !== control || control.config.recovery === undefined || participant.id !== 'execution'
      || registration?.participant !== participant || registration.closeRoot === undefined || !registration.metadata.accepting
      || mutation && (this.closed || control.phase !== 'active')) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Recovery requires its original active Root execution owner')
    }
    return registration
  }

  private async verifyRecovery(expected: Readonly<OwnerRecoveryExpectation>): Promise<OwnerRecoveryProof> {
    const control = this.activeControl(), selected = control.recoveryVerifier
    if (selected === undefined) throw new AccountRuntimeError('cloud/stop-unconfirmed', 'No original Root recovery verifier is registered')
    this.recoveryParticipant(control, selected.participant, true)
    const proof = await selected.verify(expected)
    this.recoveryParticipant(control, selected.participant, true)
    if (control.recoveryVerifier !== selected) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Root recovery verifier was withdrawn before submission')
    }
    return proof
  }

  private recoveryCapability(control: RootControl): AccountRecoveryRuntime {
    const current = (participant: DrainParticipant, mutation: boolean): void => {
      this.recoveryParticipant(control, participant, mutation)
      if (control.recoveryVerifier?.participant !== participant) {
        throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Recovery verifier is not bound to this original execution owner')
      }
    }
    const capability: AccountRecoveryRuntime = {
      whenReady: () => control.starting,
      registerVerifier: (participant: DrainParticipant, verifier: RootRecoveryVerifier) => {
        const registration = this.recoveryParticipant(control, participant, true)
        if (control.recoveryVerifier !== undefined || verifier.id !== control.config.recovery?.verifierId) {
          throw new AccountRuntimeError('cloud/invalid-config', 'Only the selected original Root recovery verifier can register')
        }
        const selected = { participant, verify: verifier.verify.bind(verifier) }, close = registration.closeRoot
        if (close === undefined) throw new AccountRuntimeError('cloud/invalid-config', 'Recovery requires an original shutdown owner')
        return this.ctx.effect(() => {
          control.recoveryVerifier = selected
          return async () => {
            await close()
            if (control.recoveryVerifier === selected) delete control.recoveryVerifier
          }
        }, 'pe-cloud-runtime: retain original recovery verifier through actual work')
      },
      migrate: (participant: DrainParticipant) => { current(participant, true); return control.owners.migrateRecovery() },
      locateInstance: (participant: DrainParticipant, instanceId) => {
        current(participant, false); return control.instance.locate(instanceId)
      },
      recoverAccount: (participant: DrainParticipant, expected) => {
        current(participant, true); return control.owners.recoverReleased(expected)
      },
      inspectAccount: (participant: DrainParticipant, expected) => {
        current(participant, false); return control.owners.inspectRecovery(expected)
      },
      closeInstance: (participant: DrainParticipant, expected) => {
        current(participant, true); return control.owners.closeRecoveredInstance(expected)
      },
      inspectInstance: (participant: DrainParticipant, expected) => {
        current(participant, false); return control.owners.inspectRecoveredInstance(expected)
      },
    }
    return Object.freeze(capability)
  }

  private assertStarting(control: RootControl): void {
    if (this.closed || control.phase !== 'starting') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime root startup admission has closed')
    }
  }

  private controlFailure(cause: unknown): void {
    const control = this.control
    if (control === undefined) return
    control.failure ??= cause
    this.recipe.revoke()
    if (!this.closed) control.phase = 'failed'
    this.ctx.logger.error('Runtime root control failed or became uncertain; new account admission is closed and status requires inspection')
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Runtime registration is closed')
  }
}


function validateRootLocations(config: RuntimeRootConfig): void {
  const { maxPathBytes } = config.paths
  const paths = [config.paths.sharedAccountsRoot, config.paths.localCacheRoot, config.native.configPath, config.native.installAnchor]
  for (const path of paths) {
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes('\0') || path.includes('\\')
      || path.length > maxPathBytes || Buffer.byteLength(path) > maxPathBytes) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Runtime deployment locations must be normalized bounded absolute POSIX paths')
    }
  }
  const base = new URL(config.native.bareModuleBaseUrl)
  if (base.protocol !== 'file:' || base.search !== '' || base.hash !== ''
    || config.native.requiredEntryIds.length === 0 || config.native.requiredEntryIds.length > config.native.maxEntries
    || new Set(config.native.requiredEntryIds).size !== config.native.requiredEntryIds.length) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Runtime native recipe locations or required entries are invalid')
  }
}

function observe<T>(actual: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new AccountRuntimeError('cloud/account-unavailable', message)) }, timeoutMs)
  })
  return Promise.race([actual, timeout]).finally(() => { clearTimeout(timer) })
}

/** Actual root Loader identity. */
export const name = 'pe-cloud-runtime/root'
/** Root control requires a formal credential provider before any database work. */
export const inject = ['credentials']
export type { RuntimeRootConfig } from './root-config.ts'
/** Complete production deployment configuration, separate from RuntimeConfigSchema capacities. */
export const Config = RuntimeRootConfigSchema
/**
 * Establish real root control without waiting for downstream files/execution injection.
 * @param ctx Root Loader scope; participant presence is checked when acquiring an account.
 * @param config Explicit database references, deployment paths and finite budgets.
 * @returns After actual migrations and instance registration, never account readiness.
 */
export async function apply(ctx: Context, config: RuntimeRootConfig): Promise<void> {
  await PeAccountRuntime.mountRoot(ctx, config)
}
