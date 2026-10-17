/** Private account-factory handoff; callers must have verified the PG owner and explicit mount inputs. */
import type { Context } from '@deepseek-ai/cordis'
import { AccountRuntimeError } from './errors.ts'
import type { AccountBinding } from './types.ts'

class RuntimeBinding implements AccountBinding {
  readonly accountId: AccountBinding['accountId']
  readonly epoch: AccountBinding['epoch']
  readonly recipeVersion: string
  readonly lifetime: AbortSignal

  constructor(input: AccountBinding) {
    this.accountId = input.accountId
    this.epoch = input.epoch
    this.recipeVersion = input.recipeVersion
    this.lifetime = input.lifetime
    Object.freeze(this)
  }
}

/**
 * Publish only immutable generation inputs before the factory mounts its root Include.
 * This internal helper does not acquire an owner or validate a storage/recipe/config-save capability.
 * @param ctx Independent account root; never a child of the public root.
 * @param input Trusted generation returned by the runtime's PG owner operation.
 * @returns The frozen binding installed as a fiber-owned contribution.
 */
export function installAccountBinding(ctx: Context, input: AccountBinding): AccountBinding {
  if (ctx !== ctx.root) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Account binding requires an independent root Context')
  }
  if (input.lifetime.aborted) {
    throw new AccountRuntimeError('cloud/stale-generation', 'Account generation lifetime has ended')
  }
  const binding = new RuntimeBinding(input)
  ctx.provide('peAccount', binding)
  return binding
}

/**
 * Admit only a private factory handoff, not a structurally similar JSON object.
 * @param ctx Account Loader context.
 * @returns The immutable generation input; all subsequent operations still check lifetime/current owner.
 * @throws AccountRuntimeError when the trusted handoff is missing or expired.
 */
export function requireAccountBinding(ctx: Context): AccountBinding {
  const binding = ctx.get('peAccount')
  if (!(binding instanceof RuntimeBinding)) {
    throw new AccountRuntimeError('cloud/account-unavailable', 'Account entry requires the runtime factory binding')
  }
  if (binding.lifetime.aborted) {
    throw new AccountRuntimeError('cloud/stale-generation', 'Account generation lifetime has ended')
  }
  return binding
}
