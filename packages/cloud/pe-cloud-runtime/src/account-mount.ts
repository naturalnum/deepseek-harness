/** Concrete native boot bridge; data alignment and native assembly never establish production readiness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { defaultProjectLayout } from './account-layout.ts'
import { AccountRuntimeError } from './errors.ts'
import { startNativeAccountBoot, type NativeAccountBootHandle } from './native-boot.ts'
import type { StartupObserver } from './startup-observation.ts'
import type { AccountBinding, AccountMountInput } from './types.ts'
import type { AccountNativePreparation } from './account-native-integration.ts'
import { RootStorageOwner, type StaticAccountStorageLease } from '@deepseek-ai/dsh-pe-cloud-files/root'
import type { DrainParticipant } from './types.ts'

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
  /** Original files Root owner and participant, retained by the private production factory only. */
  readonly storage?: Readonly<{ owner: RootStorageOwner; files: DrainParticipant }>
  /** Install graph-lived dependencies before Include; this is native preparation, not a replaceable mounter. */
  prepare(ctx: Context, binding: AccountBinding): void | Promise<void>
}

/** Production preparation rejects absent original storage and native provider handoffs. */
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
 * @param recipe Trusted deployment recipe with original storage and native providers.
 * @returns The original storage handoff after its Root and execution checks pass.
 * @throws AccountMountPrerequisiteError when an original mandatory provider is absent.
 */
export function requireAccountProductionPorts(recipe?: AccountRecipe): NonNullable<AccountRecipe['storage']> {
  const storage = recipe?.storage, native = recipe?.native
  if (storage === undefined || !(storage.owner instanceof RootStorageOwner) || storage.files.id !== 'files'
    || native === undefined || native.guards === undefined) throw new AccountMountPrerequisiteError()
  storage.owner.assertRootCurrent()
  native.assertRootCurrent()
  native.execution.assertReady()
  return storage
}

/**
 * Assemble one native graph through the existing concrete boot implementation.
 * Caller owns the PG claim, real parent/quota checks and every supplied dependency; this bridge
 * checks only address agreement. It never publishes AccountUse or runs the owner ready CAS.
 * @param input Trusted generation, canonical layout, and exact native environment snapshot.
 * @param recipe Deployment-selected Profile and native preparation with explicit budgets.
 * @param lease Original production storage lease; absent only for isolated native-mechanism assembly.
 * @param observeStartup Private original-owner observer; never an authority or cleanup participant.
 * @returns Actual native boot/disposal ownership, including partial startup.
 * @throws AccountRuntimeError for mismatched Profile addresses or ended generation; native read failures retain their identity.
 */
export function mountAccount(
  input: AccountMountInput, recipe: AccountRecipe, lease?: StaticAccountStorageLease, observeStartup?: StartupObserver,
): NativeAccountBootHandle {
  const expectedCwd = defaultProjectLayout(input.layout, recipe.maxPathBytes).root
  if (recipe.profile.dir !== input.layout.profileRoot || recipe.profile.patchPath !== input.layout.patchPath
    || recipe.profile.home !== input.layout.privateRoot || recipe.profile.cwd !== expectedCwd
    || (recipe.native?.firstScreen !== undefined && recipe.native.firstScreen.home !== recipe.profile.home)) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Native Profile addresses disagree with the account layout')
  }
  return startNativeAccountBoot({
    binding: input.binding, environment: input.environment, profile: recipe.profile,
    configPath: recipe.configPath, bareModuleBaseUrl: recipe.bareModuleBaseUrl,
    requiredEntryIds: recipe.requiredEntryIds, maxObservedEvents: recipe.maxObservedEvents,
    ...observeStartup === undefined ? {} : { observeStartup },
    ...recipe.native === undefined ? {} : { maxEntries: recipe.native.maxNativeInventoryEntries },
    ...lease === undefined ? {} : { assertBeforeNativeRead: () => { lease.assertBeforeNativeRead(recipe.profile, recipe.configPath) } },
    prepare: (ctx, binding) => recipe.prepare(ctx, binding),
  })
}
