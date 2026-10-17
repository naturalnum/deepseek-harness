/** Account Loader entry verifies the factory-owned generation; it does not accept identity in config. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { requireAccountBinding } from './binding.ts'
import { AccountRuntimeError } from './errors.ts'
import type { AccountBinding } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Immutable generation installed by the runtime's private account factory. */
    peAccount: AccountBinding
  }
}

/** Cordis account plugin name. */
export const name = 'pe-cloud-runtime-account'
/** Missing factory input must fail instead of remaining a pending injection warning. */
export const inject: readonly string[] = []
/** Account identity and generation are supplied by the private factory, never Loader JSON. */
export interface Config {}
/** The account entry accepts an empty object only; unknown fields are rejected rather than discarded. */
export const Config: z<Config> = z.transform(z.object({}), (candidate) => {
  if (Object.keys(candidate).length !== 0) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Account Loader configuration must be empty; identity comes from the runtime factory')
  }
  return candidate
})

/**
 * Require the trusted immutable binding before account plugins proceed.
 * This does not assert recipe readiness or instantiate an owner, graph, or execution resource.
 * @param ctx Independent account Loader context carrying the factory's binding.
 * @param config Empty Loader parameters; identity fields are rejected.
 */
export function apply(ctx: Context, config: Config = {}): void {
  Config(config)
  requireAccountBinding(ctx)
}
