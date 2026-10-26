/** Original generated Remote -> native Models callbacks; no credential store or version cache. */
import { observeCloudDisposal } from './observe-disposal.ts'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type {} from '@deepseek-ai/dsh-pe-cloud-api'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PreparedCloudPage, CloudModelSettingsCallbacks } from './prepared-page.ts'
import { ClientFailure } from './errors.ts'
import { MODEL_SETTINGS_NAMESPACE, modelSettingsDictionaries, type ModelSettingsKey } from './model-settings-locales.ts'

type ModelRemote = TypertClientRemote['cloudModelKey']
type NativeReference = Parameters<ModelRemote['describe']>[0]['ref']
type SaveAnswer = Awaited<ReturnType<ModelRemote['set']>>

// Treat the wire acknowledgement as runtime input even when its declared type is the literal true.
const confirmsPersistence = (value: unknown): boolean => value === true

/** Original page/owner admission and one explicit observer deadline. */
export interface ModelSettingsCallInput {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly assertCurrent: () => void
  readonly t: (key: ModelSettingsKey) => string
}

/**
 * Bind the actual generated namespace once; metadata never replaces an opened intent's version or callbacks.
 * @param remote Original native namespace after its generated contribution mounts.
 * @param input Original page/dependency checks, lifetime, finite deadline and typed localized feedback.
 * @returns Public native Models read/prepare callbacks; the original page owns their publication and revocation.
 */
export function createCloudModelSettingsCallbacks(remote: ModelRemote, input: ModelSettingsCallInput): CloudModelSettingsCallbacks {
  const metadata = remote.metadata.bind(remote), describe = remote.describe.bind(remote)
  const set = remote.set.bind(remote), unset = remote.unset.bind(remote)
  const request = async <T>(send: (signal: AbortSignal) => Promise<T>, observer?: AbortSignal): Promise<T> => {
    input.assertCurrent(); input.signal.throwIfAborted(); observer?.throwIfAborted()
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new ClientFailure('closed')) }, input.timeoutMs)
    try {
      const signal = AbortSignal.any([input.signal, deadline.signal, ...observer === undefined ? [] : [observer]])
      const response = await send(signal)
      signal.throwIfAborted(); input.assertCurrent()
      return response
    } finally { clearTimeout(timer) }
  }
  const save = async (send: (signal: AbortSignal) => Promise<SaveAnswer>): Promise<string | undefined> => {
    try {
      const answer = await request(send)
      if (!answer.ok) return input.t(answer.error.code === 'cloud/config-conflict' ? 'conflict' : 'unavailable')
      return confirmsPersistence(answer.value.persisted) ? undefined : input.t('unavailable')
    } catch { return input.t('unavailable') }
  }
  return Object.freeze({
    metadata: async () => {
      const answer = await request(signal => metadata(signal))
      if (!answer.ok) throw new ClientFailure('closed')
      return answer.value
    },
    credentials: async (refs: readonly string[]) => {
      const facts: Record<string, CredentialInfo> = {}
      for (const ref of refs) {
        const answer = await request(signal => describe({ ref: brandString<NativeReference>(ref) }, signal))
        if (!answer.ok || answer.value.ref !== ref) throw new ClientFailure('closed')
        const { configured, writable, source } = answer.value
        facts[ref] = { configured, writable, ...source === undefined ? {} : { source } }
      }
      return facts
    },
    prepare: async (ref: string, signal: AbortSignal) => {
      const reference = brandString<NativeReference>(ref)
      const answer = await request(observer => describe({ ref: reference }, observer), signal)
      if (!answer.ok || answer.value.ref !== ref || !answer.value.writable) return null
      const version = Object.freeze({ epoch: answer.value.version.epoch, editToken: answer.value.version.editToken })
      return Object.freeze({ ref,
        store: (value: string) => save(observer => set({ ref: reference, value, version }, observer)),
        remove: () => save(observer => unset({ ref: reference, version }, observer)),
      })
    },
  })
}

/**
 * Consume the owning package's existing generated contribution and attach to the original immutable page.
 * @param ctx Original Cloud Loader fiber after its captured Connection activation.
 * @param page Original PreparedCloudPage; omission of its explicit deadline keeps this integration closed.
 */
export function installCloudModelSettings(ctx: Context, page: PreparedCloudPage): void {
  const timeoutMs = page.modelSettingsRequestTimeoutMs, signal = page.lifetime.transport.signal
  const isAborted = (): boolean => signal.aborted
  if (timeoutMs === undefined || isAborted()) return
  // Projects owns the package's single generated contribution mount; this dependency consumes that same namespace.
  const dependency = ctx.inject(['remote', 'remote.cloudModelKey', 'locale'], (scope) => {
    signal.throwIfAborted()
    scope.effect(() => scope.locale.register(MODEL_SETTINGS_NAMESPACE, modelSettingsDictionaries), 'pe-cloud-client: model settings dictionaries')
    const callbacks = createCloudModelSettingsCallbacks(scope.remote.cloudModelKey, { signal, timeoutMs,
      t: scope.locale.bind(MODEL_SETTINGS_NAMESPACE),
      assertCurrent: () => { scope.fiber.assertActive(); signal.throwIfAborted() },
    })
    scope.effect(() => page.attachModels(scope, callbacks), 'pe-cloud-client: captured model settings binding')
  })
  const stop = (): void => {
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud model settings withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw original model settings contribution')
  if (isAborted()) stop()
}
