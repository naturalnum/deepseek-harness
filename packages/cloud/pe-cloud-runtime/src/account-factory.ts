/** Private actual mount, ready CAS and drain ownership with removable observers. */
import type { Context } from '@deepseek-ai/cordis'
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
import type { AccountBinding, AccountId, AccountMountInput, AccountUse, DrainParticipant, InstanceId, MountCapacityReservation } from './types.ts'

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

type State = 'claiming' | 'mounting' | 'mounted-unpublished' | 'ready' | 'blocked' | 'failed' | 'unknown' | 'closing' | 'closed'
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
   */
  constructor(private readonly capacity: RuntimeCapacity, limits: AccountFactoryLimits) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new AccountRuntimeError('cloud/invalid-config', 'Account factory limits must be positive finite integers')
      }
    }
    this.limits = Object.freeze({ ...limits })
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
    const timer = setTimeout(() => { finish({ cause: new AccountMountWaitError('deadline') }) }, deadlineAtMs - Date.now())
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
      || !['mounting', 'mounted-unpublished', 'ready'].includes(slot.state)
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
   * Inspect whether the factory still owns an actual account operation or graph.
   * @param accountId Trusted root request whose input resources may be released only after removal.
   * @returns Whether the original slot remains retained, including failed or uncertain work.
   */
  retainsAccount(accountId: AccountId): boolean { return this.slots.has(accountId) }

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

  /**
   * Join original native/save/provider work within a real drain reservation before any clean owner release.
   * @param accountId Existing slot whose original actual claim/boot must settle.
   * @returns One retained close observation; unknown work keeps its owner and capacity.
   */
  stopNative(accountId: AccountId): Promise<AccountNativeCloseObservation> {
    const slot = this.slots.get(accountId)
    if (slot === undefined) throw new AccountRuntimeError('cloud/account-unavailable', 'No retained account slot exists')
    if (slot.closing !== undefined) return slot.closing
    const drain = this.capacity.reserveDrain(accountId)
    const published = slot.state === 'ready'
    slot.closeRequested = true
    // A graph with save hooks stays alive until its existing barrier confirms actual settlement.
    slot.controller?.abort()
    const initial = slot.integration === undefined ? slot.native?.dispose() : undefined
    // Cleanup may reject before the original mount settles; retain its error for the joined await below.
    void initial?.catch((_cause: unknown) => {})
    slot.closing = (async () => {
      try {
        let transition = published && slot.owners !== undefined && slot.binding !== undefined
          ? slot.owners.beginDrain({ accountId, epoch: slot.binding.epoch }) : undefined
        // A submitted metadata transition retains its own result while original native shutdown proceeds.
        void transition?.catch((_cause: unknown) => {})
        const saves = await slot.integration?.stop()
        if (saves?.status === 'unknown') {
          slot.state = 'unknown'
          return Object.freeze({ accountId, status: 'unknown' })
        }
        slot.controller?.abort()
        // Actual failure is retained separately; native cleanup still has to join its settlement.
        try { await slot.result.promise } catch (_cause: unknown) { /* original failure remains in slot.settlement */ }
        if (slot.borrows !== 0) {
          slot.borrowsEnded ??= Promise.withResolvers<undefined>()
          await slot.borrowsEnded.promise
        }
        const native = await (initial ?? slot.native?.dispose())
        if (native?.status === 'unknown') {
          slot.state = 'unknown'
          return Object.freeze({ accountId, status: 'unknown', native })
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
          const execution = await preparation.execution.stopEpoch(binding, deadline)
          const files = await slot.storageParticipant.stopEpoch(binding, deadline)
          if (execution.status !== 'confirmed' || files.status !== 'confirmed') {
            throw new AccountRuntimeError('cloud/stop-unconfirmed', 'Original files or execution work has not settled')
          }
          if (transition === undefined && slot.owners !== undefined) {
            transition = slot.owners.beginDrain({ accountId, epoch: binding.epoch })
          }
          await transition
          await slot.storageLease.closeAfterActualDrain()
          if (slot.owners !== undefined) {
            await slot.owners.release({ accountId, epoch: binding.epoch }, {
              accountId, epoch: binding.epoch, ...observed, configSaves: saves, participants: [files, execution],
              contextDisposed: true, disposalErrors: [],
            })
            integration.releaseAfterActualDrain()
            slot.releaseAfterClose = true
            slot.state = 'closed'
          }
        }
        if (slot.state === 'unknown') {
          return Object.freeze({ accountId, status: 'unknown', ...native === undefined ? {} : { native } })
        }
        drain.release()
        if (slot.releaseAfterClose) {
          slot.reservation.releaseAccount()
          this.slots.delete(accountId)
        }
        slot.state = 'closed'
        return Object.freeze({
          accountId, status: native === undefined ? 'not-started' : 'observed',
          ...native === undefined ? {} : { native },
        })
      } catch (cause) {
        slot.state = 'unknown'
        return Object.freeze({ accountId, status: 'unknown', cause })
      }
    })()
    return slot.closing
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

  private async runNative(slot: Slot, input: AccountMountInput): Promise<NativeAccountBootOutcome> {
    if (this.isClosing(slot)) throw new AccountRuntimeError('cloud/account-unavailable', 'Account mount admission is closed')
    slot.state = 'mounting'
    slot.native = mountAccount(input, {
      ...slot.recipe,
      prepare: async (ctx, binding) => {
        slot.context = ctx
        slot.binding = binding
        this.assertMountCurrent(binding)
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
            })
            slot.integration.prepare(ctx, binding,
              (current) => { this.assertMountCurrent(current) }, (current) => { this.assertBusinessCurrent(current) }, unpublished)
          }
          await slot.recipe.prepare(ctx, binding)
          this.assertMountCurrent(binding)
        } catch (cause) {
          await slot.integration?.stop()
          throw cause
        }
      },
    }, slot.storageLease)
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
    slot.storagePreparation = storage.owner.prepareAccount(input)
    slot.storageLease = await slot.storagePreparation
    slot.storageLease.assertCurrent()
    if (this.isClosing(slot)) throw new AccountRuntimeError('cloud/account-unavailable', 'Account mounting closed during storage preparation')
    slot.storageLease.assertBeforeNativeRead(slot.recipe.profile, slot.recipe.configPath)
    request.recipe.native?.assertRootCurrent()
    const outcome = await this.runNative(slot, input)
    if (outcome.status === 'failed') return outcome
    const originalStorage = requireAccountProductionPorts(slot.recipe)
    if (originalStorage.owner !== slot.storageOwner || originalStorage.files !== slot.storageParticipant) {
      throw new AccountRuntimeError('cloud/stale-generation', 'The original storage owner changed during assembly')
    }
    if (slot.integration === undefined) throw new AccountMountPrerequisiteError()
    await slot.integration.finishBootstrap()
    slot.storageLease.assertCurrent()
    request.recipe.native?.assertRootCurrent()
    this.assertMountCurrent(outcome.binding)
    await owners.ready({ accountId: owner.accountId, epoch: owner.epoch }, owner.recipeVersion)
    const committedStorage = requireAccountProductionPorts(slot.recipe)
    if (committedStorage.owner !== slot.storageOwner || committedStorage.files !== slot.storageParticipant) {
      throw new AccountRuntimeError('cloud/stale-generation', 'The original storage owner changed during ready commit')
    }
    slot.storageLease.assertCurrent()
    request.recipe.native?.assertRootCurrent()
    this.assertMountCurrent(outcome.binding)
    slot.state = 'ready'
    return outcome
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
