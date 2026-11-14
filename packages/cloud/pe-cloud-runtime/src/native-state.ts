/** Runtime-owned reads of native Entry, Fiber and implementation identity. */
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
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
