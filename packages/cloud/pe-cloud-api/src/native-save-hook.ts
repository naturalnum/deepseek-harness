/** Bind reviewed native save submissions to the runtime-owned account barrier. */
import type { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type ConfigEditor from '@deepseek-ai/dsh-config-editor'
import type { ConfigSaveSubmissionHook } from '@deepseek-ai/dsh-config-editor'
import type { CredentialProvider, CredentialSaveSubmissionHook } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'
import type { ConfigSaveBarrier, ConfigSaveKind } from './save-hooks.ts'

function assertBinding(ctx: Context, barrier: ConfigSaveBarrier): void {
  if (ctx.get('peAccount') !== barrier.binding || ctx.root.get('peAccount') !== barrier.binding || barrier.binding.lifetime.aborted) {
    throw new CloudApiError('cloud/stale-generation', 'The native save context and configuration save barrier have different bindings.')
  }
}

function guardDisposal(barrier: ConfigSaveBarrier, dispose: () => Promise<void>): () => Promise<void> {
  return async () => {
    const state = barrier.snapshot()
    if (state.admission !== 'stopped' || state.pending.length !== 0 || state.failures.length !== 0) {
      throw new CloudApiError('cloud/config-busy', 'Native configuration save hooks still own work or unresolved evidence.')
    }
    await dispose()
  }
}

function admit<T>(ctx: Context, barrier: ConfigSaveBarrier, kind: ConfigSaveKind, submit: () => Promise<T>): Promise<T> {
  assertBinding(ctx, barrier)
  return barrier.admit(kind, () => {
    assertBinding(ctx, barrier)
    return submit()
  })
}

function bindEditorSaveHook(
  ctx: Context, barrier: ConfigSaveBarrier, editor: ConfigEditor, kindOf: (writer: string) => ConfigSaveKind,
  liveOnly = false,
): () => Promise<void> {
  assertBinding(ctx, barrier)
  const scopes = new AsyncLocalStorage<{ planSeen: boolean }>()
  const impact = liveOnly ? editor.registerImpactGuard({ check() {
    assertBinding(ctx, barrier)
    const scope = scopes.getStore()
    if (scope !== undefined) scope.planSeen = true
  } }) : undefined
  const hook: ConfigSaveSubmissionHook = {
    submit<T>(writer: string, submit: () => Promise<T>): Promise<T> {
      const kind = kindOf(writer)
      if (!liveOnly) return admit(ctx, barrier, kind, submit)
      // The installed native guarded path performs no replacement or reconcile before its plan check.
      const result = admit(ctx, barrier, kind, () => scopes.run({ planSeen: false }, async () => {
        try { return { ok: true as const, value: await submit() } }
        catch (error) {
          const outcome = editor.editFailureOutcome(error)
          if (outcome === 'not-published') return { ok: false as const, error }
          if (outcome === 'unknown') throw new ConfigSaveOutcomeUnknown({ cause: error })
          if (writer === 'settings/write' && error instanceof SettingsConflictError) {
            if (scopes.getStore()?.planSeen === false) return { ok: false as const, error }
            throw new ConfigSaveOutcomeUnknown()  // A post-plan exception cannot certify a zero-write revision refusal.
          }
          throw error
        }
      }))
      return result.then((value) => {
        if (!value.ok) throw value.error  // The no-write refusal follows settlement of its original serial turn.
        return value.value
      })
    },
  }
  const dispose = editor.registerSaveHook(hook)
  return guardDisposal(barrier, async () => {
    await dispose()
    await impact?.()
    scopes.disable()
  })
}

function requireEditor(ctx: Context, barrier: ConfigSaveBarrier): ConfigEditor {
  assertBinding(ctx, barrier)
  const editor = ctx.get('configEditor')
  if (editor === undefined) {
    throw new CloudApiError('cloud/account-unavailable', 'The account native configuration editor is not mounted.')
  }
  return editor
}

function unreviewedWriter(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The native configuration writer has not been reviewed.')
}

/**
 * Protect the verified native writer before its private queue. Other native
 * writers stay rejected until their actual submission points are instrumented.
 * Runtime must drain saves before unloading the hook's owning fiber.
 * @param ctx - runtime's bound account context with the native editor.
 * @param barrier - this generation's runtime-owned save barrier.
 * @returns a disposer that refuses withdrawal before terminal confirmed quiescence.
 */
export function installNativeDefaultModelSaveHook(ctx: Context, barrier: ConfigSaveBarrier): () => Promise<void> {
  return bindEditorSaveHook(ctx, barrier, requireEditor(ctx, barrier),
    writer => writer === 'agent-default-model/saveSelection' ? 'default-model' : unreviewedWriter())
}

/**
 * Install the editor hook for default-model, Settings writes/legacy rename and direct edits.
 * Choose this or the default-model-only installer, never both on the same editor.
 * Runtime must install before enabling writers, retain the calling fiber through
 * terminal quiescence, and separately account for initialization before installation.
 * @param ctx - caller in the independent account root with its native editor.
 * @param barrier - the same runtime barrier used by this graph's credential hook.
 * @returns disposer requiring terminal, failure-free quiescence.
 */
export function installNativeConfigSaveHook(ctx: Context, barrier: ConfigSaveBarrier): () => Promise<void> {
  return bindNativeConfigSaveHook(ctx, barrier, requireEditor(ctx, barrier))
}

/**
 * Bind the reviewed editor hook to its actual constructor receiver before consumers activate.
 * @param ctx - native receiver's owning account fiber.
 * @param barrier - exact graph save barrier, retained through terminal quiescence.
 * @param editor - actual native editor, including a receiver not yet published as ready.
 * @returns the same terminal-confirmed guarded hook disposer.
 */
export function bindNativeConfigSaveHook(ctx: Context, barrier: ConfigSaveBarrier, editor: ConfigEditor): () => Promise<void> {
  return bindEditorSaveHook(ctx, barrier, editor, (writer) => {
    switch (writer) {
      case 'agent-default-model/saveSelection': return 'default-model'
      case 'settings/write':
      case 'settings/legacyRename': return 'settings'
      case 'config-editor/edit': return 'config-editor'
      default: return unreviewedWriter()
    }
  }, true)
}

/**
 * Observe provider-instrumented set/unset/modify-record/delete-record operations.
 * Only the local provider's actual writers have been verified. Registration does
 * not cover another provider, earlier initial migration, or watch work. Runtime must retain
 * the calling fiber through terminal quiescence; no secret metadata is retained.
 * @param ctx - caller in the independent account root with its credential provider.
 * @param barrier - the same runtime barrier used by this graph's editor hook.
 * @returns disposer requiring terminal, failure-free quiescence.
 */
export function installNativeCredentialSaveHook(ctx: Context, barrier: ConfigSaveBarrier): () => Promise<void> {
  assertBinding(ctx, barrier)
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new CloudApiError('cloud/account-unavailable', 'The account native credential provider is not mounted.')
  }
  return bindNativeCredentialSaveHook(ctx, barrier, credentials)
}

/**
 * Bind the native credential receiver during construction, before Service.init migration.
 * @param ctx - receiver's owning account fiber, never a temporary HTTP borrow.
 * @param barrier - exact graph save barrier shared with the editor.
 * @param credentials - actual instrumented native receiver; this does not instrument other providers.
 * @returns the terminal-confirmed guarded disposer; runtime retains the fiber until actual settlement.
 */
export function bindNativeCredentialSaveHook(
  ctx: Context, barrier: ConfigSaveBarrier, credentials: CredentialProvider,
): () => Promise<void> {
  assertBinding(ctx, barrier)
  const hook: CredentialSaveSubmissionHook = {
    submit: (operation, submit) => {
      assertBinding(ctx, barrier)
      return barrier.admitCredentialSave(operation, () => {
        assertBinding(ctx, barrier)
        return submit()
      })
    },
  }
  return guardDisposal(barrier, credentials.registerSaveHook(hook))
}
