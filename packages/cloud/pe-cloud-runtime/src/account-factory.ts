/** Private actual mount, ready CAS and drain ownership with removable observers. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CloudAccountApi } from '@deepseek-ai/dsh-pe-cloud-api'
import type { RootStorageOwner, StaticAccountStorageLease } from '@deepseek-ai/dsh-pe-cloud-files/root'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deriveAccountLayout, type LayoutDeployment } from './account-layout.ts'
import { mountAccount, requireAccountProductionPorts, AccountMountPrerequisiteError, type AccountRecipe } from './account-mount.ts'
import type { NativeAccountBootHandle, NativeAccountBootOutcome, NativeDisposalObservation } from './native-boot.ts'
import { AccountNativeIntegration } from './account-native-integration.ts'
import type { RuntimeCapacity } from './capacity.ts'
import type { PostgresOwnerStore } from './owner-store.ts'
import { AccountRuntimeError } from './errors.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import { observeStartup, startupFailureObserver, type StartupObserver } from './startup-observation.ts'
import type { AccountBinding, AccountId, AccountOwner, ConfigurationRebuildReceipt, AccountMountInput, AccountUse, DrainParticipant, InstanceId, MountCapacityReservation, OperationId, ParticipantReceipt, SubagentCapacityReservation } from './types.ts'

/** Explicit limits for waiters and graph borrows, separate from actual mount/drain capacity. */
export interface AccountFactoryLimits {
  readonly maxWaiters: number
  readonly maxWaitersPerAccount: number
  readonly maxBorrows: number
  readonly maxBorrowsPerAccount: number
}

/** Root-resolved trusted inputs; no secret reference resolution or caller-selected account path. */
export interface AccountFactoryRequest {
  readonly accountId: AccountId
  readonly instanceId: InstanceId
  readonly recipeVersion: string
  readonly deployment: LayoutDeployment
  readonly environment: LaunchEnvironmentSnapshot
  readonly recipe: AccountRecipe
}

/** A waiting deadline or abort does not cancel the original mount. */
export class AccountMountWaitError extends AccountRuntimeError {
  /**
   * @param reason Why this observer left while the mount owner retains its responsibility.
   */
  constructor(readonly reason: 'deadline' | 'observer-cancelled') {
    super('cloud/account-starting', 'Account mount observation ended; inspect status before retrying')
    this.name = 'AccountMountWaitError'
  }
}

/** Close status; native disposal alone never establishes account clean or releases its owner. */
export type AccountNativeCloseObservation = Readonly<{
  accountId: AccountId
  status: 'not-started' | 'observed' | 'unknown'
  native?: NativeDisposalObservation
  cause?: unknown
}>

type State = 'claiming' | 'mounting' | 'mounted-unpublished' | 'ready' | 'reconfiguring' | 'blocked' | 'failed' | 'unknown' | 'closing' | 'closed'
type Settlement = { value: NativeAccountBootOutcome } | { cause: Error }
interface Waiter { finish(settlement: Settlement): void }
interface Slot {
  readonly accountId: AccountId
  readonly recipe: AccountRecipe
  readonly reservation: MountCapacityReservation
  readonly result: ReturnType<typeof Promise.withResolvers<NativeAccountBootOutcome>>
  readonly waiters: Set<Waiter>
  input?: AccountMountInput
  request?: AccountFactoryRequest
  owners?: PostgresOwnerStore
  claimAttempted: boolean
  state: State
  readonly startupDiagnostic: StartupObserver
  binding?: AccountBinding
  context?: Context
  native?: NativeAccountBootHandle
  integration?: AccountNativeIntegration
  storageOwner?: RootStorageOwner
  storageParticipant?: DrainParticipant
  storagePreparation?: Promise<StaticAccountStorageLease>
  storageLease?: StaticAccountStorageLease
  controller?: AbortController
  settlement?: Settlement
  closing?: Promise<AccountNativeCloseObservation>
  closeRequested: boolean
  borrows: number
  borrowsEnded?: ReturnType<typeof Promise.withResolvers<undefined>>
  releaseAfterClose: boolean
  configuration?: Promise<unknown>
  verifyConfiguration?: (api: CloudAccountApi, current: () => void) => Promise<void>
  ownerMutation?: Promise<unknown>
  quarantine?: Promise<void>
}

const MAX_DELAY = 2_147_483_647

/**
 * One root's bounded graph slots, not a second persisted owner authority.
 * Concrete PG and native boot work remain owned after every observer leaves. Provider absence
 * blocks production before native startup and before ready CAS; no mounted fixture can bypass it.
 */
export class AccountFactory {
  private readonly slots = new Map<AccountId, Slot>()
  private readonly limits: AccountFactoryLimits
  private waiters = 0
  private borrows = 0
  private closed = false
  private closing: Promise<readonly AccountNativeCloseObservation[]> | undefined

  /**
   * @param capacity Existing runtime-owned account/mount/drain reservations; not a readiness proof.
   * @param limits Explicit finite waiter and borrow ceilings; no hidden queue or defaults.
   * @param observe Optional original Root logger; no output grants admission or releases ownership.
   */
  constructor(private readonly capacity: RuntimeCapacity, limits: AccountFactoryLimits,
    private readonly observe?: (row: Readonly<Record<string, string | number | boolean | null>>) => void) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new AccountRuntimeError('cloud/invalid-config', 'Account factory limits must be positive finite integers')
      }
    }
    this.limits = Object.freeze({ ...limits })
  }

  /**
   * Log actual retained objects; this neither opens business admission nor certifies disposal.
   * @param accountId Optional trusted account whose presence is read from the original Map, including confirmed absence.
   */
  logObservation(accountId?: AccountId): void {
    if (this.observe === undefined) return
    try {
      const slots = [...this.slots.values()]
      this.observe({ event: 'factory-snapshot', pid: process.pid, slots: slots.length,
        retainedContexts: slots.filter(slot => slot.context !== undefined).length,
        activeContexts: slots.filter(slot => slot.context?.fiber.state === FiberState.ACTIVE).length,
        closed: this.closed })
      if (accountId !== undefined) this.logAccount(accountId)
      else for (const slot of slots) this.logAccount(slot.accountId)
    } catch (_observationError) {
      try { this.observe({ event: 'factory-observation-unknown', pid: process.pid }) }
      catch (_unavailableObserver) { /* Observation failure never changes the original factory operation. */ }
    }
  }

  private logAccount(accountId: AccountId): void {
    const slot = this.slots.get(accountId), context = slot?.context, binding = slot?.binding
    if ([accountId, binding?.epoch, binding?.recipeVersion].some(value => value !== undefined && value.length > 256)) {
      this.observe?.({ event: 'factory-observation-unknown', pid: process.pid })
      return
    }
    const registry = context?.get('workspaceRegistry')
    this.observe?.({ event: 'account-local-observation', pid: process.pid, accountId,
      epoch: binding?.epoch ?? null, recipeVersion: binding?.recipeVersion ?? null,
      slotPresent: slot !== undefined, slotState: slot?.state ?? 'absent', nativeContextPresent: context !== undefined,
      contextActive: context?.fiber.state === FiberState.ACTIVE, rootFiberUid: context?.root.fiber.uid ?? null,
      workspaceRegistryPresent: registry !== undefined,
      workspaceRecords: context === undefined ? 0 : registry === undefined ? null : registry.list().length })
  }

  private logContext(slot: Slot, event: 'context-attached' | 'native-disposal-observed', nativeDisposal: string | null = null): void {
    try {
      const context = slot.context, binding = slot.binding
      if (context === undefined || binding === undefined) return
      if ([binding.accountId, binding.epoch, binding.recipeVersion].some(value => value.length > 256)) {
        this.observe?.({ event: 'factory-observation-unknown', pid: process.pid })
        return
      }
      this.observe?.({ event, pid: process.pid, accountId: binding.accountId, epoch: binding.epoch,
        recipeVersion: binding.recipeVersion, rootFiberUid: context.root.fiber.uid,
        contextActive: context.fiber.state === FiberState.ACTIVE, slotState: slot.state, nativeDisposal })
    } catch (_observationError) {
      try { this.observe?.({ event: 'factory-observation-unknown', pid: process.pid }) }
      catch (_unavailableObserver) { /* Native ownership and close settlement remain unchanged. */ }
    }
    this.logObservation()
  }

  /**
   * Coalesce concrete native assembly for an already trusted generation; no PG claim or ready is inferred.
   * Calls share the same binding/layout/environment/recipe resources, including new outer wrappers.
   * This same-package native-only path is not
   * wired to Root or access; its caller owns the actual PG/root checks and all fixture prerequisites.
   * @param input Existing generation and canonical account addresses.
   * @param recipe Concrete native Profile preparation, never a substituted mounter.
   * @returns The same actual native boot Promise through startup/disposal settlement.
   */
  startNativeMount(input: AccountMountInput, recipe: AccountRecipe): Promise<NativeAccountBootOutcome> {
    this.assertOpen()
    const existing = this.slots.get(input.binding.accountId)
    if (existing !== undefined) {
      if (existing.input === undefined || existing.input.binding !== input.binding || existing.input.layout !== input.layout
        || existing.input.environment !== input.environment || existing.input.instanceId !== input.instanceId
        || existing.recipe !== recipe || existing.request !== undefined) this.conflict()
      return existing.result.promise
    }
    const slot = this.create(input.binding.accountId, recipe, 'mounting')
    slot.input = input
    this.launch(slot, this.runNative(slot, input))
    return slot.result.promise
  }

  /**
   * Retain one actual PG claim-to-publication operation. Concrete provider prerequisites currently reject
   * after a successful claim, before native fallback or ready; the consumed owner/epoch stays retained.
   * @param owners Actual migrated PostgresOwnerStore with the same process identity.
   * @param request Root-resolved account inputs, reused by concurrent callers.
   * @returns The same actual operation; no caller abort is forwarded into it.
   */
  claimAndMount(owners: PostgresOwnerStore, request: AccountFactoryRequest): Promise<NativeAccountBootOutcome> {
    this.assertOpen()
    const existing = this.slots.get(request.accountId)
    if (existing !== undefined) {
      const first = existing.request
      if (first === undefined || existing.owners !== owners || first.accountId !== request.accountId
        || first.instanceId !== request.instanceId || first.recipeVersion !== request.recipeVersion
        || first.recipe !== request.recipe || first.environment !== request.environment
        || first.deployment !== request.deployment) this.conflict()
      return existing.result.promise
    }
    const slot = this.create(request.accountId, request.recipe, 'claiming')
    slot.request = request
    slot.owners = owners
    this.launch(slot, this.runClaimed(slot, owners, request))
    return slot.result.promise
  }

  /**
   * Wait for the retained operation, then borrow only its confirmed ready graph.
   * @param owners Actual migrated owner store, never a test mounter or caller-supplied ready flag.
   * @param request Root-resolved mount inputs reused across observers.
   * @param deadlineAtMs Finite absolute deadline for this observer only.
   * @param signal Optional observer cancellation; absence waits to its deadline.
   * @returns A fresh current AccountUse only after actual production preparation and ready CAS.
   */
  async acquireAccount(
    owners: PostgresOwnerStore, request: AccountFactoryRequest, deadlineAtMs: number, signal?: AbortSignal,
  ): Promise<AccountUse> {
    this.checkWait(request.accountId, deadlineAtMs, signal)
    void this.claimAndMount(owners, request)
    const outcome = await this.observeMount(request.accountId, deadlineAtMs, signal)
    if (outcome.status === 'failed') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Native account assembly failed', { cause: outcome.cause })
    }
    return this.borrowCurrent(outcome.binding)
  }

  /**
   * Observe an existing slot with one removable waiter; repeated expiry never adds actual subscriptions.
   * @param accountId Trusted slot identity; this does not create a mount.
   * @param deadlineAtMs Finite absolute server deadline.
   * @param signal Optional cancellation of this observer only.
   * @returns Actual native result, or rejects with the actual failure or a typed waiting reason.
   */
  observeMount(accountId: AccountId, deadlineAtMs: number, signal?: AbortSignal): Promise<NativeAccountBootOutcome> {
    this.checkWait(accountId, deadlineAtMs, signal)
    const slot = this.slots.get(accountId)
    if (slot === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'No retained mount exists for this account')
    if (slot.settlement !== undefined) {
      return 'value' in slot.settlement ? Promise.resolve(slot.settlement.value) : Promise.reject(slot.settlement.cause)
    }
    const observed = Promise.withResolvers<NativeAccountBootOutcome>()
    const finish = (settlement: Settlement): void => {
      if (!slot.waiters.delete(waiter)) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      this.waiters--
      if ('value' in settlement) observed.resolve(settlement.value)
      else observed.reject(settlement.cause)
    }
    const waiter: Waiter = { finish }
    const aborted = (): void => { finish({ cause: new AccountMountWaitError('observer-cancelled') }) }
    const timer = setTimeout(() => {
      if (slot.waiters.has(waiter)) observeStartup(slot.startupDiagnostic, { expired: true })
      finish({ cause: new AccountMountWaitError('deadline') })
    }, deadlineAtMs - Date.now())
    this.waiters++
    slot.waiters.add(waiter)
    signal?.addEventListener('abort', aborted, { once: true })
    return observed.promise
  }

  /**
   * Reject stale/closed graph capabilities during restricted mounting as well as after assembly.
   * This is not business readiness and never takes an HTTP/Peer borrow.
   * @param binding Exact binding installed by the concrete native prepare callback.
   */
  assertMountCurrent(binding: AccountBinding): void {
    const slot = this.slots.get(binding.accountId)
    if (slot === undefined || slot.binding !== binding || slot.closeRequested || this.closed || binding.lifetime.aborted
      || !['mounting', 'mounted-unpublished', 'ready', 'reconfiguring'].includes(slot.state)
      || slot.context === undefined || slot.context.get('peAccount') !== binding) {
      throw new AccountRuntimeError('cloud/stale-generation', 'Account graph generation is no longer current')
    }
    slot.storageLease?.assertCurrent()
    slot.context.fiber.assertActive()
  }

  /**
   * Check graph business admission without capturing an HTTP or Peer borrow.
   * @param binding Exact installed generation; mounting and unpublished graphs reject.
   */
  assertBusinessCurrent(binding: AccountBinding): void {
    this.assertMountCurrent(binding)
    const slot = this.slots.get(binding.accountId)
    if (slot?.state !== 'ready') {
      throw new AccountRuntimeError('cloud/account-unavailable', 'The account graph has not passed production readiness')
    }
    slot.recipe.native?.assertRootCurrent()
    this.assertMountCurrent(binding)
  }

  /**
   * Reserve a child from this factory's original Root capacity for its exact ready graph.
   * Unknown closes business synchronously, retains original owner quarantine and deferred drain,
   * and cannot become confirmed later. Settlement never disposes its own in-flight callback.
   * @param binding Original installed ready binding, not a copied expectation or native-only fixture.
   * @param depth Actual child depth already checked by the shared account policy.
   * @returns A native-cleanup reservation; confirmed releases only its child slot.
   * @throws AccountRuntimeError before reservation unless original production owners remain present.
   */
  reserveSubagent(binding: AccountBinding, depth: number): SubagentCapacityReservation {
    this.assertBusinessCurrent(binding)
    const slot = this.slots.get(binding.accountId)
    if (slot === undefined || slot.request === undefined || slot.owners === undefined || slot.storageLease === undefined
      || slot.storageOwner !== slot.recipe.storage?.owner || slot.storageParticipant !== slot.recipe.storage?.files
      || slot.integration === undefined || slot.native === undefined || slot.quarantine !== undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'Original production ownership is required for child capacity')
    }
    return this.observeSubagent(slot, this.capacity.reserveSubagent(binding.accountId, depth))
  }

  private observeSubagent(slot: Slot, original: SubagentCapacityReservation): SubagentCapacityReservation {
    let settled = false
    return Object.freeze({ settle: (status: 'confirmed' | 'unknown') => {
      if (settled) return
      settled = true
      original.settle(status)
      if (status !== 'unknown') return
      slot.closeRequested = true
      slot.state = 'unknown'
      void this.quarantineOwned(slot).catch((_cause: unknown) => { /* The same slot retains the actual rejected quarantine. */ })
      if (slot.closing !== undefined) return
      const close = Promise.withResolvers<AccountNativeCloseObservation>()
      slot.closing = close.promise
      // Let the native settlement and its caller's original failure leave this turn before abort/disposal.
      setImmediate(() => {
        try { close.resolve(this.drainOwned(slot)) }
        catch (cause: unknown) { close.resolve(this.unknownClose(slot, cause)) }
      })
    } })
  }

  private retainOwnerMutation<T>(slot: Slot, submit: () => Promise<T>): Promise<T> {
    const previous = slot.ownerMutation
    const actual = Promise.resolve(previous).then(() => {
      if (slot.quarantine !== undefined) {
        throw new AccountRuntimeError('cloud/account-quarantined', 'The original account owner is retained for quarantine')
      }
      return submit()
    })
    slot.ownerMutation = actual
    const settled = (): void => { if (slot.ownerMutation === actual) delete slot.ownerMutation }
    void actual.then(settled, settled)
    return actual
  }

  private quarantineOwned(slot: Slot): Promise<void> {
    if (slot.quarantine !== undefined) return slot.quarantine
    const owners = slot.owners, binding = slot.binding, pending = slot.ownerMutation
    slot.closeRequested = true
    slot.state = 'unknown'
    slot.quarantine = Promise.resolve().then(async () => {
      // The original store distinguishes never-submitted failures from retained unknown writes.
      try { await pending } catch (_cause: unknown) { /* Keep its store responsibility; quarantine cannot bypass it. */ }
      if (owners === undefined || binding === undefined || this.slots.get(slot.accountId) !== slot
        || slot.owners !== owners || slot.binding !== binding) {
        throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original owner identity is unavailable for quarantine')
      }
      await owners.quarantine({ accountId: slot.accountId, epoch: binding.epoch })
    })
    return slot.quarantine
  }

  private async unknownClose(slot: Slot, cause?: unknown): Promise<AccountNativeCloseObservation> {
    slot.closeRequested = true
    slot.state = 'unknown'
    if (slot.owners !== undefined && slot.binding !== undefined) {
      try { await this.quarantineOwned(slot) }
      catch (quarantine: unknown) {
        cause = cause === undefined ? quarantine : new AggregateError([cause, quarantine], 'Original account drain and quarantine are unconfirmed')
      }
    }
    return Object.freeze({ accountId: slot.accountId, status: 'unknown', ...cause === undefined ? {} : { cause } })
  }

  /**
   * Inspect whether the factory still owns an actual account operation or graph.
   * @param accountId Trusted root request whose input resources may be released only after removal.
   * @returns Whether the original slot remains retained, including failed or uncertain work.
   */
  retainsAccount(accountId: AccountId): boolean { return this.slots.has(accountId) }

  /**
   * Select only this factory's existing production binding for an exact observed owner.
   * @param owners Original Root owner store retained by the existing slot.
   * @param expected Trusted metadata; its lifetime or a caller-created binding is never used.
   * @returns The same original borrowCurrent result; absence or any mismatch rejects without creating a slot.
   */
  borrowOwned(owners: PostgresOwnerStore, expected: AccountOwner): Promise<AccountUse> {
    try {
      this.assertOpen()
      const slot = this.slots.get(expected.accountId), binding = slot?.binding, input = slot?.input, request = slot?.request
      if (slot === undefined || slot.owners !== owners || binding === undefined || input === undefined || request === undefined
        || expected.phase !== 'ready' || expected.ownerInstanceId === null
        || input.instanceId !== expected.ownerInstanceId || request.instanceId !== expected.ownerInstanceId
        || binding.accountId !== expected.accountId || binding.epoch !== expected.epoch
        || binding.recipeVersion !== expected.recipeVersion || request.recipeVersion !== expected.recipeVersion) {
        throw new AccountRuntimeError('cloud/stale-generation', 'No original local production graph matches the expected owner')
      }
      return this.borrowCurrent(binding)
    } catch (cause) { return Promise.reject(this.failure(cause)) }
  }

  /**
   * Borrow only an exact, current, ready graph within explicit reference ceilings.
   * Native-only fixtures never reach ready, and a copied binding cannot move a borrow to a new graph.
   * @param binding Exact ready graph binding selected by trusted runtime/access code.
   * @returns A fresh reference with idempotent release; release never stops an Agent.
   */
  borrowCurrent(binding: AccountBinding): Promise<AccountUse> {
    try { return Promise.resolve(this.borrow(binding)) }
    catch (cause) { return Promise.reject(this.failure(cause)) }
  }

  private borrow(binding: AccountBinding): AccountUse {
    this.assertMountCurrent(binding)
    const slot = this.slots.get(binding.accountId)
    if (slot === undefined || slot.state !== 'ready' || slot.context === undefined) {
      throw new AccountRuntimeError('cloud/account-unavailable', 'The account graph has not passed production readiness')
    }
    this.assertBusinessCurrent(binding)
    if (this.borrows >= this.limits.maxBorrows || slot.borrows >= this.limits.maxBorrowsPerAccount) this.full()
    this.borrows++
    slot.borrows++
    let released = false
    return Object.freeze({
      binding, context: slot.context,
      assertCurrent: () => {
        if (released) throw new AccountRuntimeError('cloud/stale-generation', 'This account borrow has been released')
        this.assertBusinessCurrent(binding)
      },
      release: () => {
        if (released) return
        released = true
        slot.borrows--
        this.borrows--
        if (slot.borrows === 0) slot.borrowsEnded?.resolve(undefined)
      },
    })
  }

  /**
   * Retain a borrow through the callback's actual settlement, including failure.
   * @param binding Exact current binding, never a client JSON object.
   * @param deadlineAtMs Deadline for obtaining this borrow; it does not race the callback.
   * @param signal Observer cancellation before borrowing; undefined leaves the deadline in force.
   * @param run Native business callback; its work is not cancelled by releasing the reference.
   * @returns The callback's actual value; finally releases only this borrow.
   */
  async withAccount<T>(
    binding: AccountBinding, deadlineAtMs: number, signal: AbortSignal | undefined, run: (use: AccountUse) => Promise<T>,
  ): Promise<T> {
    this.checkWait(binding.accountId, deadlineAtMs, signal)
    const use = await this.borrowCurrent(binding)
    try { use.assertCurrent(); return await run(use) } finally { use.release() }
  }

  /** Own a nonterminal local update; the initiating Peer must release its actual Use before this call.
   * Busy native work is observed synchronously before any SQL, configuration save or task cancellation.
   * @param binding Original ready generation.
   * @param closeObservers Original access owner closure/join for pure observation Peers, after the idle check.
   * @param operation Original native writer; the callback's check is valid only in this actual window.
   * @returns Actual writer/application/audit settlement with the same root and epoch.
   */
  withIdleConfiguration<T>(binding: AccountBinding, closeObservers: () => Promise<void>,
    operation: (ctx: Context, assertCurrent: () => void) => Promise<T>): Promise<T> {
    this.assertBusinessCurrent(binding)
    const slot = this.slots.get(binding.accountId)
    if (slot === undefined) this.conflict()
    if (slot.configuration !== undefined || slot.integration === undefined || slot.context === undefined
      || slot.recipe.storage === undefined || slot.recipe.native === undefined || slot.owners === undefined) {
      return Promise.reject(new AccountRuntimeError('cloud/config-busy', 'The account has no exclusive configuration window'))
    }
    const integration = slot.integration, context = slot.context
    const preparation = slot.recipe.native, storage = slot.recipe.storage, owners = slot.owners
    slot.state = 'reconfiguring'
    const current = (): void => {
      this.assertMountCurrent(binding)
      if (slot.state !== 'reconfiguring' || slot.context !== context || slot.integration !== integration
        || slot.recipe.native !== preparation || slot.recipe.storage !== storage || slot.owners !== owners) {
        throw new AccountRuntimeError('cloud/stale-generation', 'The original configuration window is unavailable')
      }
      preparation.assertRootCurrent()
    }
    const idle = (): boolean => {
      current()
      return integration.isQuiescent() && storage.files.isEpochIdle?.(binding) === true
        && preparation.execution.isEpochIdle(binding)
    }
    try {
      if (!idle()) {
        slot.state = 'ready'
        return Promise.reject(new AccountRuntimeError('cloud/config-busy', 'The original account still owns native, save, file or execution work'))
      }
    } catch (cause) { slot.state = 'ready'; return Promise.reject(this.failure(cause)) }
    const owned = Promise.withResolvers<T>()
    // The existing graph slot owns this complete operation before the first awaited closure or SQL call.
    slot.configuration = owned.promise
    void (async () => {
      const progress = { transitioned: false, metadataSubmitted: false, nativeStarted: false }
      try {
        await closeObservers()
        current()
        if (slot.borrows !== 0) throw new AccountRuntimeError('cloud/config-busy', 'Original account borrows have not actually released')
        const receipt = await integration.pauseConfiguration()
        current()
        if (receipt.status !== 'confirmed' || !idle()) {
          throw new AccountRuntimeError('cloud/config-busy', 'Actual account work is not quiescent')
        }
        progress.metadataSubmitted = true
        try {
          await this.retainOwnerMutation(slot, () => owners.beginReconfiguration({ accountId: binding.accountId, epoch: binding.epoch }))
        }
        catch (cause) {
          if (cause instanceof OwnerPgNotSubmittedError) progress.metadataSubmitted = false
          throw cause
        }
        progress.transitioned = true
        if (!idle()) throw new AccountRuntimeError('cloud/config-busy', 'Actual account work changed before native configuration')
        const configurationCurrent = (): void => {
          current()
          if (storage.files.isEpochIdle?.(binding) !== true || !preparation.execution.isEpochIdle(binding)) {
            throw new AccountRuntimeError('cloud/config-busy', 'Original file or execution work changed during configuration')
          }
        }
        const value = await integration.withPausedPluginChange(() => {
          configurationCurrent()
          progress.nativeStarted = true
          return operation(context, configurationCurrent)
        })
        configurationCurrent()
        await integration.auditReconfigured(context)
        configurationCurrent()
        await this.retainOwnerMutation(slot, () => owners.finishReconfiguration(
          { accountId: binding.accountId, epoch: binding.epoch }, binding.recipeVersion,
        ))
        configurationCurrent()
        integration.resumeConfiguration()
        slot.state = 'ready'
        return value
      } catch (cause) {
        if (!progress.nativeStarted && (!progress.metadataSubmitted || progress.transitioned)
          && !slot.closeRequested && !binding.lifetime.aborted) {
          try {
            await integration.auditReconfigured(context)
            current()
            const saves = await integration.pauseConfiguration()
            if (saves.status !== 'confirmed' || !idle()) {
              throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original account restoration is unconfirmed')
            }
            if (progress.transitioned) await this.retainOwnerMutation(slot, () => owners.finishReconfiguration(
              { accountId: binding.accountId, epoch: binding.epoch }, binding.recipeVersion,
            ))
            current()
            integration.resumeConfiguration()
            slot.state = 'ready'
          } catch (_restoreFailure) {
            slot.state = 'unknown'
            slot.closeRequested = true
          }
          if (slot.state === 'ready') throw cause
        }
        slot.state = 'unknown'
        slot.closeRequested = true
        throw cause
      } finally {
        if (slot.state === 'ready') delete slot.configuration
      }
    })().then(owned.resolve, owned.reject)
    return owned.promise
  }

  /** Register one explicit terminal update before acknowledging its initiating native RPC.
   * The original request settles before Peer closure; version checking occurs on the paused old save owner before stop.
   * @param binding Original ready generation selected by the verified Peer.
   * @param control Original request/Peer joins, immutable intent preparation and original stopped-graph native writer.
   * @returns Acceptance plus the same owned completion Promise; final graph application follows intent verification and ready CAS.
   */
  scheduleConfigurationRebuild<T, R, V = void>(binding: AccountBinding, control: {
    readonly afterRequest: () => Promise<void>
    readonly closePeers: (deadlineAtMs: number) => Promise<void>
    readonly assertPrincipal: () => void
    readonly prepare: (ctx: Context, assertCurrent: () => void) => Promise<
      Readonly<{ accepted: true; intent: T }> | Readonly<{ accepted: false; error: Error }>>
    readonly apply: (ctx: Context, api: CloudAccountApi, intent: T, assertCurrent: () => void) => Promise<R>
    readonly verify?: (api: CloudAccountApi, intent: T, persisted: R, assertCurrent: () => void) => Promise<V>
    readonly failed: (operationId: OperationId, cause: unknown) => void
  }): Readonly<{ operationId: OperationId; completion: Promise<ConfigurationRebuildReceipt<R, V>> }> {
    this.assertBusinessCurrent(binding)
    const slot = this.slots.get(binding.accountId)
    if (slot === undefined) this.conflict()
    const request = slot.request, owners = slot.owners, integration = slot.integration, context = slot.context
    const original = request?.recipe, preparation = original?.native
    if (slot.configuration !== undefined || request === undefined || original === undefined
      || owners === undefined || preparation === undefined
      || integration === undefined || context === undefined) {
      throw new AccountRuntimeError('cloud/config-busy', 'An original replacement operation is unavailable or already retained')
    }
    const operationId = brandString<OperationId>(randomUUID()), owned = Promise.withResolvers<ConfigurationRebuildReceipt<R, V>>()
    slot.configuration = owned.promise
    void owned.promise.catch((_cause: unknown) => { /* the original slot and Root reporter retain this background failure */ })
    void (async () => {
      let replacement: Slot | undefined
      let terminal = false, oldReleased = false
      let persisted: { value: R } | undefined
      let verification: V | undefined
      try {
        await control.afterRequest()
        this.assertOpen(); control.assertPrincipal(); this.assertBusinessCurrent(binding)
        if (slot.configuration !== owned.promise || slot.context !== context || slot.integration !== integration) this.conflict()
        slot.state = 'reconfiguring'
        const current = (): void => {
          this.assertMountCurrent(binding); control.assertPrincipal()
          if (slot.state !== 'reconfiguring' || slot.configuration !== owned.promise) this.conflict()
          preparation.assertRootCurrent()
        }
        const receipt = await integration.pauseConfiguration()
        current()
        if (receipt.status !== 'confirmed') throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original configuration saves remain unconfirmed')
        const prepared = await integration.withPausedPluginChange(() => control.prepare(context, current))
        if (!prepared.accepted) {
          await integration.auditReconfigured(context)
          current(); integration.resumeConfiguration(); slot.state = 'ready'
          throw prepared.error
        }
        current()
        await control.closePeers(Date.now() + preparation.stopTimeoutMs)
        current()
        if (slot.borrows !== 0 || slot.closing !== undefined) {
          throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original Peers and borrows have not actually settled')
        }
        const closing = this.stopOwned(binding.accountId, owned.promise,
          async (api) => { persisted = { value: await control.apply(context, api, prepared.intent, current) } })
        terminal = true
        const closed = await closing
        if (closed.status !== 'observed' || this.slots.get(binding.accountId)?.state !== 'closed' || !slot.releaseAfterClose) {
          throw new AccountRuntimeError('cloud/stop-unconfirmed', 'The original complete account drain is unconfirmed')
        }
        oldReleased = true
        this.assertOpen(); control.assertPrincipal(); preparation.assertRootCurrent()
        replacement = this.create(binding.accountId, original, 'claiming')
        replacement.request = request; replacement.owners = owners; replacement.configuration = owned.promise
        const saved = persisted
        if (saved === undefined) throw new AccountRuntimeError('cloud/stop-unconfirmed', 'The original native configuration commit did not settle')
        replacement.verifyConfiguration = async (api, check) => {
          verification = await control.verify?.(api, prepared.intent, saved.value, check)
        }
        this.launch(replacement, this.runClaimed(replacement, owners, request))
        const outcome = await replacement.result.promise
        if (outcome.status !== 'mounted' || outcome.binding.epoch === binding.epoch || replacement.state !== 'ready'
          || outcome.binding.accountId !== binding.accountId || outcome.binding.recipeVersion !== binding.recipeVersion) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'The replacement generation has not passed its original ready audit')
        }
        return Object.freeze({ operationId, persisted: saved.value,
          ...verification === undefined ? {} : { verification }, application: 'graph' as const,
          previousEpoch: binding.epoch, epoch: outcome.binding.epoch, accountId: binding.accountId,
          recipeVersion: outcome.binding.recipeVersion })
      } catch (cause) {
        if (oldReleased && replacement === undefined && this.slots.get(binding.accountId) === slot
          && slot.configuration === owned.promise) this.slots.delete(binding.accountId)
        if (!terminal && slot.state === 'reconfiguring' && !slot.closeRequested && !binding.lifetime.aborted) {
          try {
            await integration.auditReconfigured(context)
            const saves = await integration.pauseConfiguration()
            if (saves.status !== 'confirmed') throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original save ownership is unconfirmed')
            integration.resumeConfiguration(); slot.state = 'ready'
          } catch (_restoreFailure) { slot.state = 'unknown'; slot.closeRequested = true }
        } else if (replacement !== undefined) { replacement.state = 'unknown'; replacement.closeRequested = true }
        try { control.failed(operationId, cause) } catch (_observerFailure) { /* the original slot still retains failure */ }
        throw cause
      } finally {
        if (slot.state === 'ready' || slot.state === 'closed') delete slot.configuration
        if (replacement?.state === 'ready') delete replacement.configuration
      }
    })().then(owned.resolve, owned.reject)
    return Object.freeze({ operationId, completion: owned.promise })
  }

  /**
   * Join original native/save/provider work within a real drain reservation before any clean owner release.
   * @param accountId Existing slot whose original actual claim/boot must settle.
   * @returns One retained close observation; unknown work keeps its owner and capacity.
   */
  stopNative(accountId: AccountId): Promise<AccountNativeCloseObservation> {
    return this.stopOwned(accountId)
  }

  private stopOwned(accountId: AccountId, configuration?: Promise<unknown>,
    commit?: (api: CloudAccountApi) => Promise<void>): Promise<AccountNativeCloseObservation> {
    const slot = this.slots.get(accountId)
    if (slot === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'No retained account slot exists')
    if (slot.closing !== undefined) return slot.closing
    if (commit !== undefined && (configuration === undefined || slot.configuration !== configuration
      || slot.state !== 'reconfiguring' || slot.binding === undefined || slot.integration === undefined
      || slot.storageLease === undefined || slot.storageParticipant === undefined || slot.borrows !== 0)) {
      throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Terminal configuration lacks its original complete graph')
    }
    slot.closing = this.drainOwned(slot, configuration, commit)
    return slot.closing
  }

  private drainOwned(slot: Slot, configuration?: Promise<unknown>,
    commit?: (api: CloudAccountApi) => Promise<void>): Promise<AccountNativeCloseObservation> {
    const accountId = slot.accountId
    const drain = this.capacity.reserveDrain(accountId)
    const published = slot.state === 'ready' || slot.state === 'reconfiguring'
    // Reconfiguring already rejects business; the final native writer still needs its exact live binding.
    if (commit === undefined) slot.closeRequested = true
    // A graph with save hooks stays alive until its existing barrier confirms actual settlement.
    if (commit === undefined) slot.controller?.abort()
    const initial = slot.integration === undefined ? slot.native?.dispose() : undefined
    // Cleanup may reject before the original mount settles; retain its error for the joined await below.
    void initial?.catch((_cause: unknown) => {})
    return (async () => {
      try {
        const initialOwners = slot.owners, initialBinding = slot.binding
        let transition = published && initialOwners !== undefined && initialBinding !== undefined
          ? this.retainOwnerMutation(slot, () => initialOwners.beginDrain({ accountId, epoch: initialBinding.epoch })) : undefined
        // A submitted metadata transition retains its own result while original native shutdown proceeds.
        void transition?.catch((_cause: unknown) => {})
        let stoppedParticipants: { readonly files: ParticipantReceipt; readonly execution: ParticipantReceipt } | undefined
        const saves = await slot.integration?.stop(commit === undefined ? undefined : async (submit) => {
          const binding = slot.binding, preparation = slot.recipe.native, files = slot.storageParticipant
          if (binding === undefined || preparation === undefined || files === undefined) {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Terminal configuration lacks original drain participants')
          }
          const current = (): void => {
            this.assertMountCurrent(binding); preparation.assertRootCurrent()
            if (slot.state !== 'reconfiguring' || slot.configuration !== configuration || slot.borrows !== 0) this.conflict()
          }
          current(); await transition; current()
          const deadline = Date.now() + preparation.stopTimeoutMs
          const execution = await preparation.execution.stopEpoch(binding, deadline)
          current()
          const fileReceipt = await files.stopEpoch(binding, deadline)
          current()
          if (execution.status !== 'confirmed' || fileReceipt.status !== 'confirmed'
            || slot.integration?.observeNativeDrain() === undefined) {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original terminal drain is unconfirmed before configuration')
          }
          stoppedParticipants = { files: fileReceipt, execution }
          await submit(async (api) => { current(); await commit(api); current() })
          current()
        })
        // Closing admission makes the original window fail its next check; join its actual SQL/native turn before disposal.
        if (slot.configuration !== configuration) {
          try { await slot.configuration } catch (_cause) { /* original save/store/slot failure remains retained */ }
        }
        if (saves?.status === 'unknown') {
          slot.closeRequested = true
          slot.state = 'unknown'
          return await this.unknownClose(slot)
        }
        slot.closeRequested = true
        slot.controller?.abort()
        // Actual failure is retained separately; native cleanup still has to join its settlement.
        try { await slot.result.promise } catch (_cause: unknown) { /* original failure remains in slot.settlement */ }
        if (slot.borrows !== 0) {
          slot.borrowsEnded ??= Promise.withResolvers<undefined>()
          await slot.borrowsEnded.promise
        }
        const native = await (initial ?? slot.native?.dispose())
        this.logContext(slot, 'native-disposal-observed', native?.status ?? 'not-started')
        if (native?.status === 'unknown') {
          slot.state = 'unknown'
          return Object.freeze({ ...await this.unknownClose(slot), native })
        }
        if (slot.storageLease !== undefined && slot.native === undefined && slot.context === undefined && slot.integration === undefined) {
          // Native boot never returned a handle or created a Context; no account lane or execution port was issued.
          await slot.storageLease.closeAfterActualDrain()
        } else if (slot.storageLease !== undefined) {
          const binding = slot.binding, integration = slot.integration, preparation = slot.recipe.native
          const observed = integration?.observeNativeDrain()
          if (binding === undefined || integration === undefined || preparation === undefined || observed === undefined
            || saves?.status !== 'confirmed' || native?.status !== 'confirmed' || slot.storageParticipant === undefined) {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Production native teardown lacks original drain evidence')
          }
          const deadline = Date.now() + preparation.stopTimeoutMs
          const execution = stoppedParticipants?.execution ?? await preparation.execution.stopEpoch(binding, deadline)
          const files = stoppedParticipants?.files ?? await slot.storageParticipant.stopEpoch(binding, deadline)
          if (execution.status !== 'confirmed' || files.status !== 'confirmed') {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original files or execution work has not settled')
          }
          if (transition === undefined && slot.owners !== undefined) {
            const owners = slot.owners
            transition = this.retainOwnerMutation(slot, () => owners.beginDrain({ accountId, epoch: binding.epoch }))
          }
          await transition
          this.capacity.assertSubagentsStopped(accountId)
          await slot.storageLease.closeAfterActualDrain()
          if (slot.owners !== undefined) {
            const owners = slot.owners
            await this.retainOwnerMutation(slot, () => owners.release({ accountId, epoch: binding.epoch }, {
              accountId, epoch: binding.epoch, ...observed, configSaves: saves, participants: [files, execution],
              contextDisposed: true, disposalErrors: [],
            }))
            integration.releaseAfterActualDrain()
            slot.releaseAfterClose = true
            slot.state = 'closed'
          }
        }
        if (slot.state === 'unknown') {
          return Object.freeze({ ...await this.unknownClose(slot), ...native === undefined ? {} : { native } })
        }
        this.capacity.assertSubagentsStopped(accountId)
        drain.release()
        if (slot.releaseAfterClose) {
          slot.reservation.releaseAccount()
          if (configuration === undefined || slot.configuration !== configuration) this.slots.delete(accountId)
        }
        slot.state = 'closed'
        return Object.freeze({
          accountId, status: native === undefined ? 'not-started' : 'observed',
          ...native === undefined ? {} : { native },
        })
      } catch (cause) {
        return this.unknownClose(slot, cause)
      }
    })()
  }

  /**
   * Close admission, then join bounded native cleanup without destroying the shared capacity owner.
   * @returns Retained close observations; each production release requires all original drain evidence.
   */
  close(): Promise<readonly AccountNativeCloseObservation[]> {
    this.closed = true
    for (const slot of this.slots.values()) slot.closeRequested = true
    this.closing ??= (async () => {
      const observations: AccountNativeCloseObservation[] = []
      for (const slot of this.slots.values()) {
        try { observations.push(await this.stopNative(slot.accountId)) }
        catch (cause) { observations.push(Object.freeze({ accountId: slot.accountId, status: 'unknown', cause })) }
        try { await slot.configuration } catch (_cause) { /* original failure remains with its slot/store/save owner */ }
      }
      return Object.freeze(observations)
    })()
    return this.closing
  }

  /**
   * Inspect bounded ownership without paths, credentials, Contexts, or a readiness certificate.
   * @returns Retained slots and actual/waiter/borrow counts; closed native slots still own their account reservation.
   */
  inspect(): Readonly<{ slots: number; pending: number; unknown: number; waiters: number; borrows: number; closed: boolean }> {
    return Object.freeze({
      slots: this.slots.size, pending: [...this.slots.values()].filter(slot => slot.settlement === undefined).length,
      unknown: [...this.slots.values()].filter(slot => slot.state === 'unknown').length,
      waiters: this.waiters, borrows: this.borrows, closed: this.closed,
    })
  }

  private create(accountId: AccountId, recipe: AccountRecipe, state: State): Slot {
    const reservation = this.capacity.reserveMount(accountId)
    const slot: Slot = {
      accountId, recipe, reservation, result: Promise.withResolvers<NativeAccountBootOutcome>(),
      startupDiagnostic: startupFailureObserver(recipe.requiredEntryIds),
      waiters: new Set(), state, claimAttempted: false, closeRequested: false, borrows: 0, releaseAfterClose: false,
    }
    this.slots.set(accountId, slot)
    // One subscription owns actual failure even after every waiting observer has left.
    void slot.result.promise.catch((_cause: unknown) => {})
    return slot
  }

  private launch(slot: Slot, actual: Promise<NativeAccountBootOutcome>): void {
    const settle = (settlement: Settlement): void => {
      slot.settlement = settlement
      slot.reservation.settleMount()
      if ('cause' in settlement && slot.request !== undefined && slot.native === undefined
        && (!slot.claimAttempted || settlement.cause instanceof OwnerPgNotSubmittedError)) {
        slot.releaseAfterClose = true
        if (slot.closing === undefined) {
          slot.reservation.releaseAccount()
          this.slots.delete(slot.accountId)
        }
      }
      for (const waiter of slot.waiters) waiter.finish(settlement)
      if ('value' in settlement) slot.result.resolve(settlement.value)
      else slot.result.reject(settlement.cause)
    }
    void actual.then((value) => { settle({ value }) }, (cause: unknown) => {
      slot.state = cause instanceof AccountMountPrerequisiteError ? 'blocked'
        : slot.claimAttempted || slot.native !== undefined ? 'unknown' : 'failed'
      settle({ cause: this.failure(cause) })
    })
  }

  private async runNative(
    slot: Slot, input: AccountMountInput, diagnostic: StartupObserver = slot.startupDiagnostic,
  ): Promise<NativeAccountBootOutcome> {
    if (this.isClosing(slot)) throw new AccountRuntimeError('cloud/account-unavailable', 'Account mount admission is closed')
    slot.state = 'mounting'
    slot.native = mountAccount(input, {
      ...slot.recipe,
      prepare: async (ctx, binding) => {
        slot.context = ctx
        slot.binding = binding
        this.assertMountCurrent(binding)
        this.logContext(slot, 'context-attached')
        try {
          const unpublished = (): void => {
            this.assertMountCurrent(binding)
            if (slot.state !== 'mounting' && slot.state !== 'mounted-unpublished') {
              throw new AccountRuntimeError('cloud/account-unavailable', 'Account registration is outside unpublished assembly')
            }
          }
          if (slot.recipe.native !== undefined) {
            const preparation = slot.recipe.native, lease = slot.storageLease
            slot.integration = new AccountNativeIntegration({ ...preparation,
              borrowAccount: (current: AccountBinding) => this.borrowCurrent(current),
              ...lease === undefined ? {} : {
                files: (_owner, current, getFileProject) => {
                  if (current !== binding) throw new AccountRuntimeError('cloud/stale-generation', 'Storage bind belongs to another native graph')
                  return lease.bindInstalled(binding,
                    (installed: AccountBinding) => { this.assertMountCurrent(installed) }, unpublished, getFileProject)
                },
              },
            }, diagnostic)
            slot.integration.prepare(ctx, binding,
              (current) => { this.assertMountCurrent(current) }, (current) => { this.assertBusinessCurrent(current) }, unpublished,
              () => {
                // Close original admission even when the existing drain reservation is exhausted.
                slot.closeRequested = true
                try {
                  void this.stopNative(slot.accountId).catch((_cause: unknown) => {
                    slot.state = 'unknown'
                  })
                } catch (_cause) {
                  slot.state = 'unknown'
                  slot.controller?.abort()
                }
              }, () => {
                this.assertMountCurrent(binding)
                if (slot.state !== 'reconfiguring') throw new AccountRuntimeError('cloud/account-unavailable', 'No original exclusive configuration window exists')
              })
          }
          await slot.recipe.prepare(ctx, binding)
          this.assertMountCurrent(binding)
        } catch (cause) {
          observeStartup(diagnostic, { failure: cause })
          await slot.integration?.stop()
          throw cause
        }
      },
    }, slot.storageLease, diagnostic)
    const outcome = await slot.native.result
    if (!this.isClosing(slot) || slot.integration === undefined) {
      slot.state = outcome.status === 'mounted' ? 'mounted-unpublished' : outcome.disposal.status === 'unknown' ? 'unknown' : 'failed'
    }
    if (this.isClosing(slot) && slot.integration === undefined) {
      const native = await slot.native.dispose()
      if (native.status === 'unknown') slot.state = 'unknown'
    }
    return outcome
  }

  private async runClaimed(slot: Slot, owners: PostgresOwnerStore, request: AccountFactoryRequest): Promise<NativeAccountBootOutcome> {
    const diagnostic = slot.startupDiagnostic
    try {
      const old = await owners.locate(request.accountId)
      if (slot.closeRequested) throw new AccountRuntimeError('cloud/account-unavailable', 'Account mounting closed before owner claim')
      slot.claimAttempted = true
      const owner = await owners.claim({
        accountId: request.accountId, expectedEpoch: old === undefined ? null : old.epoch, recipeVersion: request.recipeVersion,
      })
      if (owner.ownerInstanceId !== request.instanceId) {
        throw new AccountRuntimeError('cloud/stale-generation', 'Account owner and process instance disagree')
      }
      slot.controller = new AbortController()
      const input: AccountMountInput = Object.freeze({
        binding: Object.freeze({
          accountId: owner.accountId, epoch: owner.epoch, recipeVersion: owner.recipeVersion, lifetime: slot.controller.signal,
        }),
        instanceId: request.instanceId, layout: deriveAccountLayout(request.accountId, request.instanceId, request.deployment),
        environment: request.environment,
      })
      slot.input = input
      const storage = requireAccountProductionPorts(slot.recipe)
      slot.storageOwner = storage.owner
      slot.storageParticipant = storage.files
      observeStartup(diagnostic, { phase: 'storage-prepare' })
      slot.storagePreparation = storage.owner.prepareAccount(input)
      slot.storageLease = await slot.storagePreparation
      slot.storageLease.assertCurrent()
      if (this.isClosing(slot)) throw new AccountRuntimeError('cloud/account-unavailable', 'Account mounting closed during storage preparation')
      observeStartup(diagnostic, { phase: 'storage-before-read' })
      slot.storageLease.assertBeforeNativeRead(slot.recipe.profile, slot.recipe.configPath)
      request.recipe.native?.assertRootCurrent()
      observeStartup(diagnostic, { phase: 'nativeboot' })
      const outcome = await this.runNative(slot, input, diagnostic)
      if (outcome.status === 'failed') return outcome
      observeStartup(diagnostic, { phase: 'nativeinventory' })
      const originalStorage = requireAccountProductionPorts(slot.recipe)
      if (originalStorage.owner !== slot.storageOwner || originalStorage.files !== slot.storageParticipant) {
        throw new AccountRuntimeError('cloud/stale-generation', 'The original storage owner changed during assembly')
      }
      if (slot.integration === undefined) throw new AccountMountPrerequisiteError()
      const verify = slot.verifyConfiguration
      await slot.integration.finishBootstrap(verify === undefined ? undefined : async (api) => {
        const current = (): void => {
          this.assertMountCurrent(outcome.binding)
          request.recipe.native?.assertRootCurrent()
          if (slot.state !== 'mounted-unpublished') throw new AccountRuntimeError('cloud/account-unavailable', 'Replacement graph is no longer unpublished')
        }
        current(); await verify(api, current); current()
      })
      delete slot.verifyConfiguration
      observeStartup(diagnostic, { phase: 'ready' })
      slot.storageLease.assertCurrent()
      request.recipe.native?.assertRootCurrent()
      this.assertMountCurrent(outcome.binding)
      await this.retainOwnerMutation(slot, () => owners.ready({ accountId: owner.accountId, epoch: owner.epoch }, owner.recipeVersion))
      const committedStorage = requireAccountProductionPorts(slot.recipe)
      if (committedStorage.owner !== slot.storageOwner || committedStorage.files !== slot.storageParticipant) {
        throw new AccountRuntimeError('cloud/stale-generation', 'The original storage owner changed during ready commit')
      }
      slot.storageLease.assertCurrent()
      request.recipe.native?.assertRootCurrent()
      this.assertMountCurrent(outcome.binding)
      slot.state = 'ready'
      observeStartup(diagnostic, { settled: true })
      return outcome
    } catch (cause) {
      observeStartup(diagnostic, { failure: cause })
      throw cause
    }
  }

  private checkWait(accountId: AccountId, deadlineAtMs: number, signal?: AbortSignal): void {
    this.assertOpen()
    const remaining = deadlineAtMs - Date.now()
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0 || remaining > MAX_DELAY) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Account mount observation requires a finite absolute deadline')
    }
    if (signal?.aborted) throw new AccountMountWaitError('observer-cancelled')
    if (remaining <= 0) throw new AccountMountWaitError('deadline')
    const slot = this.slots.get(accountId)
    if (slot?.settlement === undefined && (this.waiters >= this.limits.maxWaiters
      || (slot !== undefined && slot.waiters.size >= this.limits.maxWaitersPerAccount))) this.full()
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountRuntimeError('cloud/account-unavailable', 'Account factory admission is closed')
  }

  private isClosing(slot: Slot): boolean { return slot.closeRequested }
  private failure(cause: unknown): Error {
    return cause instanceof Error ? cause : new AccountRuntimeError('cloud/account-unavailable', 'Account mounting failed', { cause })
  }

  private conflict(): never { throw new AccountRuntimeError('cloud/config-conflict', 'Concurrent account mount inputs differ') }
  private full(): never { throw new AccountRuntimeError('cloud/capacity', 'Account observer or borrow capacity is exhausted') }
}
