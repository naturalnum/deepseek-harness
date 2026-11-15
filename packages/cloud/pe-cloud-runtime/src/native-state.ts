/** Runtime-owned reads of native Entry, Fiber and implementation identity. */
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { AccountRuntimeError } from './errors.ts'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

type NativeImplementation = Context['reflect']['store'][symbol]

/** Read the canonical native fiber, retaining absence rather than creating an owner.
 * @param entry Original Loader entry.
 * @returns Its current canonical fiber, or undefined before activation.
 */
export function nativeEntryFiber(entry: Entry | undefined): Fiber | undefined {
  return entry?.fiber?.ctx.fiber
}

/** Read the configuration actually supplied to the active native instance.
 * @param fiber Original native fiber; callers retain their own readiness checks.
 * @returns Native effective configuration, without resolving a candidate or copying identity.
 */
export function nativeEffectiveConfig(fiber: Fiber | undefined): unknown { return fiber?.effectiveConfig }

/** Read every provision retained by the original canonical fiber, including isolated names and pending disposal.
 * @param fiber Original providing fiber; callers own readiness, visit bounds and duplicate rejection.
 * @returns The live native set without copying records or changing their cleanup ownership.
 */
export function nativeFiberProvisions(fiber: Fiber): ReadonlySet<NativeImplementation> { return fiber.ctx.fiber.provisions }

/** Locate a provision owned by the same canonical fiber; duplicate names remain unproven.
 * @param fiber Expected providing fiber.
 * @param name Native service key.
 * @returns Original implementation record, or undefined when absent or ambiguous.
 */
export function nativeProvision(fiber: Fiber | undefined, name: string): NativeImplementation | undefined {
  const owner = fiber?.ctx.fiber
  if (owner === undefined) return undefined
  let found: NativeImplementation | undefined
  for (const provision of nativeFiberProvisions(owner)) {
    if (provision.name !== name || provision.ctx.fiber !== owner) continue
    if (found !== undefined) return undefined
    found = provision
  }
  return found
}

/** Resolve the original implementation in a Context's current isolation scope.
 * @param ctx Original consuming Context.
 * @param name Native service key.
 * @returns The retained native record, without bypassing the caller's identity/readiness checks.
 */
export function nativeImplementation(ctx: Context, name: string): NativeImplementation | undefined {
  const label = ctx[symbols.isolate][name]
  return label === undefined ? undefined : ctx.reflect.store[label]
}

/** Read the original target recorded by a native Cordis proxy.
 * @param value Original native value; caller-owned narrowing and fallback remain with the account policy.
 * @returns The borrowed proxy target, or undefined when this value has no original target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }

/** Read the original Loader entry's moduleNamespace at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native moduleNamespace without copying or resolving it.
 */
export function nativeEntryModule(entry: Entry | undefined): Entry['moduleNamespace'] { return entry?.moduleNamespace }

/** Read the original Loader entry's id at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native id without copying or resolving it.
 */
export function nativeEntryId(entry: Entry): Entry['options']['id'] { return entry.options.id }

/** Read the original Loader entry's name at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native name without copying or resolving it.
 */
export function nativeEntryName(entry: Entry): Entry['options']['name'] { return entry.options.name }

/** Read the original Loader entry's config at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native config without copying or resolving it.
 */
export function nativeEntryConfig(entry: Entry): Entry['options']['config'] { return entry.options.config }

/** Read the original Loader entry's disabled at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native disabled without copying or resolving it.
 */
export function nativeEntryDisabled(entry: Entry): Entry['disabled'] { return entry.disabled }

/** Read the original Loader entry's group at this call's observation point.
 * @param entry Original Native entry; no readiness or identity policy is inferred.
 * @returns Its current Native group without copying or resolving it.
 */
export function nativeEntryGroup(entry: Entry): Entry['options']['group'] { return entry.options.group }

/** Read the original plugin callback retained by a Native runtime.
 * @param fiber Original providing fiber, or absence before activation.
 * @returns Its current callback identity, or undefined without a runtime.
 */
export function nativeCallback(fiber: Fiber | undefined): NonNullable<Fiber['runtime']>['callback'] | undefined {
  return fiber?.runtime?.callback
}

/** Read the schema retained by the original Native runtime.
 * @param fiber Original providing fiber.
 * @returns Its installed schema, or undefined when no schema is installed.
 */
export function nativeConfigSchema(fiber: Fiber): NonNullable<Fiber['runtime']>['Config'] | undefined { return fiber.runtime?.Config }

/** Resolve candidate configuration with the original Native fiber's resolver.
 * @param fiber Original providing fiber.
 * @param config Candidate configuration; callers retain admission and plan checks.
 * @returns The Native resolver's result.
 */
export function nativeResolveConfig(fiber: Fiber, config: Parameters<Fiber['resolveConfig']>[0]): ReturnType<Fiber['resolveConfig']> {
  return fiber.resolveConfig(config)
}

/** Import through the original entry's owning profile tree.
 * @param entry Actual Native entry whose configured module is being audited.
 * @returns The same module import promise; callers recheck ownership after awaiting.
 */
export function nativeImportEntry(entry: Entry): ReturnType<Entry['parent']['tree']['import']> {
  return entry.parent.tree.import(entry.options.name)
}

/** Read the base URL of the original entry's owning profile tree.
 * @param entry Actual Native entry.
 * @returns Its current module resolution base URL.
 */
export function nativeEntryBaseUrl(entry: Entry): Entry['parent']['tree']['ctx']['baseUrl'] { return entry.parent.tree.ctx.baseUrl }

/** Iterate the original registry without changing graph, scope or visit policy.
 * @param ctx Original consuming Context.
 * @returns Original fibers from every registered runtime, in Native iteration order.
 */
export function* nativeRegisteredFibers(ctx: Context): Iterable<Fiber> {
  for (const runtime of ctx.registry.values()) yield* runtime.fibers
}

/** Locate the original runtime fibers for one installed plugin.
 * @param ctx Original consuming Context.
 * @param plugin Actual Native registry key.
 * @returns The live fiber set or an empty list when the runtime is absent.
 */
export function nativePluginFibers(ctx: Context, plugin: Parameters<Context['registry']['get']>[0]): Iterable<Fiber> {
  return ctx.registry.get(plugin)?.fibers ?? []
}

/** Read a logged Native fiber's current state without retaining a new owner.
 * @param reference Original weak log reference.
 * @returns Current state, or undefined when the fiber was released.
 */
export function nativeLoggedFiberState(reference: WeakRef<Fiber> | undefined): Fiber['state'] | undefined {
  return reference?.deref()?.state
}

/** Install fixed Native builtins on the account's original Loader.
 * @param ctx Original account Context.
 * @param modules Reviewed declarations composed by the account integration.
 * @throws AccountRuntimeError before mutation when any name is already registered.
 */
export function nativeInstallBuiltins(ctx: Context, modules: Context['loader']['builtins']): void {
  const builtins = ctx.loader.builtins
  for (const key of Object.keys(modules)) {
    if (Object.hasOwn(builtins, key)) {
      throw new AccountRuntimeError('cloud/invalid-config', 'A fixed native account builtin has already been installed')
    }
  }
  Object.assign(builtins, modules)
}

/** Observe Native entry/fiber changes on the existing account owner.
 * @param ctx Original effect owner.
 * @param revoke Existing policy's invalidation callback; Native waterfalls always continue.
 */
export function nativeObservePolicy(ctx: Context, revoke: (entry?: Entry, fiber?: Fiber) => void): void {
  ctx.on('loader/partial-dispose', (entry) => { revoke(entry) })
  ctx.on('loader/volatile-update', function (this: Fiber) { revoke(undefined, this) }, { global: true })
  ctx.on('internal/plugin', (fiber) => { revoke(undefined, fiber) })
  ctx.on('internal/status', (fiber) => { revoke(undefined, fiber) })
  ctx.on('internal/update', function (this: Fiber, _config, next) {
    revoke(undefined, this)
    return next()
  }, { global: true, prepend: true })
}

/** Observe the existing Root recipe's Native dependencies.
 * @param owner Original Root effect owner.
 * @param revoke Existing recipe invalidation callback.
 * @param checkFiber Existing ancestry check before a Native configuration update.
 */
export function nativeObserveRecipe(owner: Context, revoke: (reason: 'root-plugin' | 'root-service' | 'entry-init' | 'partial-dispose' | 'volatile-update' | 'patch-context') => void, checkFiber: (fiber: Fiber) => void): void {
  owner.on('internal/plugin', () => { revoke('root-plugin') })
  owner.on('internal/service', () => { revoke('root-service') })
  owner.on('loader/entry-init', () => { revoke('entry-init') })
  owner.on('loader/partial-dispose', () => { revoke('partial-dispose') })
  owner.on('loader/volatile-update', () => { revoke('volatile-update') }, { global: true })
  owner.on('loader/patch-context', (_entry, next) => { revoke('patch-context'); return next() })
  owner.on('internal/update', function (this: Fiber, _config, next) {
    checkFiber(this)
    return next()
  }, { global: true, prepend: true })
}

/** Iterate one account's registry fibers with its existing visit accounting.
 * @param ctx Original account Context.
 * @param consume Original budget callback, invoked for each same-account runtime and fiber.
 * @returns Original same-account fibers, with inactive owners preserved for caller checks.
 */
export function* nativeAccountFibers(ctx: Context, consume: () => void): Iterable<Fiber> {
  for (const runtime of ctx.registry.values()) {
    let charged = false
    for (const fiber of runtime.fibers) {
      if (fiber.ctx.root !== ctx.root) continue
      if (!charged) { consume(); charged = true }
      consume()
      yield fiber
    }
  }
}
