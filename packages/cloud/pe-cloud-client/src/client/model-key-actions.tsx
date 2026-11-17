/** Key-only actions over one page-owned preparation hook; no provider/profile mutation or credential storage owner. */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelsCredentialActionsOwnerProps, PreparedCredentialEdit } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { PropsRenderFactories, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MODEL_CREDENTIAL_NAMESPACE, modelKeyActionDictionaries } from './locales/model-credentials.ts'
import styles from './model-key-actions.module.css'


interface Intent {
  readonly mode: 'store' | 'remove'
  readonly abort: AbortController
}
type View =
  | { readonly phase: 'closed' }
  | { readonly phase: 'opening'; readonly intent: Intent }
  | { readonly phase: 'ready'; readonly intent: Intent; readonly edit: PreparedCredentialEdit; readonly busy: boolean; readonly failure?: string }
  | { readonly phase: 'failed'; readonly message: string }

/** Original row data, framework Factory seat and Cloud-owned locale. */
type CredentialKeyActionsProps = ModelsCredentialActionsOwnerProps
  & PropsRenderFactories & PropsLocale<typeof MODEL_CREDENTIAL_NAMESPACE>

/**
 * A new original page scope or reference retires the complete mounted intent.
 * @param props Original row data and framework-owned render/locale seats.
 * @returns One Cloud-owned key-action occurrence.
 */
export function CloudCredentialKeyActions(props: CredentialKeyActionsProps): ReactNode {
  return <CredentialKeyActions key={props.scope + ':' + props.reference} {...props}/>
}

/**
 * Prepare once when an edit/confirmation opens, then reuse the native credential-only editor or confirmation.
 * @param props Original native row and callbacks; the owner changes the React key when page scope changes.
 * @returns Key-only controls; no model/provider removal is performed.
 */
function CredentialKeyActions(props: CredentialKeyActionsProps): ReactNode {
  const { t: copy, renderFactorySlot } = props
  const [owner] = useState(() => ({ open: true, binding: { isCurrent: props.isCurrent, prepare: props.prepare },
    intent: undefined as Intent | undefined }))
  const [view, setView] = useState<View>({ phase: 'closed' })
  useEffect(() => {
    owner.open = true
    return () => { owner.open = false; owner.intent?.abort.abort(); owner.intent = undefined }
  }, [owner])
  const current = (intent: Intent): boolean => {
    if (!owner.open || owner.intent !== intent || intent.abort.signal.aborted) return false
    let valid = false
    try { valid = owner.binding.isCurrent() } catch { /* Revoked page guards remain closed. */ }
    if (!valid) {
      intent.abort.abort(); owner.intent = undefined
      setView({ phase: 'closed' })
    }
    return valid
  }
  const observeBusy = useCallback((busy: boolean): void => {
    const intent = owner.intent
    if (!owner.open || intent === undefined || intent.abort.signal.aborted) return
    setView(state => state.phase !== 'ready' || state.intent !== intent || state.busy === busy ? state : { ...state, busy })
  }, [owner])
  const close = (): void => {
    owner.intent?.abort.abort(); owner.intent = undefined
    setView({ phase: 'closed' })
  }
  const open = (mode: Intent['mode']): void => {
    if (view.phase === 'opening' || view.phase === 'ready' && view.busy) return
    owner.intent?.abort.abort()
    const intent: Intent = { mode, abort: new AbortController() }
    owner.intent = intent
    if (!current(intent)) { close(); return }
    setView({ phase: 'opening', intent })
    void Promise.resolve().then(() =>
      current(intent) ? owner.binding.prepare(props.reference, intent.abort.signal) : null).then((prepared) => {
      if (!current(intent)) return
      if (prepared === null || prepared.ref !== props.reference) {
        setView({ phase: 'failed', message: copy('keyEditUnavailable') }); return
      }
      const store = prepared.store, remove = prepared.remove
      const edit: PreparedCredentialEdit = Object.freeze({ ref: prepared.ref,
        store: async (value: string) => {
          if (!current(intent)) return copy('keyEditUnavailable')
          const failure = await store(value)
          return current(intent) ? failure : copy('keyEditUnavailable')
        },
        remove: async () => {
          if (!current(intent)) return copy('keyEditUnavailable')
          const failure = await remove()
          return current(intent) ? failure : copy('keyEditUnavailable')
        },
      })
      setView({ phase: 'ready', intent, edit, busy: false })
    }, () => { if (current(intent)) setView({ phase: 'failed', message: copy('keyEditUnavailable') }) })
  }
  const remove = async (): Promise<void> => {
    if (view.phase !== 'ready' || view.busy || view.failure !== undefined || !current(view.intent)) return
    const selected = view
    setView({ ...selected, busy: true })
    try {
      const failure = await selected.edit.remove()
      if (!current(selected.intent)) return
      if (failure !== undefined) { setView({ ...selected, busy: false, failure }); return }
      close(); props.onSaved()
    } catch {
      if (current(selected.intent)) setView({ ...selected, busy: false, failure: copy('keyEditUnavailable') })
    }
  }
  const selected = view.phase === 'ready' ? view : undefined
  const busy = view.phase === 'opening' || selected?.busy === true
  return <>
    <span className={styles['rowActions']}>
      <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={() => { open('store') }}>{copy('editKey')}</button>
      {props.configured ? <button type="button" className={styles['dangerButton']} disabled={busy} onClick={() => { open('remove') }}>{copy('removeKey')}</button> : null}
    </span>
    {view.phase === 'opening' ? <><p role="status">{copy('keyPreparing')}</p>
      <button type="button" className={styles['secondaryButton']} onClick={close}>{copy('cancel')}</button></> : null}
    {view.phase === 'failed' ? <p role="alert" className={styles['error']}>{view.message}</p> : null}
    {selected?.intent.mode === 'store' ? renderFactorySlot('settings.models.provider-editor', {
      provider: props.provider, displayName: props.displayName, namespace: props.namespace,
      settingsPath: props.settingsPath, readOnly: false,
      credentialOnly: true, credentialRequired: true, credentialEdit: selected.edit,
      credentialUnavailable: () => copy('keyEditUnavailable'), onBusyChange: observeBusy,
      onClose: (changed) => { if (!current(selected.intent)) return; close(); if (changed) props.onSaved() },
    }) : null}
    <Modal open={selected?.intent.mode === 'remove'} title={copy('removeKeyTitle')} description={copy('removeKeyDescription')}
      closeLabel={copy('close')} onClose={() => { if (selected?.busy !== true) close() }}
      footer={<><Button variant="outline" disabled={selected?.busy} onClick={close}>{copy('cancel')}</Button>
        <Button variant="outline" disabled={selected?.busy || selected?.failure !== undefined} onClick={() => { void remove() }}>
          {selected?.busy ? copy('removingKey') : copy('removeKey')}
        </Button></>}>
      {selected?.failure === undefined ? null : <p role="alert" className={styles['error']}>{selected.failure}</p>}
    </Modal>
  </>
}


/**
 * Contribute key-only controls while the original Cloud page and Native slot/locale remain live.
 * @param ctx Original Cloud entry scope; owns the optional contribution.
 * @param signal Original page lifetime; abortion withdraws synchronously.
 */
export function installCloudModelKeyActions(ctx: Context, signal: AbortSignal): void {
  if (signal.aborted) return
  ctx.inject(['slots', 'locale'], (owner) => {
    if (signal.aborted) return
    const removeCopy = owner.locale.register(MODEL_CREDENTIAL_NAMESPACE, modelKeyActionDictionaries)
    const removeSlot = owner.slots.inject('settings.models.provider.credentials', () => owner.slots.register({
      name: 'settings.models.provider.credentials', locale: MODEL_CREDENTIAL_NAMESPACE,
    }, CloudCredentialKeyActions))
    let live = true
    const withdraw = (): void => {
      if (!live) return
      live = false; removeSlot(); removeCopy()
    }
    signal.addEventListener('abort', withdraw, { once: true })
    owner.effect(() => () => { signal.removeEventListener('abort', withdraw); withdraw() }, 'Cloud model key action lifetime')
  })
}
