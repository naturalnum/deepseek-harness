/** Shared Host/browser reads of Native identity and owner lifecycle. */
import { symbols, type Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'

/** Read a Native proxy target without changing the caller's identity policy.
 * @param value Borrowed Native object.
 * @returns Its original target, or undefined without a Native proxy target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }

/** Subscribe on the original Native effect owner.
 * @param ctx Original owner Context.
 * @param listener Existing plugin lifecycle handler.
 */
export function nativeOnPlugin(ctx: Context, listener: (fiber: Fiber) => void): void { ctx.on('internal/plugin', listener) }

/** Subscribe on the original Native effect owner, preserving the caller's event scope.
 * @param ctx Original owner Context.
 * @param listener Existing status transition handler.
 * @param options Original global-listener selection when explicitly requested.
 */
export function nativeOnStatus(ctx: Context, listener: (fiber: Fiber, previous: FiberState) => void,
  options?: { readonly global?: boolean }): void { ctx.on('internal/status', listener, options) }

/** Read the actual Host Loader resolution base without importing Host runtime code into the browser.
 * @param owner Original Host Context; its typed fiber must supply this Native entry/tree relationship.
 * @returns The existing base URL, or undefined when the owner has no Loader entry.
 */
export function nativeModuleBaseUrl(owner: { readonly fiber: { readonly entry?: {
  readonly parent: { readonly tree: { readonly ctx: { readonly baseUrl?: string | undefined } } }
} } }): string | undefined { return owner.fiber.entry?.parent.tree.ctx.baseUrl }
