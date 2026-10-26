/** Private native assembly after the factory's owner, root-capability, and recipe admission checks. */
import { isAbsolute } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { installAccountBinding, requireAccountBinding } from './binding.ts'
import { AccountRuntimeError } from './errors.ts'
import { observeStartup, startupFailureObserver, type StartupObserver } from './startup-observation.ts'
import type { AccountBinding } from './types.ts'

/** Factory-owned native inputs; generation-bound ports are constructed in prepare. */
export interface NativeAccountBootInput {
  readonly binding: AccountBinding
  readonly profile: ProfileContext
  readonly configPath: string
  readonly bareModuleBaseUrl: string
  readonly environment: LaunchEnvironmentSnapshot
  readonly requiredEntryIds: readonly string[]
  readonly maxObservedEvents: number
  /** Production uses its existing native entry budget; omission remains native-mechanism-only. */
  readonly maxEntries?: number
  /** Private original-owner observation only; callback failures never affect startup. */
  readonly observeStartup?: StartupObserver
  /** Original files lease checks exact Profile/base addresses before native Profile or configuration I/O. */
  readonly assertBeforeNativeRead?: () => void
  /** Build/verify/inject ports from this exact installed binding; await setup and register native teardown. */
  prepare(ctx: Context, binding: AccountBinding): void | Promise<void>
}

/** Native fiber settlement only; this never establishes business-work drain or account clean. */
export interface NativeDisposalObservation {
  readonly status: 'confirmed' | 'unknown'
  readonly errorEvents: number
  readonly warningEvents: number
  readonly overflow: boolean
}

/** A mounted native tree still requires the product factory's provider, save, and exposure audits. */
export type NativeAccountBootOutcome =
  | Readonly<{ status: 'mounted'; context: Context; binding: AccountBinding }>
  | Readonly<{ status: 'failed'; cause: unknown; disposal: NativeDisposalObservation }>

/** Retains actual boot/disposal settlement when a caller stops waiting. */
export interface NativeAccountBootHandle {
  readonly result: Promise<NativeAccountBootOutcome>
  /** Stop the native tree once; callers retain this Promise through any observation deadline. */
  dispose(): Promise<NativeDisposalObservation>
}

function validateLocations(input: NativeAccountBootInput): void {
  const profile = input.profile
  if (![input.configPath, profile.dir, profile.patchPath, profile.installAnchor, profile.cwd, profile.home].every(isAbsolute)) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Native account locations must all be explicit absolute paths')
  }
  if (!Number.isSafeInteger(input.maxObservedEvents) || input.maxObservedEvents <= 0) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Native diagnostic observation requires a positive finite event bound')
  }
  if (input.maxEntries !== undefined && (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1
    || input.requiredEntryIds.length > input.maxEntries)) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Required native entries exceed the explicit inventory limit')
  }
  if (input.requiredEntryIds.length === 0 || new Set(input.requiredEntryIds).size !== input.requiredEntryIds.length) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Native assembly requires distinct required entry ids')
  }
}

/**
 * Start one independent native Profile without CLI bootstrap or process mutation.
 * The caller owns PG/root-capability/recipe admission and finite waiting budgets; this handle retains
 * actual settlement after a deadline. Neither a mounted result nor native disposal publishes ready/clean.
 * @param input Trusted account paths, environment, binding, and verified-port preparation.
 * @returns Private boot and single-flight disposal ownership, including partial-startup diagnostics.
 * @throws AccountRuntimeError for invalid location/observation inputs or an ended binding.
 * @throws Native profile read/parse failures before creating any Context.
 */
export function startNativeAccountBoot(input: NativeAccountBootInput): NativeAccountBootHandle {
  const diagnostic = input.observeStartup ?? startupFailureObserver(input.requiredEntryIds)
  observeStartup(diagnostic, { phase: 'prepare' })
  try { validateLocations(input) } catch (cause) { observeStartup(diagnostic, { failure: cause }); throw cause }
  if (input.binding.lifetime.aborted) {
    throw new AccountRuntimeError('cloud/stale-generation', 'Account generation lifetime has ended')
  }
  const profile = Object.freeze(structuredClone(input.profile))
  const environment = input.environment
  const requiredIds = [...input.requiredEntryIds]
  observeStartup(diagnostic, { phase: 'storage-before-read' })
  let patches: ReturnType<typeof readProfilePatches>
  try {
    input.assertBeforeNativeRead?.()
    patches = readProfilePatches('pe-cloud-account', profile)
  } catch (cause) { observeStartup(diagnostic, { failure: cause }); throw cause }
  const observer = new Context()
  let context: Context | undefined
  let disposeRequested = false
  let disposing: Promise<NativeDisposalObservation> | undefined
  let errorEvents = 0
  let warningEvents = 0
  let overflow = false
  const closing = (binding: AccountBinding): boolean => disposeRequested || binding.lifetime.aborted

  const observation = (): NativeDisposalObservation => Object.freeze({
    status: errorEvents === 0 && !overflow ? 'confirmed' : 'unknown',
    errorEvents, warningEvents, overflow,
  })
  const disposeContext = async (): Promise<void> => { await context?.fiber.dispose() }
  let requiredEntryId: string | undefined
  const result: Promise<NativeAccountBootOutcome> = (async () => {
    try {
      observeStartup(diagnostic, { phase: 'storage-before-read' })
      input.assertBeforeNativeRead?.()
      observeStartup(diagnostic, { phase: 'nativeboot' })
      const mounted = await boot('pe-cloud-account', input.configPath, patches, async (ctx) => {
        context = ctx
        observeStartup(diagnostic, { phase: 'prepare' })
        // The observer's own fiber survives the account root's disposable chain.
        observer.logger = ctx.logger
        observer.logger.exporter({ levels: { default: 1 }, export(message) {
          if (message.type !== 'error' && message.type !== 'warn') return
          if (errorEvents + warningEvents >= input.maxObservedEvents) { overflow = true; return }
          if (message.type === 'error') {
            errorEvents++
            const failure: unknown = message.args.slice(0, 3).find(value => value !== null
              && (typeof value === 'object' || typeof value === 'function'))
            observeStartup(diagnostic, { nativeError: failure })
          } else warningEvents++
        } })
        if (disposeRequested) throw new AccountRuntimeError('cloud/account-unavailable', 'Native account startup was closed')
        ctx.provide('profileContext', profile)
        ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        const binding = installAccountBinding(ctx, input.binding)
        try { await input.prepare(ctx, binding) }
        catch (cause) { observeStartup(diagnostic, { failure: cause }); throw cause }
        if (closing(binding)) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'Native account startup ended during preparation')
        }
        observeStartup(diagnostic, { phase: 'nativeboot' })
      }, input.bareModuleBaseUrl)
      const loader = mounted.get('loader')
      if (closing(input.binding) || loader === undefined) {
        throw new AccountRuntimeError('cloud/account-unavailable', 'Native account startup ended before assembly settled')
      }
      observeStartup(diagnostic, { phase: 'required-entry' })
      const entries: NonNullable<Context['fiber']['entry']>[] = []
      for (const entry of loader.entries()) {
        if (input.maxEntries !== undefined && entries.length >= input.maxEntries) {
          throw new AccountRuntimeError('cloud/account-unavailable', 'Native entries exceed the explicit inventory limit')
        }
        entries.push(entry)
      }
      for (const id of requiredIds) {
        const matches = entries.filter(entry => entry.options.id === id)
        if (matches.length !== 1 || matches[0]?.fiber?.state !== FiberState.ACTIVE) {
          requiredEntryId = id
          throw new AccountRuntimeError('cloud/account-unavailable', 'A required native recipe entry is absent, disabled, duplicated, or inactive')
        }
      }
      return Object.freeze({ status: 'mounted', context: mounted, binding: requireAccountBinding(mounted) })
    } catch (cause) {
      observeStartup(diagnostic, { failure: cause, ...requiredEntryId === undefined ? {} : { requiredEntryId } })
      await disposeContext()
      await observer.fiber.dispose()
      return Object.freeze({ status: 'failed', cause, disposal: observation() })
    }
  })()

  return Object.freeze({
    result,
    dispose: (): Promise<NativeDisposalObservation> => {
      disposeRequested = true
      if (disposing !== undefined) return disposing
      const pending = disposeContext()
      disposing = (async () => {
        await pending
        await result
        await disposeContext()
        await observer.fiber.dispose()
        return observation()
      })()
      return disposing
    },
  })
}
