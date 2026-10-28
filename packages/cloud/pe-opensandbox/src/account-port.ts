/** Exact account-generation ports issued by one closed execution owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { ExecutionStateError } from './errors.ts'
import type { ApplicationServiceSelection, RegisteredApplicationService } from './types.ts'
import { PreviewHttpError } from './application-http.ts'

/** Internal factory capability; it cannot select an account, backend, or process. */
export interface AccountExecutionPort {
  /** Original owner declaration; Files derives mandatory policy enforcement from this same issued capability. */
  readonly enforcesSessionFilePolicy?: true | undefined
  /**
   * Synchronously check retained native command/service work before changing a Session policy.
   * @param ctx Original account caller within the exact installed graph.
   * @param session Exact native Session whose policy is about to change.
   */
  assertSessionFilePolicyChange?(ctx: Context, session: Session): void
  readonly binding: AccountBinding
  /**
   * Check the exact issued object, current graph and permanent admission state.
   * @param ctx - actual installation or native caller context.
   */
  assertCurrent(ctx: Context): void
  /**
   * Refuse user execution before preparation; a pre-aborted caller retains its reason.
   * @param ctx - actual native caller context with its installed port.
   * @param signal - optional caller cancellation; omission adds no caller cancellation.
   * @returns never; no handle or execution-world resource is created.
   */
  deny(ctx: Context, signal?: AbortSignal): never
  /**
   * Reserve the sole native provider pair for this generation.
   * @param ctx - account Loader effect scope; unloading permanently closes this port.
   */
  claim(ctx: Context): void
  /** Permanently close only this generation; internal stop observation remains available. */
  close(): void
}

/** Private owner checks, retained by each original issued port rather than serialized account data. */
export interface ExecutionPortOwner {
  /** Mandatory on an owner that issues enforcesSessionFilePolicy ports. */
  assertSessionFilePolicyChange?(port: AccountExecutionPort, ctx: Context, session: Session): void
  assertPort(port: AccountExecutionPort, ctx: Context): void
  assertProviders(port: AccountExecutionPort, ctx: Context): void
  /** @param port Original issued port. @param ctx Actual consumer scope. @returns Current installed service facts. */
  inspectServices(port: AccountExecutionPort, ctx: Context): AccountServiceAvailability
}

/** Original installed consumer/provider facts only; no service process or HTTP readiness is asserted. */
export interface AccountServiceAvailability {
  readonly developmentServices: boolean
  readonly servicePreview: boolean
}

/** Common nominal installation check; each mode retains its own exact-object owner registry. */
export abstract class IssuedExecutionPort implements AccountExecutionPort {
  declare readonly enforcesSessionFilePolicy?: true | undefined
  readonly #owner: ExecutionPortOwner

  /** @param binding Original runtime binding. @param owner Original mode-specific Root registry.
   * @param mode Fixed provider selection; declarations alone cannot issue this original capability.
   */
  constructor(readonly binding: AccountBinding, owner: ExecutionPortOwner, readonly mode: 'closed' | 'session-collect') {
    this.#owner = owner
  }

  abstract assertCurrent(ctx: Context): void
  abstract deny(ctx: Context, signal?: AbortSignal): never
  abstract claim(ctx: Context): void
  abstract close(): void

  /**
   * Borrow only an original submitted service, retaining its request through actual local I/O settlement.
   * @param ctx Original admitted account scope with this exact installed port and providers.
   * @param selection Original native Session and registered service; never allocates or resumes work.
   * @param signal Original ingress cancellation observer.
   * @param deadlineAtMs Original absolute observer deadline, which the transport cannot extend.
   * @param consume Callback retained through its actual response and cleanup.
   * @returns Actual callback and I/O settlement; uncertain cleanup remains with the original owner.
   */
  abstract withApplicationService(ctx: Context, selection: ApplicationServiceSelection, signal: AbortSignal,
    deadlineAtMs: number, consume: (service: RegisteredApplicationService) => Promise<void>): Promise<void>

  /**
   * Check this exact issued port against its owner's current account installation.
   * @param ctx Original installation or account consumer scope.
   */
  assertOwned(ctx: Context): void { this.#owner.assertPort(this, ctx) }

  /**
   * Require the original enforcing owner and quiescent Session ranges before a policy change.
   * @param ctx Original account native caller.
   * @param session Exact native Session whose policy will change synchronously after this check.
   */
  assertSessionFilePolicyChange(ctx: Context, session: Session): void {
    this.assertOwned(ctx)
    if (this.enforcesSessionFilePolicy !== true || this.#owner.assertSessionFilePolicyChange === undefined) {
      throw new ExecutionStateError('cloud/execution-unavailable', 'Session permission changes require their original enforcing owner.')
    }
    this.#owner.assertSessionFilePolicyChange(this, ctx, session)
  }
  /**
   * Verify the original installed providers without executing native work.
   * @param ctx Actual account consumer scope.
   */
  assertProvidersOwned(ctx: Context): void { this.#owner.assertProviders(this, ctx) }
  /**
   * Read installed service-provider facts from this port's original owner.
   * @param ctx Actual account consumer scope.
   * @returns Original owner facts without executing user work or asserting process readiness.
   */
  inspectServicesOwned(ctx: Context): AccountServiceAvailability { return this.#owner.inspectServices(this, ctx) }

  /**
   * Test nominal issuance without checking current admission or provider installation.
   * @param value Candidate in-process capability.
   * @returns Whether it has this class's actual constructor-owned private slot.
   */
  static isIssued(value: unknown): value is IssuedExecutionPort {
    return value instanceof IssuedExecutionPort && #owner in value
  }
}

/**
 * Require the installed exact owner-issued capability before account assembly or native observations.
 * @param ctx Original installation or account consumer scope.
 * @returns The original nominal port; copied, prototype-cloned and shadowed objects reject.
 */
export function requireIssuedExecutionPort(ctx: Context): IssuedExecutionPort {
  const port = ctx.get('peAccountExecution')
  if (!IssuedExecutionPort.isIssued(port) || ctx.root.get('peAccountExecution') !== port) {
    throw new ExecutionStateError('cloud/stale-generation', 'The account requires its original Root-issued execution port.')
  }
  IssuedExecutionPort.prototype.assertOwned.call(port, ctx)
  return port
}

/**
 * Install the original mode-specific port during trusted native prepare, before its account entry.
 * @param ctx Original independent account prepare scope.
 * @param port Root owner's original capability; installation does not execute or establish readiness.
 */
export function installIssuedExecutionPort(ctx: Context, port: AccountExecutionPort): void {
  if (!IssuedExecutionPort.isIssued(port)) {
    throw new ExecutionStateError('cloud/stale-generation', 'Execution port was not issued by a Root execution owner.')
  }
  IssuedExecutionPort.prototype.assertOwned.call(port, ctx)
  if (ctx.get('peAccountExecution') !== undefined || ctx.root.get('peAccountExecution') !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'The account already has an execution port.')
  }
  const unprovide = ctx.provide('peAccountExecution', port)
  if (ctx.root.get('peAccountExecution') !== port) {
    unprovide()
    throw new ExecutionStateError('cloud/stale-generation', 'Execution port installation must be visible in its account root.')
  }
}

/**
 * Check the current original providers for either an explicit refusal mode or a verified execution mode.
 * @param ctx Actual account consumer scope.
 */
export function assertAccountExecutionProviders(ctx: Context): void {
  const port = requireIssuedExecutionPort(ctx)
  IssuedExecutionPort.prototype.assertProvidersOwned.call(port, ctx)
}

/**
 * Borrow an original registered application service from the exact admitted account graph.
 * @param ctx Original AccountUse context, retained by ingress until this operation actually settles.
 * @param selection Native Session and service identifiers; they grant no authority or new allocation.
 * @param signal Original request cancellation observer.
 * @param deadlineAtMs Original absolute request deadline.
 * @param consume Consumer retained through actual HTTP and callback settlement.
 * @returns Actual settlement; absent, stale, closed or unknown service ownership rejects.
 */
export async function withAccountApplicationService(ctx: Context, selection: ApplicationServiceSelection,
  signal: AbortSignal, deadlineAtMs: number, consume: (service: RegisteredApplicationService) => Promise<void>): Promise<void> {
  const port = requireIssuedExecutionPort(ctx)
  IssuedExecutionPort.prototype.assertProvidersOwned.call(port, ctx)
  try { await port.withApplicationService(ctx, selection, signal, deadlineAtMs, consume) }
  catch (cause) {
    if (cause instanceof PreviewHttpError) throw new ExecutionStateError(cause.code, 'The original application request remains unavailable or unconfirmed.')
    throw cause
  }
}

/**
 * Read only the selected original provider mode after its live owner and native services are verified.
 * @param ctx Actual account consumer scope.
 * @returns Fixed mode for compact availability projection; this creates no allocation or execution authority.
 */
export function accountExecutionMode(ctx: Context): 'closed' | 'session-collect' {
  const port = requireIssuedExecutionPort(ctx)
  IssuedExecutionPort.prototype.assertProvidersOwned.call(port, ctx)
  return port.mode
}

/**
 * Read service availability from the same nominal installed port and its original live owner.
 * @param ctx Actual admitted account scope.
 * @returns Installed consumer and optional application-provider facts; never a process-readiness result.
 */
export function accountServiceAvailability(ctx: Context): AccountServiceAvailability {
  const port = requireIssuedExecutionPort(ctx)
  IssuedExecutionPort.prototype.assertProvidersOwned.call(port, ctx)
  return IssuedExecutionPort.prototype.inspectServicesOwned.call(port, ctx)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Private runtime prepare contribution, issued by the root execution owner. */
    peAccountExecution: AccountExecutionPort
  }
}

/**
 * Reject isolated child bindings and ports outside their installed account root.
 * @param ctx - actual native caller or installation context.
 * @param binding - exact binding installed by runtime, never its pre-install input.
 * @param root - independent account root captured at issuance.
 */
export function assertInstalledExecutionBinding(ctx: Context, binding: AccountBinding, root: Context): void {
  if (ctx.root !== root || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
    throw new ExecutionStateError('cloud/stale-generation', 'Execution requires the exact installed account root binding.')
  }
  ctx.fiber.assertActive()
}
