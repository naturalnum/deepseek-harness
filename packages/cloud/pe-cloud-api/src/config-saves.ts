/** F06 bounded submissions and actual-work ownership, instantiated and owned by runtime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { AccountBinding, AccountId, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { CredentialInfo, CredentialRef, CredentialSaveOperation } from '@deepseek-ai/dsh-credentials'
import { CloudApiError } from './errors.ts'
import { ConfigSaveLimitsSchema } from './schema.ts'
import type {
  ConfigSaveAdmission, ConfigSaveBarrier, ConfigSaveFailure, ConfigSaveKind, ConfigSaveLimits,
  ConfigSaveReceipt, ConfigSaveSnapshot,
  CredentialEditPolicy, CredentialEditToken, CredentialEditVersion, CredentialEditView,
  SkillEditToken, SkillEditVersion, SkillPointerCommit,
  PluginEditToken, PluginEditVersion, PluginEditCommit,
} from './save-hooks.ts'

/** A native adapter uses this when its operation settles without a known actual outcome. */
export class ConfigSaveOutcomeUnknown extends Error {
  override readonly name: string = 'ConfigSaveOutcomeUnknown'
  constructor(options?: ErrorOptions) { super('The native configuration save outcome is unknown.', options) }
}

/** Confirmed durable skill selection whose synchronous native apply failed; original save retains failure. */
export class SkillEditApplyFailure extends Error {
  constructor(readonly version: SkillEditVersion) { super('The skill pointer persisted, but native catalog application failed.') }
}

interface Operation {
  readonly operationId: OperationId
  readonly kind: ConfigSaveKind
  readonly owner: AccountSaves
  state: 'queued' | 'running' | 'settled'
  readonly start: () => void
}

interface Execution {
  readonly operation: Operation
  active: boolean
  readonly children: Set<Promise<void>>
  failure: { readonly error: unknown } | undefined
  unknown: boolean
  credentialEdit: { readonly ref: CredentialRef; observed: boolean; completed: boolean } | undefined
  commitCredentialVersion: (() => void) | undefined
}

interface Waiter {
  readonly finish: (reason: 'deadline' | 'observer-cancelled' | undefined) => void
}

interface AccountControl {
  readonly limits: ConfigSaveLimits
  submit<T>(owner: AccountSaves, kind: ConfigSaveKind, submit: () => Promise<T>, admission?: ConfigSaveAdmission): Promise<T>
  assertOutsideSave(): void
  current(owner: AccountSaves): Execution | undefined
}

function failure(error: unknown): ConfigSaveFailure['outcome'] {
  return error instanceof ConfigSaveOutcomeUnknown ? 'unknown' : 'failed'
}

function rememberFailure(execution: Execution, error: unknown): void {
  execution.failure ??= { error }
  execution.unknown ||= failure(error) === 'unknown'
}

function deadline(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudApiError('cloud/invalid-config', 'Configuration save observation requires a finite absolute deadline.')
  }
}

/**
 * One shared capacity owner borrowed by all account barriers. Runtime creates,
 * retains, and closes this object; it is not another Loader service or participant.
 */
export class ConfigSaveCoordinator {
  /** Validated, immutable deployment limits shared by all account barriers. */
  readonly limits: ConfigSaveLimits
  private readonly accounts: Map<AccountId, AccountSaves> = new Map()
  private readonly queue: Operation[] = []
  private readonly execution: AsyncLocalStorage<Execution> = new AsyncLocalStorage()
  private running: number = 0
  private tracked: number = 0
  private closed: boolean = false

  /**
   * @param input - explicit deployment limits; no capacity default is inferred.
   */
  constructor(input: ConfigSaveLimits) {
    this.limits = Object.freeze(ConfigSaveLimitsSchema({ ...input }))
  }

  /**
   * Create the sole save barrier for a live account generation within deployment limits.
   * @param binding - the runtime factory's immutable graph binding.
   * @param credentialPolicy - optional finite approved references; omission keeps the original private credential behavior.
   * @param onFailure Original synchronous runtime containment; it must not throw or start another save.
   * @returns the sole save barrier for this account graph.
   */
  createAccount(
    binding: AccountBinding, credentialPolicy?: CredentialEditPolicy, onFailure?: (failure: ConfigSaveFailure) => void,
  ): ConfigSaveBarrier {
    if (this.closed || binding.lifetime.aborted) this.unavailable()
    if (this.accounts.has(binding.accountId)) {
      throw new CloudApiError('cloud/config-busy', 'The account already owns a configuration save barrier.')
    }
    if (this.accounts.size >= this.limits.maxAccounts) this.capacity()
    const control: AccountControl = {
      limits: this.limits,
      submit: (owner, kind, submit, admission) => this.submit(owner, kind, submit, admission),
      assertOutsideSave: () => { this.assertOutsideSave() },
      current: (owner) => {
        const execution = this.current()
        return execution?.active === true && execution.operation.owner === owner ? execution : undefined
      },
    }
    const account = new AccountSaves(control, binding, credentialPolicy, onFailure)
    this.accounts.set(binding.accountId, account)
    return account
  }

  /**
   * Remove only a terminal, confirmed barrier after runtime finishes its other drain checks.
   * @param barrier - exact object issued by createAccount, not a copied receipt.
   */
  releaseAccount(barrier: ConfigSaveBarrier): void {
    const account = this.accounts.get(barrier.binding.accountId)
    if (account !== barrier) this.unavailable()
    account.assertReleasable()
    this.accounts.delete(account.binding.accountId)
  }

  /** Commit once through the exact stopped save owner before its graph is disposed.
   * @param barrier Original runtime-issued barrier after actual native, file and execution drain.
   * @param submit Original configuration writer and required application; nested hooks join this turn.
   * @returns Actual bounded settlement; top-level admission stays permanently stopped, including on failure.
   */
  commitStoppedConfiguration<T>(barrier: ConfigSaveBarrier, submit: () => Promise<T>): Promise<T> {
    this.assertOutsideSave()
    const account = this.accounts.get(barrier.binding.accountId)
    if (account === undefined || account !== barrier) this.unavailable()
    account.reserveStoppedConfiguration()
    return this.submit(account, 'config-editor', submit, 'stopped')
  }

  /** Close only after runtime has released every actual account barrier. */
  close(): void {
    if (this.accounts.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save barriers still own actual work or evidence.')
    }
    this.closed = true
    this.execution.disable()
  }

  /**
   * Read current shared save capacity without exposing native configuration values.
   * @returns bounded root capacity observations, without native values.
   */
  snapshot(): { readonly accounts: number; readonly running: number; readonly queued: number; readonly tracked: number } {
    return Object.freeze({ accounts: this.accounts.size, running: this.running, queued: this.queue.length, tracked: this.tracked })
  }

  private current(): Execution | undefined { return this.execution.getStore() }

  private submit<T>(owner: AccountSaves, kind: ConfigSaveKind, submit: () => Promise<T>, admission: ConfigSaveAdmission = 'open'): Promise<T> {
    const parent = this.current()
    if (parent !== undefined) return this.join(parent, owner, submit)
    owner.assertAdmitted(admission)
    if (this.closed || this.accounts.get(owner.binding.accountId) !== owner) this.unavailable()
    const queued = owner.running || this.running >= this.limits.maxRunning
    if (this.tracked >= this.limits.maxTrackedOperations
      || owner.tracked >= this.limits.maxTrackedOperationsPerAccount
      || (queued && (this.queue.length >= this.limits.maxQueued
        || owner.queued >= this.limits.maxQueuedPerAccount))) this.capacity()

    const result = Promise.withResolvers<T>()
    // The bounded failure table owns observation even if a request drops its Promise.
    void result.promise.catch((_error: unknown) => {})
    const operation: Operation = {
      operationId: brandString<OperationId>(randomUUID()), kind, owner, state: 'queued',
      start: () => {
        const execution: Execution = { operation, active: true, children: new Set(), failure: undefined, unknown: false,
          credentialEdit: undefined, commitCredentialVersion: undefined }
        void this.execute(execution, submit).then(
          (value) => { this.settle(operation); result.resolve(value) },
          (error: unknown) => {
            this.settle(operation, { outcome: execution.unknown ? 'unknown' : 'failed' })
            result.reject(error)
          },
        )
      },
    }
    // Capacity and responsibility are committed before either queue can see submit.
    this.tracked++
    owner.enroll(operation)
    if (queued) this.queue.push(operation)
    else this.start(operation)
    return result.promise
  }

  private assertOutsideSave(): void {
    if (this.current() !== undefined) {
      throw new CloudApiError('cloud/config-busy', 'A configuration save cannot wait for its own submission turn.')
    }
  }

  private join<T>(parent: Execution, owner: AccountSaves, submit: () => Promise<T>): Promise<T> {
    if (!parent.active || parent.operation.owner !== owner || owner.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'The native configuration continuation is no longer admitted.')
    }
    if (parent.children.size >= this.limits.maxNestedPerOperation) {
      const error = new CloudApiError('cloud/capacity', 'Configuration save continuation capacity is exhausted.')
      rememberFailure(parent, error)
      throw error
    }
    const deferred = Promise.withResolvers<T>()
    const observed: Promise<void> = deferred.promise.then(
      () => { parent.children.delete(observed) },
      (error: unknown) => {
        rememberFailure(parent, error)
        parent.children.delete(observed)
      },
    )
    parent.children.add(observed)
    try { deferred.resolve(submit()) } catch (error) { deferred.reject(error) }
    return deferred.promise
  }

  private async execute<T>(execution: Execution, submit: () => Promise<T>): Promise<T> {
    let result: { readonly value: T } | undefined
    try {
      if (execution.operation.owner.binding.lifetime.aborted) {
        throw new CloudApiError('cloud/stale-generation', 'The queued configuration generation has ended.')
      }
      const value = await this.execution.run(execution, submit)
      result = { value }
    } catch (error) {
      rememberFailure(execution, error)
    }
    while (execution.children.size !== 0) await Promise.all([...execution.children])
    execution.active = false
    if (execution.failure !== undefined) throw execution.failure.error
    if (result === undefined) throw new Error('Configuration save completed without a result.')
    execution.commitCredentialVersion?.()  // After all required children, before this serial turn can release.
    return result.value
  }

  private start(operation: Operation): void {
    operation.state = 'running'
    operation.owner.start()
    this.running++
    operation.start()
  }

  private settle(operation: Operation, failed?: { readonly outcome: ConfigSaveFailure['outcome'] }): void {
    operation.state = 'settled'
    this.running--
    operation.owner.settle(operation, failed)
    if (failed === undefined) this.tracked--
    this.pump()
  }

  private pump(): void {
    while (this.running < this.limits.maxRunning) {
      const index = this.queue.findIndex(operation => !operation.owner.running)
      if (index === -1) return
      const operation = this.queue.splice(index, 1)[0]
      if (operation === undefined) throw new Error('Configuration save queue lost an admitted operation.')
      this.start(operation)
    }
  }

  private capacity(): never {
    throw new CloudApiError('cloud/capacity', 'Configuration save capacity is exhausted.')
  }

  private unavailable(): never {
    throw new CloudApiError('cloud/account-unavailable', 'Configuration save ownership is unavailable.')
  }
}

class AccountSaves implements ConfigSaveBarrier {
  private admission: ConfigSaveAdmission = 'open'
  private stoppedConfiguration = false
  private readonly pending: Map<OperationId, Operation> = new Map()
  private readonly failures: Map<OperationId, ConfigSaveFailure> = new Map()
  private readonly waiters: Set<Waiter> = new Set()
  running: boolean = false
  private readonly credentialVersions = new Map<CredentialRef, CredentialEditToken>()
  private skillEdit: { readonly revision: FsVersion | null; readonly editToken: SkillEditToken } | undefined
  private pluginEdit: { readonly revision: string; readonly editToken: PluginEditToken } | undefined

  constructor(private readonly owner: AccountControl, readonly binding: AccountBinding, policy?: CredentialEditPolicy,
    private readonly onFailure?: (failure: ConfigSaveFailure) => void) {
    if (policy === undefined) return
    if (!Number.isSafeInteger(policy.maxReferences) || policy.maxReferences < 1
      || !Number.isSafeInteger(policy.maxReferenceBytes) || policy.maxReferenceBytes < 1
      || policy.references.length > policy.maxReferences) {
      throw new CloudApiError('cloud/invalid-config', 'Credential edit policy requires finite reference bounds.')
    }
    for (const ref of policy.references) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || Buffer.byteLength(ref) > policy.maxReferenceBytes
        || this.credentialVersions.has(ref)) {
        throw new CloudApiError('cloud/invalid-config', 'Credential edit policy references must be bounded and unique.')
      }
      this.credentialVersions.set(ref, brandString<CredentialEditToken>(randomUUID()))
    }
  }

  async describeCredentialEdit(
    ref: CredentialRef, describe: () => Promise<CredentialInfo>, assertCurrent?: () => void,
  ): Promise<CredentialEditView> {
    this.owner.assertOutsideSave()
    const result = await this.admit('credentials', async () => {
      const refusal = this.credentialRefusal(ref)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      // This read-only request check runs in the original serial turn, before any native work.
      try { assertCurrent?.() } catch (error) { return { ok: false as const, error } }
      const editToken = this.credentialVersions.get(ref)
      if (editToken === undefined) throw new Error('Credential edit reference lost its owner version.')
      try {
        const info = await describe()
        const credential: CredentialInfo = { configured: info.configured, writable: info.writable,
          ...info.source === undefined ? {} : { source: info.source } }
        return { ok: true as const, value: Object.freeze({ credential,
          version: Object.freeze({ epoch: this.binding.epoch, editToken }) }) }
      } catch (_error) {
        // The verified native describe is read-only; do not publish its diagnostic or a secret value.
        return { ok: false as const, error: new CloudApiError('cloud/account-unavailable', 'Credential state could not be read.') }
      }
    })
    if (!result.ok) throw result.error
    return result.value
  }

  async commitCredentialEdit(
    ref: CredentialRef, version: CredentialEditVersion, save: () => Promise<void>, assertCurrent?: () => void,
  ): Promise<CredentialEditVersion> {
    this.owner.assertOutsideSave()
    const expected = { epoch: version.epoch, editToken: version.editToken }
    let entered = false
    const result = await this.admit('credentials', async () => {
      entered = true
      const refusal = this.credentialRefusal(ref)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      // This read-only request check runs in the original serial turn, before any native work.
      try { assertCurrent?.() } catch (error) { return { ok: false as const, error } }
      if (expected.epoch !== this.binding.epoch) {
        return { ok: false as const, error: new CloudApiError('cloud/stale-generation', 'The credential edit generation has ended.') }
      }
      if (expected.editToken !== this.credentialVersions.get(ref)) {
        return { ok: false as const, error: new CloudApiError('cloud/config-conflict', 'The credential changed; read its current version before editing.') }
      }
      const execution = this.owner.current(this)
      if (execution === undefined || execution.credentialEdit !== undefined) throw new Error('Credential edit has no original serial turn.')
      const scope = { ref, observed: false, completed: false }
      execution.credentialEdit = scope
      const next = brandString<CredentialEditToken>(randomUUID())
      try { await save() }
      catch (error) {
        if (scope.observed) throw new ConfigSaveOutcomeUnknown()
        throw error
      }
      if (!scope.observed || !scope.completed) throw new Error('Credential edit did not complete its original native save.')
      execution.commitCredentialVersion = () => { this.credentialVersions.set(ref, next) }
      return { ok: true as const, value: Object.freeze({ epoch: this.binding.epoch, editToken: next }) }
    }).catch((error: unknown) => {
      if (!entered) throw error  // Original synchronous/queued admission refusal, before native work.
      throw new CloudApiError('cloud/account-unavailable', 'The credential update did not complete; its save responsibility remains held.')
    })
    if (!result.ok) throw result.error  // Known no-write decisions settle before their original refusal is returned.
    return result.value
  }

  async describeSkillEdit<T>(observe: () => Promise<{ readonly value: T; readonly revision: FsVersion | null }>,
    assertCurrent: () => void): Promise<{ readonly value: T
    readonly version: SkillEditVersion }> {
    this.owner.assertOutsideSave()
    const result = await this.admit('skill-publish', async () => {
      try {
        if (this.failures.size !== 0) throw new CloudApiError('cloud/account-unavailable', 'An unresolved save prevents skill editing.')
        assertCurrent()
        const observed = await observe()
        assertCurrent()
        if (this.skillEdit === undefined || this.skillEdit.revision !== observed.revision) {
          this.skillEdit = { revision: observed.revision, editToken: brandString<SkillEditToken>(randomUUID()) }
        }
        return { ok: true as const, value: observed.value,
          version: Object.freeze({ epoch: this.binding.epoch, editToken: this.skillEdit.editToken }) }
      } catch (_error) {
        // This observation never writes a pointer. Files keeps any actual read/transport responsibility.
        return { ok: false as const }
      }
    })
    if (!result.ok) throw new CloudApiError('cloud/account-unavailable', 'Current skill state could not be read.')
    return { value: result.value, version: result.version }
  }

  async commitSkillEdit(version: SkillEditVersion, persist: (expected: FsVersion | null) => Promise<SkillPointerCommit>,
    apply: () => void | Promise<void>, assertCurrent: () => void): Promise<SkillEditVersion> {
    this.owner.assertOutsideSave()
    const expected = { epoch: version.epoch, editToken: version.editToken }
    const result = await this.admit('skill-publish', async () => {
      try {
        assertCurrent()
        if (this.failures.size !== 0) throw new CloudApiError('cloud/account-unavailable', 'An unresolved save prevents skill publication.')
        if (expected.epoch !== this.binding.epoch) throw new CloudApiError('cloud/stale-generation', 'The skill edit generation has ended.')
        if (this.skillEdit === undefined || this.skillEdit.editToken !== expected.editToken) {
          throw new CloudApiError('cloud/config-conflict', 'The skill changed; read current state before editing.')
        }
      } catch (error) { return { ok: false as const, error } }
      const revision = this.skillEdit.revision
      const saved = await persist(revision)
      if (!saved.persisted) return { ok: false as const, error: saved.error }
      // Durable confirmation must be applied even if the observer cancelled after native handoff.
      const next = Object.freeze({ epoch: this.binding.epoch, editToken: brandString<SkillEditToken>(randomUUID()) })
      this.skillEdit = { revision: saved.revision, editToken: next.editToken }
      try { await apply() } catch (_error) { throw new SkillEditApplyFailure(next) }
      return { ok: true as const, version: next }
    })
    if (!result.ok) throw result.error
    return result.version
  }

  admitCredentialSave<T>(operation: CredentialSaveOperation, submit: () => Promise<T>): Promise<T> {
    const scope = this.owner.current(this)?.credentialEdit
    if (scope !== undefined) {
      if ((operation.kind !== 'set' && operation.kind !== 'unset') || operation.ref !== scope.ref || scope.observed) {
        throw new CloudApiError('cloud/forbidden', 'The credential save is outside the checked edit.')
      }
      scope.observed = true
      return this.admit('credentials', async () => {
        const value = await submit()
        scope.completed = true
        return value
      })
    }
    if ((operation.kind === 'set' || operation.kind === 'unset') && this.credentialVersions.has(operation.ref)) {
      throw new CloudApiError('cloud/config-conflict', 'A current credential edit version is required before saving.')
    }
    return this.admit('credentials', submit)
  }

  private credentialRefusal(ref: CredentialRef): CloudApiError | undefined {
    if (!this.credentialVersions.has(ref)) return new CloudApiError('cloud/forbidden', 'The credential reference is not approved for editing.')
    if (this.failures.size !== 0) return new CloudApiError('cloud/account-unavailable', 'An unresolved configuration save prevents credential editing.')
    return undefined
  }

  get tracked(): number { return this.pending.size + this.failures.size }
  get queued(): number { return [...this.pending.values()].filter(operation => operation.state === 'queued').length }

  admit<T>(kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T> {
    return this.owner.submit(this, kind, submit)
  }

  withPausedPluginChange<T>(submit: () => Promise<T>): Promise<T> {
    this.owner.assertOutsideSave()
    if (this.pending.size !== 0 || this.failures.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Exclusive plugin changes require confirmed empty configuration work.')
    }
    return this.owner.submit(this, 'plugin-selection', submit, 'paused')
  }

  async describePluginEdit<T>(observe: () => Promise<{ readonly value: T; readonly revision: string }>,
    assertCurrent: () => void): Promise<{ readonly value: T
    readonly version: PluginEditVersion }> {
    this.owner.assertOutsideSave()
    const result = await this.admit('plugin-selection', async () => {
      try {
        assertCurrent()
        if (this.failures.size !== 0) throw new CloudApiError('cloud/account-unavailable', 'An unresolved save prevents plugin editing.')
        const observed = await observe()
        assertCurrent()
        if (this.pluginEdit === undefined || this.pluginEdit.revision !== observed.revision) {
          this.pluginEdit = { revision: observed.revision, editToken: brandString<PluginEditToken>(randomUUID()) }
        }
        return { ok: true as const, value: observed.value,
          version: Object.freeze({ epoch: this.binding.epoch, editToken: this.pluginEdit.editToken }) }
      } catch (error) { return { ok: false as const, error } }
    })
    if (!result.ok) throw result.error
    return { value: result.value, version: result.version }
  }

  commitPluginEdit<T>(version: PluginEditVersion, revision: () => string,
    publish: () => Promise<PluginEditCommit<T>>, assertCurrent: () => void): Promise<PluginEditCommit<{
    readonly value: T
    readonly version: PluginEditVersion
  }>> {
    const expected = { epoch: version.epoch, editToken: version.editToken }
    return this.admit('plugin-selection', async () => {
      try {
        assertCurrent()
        if (this.failures.size !== 0) throw new CloudApiError('cloud/account-unavailable', 'An unresolved save prevents plugin publication.')
        if (expected.epoch !== this.binding.epoch) throw new CloudApiError('cloud/stale-generation', 'The plugin edit generation has ended.')
        if (this.pluginEdit === undefined || this.pluginEdit.editToken !== expected.editToken
          || this.pluginEdit.revision !== revision()) throw new CloudApiError('cloud/config-conflict', 'The plugin choice changed; read its current state.')
      } catch (error) {
        if (error instanceof CloudApiError) return { published: false as const, error }
        return { published: false as const, error: new CloudApiError('cloud/account-unavailable', 'The plugin state could not be checked.') }
      }
      const result = await publish()
      if (!result.published) return result
      const editToken = brandString<PluginEditToken>(randomUUID())
      this.pluginEdit = { revision: result.revision, editToken }
      return { published: true as const, revision: result.revision,
        value: { value: result.value, version: Object.freeze({ epoch: this.binding.epoch, editToken }) } }
    })
  }

  checkPluginEdit(version: PluginEditVersion, revision: () => string, assertCurrent: () => void): Promise<
    Readonly<{ accepted: true }> | Readonly<{ accepted: false; error: CloudApiError }>> {
    const expected = { epoch: version.epoch, editToken: version.editToken }
    return this.admit<Awaited<ReturnType<ConfigSaveBarrier['checkPluginEdit']>>>('plugin-selection', () => {
      try {
        assertCurrent()
        if (this.failures.size !== 0) throw new CloudApiError('cloud/account-unavailable', 'An unresolved save prevents plugin editing.')
        if (expected.epoch !== this.binding.epoch) throw new CloudApiError('cloud/stale-generation', 'The plugin edit generation has ended.')
        if (this.pluginEdit === undefined || this.pluginEdit.editToken !== expected.editToken
          || this.pluginEdit.revision !== revision()) throw new CloudApiError('cloud/config-conflict', 'The plugin choice changed; read its current state.')
        return Promise.resolve({ accepted: true as const })
      } catch (error) {
        return Promise.resolve({ accepted: false as const, error: error instanceof CloudApiError ? error
          : new CloudApiError('cloud/account-unavailable', 'The original plugin edit is unavailable.') })
      }
    })
  }

  admitWithApply<T>(kind: ConfigSaveKind, persist: () => Promise<T>, apply: (value: T) => Promise<void>): Promise<T> {
    return this.admit(kind, async () => {
      const value = await persist()
      await apply(value)
      return value
    })
  }

  snapshot(): ConfigSaveSnapshot {
    return Object.freeze({
      accountId: this.binding.accountId, epoch: this.binding.epoch, admission: this.admission,
      pending: Object.freeze([...this.pending.values()].map(operation =>
        Object.freeze({ operationId: operation.operationId, kind: operation.kind }))),
      failures: Object.freeze([...this.failures.values()]),
    })
  }

  pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    this.owner.assertOutsideSave()
    deadline(deadlineAtMs)
    if (this.admission === 'open') this.admission = 'paused'
    return this.wait(deadlineAtMs, signal)
  }

  resumeAccountChanges(): void {
    this.owner.assertOutsideSave()
    if (this.admission !== 'paused' || this.pending.size !== 0 || this.failures.size !== 0 || this.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save admission cannot reopen in this graph.')
    }
    this.admission = 'open'
  }

  stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    this.owner.assertOutsideSave()
    deadline(deadlineAtMs)
    this.admission = 'stopped'
    return this.wait(deadlineAtMs, signal)
  }

  reserveStoppedConfiguration(): void {
    this.assertAdmitted('stopped')
    if (this.stoppedConfiguration || this.pending.size !== 0 || this.failures.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Terminal configuration requires the original empty, confirmed save owner.')
    }
    this.stoppedConfiguration = true
  }

  assertAdmitted(admission: ConfigSaveAdmission = 'open'): void {
    if (this.binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'The account configuration generation has ended.')
    }
    if (this.admission !== admission) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save submission is paused or stopped.')
    }
  }

  assertReleasable(): void {
    if (this.admission !== 'stopped' || this.tracked !== 0 || this.waiters.size !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Configuration save responsibility has not been confirmed.')
    }
  }

  enroll(operation: Operation): void { this.pending.set(operation.operationId, operation) }
  start(): void { this.running = true }

  settle(operation: Operation, failed?: { readonly outcome: ConfigSaveFailure['outcome'] }): void {
    this.running = false
    this.pending.delete(operation.operationId)
    if (failed !== undefined) {
      const outcome = failed.outcome
      const recorded = Object.freeze({
        operationId: operation.operationId, kind: operation.kind, outcome,
        code: outcome === 'unknown' ? 'config-save/outcome-unknown' : 'config-save/operation-failed',
      })
      this.failures.set(operation.operationId, recorded)
      // The original failure row retains responsibility before synchronous lifecycle containment.
      if (this.onFailure !== undefined) { this.admission = 'stopped'; this.onFailure(recorded) }
    }
    if (this.pending.size === 0) for (const waiter of [...this.waiters]) waiter.finish(undefined)
  }

  private wait(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt> {
    if (this.pending.size === 0) return Promise.resolve(this.receipt())
    if (signal?.aborted === true) return Promise.resolve(this.receipt('observer-cancelled'))
    if (deadlineAtMs <= Date.now()) return Promise.resolve(this.receipt('deadline'))
    if (this.waiters.size >= this.owner.limits.maxWaitersPerAccount) {
      throw new CloudApiError('cloud/capacity', 'Configuration save observation capacity is exhausted.')
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const cancelled = (): void => { waiter.finish('observer-cancelled') }
      const waiter: Waiter = {
        finish: (reason) => {
          if (finished) return
          finished = true
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', cancelled)
          this.waiters.delete(waiter)
          resolve(this.receipt(reason))
        },
      }
      const arm = (): void => {
        const remaining = deadlineAtMs - Date.now()
        if (remaining <= 0) waiter.finish('deadline')
        else timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS))
      }
      this.waiters.add(waiter)
      signal?.addEventListener('abort', cancelled, { once: true })
      arm()
    })
  }

  private receipt(reason?: 'deadline' | 'observer-cancelled'): ConfigSaveReceipt {
    if (this.admission === 'open') throw new Error('Configuration save receipt requires closed admission.')
    const common = {
      accountId: this.binding.accountId, epoch: this.binding.epoch, admission: this.admission,
      evidenceRefs: Object.freeze([...this.pending.keys(), ...this.failures.keys()].map(id => 'config-save/' + id)),
    }
    if (this.pending.size === 0 && this.failures.size === 0) {
      return Object.freeze({
        ...common, status: 'confirmed',
        pendingOperationIds: Object.freeze([] as const), failures: Object.freeze([] as const),
      })
    }
    return Object.freeze({
      ...common, status: 'unknown', pendingOperationIds: Object.freeze([...this.pending.keys()]),
      failures: Object.freeze([...this.failures.values()]),
      reason: reason ?? (this.failures.size !== 0 ? 'failed' : 'pending'),
    })
  }
}
