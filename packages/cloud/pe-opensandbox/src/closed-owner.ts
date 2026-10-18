/** Closed execution owns registrations and refusal only; it has no backend or process dependency. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountBinding, AccountId, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { assertInstalledExecutionBinding, type AccountExecutionPort } from './account-port.ts'
import { ExecutionStateError, ExecutionUnavailableError } from './errors.ts'

interface Registration {
  readonly binding: AccountBinding
  readonly root: Context
  readonly assertCurrent: () => void
  readonly receipt: ParticipantReceipt
  readonly detach: () => void
  state: 'open' | 'stopped'
  claimed: boolean
}

class ClosedPort implements AccountExecutionPort {
  constructor(readonly binding: AccountBinding, private readonly owner: ClosedExecutionOwner) {}
  assertCurrent(ctx: Context): void { this.owner.assertPort(this, ctx) }
  deny(ctx: Context, signal?: AbortSignal): never {
    if (requireAccountExecutionPort(ctx) !== this) {
      throw new ExecutionStateError('cloud/stale-generation', 'Execution requires the original installed refusal port.')
    }
    signal?.throwIfAborted()
    throw new ExecutionUnavailableError({ availableCapabilities: [], missingCapabilities: [], missingPrerequisites: [] }, 'disabled')
  }
  claim(ctx: Context): void { this.owner.claim(this, ctx) }
  close(): void { this.owner.closePort(this) }
}

/** Fixed-capacity owner of exact closed-mode bindings, including terminal observations. */
export class ClosedExecutionOwner {
  private readonly registrations = new WeakMap<AccountBinding, Registration>()
  private readonly ports = new WeakMap<AccountExecutionPort, Registration>()
  private readonly active = new Map<AccountId, Registration>()
  private readonly ownerId = randomUUID()
  private state: 'open' | 'closing' | 'closed' = 'open'

  /**
   * @param root - the sole root coordinator's Context, distinct from account graphs.
   * @param maxBoundAccounts - finite positive capacity for simultaneous registrations.
   */
  constructor(private readonly root: Context, private readonly maxBoundAccounts: number) {
    if (!Number.isSafeInteger(maxBoundAccounts) || maxBoundAccounts < 1) {
      throw new ExecutionStateError('cloud/invalid-config', 'Closed execution requires a positive finite maxBoundAccounts.')
    }
  }

  /** Reject new bindings once the root has begun shutdown. */
  assertOpen(): void {
    if (this.state !== 'open') throw new ExecutionStateError('cloud/account-unavailable', 'Execution root registration is closed.')
  }

  /**
   * Bind once to the actual runtime-installed account graph.
   * @param ctx - independent account prepare context.
   * @param binding - exact installed binding, not the original mount input.
   * @param assertCurrent - runtime-owned fresh-generation check, including mounting admission;
   * the factory must retain all earlier owner/recovery obligations outside this closed generation.
   * @returns a restricted refusal port; no external work can be submitted.
   */
  bind(ctx: Context, binding: AccountBinding, assertCurrent: () => void): AccountExecutionPort {
    this.assertOpen()
    assertInstalledExecutionBinding(ctx, binding, ctx.root)
    if (ctx.root === this.root || binding.lifetime.aborted || this.registrations.has(binding)
      || this.active.has(binding.accountId)) {
      throw new ExecutionStateError('cloud/stale-generation', 'Execution requires one fresh independent account generation.')
    }
    assertCurrent()
    this.assertOpen()
    assertInstalledExecutionBinding(ctx, binding, ctx.root)
    binding.lifetime.throwIfAborted()
    if (this.registrations.has(binding) || this.active.has(binding.accountId)) this.stale()
    if (this.active.size >= this.maxBoundAccounts) {
      throw new ExecutionStateError('cloud/capacity', 'Closed execution account registration capacity is exhausted.')
    }
    const abort = (): void => { this.stop(registration) }
    const registration: Registration = {
      binding, root: ctx.root, assertCurrent, state: 'open', claimed: false,
      receipt: Object.freeze({ participant: 'execution', accountId: binding.accountId, epoch: binding.epoch,
        status: 'confirmed', pendingOperationIds: Object.freeze([] as const),
        evidenceRefs: Object.freeze([`execution-closed:${this.ownerId}:${randomUUID()}`]) }),
      detach: () => { binding.lifetime.removeEventListener('abort', abort) },
    }
    const port = Object.freeze(new ClosedPort(binding, this))
    this.registrations.set(binding, registration)
    this.ports.set(port, registration)
    this.active.set(binding.accountId, registration)
    binding.lifetime.addEventListener('abort', abort, { once: true })
    return port
  }

  /**
   * Verify exact issued port and caller before any native user operation.
   * @param port - original issued object; structural copies reject.
   * @param ctx - native caller with the exact installed account root binding.
   */
  assertPort(port: AccountExecutionPort, ctx: Context): void {
    const registration = this.ownedPort(port)
    assertInstalledExecutionBinding(ctx, registration.binding, registration.root)
    this.assertOpen()
    this.assertRegistrationOpen(registration)
    registration.assertCurrent()
    this.assertOpen()
    this.assertRegistrationOpen(registration)
  }

  /**
   * Reserve the sole account provider pair; unloading permanently closes this port.
   * @param port - original live issued port.
   * @param ctx - account entry effect scope.
   */
  claim(port: AccountExecutionPort, ctx: Context): void {
    this.assertPort(port, ctx)
    const registration = this.ownedPort(port)
    if (registration.claimed) throw new ExecutionStateError('cloud/invalid-config', 'Execution providers already belong to this account generation.')
    registration.claimed = true
    ctx.effect(() => () => { this.stop(registration) }, 'pe-opensandbox: close account refusal port')
  }

  /**
   * Close this issued generation without using the business-current guard.
   * @param port - exact issued port, including an already stopped one.
   */
  closePort(port: AccountExecutionPort): void { this.stop(this.ownedPort(port)) }

  /**
   * Permanently close an actually registered generation and observe its zero-work fact.
   * @param binding - exact registered runtime binding; clones and unknown generations reject.
   * @param deadlineAtMs - finite absolute observation deadline, including an already expired one.
   * @returns the same terminal receipt; it proves only this owner's closed-mode generation.
   */
  stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt> {
    return new Promise((resolve) => {
      if (!Number.isSafeInteger(deadlineAtMs)) {
        throw new ExecutionStateError('cloud/invalid-config', 'Execution stop requires a finite integer server deadline.')
      }
      const registration = this.registrations.get(binding)
      if (registration === undefined) return this.stale()
      this.stop(registration)
      resolve(registration.receipt)
    })
  }

  /** Close all registered admission before root participant/service withdrawal. */
  close(): void {
    if (this.state !== 'open') return
    this.state = 'closing'
    for (const registration of this.active.values()) this.stop(registration)
    this.state = 'closed'
  }

  private ownedPort(port: AccountExecutionPort): Registration {
    const registration = this.ports.get(port)
    if (registration === undefined) return this.stale()
    return registration
  }

  private assertRegistrationOpen(registration: Registration): void {
    if (registration.state !== 'open' || registration.binding.lifetime.aborted) this.stale()
  }

  private stop(registration: Registration): void {
    if (registration.state === 'stopped') return
    registration.state = 'stopped'
    registration.detach()
    if (this.active.get(registration.binding.accountId) === registration) this.active.delete(registration.binding.accountId)
  }

  private stale(): never {
    throw new ExecutionStateError('cloud/stale-generation', 'Execution does not own this exact generation or port.')
  }
}

/**
 * Validate the original owner-issued object and its exact installed root contribution.
 * @param ctx - account Loader or consumer context.
 * @returns the original issued refusal port; copied and shadowed ports reject.
 */
export function requireAccountExecutionPort(ctx: Context): AccountExecutionPort {
  const port = ctx.get('peAccountExecution')
  if (!(port instanceof ClosedPort) || ctx.root.get('peAccountExecution') !== port) {
    throw new ExecutionStateError('cloud/stale-generation', 'The account requires its root-issued execution port.')
  }
  ClosedPort.prototype.assertCurrent.call(port, ctx)
  return port
}

/**
 * Install a root-issued port during runtime prepare, without enabling execution.
 * @param ctx - prepare scope carrying runtime's actual installed binding.
 * @param port - the root owner's exact issued capability.
 */
export function installAccountExecutionPort(ctx: Context, port: AccountExecutionPort): void {
  if (!(port instanceof ClosedPort)) {
    throw new ExecutionStateError('cloud/stale-generation', 'Execution port was not issued by the closed execution owner.')
  }
  ClosedPort.prototype.assertCurrent.call(port, ctx)
  if (ctx.get('peAccountExecution') !== undefined || ctx.root.get('peAccountExecution') !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'The account already has an execution port.')
  }
  const unprovide = ctx.provide('peAccountExecution', port)
  if (ctx.root.get('peAccountExecution') !== port) {
    unprovide()
    throw new ExecutionStateError('cloud/stale-generation', 'Execution port installation must be visible in its account root.')
  }
}
