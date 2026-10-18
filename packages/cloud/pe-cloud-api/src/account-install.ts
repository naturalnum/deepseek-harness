/** Private prepare-time installation of account exposure and two native save-hook owners. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { createAccountExposure } from './account-exposure.ts'
import { CloudApiError } from './errors.ts'
import type { ExposurePolicy } from './exposure.ts'
import { bindNativeConfigSaveHook, bindNativeCredentialSaveHook } from './native-save-hook.ts'
import type { ConfigSaveBarrier, ConfigSaveReceipt } from './save-hooks.ts'
import type { ExposureManifest } from './types.ts'

/** Private structural result retained by trusted account assembly, never Loader JSON or a ready certificate. */
export interface AccountApiInstall {
  /** Exact installed binding shared with the root-issued barrier. */
  readonly binding: AccountBinding
  /** Unaudited graph view; only actual native handler/guard inventory may audit it. */
  readonly exposure: ExposurePolicy
  /** Fixed native editor subclass; preserve its original Config and inject dependencies. */
  readonly configEditor: typeof ConfigEditor
  /** Fixed native local provider subclass; requires an explicit absolute path and watch=false. */
  readonly credentials: typeof LocalCredentialProvider
  /** @param owner Owning graph scope; rejects withdrawal, a closed fiber or a different installed binding. */
  assertInstalled(owner: Context): void
  /**
   * Pause top-level configuration submissions, retaining actual admitted work.
   * @param deadlineAtMs - finite absolute server observation deadline.
   * @param signal - observer cancellation only.
   * @returns the existing save barrier's actual-work evidence.
   */
  pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>
  /** Reopen only after runtime's actual re-audit; the barrier still enforces paused, quiescent, failure-free state. */
  resumeAccountChanges(): void
  /**
   * Permanently close this generation's configuration submission admission.
   * @param deadlineAtMs - finite absolute observation deadline.
   * @param signal - observer cancellation, never cancellation of submitted native writes.
   * @returns the existing barrier receipt, retaining pending work and failures on unknown.
   */
  stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>
  /**
   * Close installation and withdraw hooks only after terminal, failure-free actual settlement.
   * Native Loader initialization must also settle before hooks are removed.
   * This neither disposes the account Context nor releases its root coordinator slot.
   * @returns the retained actual withdrawal Promise; rejection leaves installation closed.
   */
  withdraw(): Promise<void>
}

/**
 * Prepare graph-local exposure and native constructor hooks before Loader activation.
 * Binding installation is checked without calling graph/mount-current admission:
 * startup saves may run while external business remains closed. The provided
 * barrier must be root-issued for this exact installed binding. This function
 * mounts no provider, audits no inventory, and opens no account entry. Runtime
 * must retain this handle/fibers through pending or failed initialization work.
 * @param ctx - owning prepare fiber in the independent installed account graph.
 * @param binding - exact installed runtime graph binding.
 * @param assertGraphCurrent - runtime graph/mount-current for exposure audit; restricted mounting is allowed,
 * while closed or stale graphs are rejected.
 * Business-ready remains an independent Controller/LLM/AccountUse check.
 * @param rootExposure - deployment-owned immutable exposure ceiling.
 * @param selected - graph selection, never an inventory or readiness assertion.
 * @param saves - the root coordinator's sole barrier issued for binding.
 * @returns the fixed native constructors and private save-control/withdrawal handle.
 * @throws CloudApiError if graph/barrier bindings differ; native hook/configuration errors retain identity.
 */
export function prepareAccountApiInstall(
  ctx: Context,
  binding: AccountBinding,
  assertGraphCurrent: (binding: AccountBinding) => void,
  rootExposure: ExposurePolicy,
  selected: ExposureManifest,
  saves: ConfigSaveBarrier,
): AccountApiInstall {
  let editorHook: (() => Promise<void>) | undefined
  let credentialHook: (() => Promise<void>) | undefined
  let withdrawal: Promise<void> | undefined

  const assertInstalled = (owner: Context): void => {
    if (saves.binding !== binding || binding.lifetime.aborted || owner.root !== ctx.root
      || owner.get('peAccount') !== binding || owner.root.get('peAccount') !== binding
      || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The account API installation and save barrier have different graph bindings.')
    }
    ctx.fiber.assertActive()
    owner.fiber.assertActive()
    if (withdrawal !== undefined) {
      throw new CloudApiError('cloud/account-unavailable', 'The account API installation has been withdrawn.')
    }
  }
  assertInstalled(ctx)
  const loader = ctx.get('loader')
  if (loader === undefined) {
    throw new CloudApiError('cloud/account-unavailable', 'Account API installation requires the native Loader prepare context.')
  }
  const exposure = createAccountExposure(ctx, binding, assertGraphCurrent, rootExposure, selected)

  class AccountConfigEditor extends ConfigEditor {
    static override inject = [...ConfigEditor.inject, 'peAccount']

    constructor(owner: Context) {
      assertInstalled(owner)
      if (editorHook !== undefined) throw new CloudApiError('cloud/invalid-config', 'This account API installation already owns its editor.')
      super(owner)
      editorHook = bindNativeConfigSaveHook(owner, saves, this)
    }
  }

  class AccountCredentials extends LocalCredentialProvider {
    static inject = ['peAccount']

    constructor(owner: Context, config: ConstructorParameters<typeof LocalCredentialProvider>[1]) {
      assertInstalled(owner)
      if (credentialHook !== undefined) {
        throw new CloudApiError('cloud/invalid-config', 'This account API installation already owns its credential provider.')
      }
      if (config.path === undefined || !isAbsolute(config.path) || config.watch !== false) {
        throw new CloudApiError('cloud/invalid-config', 'Account credentials require an explicit absolute path and disabled watch.')
      }
      super(owner, config)
      credentialHook = bindNativeCredentialSaveHook(owner, saves, this)
    }
  }

  return Object.freeze({
    binding, exposure, configEditor: AccountConfigEditor, credentials: AccountCredentials, assertInstalled,
    pauseAccountChanges: (deadlineAtMs: number, signal?: AbortSignal) => saves.pauseAccountChanges(deadlineAtMs, signal),
    resumeAccountChanges: () => { saves.resumeAccountChanges() },
    stopConfigSaves: (deadlineAtMs: number, signal?: AbortSignal) => saves.stopConfigSaves(deadlineAtMs, signal),
    withdraw(): Promise<void> {
      if (withdrawal !== undefined) return withdrawal
      const state = saves.snapshot()
      if (state.admission !== 'stopped' || state.pending.length !== 0 || state.failures.length !== 0) {
        return Promise.reject(new CloudApiError('cloud/config-busy', 'Account API save hooks still own work or unresolved evidence.'))
      }
      exposure.invalidate()
      withdrawal = Promise.resolve().then(async () => {
        // A provider may still be reading its initial document before it submits its first save.
        await loader.await()
        const actual = saves.snapshot()
        if (actual.admission !== 'stopped' || actual.pending.length !== 0 || actual.failures.length !== 0) {
          throw new CloudApiError('cloud/config-busy', 'Account API initialization still owns save work or unresolved evidence.')
        }
        await editorHook?.()
        await credentialHook?.()
      })
      return withdrawal
    },
  })
}
