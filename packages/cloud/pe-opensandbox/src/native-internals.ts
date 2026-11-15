/** Native identity reads used by this plugin's existing owners. */
import { symbols } from '@deepseek-ai/cordis'

/** Read a Native proxy target without adding ownership or fallback policy.
 * @param value Borrowed Native object or function.
 * @returns Its original target, or undefined without a Native proxy target.
 */
export function nativeOriginal(value: object): unknown { return Reflect.get(value, symbols.original) }
