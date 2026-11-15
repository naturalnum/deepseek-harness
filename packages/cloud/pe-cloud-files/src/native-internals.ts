/** Native identity reads used by this plugin's existing owners. */
import { symbols, type Context } from '@deepseek-ai/cordis'

type NativeFibers = NonNullable<ReturnType<Context['registry']['get']>>['fibers']

/** Read a Native proxy target without adding ownership or fallback policy.
 * @param value Borrowed Native object or function.
 * @returns Its original target, or undefined without a Native proxy target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }

/** Read the original registered runtime fibers for an exact installed plugin.
 * @param ctx Actual account Context.
 * @param plugin Original Native registry key.
 * @returns Its live Native fiber list, or undefined when no runtime is registered.
 */
export function nativePluginFibers(ctx: Context, plugin: Parameters<Context['registry']['get']>[0]): NativeFibers | undefined {
  return ctx.registry.get(plugin)?.fibers
}
