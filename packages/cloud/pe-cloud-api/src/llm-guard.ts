/** Actual native LLM dispatch admission, shared by ordinary and prepared calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'

/**
 * Register on the account's real llm/stream waterfall. The lifetime is the
 * registering fiber; request options, including deep-frozen Loop input, stay unchanged.
 * @param ctx - account context with its isolated native LLM service.
 * @param binding - runtime-owned graph lifetime, independent of a request borrow.
 * @param assertCurrent - runtime's generation admission check, never a request identity.
 * @param allowed - the same provider/model set used by selection and catalog projection.
 * @returns the Cordis listener disposer.
 */
export function installActualLlmGuard(
  ctx: Context,
  binding: AccountBinding,
  assertCurrent: (binding: AccountBinding) => void,
  allowed: (provider: string, model: string) => boolean,
): () => void {
  return ctx.on('llm/stream', async function* (options, next) {
    if (binding.lifetime.aborted) {
      throw new CloudApiError('cloud/stale-generation', 'Account generation lifetime has ended.')
    }
    assertCurrent(binding)
    if (!allowed(options.provider, options.model)) {
      throw new CloudApiError('cloud/model-not-allowed', 'The model route is not approved for this account.')
    }
    yield* next()
  })
}
