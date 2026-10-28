/** Current-account generated reads for the original native Settings pages. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type { PreparedCloudPage, CloudNativeSettingsCallbacks } from './prepared-page.ts'
import { observeCloudDisposal } from './observe-disposal.ts'
import { ClientFailure } from './errors.ts'

type NativeSettingsRemote = TypertClientRemote['cloudNativeSettings']

/** Bind the generated Remote once; no profile manager or raw configuration reader is available.
 * @param remote The original page's generated account-native Settings namespace.
 * @param input Captured page lifetime and explicit per-read deadline.
 * @returns Native page read callbacks; errors never fall back to global Host reads.
 */
export function createCloudNativeSettingsCallbacks(remote: NativeSettingsRemote, input: {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly assertCurrent: () => void
}): CloudNativeSettingsCallbacks {
  const inventory = remote.inventory.bind(remote), presets = remote.presets.bind(remote), readPreset = remote.readPreset.bind(remote)
  const request = async <T>(send: (signal: AbortSignal) => Promise<{ ok: true; value: T } | { ok: false }>): Promise<T> => {
    input.signal.throwIfAborted(); input.assertCurrent()
    const deadline = new AbortController(), timer = setTimeout(() => { deadline.abort() }, input.timeoutMs)
    const signal = AbortSignal.any([input.signal, deadline.signal])
    try {
      const result = await send(signal)
      signal.throwIfAborted(); input.assertCurrent()
      if (!result.ok) throw new ClientFailure('closed')
      return result.value
    } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    inventory: () => request(signal => inventory(signal)),
    presets: async () => {
      const roster = await request(signal => presets(signal))
      const result: Awaited<ReturnType<CloudNativeSettingsCallbacks['presets']>>[number][] = []
      // The native account owns the finite roster bound. Sequential reads keep this page within its original fetch budget.
      for (const row of roster.presets) {
        const composition = await request(signal => readPreset({ id: row.id }, signal))
        if (composition.id !== row.id || composition.isDefault !== row.isDefault) throw new ClientFailure('closed')
        result.push(Object.freeze({ ...composition,
          ...row.name === undefined ? {} : { name: row.name },
          ...row.description === undefined ? {} : { description: row.description },
        }))
      }
      return Object.freeze(result)
    },
  })
}

/** Install readonly Settings reads on the one original Cloud page.
 * @param ctx Original Cloud Loader scope after Connection activation.
 * @param page Captured page; omission of the explicit option keeps the integration absent.
 */
export function installCloudNativeSettings(ctx: Context, page: PreparedCloudPage): void {
  const timeoutMs = page.nativeSettingsRequestTimeoutMs, signal = page.lifetime.transport.signal
  const isAborted = (): boolean => signal.aborted
  if (timeoutMs === undefined || isAborted()) return
  const dependency = ctx.inject(['remote', 'remote.cloudNativeSettings'], (owner) => {
    signal.throwIfAborted()
    const callbacks = createCloudNativeSettingsCallbacks(owner.remote.cloudNativeSettings, { signal, timeoutMs,
      assertCurrent: () => { page.assertAccountManagementCurrent(owner) },
    })
    owner.effect(() => page.attachNativeSettings(owner, callbacks), 'pe-cloud-client: account-native Settings reads')
  })
  const stop = (): void => {
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud native Settings withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw readonly Settings integration')
  if (isAborted()) stop()
}
