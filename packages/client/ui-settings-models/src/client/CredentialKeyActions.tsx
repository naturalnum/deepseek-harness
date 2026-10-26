/** Key-only actions over one page-owned preparation hook; no provider/profile mutation or credential storage owner. */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProviderEditor } from './ProviderEditor.tsx'
import type { ProviderEditorProps } from './ProviderEditor.tsx'
import type { ModelsCredentialEditing, PreparedCredentialEdit } from './operations.ts'
import styles from './ModelsSection.module.css'

interface Intent {
  readonly mode: 'store' | 'remove'
  readonly abort: AbortController
}
type View =
  | { readonly phase: 'closed' }
  | { readonly phase: 'opening'; readonly intent: Intent }
  | { readonly phase: 'ready'; readonly intent: Intent; readonly edit: PreparedCredentialEdit; readonly busy: boolean; readonly failure?: string }
  | { readonly phase: 'failed'; readonly message: string }

/** Original provider editor inputs and a page-lifetime key-only preparation callback. */
export interface CredentialKeyActionsProps extends Pick<ProviderEditorProps,
  'provider' | 'displayName' | 'namespace' | 'schema' | 'settingsPath' | 'operations' | 't'> {
  /** Exact native named reference; this component does not derive an approved ref from a provider id. */
  readonly reference: string
  /** Original page's preparation and liveness callbacks for this immutable UI scope. */
  readonly editing: ModelsCredentialEditing
  /** Original redacted configured fact, used only to offer removal. */
  readonly configured: boolean
  /** Refresh native metadata only after current-scope confirmed persistence. */
  readonly onSaved: () => void
}

/**
 * Prepare once when an edit/confirmation opens, then reuse the native credential-only editor or confirmation.
 * @param props Original native row and callbacks; the owner changes the React key when page scope changes.
 * @returns Key-only controls; no model/provider removal is performed.
 */
export function CredentialKeyActions(props: CredentialKeyActionsProps): ReactNode {
  const { t } = props
  const [owner] = useState(() => ({ open: true, binding: props.editing, intent: undefined as Intent | undefined }))
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
        setView({ phase: 'failed', message: t('keyEditUnavailable') }); return
      }
      const store = prepared.store, remove = prepared.remove
      const edit: PreparedCredentialEdit = Object.freeze({ ref: prepared.ref,
        store: async (value: string) => {
          if (!current(intent)) return t('keyEditUnavailable')
          const failure = await store(value)
          return current(intent) ? failure : t('keyEditUnavailable')
        },
        remove: async () => {
          if (!current(intent)) return t('keyEditUnavailable')
          const failure = await remove()
          return current(intent) ? failure : t('keyEditUnavailable')
        },
      })
      setView({ phase: 'ready', intent, edit, busy: false })
    }, () => { if (current(intent)) setView({ phase: 'failed', message: t('keyEditUnavailable') }) })
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
      if (current(selected.intent)) setView({ ...selected, busy: false, failure: t('keyEditUnavailable') })
    }
  }
  const selected = view.phase === 'ready' ? view : undefined
  const busy = view.phase === 'opening' || selected?.busy === true
  return <>
    <span className={styles['rowActions']}>
      <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={() => { open('store') }}>{t('editKey')}</button>
      {props.configured ? <button type="button" className={styles['dangerButton']} disabled={busy} onClick={() => { open('remove') }}>{t('removeKey')}</button> : null}
    </span>
    {view.phase === 'opening' ? <><p role="status">{t('keyPreparing')}</p>
      <button type="button" className={styles['secondaryButton']} onClick={close}>{t('cancel')}</button></> : null}
    {view.phase === 'failed' ? <p role="alert" className={styles['error']}>{view.message}</p> : null}
    {selected?.intent.mode === 'store' ? <ProviderEditor
      provider={props.provider} displayName={props.displayName} namespace={props.namespace} schema={props.schema}
      settingsPath={props.settingsPath} operations={props.operations} t={t} readOnly={false}
      credentialOnly credentialRequired credentialEdit={selected.edit}
      onBusyChange={observeBusy}
      onClose={(changed) => { if (!current(selected.intent)) return; close(); if (changed) props.onSaved() }}
    /> : null}
    <Modal open={selected?.intent.mode === 'remove'} title={t('removeKeyTitle')} description={t('removeKeyDescription')}
      closeLabel={t('close')} onClose={() => { if (selected?.busy !== true) close() }}
      footer={<><Button variant="outline" disabled={selected?.busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="outline" disabled={selected?.busy || selected?.failure !== undefined} onClick={() => { void remove() }}>
          {selected?.busy ? t('removingKey') : t('removeKey')}
        </Button></>}>
      {selected?.failure === undefined ? null : <p role="alert" className={styles['error']}>{selected.failure}</p>}
    </Modal>
  </>
}
