/** Title-only project creation in the native Workspace directory-flow slots. */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

import type {} from './locales.ts'

/** Slot injection contains only the allocation action and localized copy. */
export interface CloudProjectFlowInjected {
  /** Allocate once and return the original native Workspace path; unknown outcomes must not be replayed. */
  readonly createProject: (title: string, signal: AbortSignal) => Promise<string>
  readonly t: TranslateNS<'cloud-projects'>
}

/**
 * Collect a display title, then let the native owner adopt the returned directory.
 * @param props Original directory-flow conversation and account-fixed allocation action.
 * @returns Shared modal primitives; late outcomes after cancellation/unmount never adopt a directory.
 */
export function CloudProjectFlow(props: DirectoryFlowOwnerProps & CloudProjectFlowInjected): ReactElement {
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reported, setReported] = useState(false)
  const tooLong = new TextEncoder().encode(title.trim()).byteLength > 256
  const latest = useRef(props)
  latest.current = props
  const active = useRef<AbortController | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort() }
  }, [])
  useEffect(() => {
    if (!props.open && active.current !== undefined) {
      active.current.abort()
      setFailed(true)
    }
    if (!props.open) setReported(false)
  }, [props.open])

  const cancel = (): void => {
    if (active.current !== undefined) setFailed(true)
    active.current?.abort()
    latest.current.onCancel()
  }
  const submit = (): void => {
    if (!props.open || active.current !== undefined || props.busy || failed || reported || tooLong || title.trim().length === 0) return
    const control = new AbortController()
    active.current = control
    setPending(true)
    const complete = async (): Promise<void> => {
      try {
        const path = await props.createProject(title.trim(), control.signal)
        if (!control.signal.aborted && latest.current.open) {
          setReported(true)
          latest.current.onPicked(path)
        }
      } catch (_error) {
        // A failed response may follow an actual commit. Keep this form closed to replay until page recovery.
        if (!control.signal.aborted) setFailed(true)
      } finally {
        if (active.current === control) active.current = undefined
        if (alive.current) setPending(false)
      }
    }
    void complete()
  }
  const { t } = props
  return <Modal open={props.open} onClose={cancel} title={t('title')} closeLabel={t('cancel')}
    footer={<>
      <Button onClick={cancel}>{t('cancel')}</Button>
      <Button variant="primary" onClick={submit} disabled={pending || props.busy || failed || reported || tooLong || title.trim().length === 0}>
        {t('create')}
      </Button>
    </>}>
    <form onSubmit={(event) => { event.preventDefault(); submit() }}>
      <label>{t('name')}<Input aria-label={t('name')} aria-invalid={tooLong} data-modal-autofocus value={title}
        disabled={pending || props.busy || failed} onChange={(event) => { setTitle(event.target.value) }} /></label>
      {tooLong && <p role="alert">{t('invalid')}</p>}
      {failed && <p role="alert">{t('unknown')}</p>}
      {pending && <p role="status">{t('pending')}</p>}
    </form>
  </Modal>
}
