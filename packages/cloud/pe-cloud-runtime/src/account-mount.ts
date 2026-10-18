/** Concrete native boot bridge; data alignment and native assembly never establish production readiness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { defaultProjectLayout } from './account-layout.ts'
import { AccountRuntimeError } from './errors.ts'
import { startNativeAccountBoot, type NativeAccountBootHandle } from './native-boot.ts'
import type { AccountBinding, AccountMountInput } from './types.ts'
import type { AccountNativePreparation } from './account-native-integration.ts'

/** Private, deployment-selected native recipe; no caller-selected module paths or account capability. */
export interface AccountRecipe {
  readonly profile: ProfileContext
  readonly configPath: string
  readonly bareModuleBaseUrl: string
  readonly requiredEntryIds: readonly string[]
  readonly maxObservedEvents: number
  readonly maxPathBytes: number
  /** Actual Root-issued API/execution resources; absent for isolated native-mechanism fixtures. */
  readonly native?: AccountNativePreparation
  /** Install graph-lived dependencies before Include; this is native preparation, not a replaceable mounter. */
  prepare(ctx: Context, binding: AccountBinding): void | Promise<void>
}

/** Mandatory provider handoffs have no production issuer in this slice. */
export class AccountMountPrerequisiteError extends AccountRuntimeError {
  /** Missing real providers; these names cannot be supplied as approval flags. */
  readonly missing = Object.freeze(['files-bootstrap-and-native-fs', 'execution-port', 'api-save-and-exposure', 'all-writer-quota'])

  /** Reject publication until actual provider interfaces and their verified issuers are integrated. */
  constructor() {
    super('cloud/account-unavailable', 'Account assembly lacks the required production provider and storage handoffs')
    this.name = 'AccountMountPrerequisiteError'
  }
}

/**
 * Refuse production preparation before native services could fall back to unrestricted providers.
 * No configuration value or native mounted result can satisfy the missing handoffs.
 * @throws AccountMountPrerequisiteError unconditionally until the real provider composition is implemented.
 */
export function requireAccountProductionPorts(): void {
  throw new AccountMountPrerequisiteError()
}

/**
 * Assemble one native graph through the existing concrete boot implementation.
 * Caller owns the PG claim, real parent/quota checks and every supplied dependency; this bridge
 * checks only address agreement. It never publishes AccountUse or runs the owner ready CAS.
 * @param input Trusted generation, canonical layout, and exact native environment snapshot.
 * @param recipe Deployment-selected Profile and native preparation with explicit budgets.
 * @returns Actual native boot/disposal ownership, including partial startup.
 * @throws AccountRuntimeError for mismatched Profile addresses or ended generation; native read failures retain their identity.
 */
export function mountAccount(input: AccountMountInput, recipe: AccountRecipe): NativeAccountBootHandle {
  const expectedCwd = defaultProjectLayout(input.layout, recipe.maxPathBytes).root
  if (recipe.profile.dir !== input.layout.profileRoot || recipe.profile.patchPath !== input.layout.patchPath
    || recipe.profile.home !== input.layout.privateRoot || recipe.profile.cwd !== expectedCwd) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Native Profile addresses disagree with the account layout')
  }
  return startNativeAccountBoot({
    binding: input.binding, environment: input.environment, profile: recipe.profile,
    configPath: recipe.configPath, bareModuleBaseUrl: recipe.bareModuleBaseUrl,
    requiredEntryIds: recipe.requiredEntryIds, maxObservedEvents: recipe.maxObservedEvents,
    prepare: (ctx, binding) => recipe.prepare(ctx, binding),
  })
}
