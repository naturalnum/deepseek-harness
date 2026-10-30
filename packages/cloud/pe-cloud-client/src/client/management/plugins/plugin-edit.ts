/** One explicit account edit over the actual generated cloudPlugins namespace; the backend keeps save ownership. */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { ClientFailure } from '../../errors.ts'
import { pluginLiteralDraft, pluginFieldPolicy, samePluginPath } from './plugin-schema.ts'

/** The actual approved namespace, without raw native PluginManager methods. */
export type CloudPluginRemote = TypertClientRemote['cloudPlugins']
type Current = Extract<Awaited<ReturnType<CloudPluginRemote['current']>>, { ok: true }>['value']
type ChangeRequest = Parameters<CloudPluginRemote['change']>[0]
type ChangeResult = Extract<Awaited<ReturnType<CloudPluginRemote['change']>>, { ok: true }>['value']
/** Qualified native read facts; the opaque edit token stays inside its captured submission callback. */
export type AccountPluginEditState = Omit<Current, 'version'>
/** Application and accepted rebuild remain distinct; neither a conflict nor observer loss triggers retry. */
export type AccountPluginEditOutcome =
  | { readonly kind: 'applied'; readonly state: AccountPluginEditState; readonly native?: Extract<ChangeResult, { kind: 'applied' }>['native'] }
  | Extract<ChangeResult, { kind: 'accepted-rebuild' }>
  | { readonly kind: 'busy' | 'conflict' | 'unknown' }
/** Original page/Connection admission and transport revocation, supplied by its existing owner. */
export interface AccountPluginEditAdmission {
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
}
/** An explicit original read and one submission attempt; changing metadata does not renew this edit. */
export interface PreparedAccountPluginEdit {
  readonly state: AccountPluginEditState
  /**
   * @param operation One operation and ordinary field path authorized by this original read.
   * @param mode Explicit caller choice; this adapter never escalates an idle refusal to a terminal rebuild.
   * @param observer Current interaction cancellation, without claiming backend rollback.
   * @returns Actual backend outcome, or busy/conflict/unknown; the attempt is consumed even when observation fails.
   * @throws ClientFailure when this edit's submission attempt was already consumed.
   */
  readonly submit: (operation: ChangeRequest['operation'], mode: ChangeRequest['mode'], observer: AbortSignal) => Promise<AccountPluginEditOutcome>
}

/**
 * Read through the original namespace once and capture its original opaque edit version.
 * @param remote Actual traced generated namespace mounted on the original Connection.
 * @param id Identity admitted by the original page bootstrap.
 * @param admission Existing page/owner checks; this adapter creates no transport, queue or save owner.
 * @param observer This explicit edit's lifetime, retained through its one submission attempt.
 * @returns Captured native state and a one-attempt callback; no eager publication or automatic retry.
 * @throws Error when the original read or page/interaction admission is unavailable; no edit is issued.
 */
export async function prepareAccountPluginEdit(remote: CloudPluginRemote, id: string, admission: AccountPluginEditAdmission,
  observer: AbortSignal): Promise<PreparedAccountPluginEdit> {
  admission.assertCurrent(); admission.signal.throwIfAborted(); observer.throwIfAborted()
  const current = remote.current.bind(remote), change = remote.change.bind(remote)
  const request = async <T>(send: (signal: AbortSignal) => Promise<T>, operationObserver: AbortSignal): Promise<T> => {
    admission.assertCurrent()
    const signal = AbortSignal.any([admission.signal, observer, operationObserver])
    signal.throwIfAborted()
    const answer = await send(signal)
    signal.throwIfAborted(); admission.assertCurrent()
    return answer
  }
  const reference = Object.freeze({ id })
  const answer = await request(signal => current(reference, signal), observer)
  // The original Gateway folds carrier failures into this exact endpoint-scoped error.
  if (!answer.ok && answer.error.code === 'gateway/internal'
    && answer.error.message === 'client api: cloudPlugins/current failed: cloud client plugin-management-unavailable') {
    throw new ClientFailure('plugin-management-unavailable')
  }
  if (!answer.ok || answer.value.id !== id) throw new ClientFailure('closed')
  const version = Object.freeze({ epoch: answer.value.version.epoch, editToken: answer.value.version.editToken })
  const state = visibleState(answer.value)
  let used = false
  return Object.freeze({ state,
    submit: async (operation: ChangeRequest['operation'], mode: ChangeRequest['mode'], signal: AbortSignal): Promise<AccountPluginEditOutcome> => {
      if (used) throw new ClientFailure('closed')
      used = true
      if (!state.operations.includes(operation.kind)
        || operation.kind === 'enabled' && state.selectionTarget.kind !== 'entry'
        || operation.kind === 'selected' && state.selectionTarget.kind !== 'bundle'
        || operation.kind === 'configure' && !state.configuration.fields.some(field => samePluginPath(field.path, operation.path) && pluginFieldPolicy(field).writable)) {
        throw new ClientFailure('closed')
      }
      const ownedOperation: ChangeRequest['operation'] = operation.kind === 'configure'
        ? { kind: 'configure', path: [...operation.path], value: pluginLiteralDraft(operation.value) }
        : { ...operation }
      try {
        const result = await request(observer => change({ ...reference, version, operation: ownedOperation, mode }, observer), signal)
        if (!result.ok) return { kind: result.error.code === 'cloud/config-conflict' ? 'conflict'
          : result.error.code === 'cloud/config-busy' ? 'busy' : 'unknown' }
        switch (result.value.kind) {
          case 'accepted-rebuild': return result.value
          case 'applied':
            if (result.value.value.id !== id) return { kind: 'unknown' }
            return { kind: 'applied', state: visibleState(result.value.value),
              ...result.value.native === undefined ? {} : { native: result.value.native } }
          default: return assertNever(result.value)
        }
      } catch { return { kind: 'unknown' } }
    },
  })
}

function visibleState(value: Current): AccountPluginEditState {
  switch (value.selectionTarget.kind) {
    case 'entry':
      if (value.plugin === undefined || value.bundle !== undefined || value.plugin.entryId !== value.selectionTarget.id) {
        throw new ClientFailure('closed')
      }
      break
    case 'bundle':
      if (value.bundle === undefined || value.plugin !== undefined || value.bundle.name !== value.selectionTarget.name) {
        throw new ClientFailure('closed')
      }
      break
    default: return assertNever(value.selectionTarget)
  }
  return Object.freeze({ id: value.id,
    ...value.plugin === undefined ? {} : { plugin: value.plugin },
    ...value.bundle === undefined ? {} : { bundle: value.bundle }, selectionTarget: value.selectionTarget,
    operations: Object.freeze([...value.operations]), ...value.maxImpact === undefined ? {} : { maxImpact: value.maxImpact },
    configuration: Object.freeze({ fields: Object.freeze(value.configuration.fields.map((field) => {
      if (!pluginFieldPolicy(field).secret) return field
      const { value: _concealed, ...metadata } = field
      return Object.freeze(metadata)
    })) }) })
}
