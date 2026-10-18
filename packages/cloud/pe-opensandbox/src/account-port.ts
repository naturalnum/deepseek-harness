/** Exact account-generation ports issued by one closed execution owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { ExecutionStateError } from './errors.ts'

/** Internal factory capability; it cannot select an account, backend, or process. */
export interface AccountExecutionPort {
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
