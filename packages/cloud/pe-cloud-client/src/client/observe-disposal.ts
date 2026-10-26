/** Promise observation for original single-shot Cordis disposal invocations. */
import type { Disposable } from '@deepseek-ai/cordis'

/**
 * Invoke disposal synchronously and observe its returned work with await semantics.
 * @param dispose Original disposer; a retired single-shot effect may return void.
 * @returns This invocation's settlement; the native owner still joins its complete graph cleanup.
 */
export async function observeCloudDisposal(dispose: Disposable<void | Promise<void>>): Promise<void> {
  await dispose()
}
