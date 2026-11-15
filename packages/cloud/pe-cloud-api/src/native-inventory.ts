/** Exact implementation identity comparison for the original mounted account inventory. */
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { EndpointExposure } from './types.ts'

type Descriptor = NonNullable<ReturnType<Context['typert']['local']['get']>>

/**
 * Match one inspected endpoint to its actual Typert implementation.
 * @param row Actual installed inventory row, independently audited by its provider.
 * @param mode Original registry iteration mode.
 * @param descriptor Actual registered Typert method description.
 * @returns Whether the original Native relation or the sole approved Cloud management tuple matches.
 */
export function inventoryMethodMatches(row: EndpointExposure, mode: 'rpc' | 'stream', descriptor: Descriptor): boolean {
  const service = row.handlerId.startsWith('native:') ? row.handlerId.slice('native:'.length)
    : mode === 'rpc' && row.endpoint === 'cloudRemoteServers/action' && row.handlerId === 'cloud:remote-servers'
      && row.guard === 'authenticated-account' ? 'cloudRemoteServers' : undefined
  if (service === undefined) return false
  const separator = row.endpoint.indexOf('/'), namespace = row.endpoint.slice(0, separator)
  const method = row.endpoint.slice(separator + 1)
  return descriptor.service === service && descriptor.namespace === namespace && descriptor.method === method
    && (descriptor.implementation ?? descriptor.method) === method && (descriptor.mode ?? 'rpc') === mode
}

/** Read the original Native proxy target without narrowing or choosing fallback policy.
 * @param value Borrowed Native value; its caller retains ownership and interpretation.
 * @returns The original target, or undefined for a value with no Native proxy target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }

/** Iterate fibers belonging to this account before charging its existing audit budget.
 * @param ctx Original account Context.
 * @param consume Charge one same-account runtime or fiber; refusal aborts iteration.
 * @returns Original fibers, including inactive owners so callers retain their existing state checks.
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
